/**
 * wx.createVideoDecoder：基于浏览器 <video> + <canvas> 实现视频解帧。
 * start 载入源并返回媒体宽高，seek 按毫秒跳转，getFrameData 返回 RGBA 帧与时间戳，
 * 并按公开契约派发 start / seek / wait / stop / end 事件。
 */

import { blobFromPath } from './temp-files';

type Listener = (result: any) => void;

class VideoDecoder {
  private static nextId = 1;
  readonly videoDecoderId: number;
  width = 0;
  height = 0;
  private listeners = new Map<string, Listener[]>();
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private started = false;

  constructor() {
    this.videoDecoderId = VideoDecoder.nextId++;
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

  private async resolveSource(source: string): Promise<string> {
    if (/^(https?|blob):/.test(source)) return source;
    const blob = await blobFromPath(source);
    return URL.createObjectURL(blob);
  }

  async start(options: { source?: string; mode?: number; videoFormat?: number; startTime?: number; abortAudio?: boolean; abortVideo?: boolean } = {}) {
    if (!options.source) throw new Error('start:fail parameter source is required');
    await this.remove();
    const video = document.createElement('video');
    video.muted = !!options.abortAudio;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.src = await this.resolveSource(String(options.source));
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        video.removeEventListener('loadeddata', loaded);
        video.removeEventListener('error', failed);
        if (error) reject(error);
        else resolve();
      };
      const loaded = () => settle();
      const failed = () => settle(new Error('start:fail media load failed'));
      // 等 loadeddata（而非 loadedmetadata），保证 start 后 getFrameData 立即有帧可取
      video.addEventListener('loadeddata', loaded);
      video.addEventListener('error', failed);
    });
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    this.canvas.width = this.width || 1;
    this.canvas.height = this.height || 1;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (options.startTime) video.currentTime = Number(options.startTime) / 1000;
    video.addEventListener('ended', () => {
      this.emit('end', {});
      this.started = false;
    });
    this.started = true;
    const result = { video: { width: this.width, height: this.height }, audio: {} };
    this.emit('start', result);
    return result;
  }

  async seek(position: number, mode: 'accurate' | 'inaccurate' = 'inaccurate') {
    const video = this.requireVideo();
    const stamp = Number(position);
    await new Promise<void>(resolve => {
      const done = () => {
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done);
      // 目标与当前一致时浏览器可能不再派发 seeked，直接返回
      if (Math.abs(video.currentTime - stamp / 1000) < 0.001) {
        video.removeEventListener('seeked', done);
        resolve();
        return;
      }
      video.currentTime = stamp / 1000;
    });
    // accurate 模式在官方由原生精确到帧；浏览器宿主以 seeked 事件近似
    this.emit('seek', { position: stamp, mode });
    return stamp;
  }

  async wait(wait = false) {
    this.requireVideo();
    this.emit('wait', { wait });
    return {};
  }

  async stop() {
    const video = this.requireVideo();
    video.pause();
    this.started = false;
    this.emit('stop', {});
    return {};
  }

  async remove() {
    const video = this.video;
    this.started = false;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    }
    this.video = null;
    this.canvas = null;
    this.context = null;
    this.width = 0;
    this.height = 0;
    return {};
  }

  getFrameData(): { width: number; height: number; data: ArrayBuffer; pts: number; pkPts: number; dts: number; pkDts: number } | null {
    const video = this.video, context = this.context;
    if (!video || !context || !this.started || video.readyState < 2) return null;
    context.drawImage(video, 0, 0, this.canvas!.width, this.canvas!.height);
    const image = context.getImageData(0, 0, this.canvas!.width, this.canvas!.height);
    const pts = Math.round(video.currentTime * 1000);
    return {
      width: this.width,
      height: this.height,
      data: image.data.buffer,
      pts,
      pkPts: 0,
      dts: pts,
      pkDts: 0
    };
  }

  private requireVideo(): HTMLVideoElement {
    if (!this.video) throw new Error('start:fail video decoder not started');
    return this.video;
  }
}

export function createVideoDecoderApi(): { createVideoDecoder: (options?: any) => any } {
  return {
    // 官方 options.type 仅区分 'wemedia' 原生管线与默认渲染层管线；浏览器宿主统一用渲染层实现
    createVideoDecoder: (_options?: any) => new VideoDecoder() as any
  };
}

export type { VideoDecoder };
