/**
 * wx.createMediaRecorder(canvasNode, options)：官方 3.7.0 要求 canvas 节点有 webgl/wgfx
 * 上下文（重复创建同一节点报 Already created by the same canvas node.），
 * start/pause/resume/stop 以事件派发，stop 返回 {tempFilePath, tempThumbPath, fileSize, duration}。
 * 浏览器宿主用 canvas.captureStream + 真实 MediaRecorder 实现；容器格式取决于浏览器
 * （优先 mp4，回退 webm）。官方的音频轨道合并（audioPlayerId）与 gop/timeUpdateInterval
 * 属原生编码参数，浏览器宿主不支持，参数保留但不改变行为。
 */

import { addTempFile } from './temp-files';

type Listener = (result: any) => void;

const MIME_CANDIDATES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];

class CanvasMediaRecorder {
  private listeners = new Map<string, Listener[]>();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private pausedAt: number | null = null;
  private pausedDuration = 0;
  private mimeType = '';
  // 官方时序：create 事件完成后才允许 start/pause/resume/stop 生效
  private ready: Promise<void>;

  private async requireReady() {
    await this.ready;
  }

  duration: number;
  videoBitsPerSecond: number;
  fps: number;
  gop: number;
  width: number;
  height: number;
  timeUpdateInterval: number;

  constructor(private readonly canvas: HTMLCanvasElement, options: any = {}) {
    this.duration = typeof options.duration === 'number' ? Math.min(7200, Math.max(5, options.duration)) : 7200;
    this.videoBitsPerSecond = typeof options.videoBitsPerSecond === 'number' ? Math.min(3000, Math.max(600, options.videoBitsPerSecond)) : 1000;
    this.fps = options.fps || 24;
    this.gop = options.gop || 12;
    this.width = options.width || canvas.width;
    this.height = options.height || canvas.height;
    this.timeUpdateInterval = options.timeUpdateInterval || this.gop;
    this.ready = new Promise(resolve =>
      queueMicrotask(() => {
        this.emit('create', {});
        resolve();
      })
    );
  }

  private emit(event: string, result: any) {
    for (const listener of this.listeners.get(event) ?? []) listener(result);
  }

  on(event: string, callback: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  off(event: string, callback?: Listener) {
    if (!callback) this.listeners.delete(event);
    else this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== callback));
  }

  private requireRecorder(): MediaRecorder {
    if (!this.recorder || this.recorder.state === 'inactive') throw new Error('start:fail recorder is not started');
    return this.recorder;
  }

  async start() {
    await this.requireReady();
    const mimeType = MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
    this.mimeType = mimeType.split(';')[0];
    const stream = this.canvas.captureStream(this.fps);
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: this.videoBitsPerSecond * 1000
    });
    recorder.ondataavailable = event => {
      if (event.data.size) this.chunks.push(event.data);
    };
    recorder.start();
    this.stream = stream;
    this.recorder = recorder;
    this.startedAt = Date.now();
    this.pausedDuration = 0;
    this.pausedAt = null;
    // 官方 start 后到达 duration 自动停止
    window.setTimeout(() => {
      if (this.recorder === recorder && recorder.state !== 'inactive') void this.stop();
    }, this.duration * 1000);
    this.emit('start', {});
    return {};
  }

  async pause() {
    await this.requireReady();
    const recorder = this.requireRecorder();
    if (recorder.state === 'recording') {
      recorder.pause();
      this.pausedAt = Date.now();
      this.emit('pause', {});
    }
    return {};
  }

  async resume() {
    await this.requireReady();
    const recorder = this.requireRecorder();
    if (recorder.state === 'paused') {
      recorder.resume();
      if (this.pausedAt !== null) this.pausedDuration += Date.now() - this.pausedAt;
      this.pausedAt = null;
      this.emit('resume', {});
    }
    return {};
  }

  async requestFrame(callback?: () => void) {
    const track = this.stream?.getVideoTracks()[0] as any;
    track?.requestFrame?.();
    callback?.();
    return {};
  }

  async stop(): Promise<{ tempFilePath: string; tempThumbPath: string; fileSize: number; duration: number }> {
    await this.requireReady();
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') throw new Error('stop:fail recorder is not started');
    return new Promise(resolve => {
      recorder.onstop = async () => {
        const duration = Math.max(0, Date.now() - this.startedAt - this.pausedDuration);
        const blob = new Blob(this.chunks, { type: this.mimeType || 'video/webm' });
        const record = addTempFile(blob, 'record.' + (this.mimeType === 'video/mp4' ? 'mp4' : 'webm'));
        // 官方返回封面缩略图：宿主用当前画面导出 JPEG
        const thumb = document.createElement('canvas');
        thumb.width = this.canvas.width;
        thumb.height = this.canvas.height;
        thumb.getContext('2d')!.drawImage(this.canvas, 0, 0);
        const thumbBlob = await new Promise<Blob | null>(resolve2 => thumb.toBlob(resolve2, 'image/jpeg', 0.8));
        const thumbPath = thumbBlob ? addTempFile(thumbBlob, 'record-thumb.jpg').path : '';
        const result = { tempFilePath: record.path, tempThumbPath: thumbPath, fileSize: blob.size, duration: Math.round(duration) };
        this.stream?.getTracks().forEach(track => track.stop());
        this.stream = null;
        this.recorder = null;
        this.chunks = [];
        this.emit('stop', result);
        resolve(result);
      };
      recorder.stop();
    });
  }
}

export function createMediaRecorderApi(): { createMediaRecorder: (canvasNode: HTMLCanvasElement, options?: any) => any } {
  const recorders = new WeakMap<HTMLCanvasElement, CanvasMediaRecorder>();
  return {
    createMediaRecorder: (canvasNode: HTMLCanvasElement, options: any = {}): any => {
      if (recorders.get(canvasNode)) throw new Error('Already created by the same canvas node.');
      if (!canvasNode || typeof canvasNode.getContext !== 'function' || (!canvasNode.getContext('webgl') && !canvasNode.getContext('wgfx')))
        throw new Error('Cannot get webgl context from target.');
      const recorder = new CanvasMediaRecorder(canvasNode, options);
      recorders.set(canvasNode, recorder);
      return recorder;
    }
  };
}
