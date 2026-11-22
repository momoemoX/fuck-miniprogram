import { ownedElements } from '../selectors';
import { addTempFile } from './temp-files';
import { deliver, invoke } from './util';

export class BrowserCamera {
  private closed = false;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private permission: Promise<HTMLVideoElement> | null = null;
  private observer: MutationObserver | null = null;
  private readonly frameStops = new Set<() => void>();
  private recorder: MediaRecorder | null = null;
  private startingRecord = false;
  private chunks: Blob[] = [];
  private recordingDone: (() => void) | null = null;

  constructor(
    private readonly root: Element,
    private readonly onDispose?: () => void
  ) {}

  get disposed() {
    return this.closed;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.observer?.disconnect();
    for (const stop of this.frameStops) stop();
    this.frameStops.clear();
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    }
    this.recordingDone?.();
    this.recordingDone = null;
    this.recorder = null;
    this.chunks = [];
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.video = null;
    this.onDispose?.();
  }

  private assertOpen() {
    if (this.closed) throw new Error('camera disposed');
  }

  private call(name: string, options: any, run: () => any) {
    const guarded = { ...options };
    for (const key of ['success', 'fail', 'complete']) {
      if (typeof options?.[key] === 'function')
        guarded[key] = (result: any) => {
          if (!this.closed) options[key](result);
        };
    }
    return invoke(name, guarded, run);
  }

  private ensure(): Promise<HTMLVideoElement> {
    if (this.closed) return Promise.reject(new Error('camera disposed'));
    if (this.permission) return this.permission;
    const holder = ownedElements(this.root, 'wx-camera')[0];
    if (!holder || !holder.isConnected) return Promise.reject(new Error('camera component is not found'));
    if (this.video && this.stream) return Promise.resolve(this.video);
    if (typeof MutationObserver !== 'undefined' && !this.observer) {
      this.observer = new MutationObserver(() => {
        if (!holder.isConnected) this.dispose();
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }
    this.permission = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: holder.getAttribute?.('device-position') === 'front' ? 'user' : 'environment' },
        audio: false
      });
      if (this.closed || !holder.isConnected) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error('camera component is not available');
      }
      this.stream = stream;
      const video = holder.querySelector('video') ?? document.createElement('video');
      this.video = video;
      video.srcObject = stream;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      if (!video.parentElement) holder.appendChild(video);
      await video.play().catch(() => undefined);
      this.assertOpen();
      if (!holder.isConnected) {
        this.dispose();
        throw new Error('camera component is not available');
      }
      return video;
    })().finally(() => {
      this.permission = null;
    });
    return this.permission;
  }

  private async photo(video: HTMLVideoElement, quality: string): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/jpeg', quality === 'high' ? 0.95 : quality === 'low' ? 0.6 : 0.8)
    );
    this.assertOpen();
    if (!blob) throw new Error('photo capture failed');
    return blob;
  }

  api() {
    return {
      takePhoto: (options: any = {}) =>
        this.call('CameraContext.takePhoto', options, async () => {
          const video = await this.ensure();
          const blob = await this.photo(video, options.quality);
          return { tempImagePath: addTempFile(blob, 'photo.jpg').path };
        }),
      setZoom: (options: any = {}) =>
        this.call('CameraContext.setZoom', options, async () => {
          await this.ensure();
          const track = this.stream!.getVideoTracks()[0];
          const range = (track.getCapabilities?.() as any)?.zoom;
          if (!range || !track.applyConstraints) throw new Error('zoom is not supported');
          const zoom = Math.round(Number(options.zoom) * 10) / 10;
          if (!Number.isFinite(zoom) || zoom < Math.max(1, range.min) || zoom > range.max) throw new Error('zoom is out of range');
          await track.applyConstraints({ advanced: [{ zoom } as any] });
          this.assertOpen();
          return { zoom };
        }),
      startRecord: (options: any = {}) =>
        this.call('CameraContext.startRecord', options, async () => {
          if (this.startingRecord || this.recorder) throw new Error('already recording');
          this.startingRecord = true;
          try {
            const video = await this.ensure();
            this.assertOpen();
            const recorder = new MediaRecorder(video.srcObject as MediaStream, {
              mimeType: MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : ''
            });
            this.chunks = [];
            this.recorder = recorder;
            recorder.ondataavailable = event => {
              if (!this.closed && this.recorder === recorder && event.data.size) this.chunks.push(event.data);
            };
            recorder.start();
            return {};
          } finally {
            this.startingRecord = false;
          }
        }),
      stopRecord: (options: any = {}) =>
        this.call('CameraContext.stopRecord', options, async () => {
          const recorder = this.recorder;
          if (!recorder || recorder.state === 'inactive') throw new Error('not recording');
          await new Promise<void>(resolve => {
            this.recordingDone = resolve;
            recorder.onstop = () => resolve();
            recorder.stop();
          });
          this.recordingDone = null;
          this.assertOpen();
          const blob = new Blob(this.chunks, { type: recorder.mimeType || 'video/webm' });
          this.recorder = null;
          this.chunks = [];
          const thumbnail = await this.photo(this.video!, 'normal');
          return { tempThumbPath: addTempFile(thumbnail, 'thumb.jpg').path, tempVideoPath: addTempFile(blob, 'record.webm').path };
        }),
      onCameraFrame: (callback: (frame: any) => void) => {
        let active = false,
          generation = 0,
          frame = 0;
        const stop = () => {
          active = false;
          generation++;
          if (frame) cancelAnimationFrame(frame);
          frame = 0;
        };
        this.frameStops.add(stop);
        return {
          start: (options: any = {}) =>
            this.call('CameraFrameListener.start', options, async () => {
              if (active) return {};
              active = true;
              const current = ++generation;
              try {
                const video = await this.ensure();
                const canvas = document.createElement('canvas');
                const loop = () => {
                  if (!active || this.closed || current !== generation) return;
                  canvas.width = video.videoWidth;
                  canvas.height = video.videoHeight;
                  if (canvas.width && canvas.height) {
                    const context = canvas.getContext('2d')!;
                    context.drawImage(video, 0, 0);
                    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                    deliver(callback, {
                      data: pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength),
                      width: canvas.width,
                      height: canvas.height
                    });
                  }
                  if (active && !this.closed && current === generation) frame = requestAnimationFrame(loop);
                };
                loop();
                return {};
              } catch (error) {
                if (current === generation) active = false;
                throw error;
              }
            }),
          stop: (options: any = {}) =>
            this.call('CameraFrameListener.stop', options, () => {
              stop();
              return {};
            })
        };
      }
    };
  }
}
