/**
 * 媒体：图片、视频、音频、录音、相机
 *
 * 尽量用浏览器真实能力：文件选择、canvas 压缩、WebAudio、MediaRecorder、getUserMedia。
 * 无法真实完成的部分（保存到相册）退化为下载，但回调形态与微信一致。
 */

import { showActionSheet } from '../overlay';
import { BrowserCamera } from './camera';
import { readImageMetadata } from './image-metadata';
import { addTempFile, blobFromPath, mediaSource } from './temp-files';
import type { WxHost } from './types';
import { absoluteUrl, deliver, invoke, numberOr, uid } from './util';
import { ownedElements } from '../selectors';
import { anchorOf } from '../hosts';
import type { ContextShape } from '../contexts';
import { eventOwner } from '../events';
import { PcmRecorder } from './pcm-recorder';
import { AacRecorder, AAC_MEDIA_TYPE } from './aac-recorder';

type Listener = (...args: any[]) => void;

const RECORDING_BIT_RATES: Record<number, readonly [number, number]> = {
  8000: [16000, 48000], 11025: [16000, 48000], 12000: [24000, 64000],
  16000: [24000, 96000], 22050: [32000, 128000], 24000: [32000, 128000],
  32000: [48000, 192000], 44100: [64000, 320000], 48000: [64000, 320000]
};

function pickFiles(options: { accept?: string; multiple?: boolean; capture?: boolean }, signal: AbortSignal): Promise<File[]> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve([]);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    if (options.accept) input.accept = options.accept;
    input.multiple = !!options.multiple;
    if (options.capture) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    document.body.appendChild(input);
    const changed = () => done(Array.from(input.files ?? []));
    const cancelled = () => done([]);
    const done = (files: File[]) => {
      input.removeEventListener('change', changed);
      input.removeEventListener('cancel', cancelled);
      signal.removeEventListener('abort', cancelled);
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', changed);
    input.addEventListener('cancel', cancelled);
    signal.addEventListener('abort', cancelled, { once: true });
    input.click();
  });
}

function imageSize(
  src: string,
  signal: AbortSignal
): Promise<{ width: number; height: number; path: string; orientation: string; type: string }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const cleanup = () => {
      image.onload = image.onerror = null;
      signal.removeEventListener('abort', abort);
      image.removeAttribute('src');
    };
    const abort = () => {
      cleanup();
      reject(new Error('media disposed'));
    };
    image.onload = () => {
      const result = {
        width: image.naturalWidth,
        height: image.naturalHeight,
        path: src,
        orientation: 'up',
        type: `image/${(src.match(/\.(png|jpe?g|gif|webp|svg)/i)?.[1] ?? 'jpeg').toLowerCase().replace('jpg', 'jpeg')}`
      };
      cleanup();
      resolve(result);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('getImageInfo:fail image load failed'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    image.src = src;
  });
}

function videoMeta(
  src: string,
  signal: AbortSignal,
  thumbnail = false
): Promise<{ duration: number; width: number; height: number; size: number; orientation: string; thumb?: Blob }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = thumbnail ? 'auto' : 'metadata';
    let settled = false,
      finishing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      video.onloadedmetadata = video.onloadeddata = video.onerror = null;
      signal.removeEventListener('abort', abort);
      if (timer) clearTimeout(timer);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('media disposed'));
    };
    const finish = (withFrame: boolean) => {
      if (settled || finishing) return;
      finishing = true;
      const result = {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        size: 0,
        orientation: 'up'
      };
      const done = (thumb?: Blob | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(thumb ? { ...result, thumb } : result);
      };
      if (withFrame && result.width && result.height) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = result.width;
          canvas.height = result.height;
          canvas.getContext('2d')!.drawImage(video, 0, 0);
          canvas.toBlob(done, 'image/jpeg');
        } catch {
          done();
        }
      } else done();
    };
    video.onloadedmetadata = () => {
      if (!thumbnail) finish(false);
      else if (video.readyState >= 2) finish(true);
      else timer = setTimeout(() => finish(false), 1000);
    };
    if (thumbnail) video.onloadeddata = () => finish(true);
    video.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('video load failed'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    video.src = src;
  });
}

async function compress(
  blob: Blob,
  quality: number,
  requestedWidth?: number,
  requestedHeight?: number,
  type = 'image/jpeg'
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    if (
      (requestedWidth !== undefined && (!Number.isFinite(Number(requestedWidth)) || Number(requestedWidth) <= 0)) ||
      (requestedHeight !== undefined && (!Number.isFinite(Number(requestedHeight)) || Number(requestedHeight) <= 0))
    )
      throw new Error('invalid compressed dimensions');
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(
      1,
      Math.round(requestedWidth ?? (requestedHeight === undefined ? bitmap.width : (bitmap.width * requestedHeight) / bitmap.height))
    );
    canvas.height = Math.max(
      1,
      Math.round(requestedHeight ?? (requestedWidth === undefined ? bitmap.height : (bitmap.height * requestedWidth) / bitmap.width))
    );
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(result => (result ? resolve(result) : reject(new Error('image encoding failed'))), type, quality)
    );
  } finally {
    bitmap.close();
  }
}

export class MediaApi {
  private innerAudios = new Set<any>();
  private voice: HTMLAudioElement | null = null;
  private recorder: MediaRecorder | PcmRecorder | AacRecorder | null = null;
  private recorderManager: any = null;
  private recorderGeneration = 0;
  private recorderTimer: ReturnType<typeof setTimeout> | null = null;
  private recorderStream: MediaStream | null = null;
  private recorderCallbacks: Record<string, Listener | undefined> = {};
  private recorderLegacyCallbacks: Record<string, Listener | undefined> = {};
  private background: any = null;
  private backgroundCleanup: (() => void) | null = null;
  private backgroundPlay: ((source?: string, metadata?: { title: any; coverImgUrl: any }) => Promise<void>) | null = null;
  private backgroundListenLegacy: ((name: string, callback: Listener) => void) | null = null;
  private backgroundState: () => any = () => ({ status: 2 });
  private webAudios = new Set<AudioContext>();
  private disposed = false;
  private cameras = new Map<Element, BrowserCamera>();
  private readonly pending = new AbortController();
  private readonly contextCleanups = new Set<() => void>();
  private statusBarOwner: object | null = null;
  private readonly videoContextCache = new WeakMap<Element, Map<string | Element, any>>();
  private legacyRecording: { started: boolean; cancel(error: Error): void } | null = null;

  private assertOpen() {
    if (this.disposed) throw new Error('media disposed');
  }

  private call(name: string, options: any, run: (options: any) => any) {
    const guarded = { ...options };
    for (const key of ['success', 'fail', 'complete']) {
      if (typeof options?.[key] === 'function')
        guarded[key] = (result: any) => {
          if (!this.disposed) options[key](result);
        };
    }
    return invoke(name, guarded, async opts => {
      this.assertOpen();
      const result = await run(opts);
      this.assertOpen();
      return result;
    });
  }

  constructor(private readonly host: WxHost) {}

  private pageRoot(): Element {
    return this.host.pageElement() ?? document.body;
  }

  private videoOf(id?: string, component?: any): HTMLVideoElement | null {
    if (!id) return null;
    const root = component?.__el ?? this.pageRoot();
    const holder = ownedElements(root, `#${CSS.escape(id)}`)[0];
    if (!holder) return null;
    return holder.tagName === 'VIDEO' ? (holder as HTMLVideoElement) : holder.querySelector('video');
  }

  private audioContext() {
    const audio = new Audio();
    audio.preload = 'auto';
    const listeners = new Set<any>();
    let destroyed = false;
    let source = '';
    let startTime = 0;
    let hasPlayed = false;
    let playing = false;
    let obeyMuteSwitch: any;
    let referrerPolicy: any;
    const listening = new AbortController();
    const api: any = {};

    const define = (name: string, get: () => any, set?: (value: any) => void) => {
      Object.defineProperty(api, name, {
        get,
        set: (value: any) => {
          if (!destroyed && !this.disposed) set?.(value);
        }
      });
    };

    define(
      'src',
      () => source,
      value => {
        if (typeof value !== 'string' || !value || value === source) return;
        source = value;
        playing = false;
        audio.pause();
        hasPlayed = false;
        audio.src = value;
      }
    );
    define(
      'startTime',
      () => startTime,
      value => {
        const time = Number(value);
        if (Number.isNaN(time) || time < 0 || time === startTime) return;
        startTime = time;
        if (!hasPlayed) api.seek(time);
      }
    );
    define(
      'autoplay',
      () => audio.autoplay,
      value => {
        audio.autoplay = !!value;
      }
    );
    define(
      'loop',
      () => audio.loop,
      value => {
        audio.loop = !!value;
      }
    );
    define(
      'volume',
      () => audio.volume,
      value => {
        if (typeof value === 'number' && value >= 0 && value <= 1) audio.volume = value;
      }
    );
    define(
      'playbackRate',
      () => audio.playbackRate,
      value => {
        if (typeof value !== 'number' || value < 0.5 || value > 2 || Number.isNaN(value)) return;
        audio.defaultPlaybackRate = value;
        audio.playbackRate = value;
      }
    );
    define('duration', () => audio.duration);
    define('currentTime', () => audio.currentTime, value => api.seek(Number(value)));
    define('paused', () => !playing);
    define('buffered', () => (audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0));
    define(
      'obeyMuteSwitch',
      () => obeyMuteSwitch,
      value => { obeyMuteSwitch = value; }
    );
    define('referrerPolicy', () => referrerPolicy, value => { referrerPolicy = value; });

    api.play = () => {
      if (destroyed || this.disposed) return;
      const promise = audio.play();
      promise?.catch?.(error => {
        if (error?.name === 'AbortError') return;
        emit('Error', { errMsg: `play:fail ${error?.message ?? error}` });
      });
    };
    api.pause = () => {
      if (destroyed || this.disposed) return;
      const wasPlaying = playing;
      playing = false;
      audio.pause();
      if (wasPlaying) emit('Pause');
    };
    api.stop = () => {
      if (destroyed || this.disposed) return;
      const wasPlaying = playing;
      playing = false;
      audio.pause();
      if (!wasPlaying) return;
      try {
        audio.currentTime = 0;
      } catch {
        /* 元数据未就绪 */
      }
      emit('Stop');
    };
    api.seek = (time: number) => {
      time = Number(time);
      if (destroyed || this.disposed || Number.isNaN(time) || time < 0) return;
      emit('Seeking');
      try { audio.currentTime = time; } catch { /* 资源尚未就绪时保留起播配置。 */ }
      emit('Seeked');
      emit('Canplay');
    };
    api.destroy = () => {
      if (destroyed) return;
      destroyed = true;
      playing = false;
      listening.abort();
      listeners.clear();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      this.innerAudios.delete(api);
    };

    const emit = (name: string, ...args: any[]) => {
      if (destroyed || this.disposed) return;
      for (const entry of Array.from(listeners)) {
        if (entry.name === name) deliver(entry.callback, ...args);
      }
    };

    const events: Array<[string, string]> = [
      ['Canplay', 'canplay'],
      ['Play', 'playing'],
      ['Pause', 'pause'],
      ['Stop', 'stop'],
      ['Ended', 'ended'],
      ['TimeUpdate', 'timeupdate'],
      ['Error', 'error'],
      ['Waiting', 'waiting'],
      ['Seeking', 'seeking'],
      ['Seeked', 'seeked'],
      ['LoadedMetadata', 'loadedmetadata'],
      ['Progress', 'progress']
    ];
    for (const [name, type] of events) {
      if (type === 'seeking' || type === 'seeked' || type === 'stop' || type === 'pause') continue;
      audio.addEventListener(type, () => {
        if (type === 'playing') { playing = true; hasPlayed = true; }
        if (type === 'ended' || type === 'error') playing = false;
        if (type === 'timeupdate' && !playing) return;
        if (type === 'error') {
          const code = audio.error?.code;
          emit('Error', { errMsg: `MediaError: code ${code ?? 0}` });
          return;
        }
        emit(name);
      }, { signal: listening.signal });
    }
    audio.addEventListener('loadedmetadata', () => {
      if (!hasPlayed && startTime > 0 && Number.isFinite(startTime)) audio.currentTime = startTime;
    }, { signal: listening.signal });

    for (const name of events.map(([name]) => name)) {
      api[`on${name}`] = (callback: Listener) => {
        listeners.add({ name, callback });
      };
      api[`off${name}`] = (callback?: Listener) => {
        for (const entry of Array.from(listeners).reverse()) {
          if (entry.name === name && (!callback || entry.callback === callback)) {
            listeners.delete(entry);
            if (callback) break;
          }
        }
      };
    }

    this.innerAudios.add(api);
    return api;
  }

  /** 应用销毁时释放媒体资源；页面切换不改变全局媒体管理器。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.abort();
    for (const cleanup of this.contextCleanups) cleanup();
    this.contextCleanups.clear();
    this.legacyRecording?.cancel(new Error('media disposed'));
    this.recorderGeneration++;
    this.recorderCallbacks = {};
    this.recorderLegacyCallbacks = {};
    if (this.recorderTimer) clearTimeout(this.recorderTimer);
    this.recorderTimer = null;
    for (const audio of Array.from(this.innerAudios)) audio.destroy();
    this.innerAudios.clear();
    this.voice?.pause();
    this.voice = null;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorderStream?.getTracks().forEach(track => track.stop());
    this.recorderStream = null;
    this.recorder = null;
    this.backgroundCleanup?.();
    this.backgroundCleanup = null;
    this.background = null;
    this.backgroundPlay = null;
    this.backgroundState = () => ({ status: 2 });
    for (const context of this.webAudios) {
      if (context.state !== 'closed') void context.close().catch(() => undefined);
    }
    this.webAudios.clear();
    for (const camera of this.cameras.values()) camera.dispose();
    this.cameras.clear();
  }

  private videoContext(id: string, component?: any, node?: Element) {
    if (typeof id !== 'string') return undefined;
    const root = component?.__el ?? this.pageRoot();
    let cache = this.videoContextCache.get(root);
    if (!cache) { cache = new Map(); this.videoContextCache.set(root, cache); }
    const key = node ?? id;
    if (cache.has(key)) return cache.get(key);
    let bound: HTMLVideoElement | null = null;
    let cleaned = false;
    let requestedFullscreen = false;
    let observer: MutationObserver | undefined;
    const handlers = new Map<string, EventListener>();
    const unbind = () => {
      for (const [type, handler] of handlers) bound?.removeEventListener(type, handler);
      handlers.clear();
      bound = null;
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (this.statusBarOwner === ctx) {
        this.host.setStatusBarHidden(false);
        this.statusBarOwner = null;
      }
      observer?.disconnect();
      unbind();
      listeners.clear();
      cache.delete(key);
      if (!cache.size) this.videoContextCache.delete(root);
      this.contextCleanups.delete(cleanup);
    };
    const found = () => {
      if (cleaned || this.disposed) return null;
      const video = node ? node.isConnected ? node.querySelector('video') : null : this.videoOf(id, { __el: root });
      if (video !== bound) {
        unbind();
        bound = video;
        if (video)
          for (const type of ['play', 'pause', 'ended', 'timeupdate', 'waiting', 'error', 'progress', 'fullscreenchange']) {
            const handler = () =>
              emit(type === 'timeupdate' ? 'timeUpdate' : type, { currentTime: video.currentTime, duration: video.duration });
            handlers.set(type, handler);
            video.addEventListener(type, handler);
          }
      }
      return video;
    };
    const listeners = new Map<string, Set<Listener>>();
    const on = (name: string, callback: Listener) => {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(callback);
    };
    const off = (name: string, callback?: Listener) => {
      if (!callback) listeners.delete(name);
      else listeners.get(name)?.delete(callback);
    };
    const emit = (name: string, payload: any) => {
      if (cleaned || this.disposed) return;
      for (const callback of Array.from(listeners.get(name) ?? [])) deliver(callback, payload);
    };

    this.contextCleanups.add(cleanup);
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        if (!anchorOf(root).isConnected) cleanup();
        else found();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    found();

    const player = () => {
      const video = found();
      return (video?.closest('wx-video') ?? video) as any;
    };

    const statusBar = (hidden: boolean, options: any = {}) => {
      if (cleaned || this.disposed) return;
      const permitted = !hidden || requestedFullscreen;
      const result = { errMsg: permitted ? `${hidden ? 'hide' : 'show'}StatusBar:ok` : 'hideStatusBar:fail cannot be invoked but in fullscreen.' };
      if (permitted) {
        this.host.setStatusBarHidden(hidden);
        this.statusBarOwner = hidden ? ctx : null;
      }
      deliver(permitted ? options.success : options.fail, result);
      deliver(options.complete, result);
    };

    const ctx = {
      play: () => {
        void player()?.play()?.catch(() => undefined);
      },
      pause: () => { player()?.pause(); },
      stop: () => {
        const target = player();
        if (target?.stop) { target.stop(); return; }
        const video = target as HTMLVideoElement | null;
        if (!video) return;
        video.pause();
        video.currentTime = 0;
      },
      seek: (time: number, mode = 'accurate') => {
        if (mode !== 'accurate' && mode !== 'inaccurate') throw new Error('Parameter 2 must either be `accurate` or be `inaccurate`');
        const target = player();
        if (target?.seek) target.seek(Number(time) || 0);
        else if (target) target.currentTime = Number(time) || 0;
      },
      sendDanmu: ({ text, color }: any) => { player()?.sendDanmu?.({ text, color }); },
      playbackRate: (rate: number) => {
        if (rate != null && typeof rate.toFixed !== 'function') throw new TypeError('e.toFixed is not a function');
        const normalized = parseFloat(rate.toFixed(2));
        if (![0.5, 0.8, 1, 1.25, 1.5, 2].includes(normalized)) return;
        const video = found();
        if (video) video.playbackRate = normalized;
      },
      requestFullScreen: (options: any) => {
        if (cleaned || this.disposed) return;
        requestedFullscreen = true;
        const target = player();
        if (target?.requestFullScreen) target.requestFullScreen(options);
        else if (target?.requestFullscreen) void target.requestFullscreen().catch(() => undefined);
        else target?.webkitEnterFullscreen?.();
      },
      exitFullScreen: () => {
        if (cleaned || this.disposed) return;
        requestedFullscreen = false;
        const target = player();
        if (target?.exitFullScreen) target.exitFullScreen();
        else if (target && document.fullscreenElement === target) void document.exitFullscreen().catch(() => undefined);
        statusBar(false);
      },
      showStatusBar: (options?: any) => statusBar(false, options),
      hideStatusBar: (options?: any) => statusBar(true, options),
      exitPictureInPicture: () => {
        if (cleaned || this.disposed || !document.pictureInPictureElement) return;
        void document.exitPictureInPicture().catch(() => undefined);
      },
      onTimeUpdate: (callback: Listener) => on('timeUpdate', callback),
      offTimeUpdate: (callback?: Listener) => off('timeUpdate', callback),
      onPlay: (callback: Listener) => on('play', callback),
      offPlay: (callback?: Listener) => off('play', callback),
      onPause: (callback: Listener) => on('pause', callback),
      offPause: (callback?: Listener) => off('pause', callback),
      onEnded: (callback: Listener) => on('ended', callback),
      offEnded: (callback?: Listener) => off('ended', callback),
      onWaiting: (callback: Listener) => on('waiting', callback),
      offWaiting: (callback?: Listener) => off('waiting', callback),
      onError: (callback: Listener) => on('error', callback),
      offError: (callback?: Listener) => off('error', callback),
      onProgress: (callback: Listener) => on('progress', callback),
      offProgress: (callback?: Listener) => off('progress', callback),
      onFullScreenChange: (callback: Listener) => on('fullscreenchange', callback),
      offFullScreenChange: (callback?: Listener) => off('fullscreenchange', callback)
    } satisfies ContextShape<'VideoContext'> & Record<string, unknown>;
    cache.set(key, ctx);
    return ctx;
  }

  videoContextForNode(node: Element) {
    return this.videoContext(node.id, eventOwner(node), node);
  }

  api() {
    return {
      // ---------------------------------------------------------------- 图片
      chooseImage: (options: any) =>
        this.call('chooseImage', options, async opts => {
          const count = Math.max(1, Math.min(Math.floor(numberOr(opts?.count, 9)), 9));
          const files = await pickFiles(
            { accept: 'image/*', multiple: count > 1, capture: opts?.sourceType?.[0] === 'camera' },
            this.pending.signal
          );
          if (!files.length) throw new Error('cancel');
          const compressed = opts?.sizeType?.includes('compressed') && !opts?.sizeType?.includes('original');
          const tempFiles = [];
          for (const file of files.slice(0, count)) {
            const blob = compressed ? await compress(file, 0.8) : file;
            this.assertOpen();
            const record = addTempFile(blob, file.name, file.type);
            tempFiles.push({ path: record.path, size: blob.size });
          }
          return { tempFilePaths: tempFiles.map(file => file.path), tempFiles };
        }),

      chooseMedia: (options: any) =>
        this.call('chooseMedia', options, async opts => {
          const count = Math.max(1, Math.min(Math.floor(numberOr(opts?.count, 9)), 20));
          const types: string[] = opts?.mediaType ?? ['image', 'video'];
          const accept =
            types.includes('mix') || (types.includes('image') && types.includes('video'))
              ? 'image/*,video/*'
              : types.includes('video')
                ? 'video/*'
                : 'image/*';
          const source = opts?.sourceType?.[0] === 'camera';
          const picked = await pickFiles({ accept, multiple: count > 1, capture: source }, this.pending.signal);
          const videos = picked.filter(file => file.type.startsWith('video/'));
          const files = !types.includes('mix') && videos.length ? videos : picked;
          if (!files.length) throw new Error('cancel');
          const tempFiles = [];
          for (const file of files.slice(0, count)) {
            const isVideo = file.type.startsWith('video');
            const blob =
              !isVideo && opts?.sizeType?.includes('compressed') && !opts?.sizeType?.includes('original')
                ? await compress(file, 0.8)
                : file;
            this.assertOpen();
            const record = addTempFile(blob, file.name, file.type);
            if (isVideo) {
              const meta = await videoMeta(record.url, this.pending.signal, true).catch(() => null);
              this.assertOpen();
              tempFiles.push({
                tempFilePath: record.path,
                size: blob.size,
                duration: meta?.duration ?? 0,
                width: meta?.width ?? 0,
                height: meta?.height ?? 0,
                thumbTempFilePath: meta?.thumb ? addTempFile(meta.thumb, 'thumb.jpg').path : '',
                fileType: 'video'
              });
            } else {
              tempFiles.push({
                tempFilePath: record.path,
                size: blob.size,
                fileType: 'image'
              });
            }
          }
          return { tempFiles, type: types.includes('mix') ? 'mix' : (tempFiles[0]?.fileType ?? 'image') };
        }),

      chooseVideo: (options: any) =>
        this.call('chooseVideo', options, async opts => {
          const files = await pickFiles({ accept: 'video/*', capture: opts?.sourceType?.[0] === 'camera' }, this.pending.signal);
          if (!files.length) throw new Error('cancel');
          const file = files[0];
          const record = addTempFile(file, file.name, file.type);
          const meta = await videoMeta(record.url, this.pending.signal, true).catch(() => null);
          this.assertOpen();
          return {
            tempFilePath: record.path,
            duration: meta?.duration ?? 0,
            size: file.size,
            height: meta?.height ?? 0,
            width: meta?.width ?? 0,
            thumbTempFilePath: meta?.thumb ? addTempFile(meta.thumb, 'thumb.jpg').path : ''
          };
        }),

      chooseMessageFile: (options: any) =>
        this.call('chooseMessageFile', options, async opts => {
          const count = Math.max(0, Math.min(100, Math.floor(numberOr(opts?.count, 1))));
          const accept =
            opts.type === 'image'
              ? 'image/*'
              : opts.type === 'video'
                ? 'video/*'
                : opts.type === 'file' && Array.isArray(opts.extension)
                  ? opts.extension.map((extension: string) => `.${String(extension).replace(/^\./, '')}`).join(',')
                  : '';
          const files = await pickFiles({ accept, multiple: count > 1 }, this.pending.signal);
          if (!files.length) throw new Error('cancel');
          const tempFiles = files.slice(0, count).map(file => {
            const record = addTempFile(file, file.name, file.type);
            return {
              path: record.path,
              name: file.name,
              size: file.size,
              time: Math.floor(Date.now() / 1000),
              type: file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'file'
            };
          });
          return { tempFiles };
        }),

      previewImage: (options: any) =>
        this.call('previewImage', options, async opts => {
          const urls: string[] = opts?.urls ?? [];
          if (!urls.length) throw new Error('parameter error: "urls" is required');
          const index = typeof opts.current === 'number' ? Math.floor(opts.current) : Math.max(0, urls.indexOf(opts.current));
          await this.preview(urls.map(url => ({ url, type: 'image' })), index);
          return {};
        }),

      previewMedia: (options: any) =>
        this.call('previewMedia', options, async opts => {
          const sources = opts?.sources ?? [];
          if (!sources.length) throw new Error('parameter error: "sources" is required');
          const index = Math.min(sources.length - 1, Math.max(0, Math.floor(numberOr(opts.current, 0))));
          await this.preview(sources, index);
          return {};
        }),

      getImageInfo: (options: any) =>
        this.call('getImageInfo', options, async opts => {
          if (!opts?.src) throw new Error('parameter error: "src" is required');
          const blob = await blobFromPath(absoluteUrl(opts.src), this.pending.signal);
          this.assertOpen();
          const url = URL.createObjectURL(blob);
          try {
            const size = await imageSize(url, this.pending.signal);
            const metadata = readImageMetadata(new Uint8Array(await blob.arrayBuffer()));
            this.assertOpen();
            const path = /^(https?:|data:)/.test(opts.src) ? addTempFile(blob).path : opts.src;
            return { ...size, ...metadata, path };
          } finally {
            URL.revokeObjectURL(url);
          }
        }),

      saveImageToPhotosAlbum: (options: any) =>
        this.call('saveImageToPhotosAlbum', options, async opts => {
          if (!opts?.filePath) throw new Error('parameter error: "filePath" is required');
          const blob = await blobFromPath(opts.filePath, this.pending.signal);
          this.assertOpen();
          downloadBlob(blob, `image-${uid()}.png`);
          return {};
        }),

      compressVideo: (options: any) =>
        this.call('compressVideo', options, async opts => {
          if (!opts?.src) throw new Error('parameter error: "src" is required');
          // 浏览器里不做转码，直接复制成新的临时文件，接口形状保持一致
          const blob = await blobFromPath(opts.src, this.pending.signal);
          this.assertOpen();
          const temp = addTempFile(blob, 'mp4');
          return { tempFilePath: temp.path, size: blob.size };
        }),
      openVideoEditor: (options: any) =>
        this.call('openVideoEditor', options, async opts => {
          if (!opts?.filePath) throw new Error('parameter error: "filePath" is required');
          const blob = await blobFromPath(opts.filePath, this.pending.signal);
          this.assertOpen();
          const temp = addTempFile(blob, 'mp4');
          return { tempFilePath: temp.path, duration: 0, size: blob.size };
        }),
      saveVideoToPhotosAlbum: (options: any) =>
        this.call('saveVideoToPhotosAlbum', options, async opts => {
          if (!opts?.filePath) throw new Error('parameter error: "filePath" is required');
          const blob = await blobFromPath(opts.filePath, this.pending.signal);
          this.assertOpen();
          downloadBlob(blob, `video-${uid()}.mp4`);
          return {};
        }),

      compressImage: (options: any) =>
        this.call('compressImage', options, async opts => {
          if (!opts?.src) throw new Error('parameter error: "src" is required');
          const quality = numberOr(opts.quality, 80);
          if (quality < 0 || quality > 100) throw new Error('quality is out of range');
          const blob = await blobFromPath(opts.src, this.pending.signal);
          const format = readImageMetadata(new Uint8Array(await blob.slice(0, 32).arrayBuffer())).type;
          const result = await compress(
            blob,
            quality / 100,
            opts.compressedWidth,
            opts.compressedHeight,
            format === 'png' ? 'image/png' : 'image/jpeg'
          );
          this.assertOpen();
          return { tempFilePath: addTempFile(result).path };
        }),

      editImage: (options: any) =>
        this.call('editImage', options, async opts => {
          const blob = await blobFromPath(opts?.src, this.pending.signal);
          this.assertOpen();
          downloadBlob(blob, `edited-${uid()}.png`);
          return { tempFilePath: opts?.src };
        }),

      getVideoInfo: (options: any) =>
        this.call('getVideoInfo', options, async opts => {
          const blob = await blobFromPath(opts?.src, this.pending.signal);
          this.assertOpen();
          const record = addTempFile(blob);
          const meta = await videoMeta(record.url, this.pending.signal);
          return {
            orientation: meta.orientation,
            duration: meta.duration,
            tempFilePath: record.path,
            size: blob.size,
            height: meta.height,
            width: meta.width,
            fps: 30,
            bitrate: 0
          };
        }),

      // ---------------------------------------------------------------- 视频
      createVideoContext: (id: string, component?: any) => this.videoContext(id, component),

      // ---------------------------------------------------------------- 音频
      checkIsPictureInPictureActive: () => typeof document !== 'undefined' && !!document.pictureInPictureElement,
      createInnerAudioContext: () => this.audioContext(),
      setInnerAudioOption: (options: any) => this.call('setInnerAudioOption', options, () => ({})),
      getAvailableAudioSources: (options: any) => this.call('getAvailableAudioSources', options, () => {
        const encoder = typeof MediaRecorder !== 'undefined' || typeof AudioContext === 'function' || typeof (globalThis as any).webkitAudioContext === 'function';
        const supported = encoder && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
        return { audioSources: supported ? ['auto'] : [] };
      }),

      createAudioContext: (id: string, component?: any) => {
        if (typeof id !== 'string') return undefined;
        const root = component?.__el ?? this.pageRoot();
        const pending: Array<() => void> = [];
        const found = () => {
          if (this.disposed || !id) return null;
          return ownedElements(root, `wx-audio#${CSS.escape(id)}`)[0] as (HTMLElement & { play(): void; pause(): void; seek(time: number): void; setSource(source: string): void }) | undefined;
        };
        const flush = () => {
          if (found()) for (const action of pending.splice(0)) action();
        };
        const send = (action: (audio: NonNullable<ReturnType<typeof found>>) => void) => {
          if (this.disposed) return;
          const audio = found();
          if (audio) action(audio);
          else pending.push(() => { const audio = found(); if (audio) action(audio); });
        };
        const observer = new MutationObserver(flush);
        observer.observe(document.body, { childList: true, subtree: true });
        const cleanup = () => { observer.disconnect(); pending.length = 0; this.contextCleanups.delete(cleanup); };
        this.contextCleanups.add(cleanup);
        return {
          play: () => send(audio => { audio.play(); }),
          pause: () => send(audio => audio.pause()),
          seek: (time: number) => send(audio => audio.seek(time)),
          setSrc: (source: string) => send(audio => audio.setSource(source))
        } satisfies ContextShape<'AudioContext'>;
      },

      playVoice: (options: any) =>
        this.call('playVoice', options, opts => {
          this.voice?.pause();
          this.voice = new Audio(String(opts?.filePath ?? ''));
          void this.voice.play().catch(() => undefined);
          return {};
        }),
      pauseVoice: (options: any) =>
        this.call('pauseVoice', options, () => {
          this.voice?.pause();
          return {};
        }),
      stopVoice: (options: any) =>
        this.call('stopVoice', options, () => {
          this.voice?.pause();
          this.voice = null;
          return {};
        }),

      getBackgroundAudioManager: () => this.backgroundManager(),
      getBackgroundAudioPlayerState: (options: any) =>
        this.call('getBackgroundAudioPlayerState', options, () => {
          const state = this.backgroundState();
          if (state.status === 2) throw { errMsg: 'getBackgroundAudioPlayerState: fail not playing' };
          return state;
        }),
      playBackgroundAudio: (options: any) =>
        this.call('playBackgroundAudio', options, async opts => {
          if (typeof opts.dataUrl !== 'string' || !opts.dataUrl) throw new Error('dataUrl is required');
          this.backgroundManager();
          await this.backgroundPlay!(opts.dataUrl, { title: opts.title ?? '', coverImgUrl: opts.coverImgUrl ?? '' });
        }),
      pauseBackgroundAudio: (options: any) => this.call('pauseBackgroundAudio', options, () => this.backgroundManager().pause()),
      stopBackgroundAudio: (options: any) => this.call('stopBackgroundAudio', options, () => this.backgroundManager().stop()),
      seekBackgroundAudio: (options: any) =>
        this.call('seekBackgroundAudio', options, opts => this.backgroundManager().seek(opts.position)),
      onBackgroundAudioPlay: (callback: Listener) => this.legacyBackgroundListener('play', callback),
      onBackgroundAudioPause: (callback: Listener) => this.legacyBackgroundListener('pause', callback),
      onBackgroundAudioStop: (callback: Listener) => {
        this.legacyBackgroundListener('stop', callback);
      },

      // ---------------------------------------------------------------- 录音
      getRecorderManager: () => (this.recorderManager ??= this.createRecorder()),

      startRecord: (options: any) => this.call('startRecord', options, () => this.recordLegacy()),
      stopRecord: (options: any) =>
        this.call('stopRecord', options, () => {
          const pending = this.legacyRecording;
          (this.recorderManager ??= this.createRecorder()).stop();
          if (pending && !pending.started) pending.cancel(new Error('cancel'));
          return {};
        }),
      // 官方 3.7.0：应用级音频中断与录音中断共用原生通道语义，浏览器宿主没有系统
      // 级触发源，这里只提供注册通道，触发由宿主桥接注入，不虚构事件。
      onAudioInterruptionBegin: (callback: Listener) => this.host.on('audioInterruptionBegin', callback),
      offAudioInterruptionBegin: (callback: Listener) => this.host.off('audioInterruptionBegin', callback),
      onAudioInterruptionEnd: (callback: Listener) => this.host.on('audioInterruptionEnd', callback),
      offAudioInterruptionEnd: (callback: Listener) => this.host.off('audioInterruptionEnd', callback),

      // ---------------------------------------------------------------- 相机
      createCameraContext: () => this.createCamera(),
      createLivePlayerContext: (id: string) => this.createLive('wx-live-player', id),
      createLivePusherContext: (id: string) => this.createLive('wx-live-pusher', id),

      // ---------------------------------------------------------------- WebAudio
      createWebAudioContext: () => {
        const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext;
        if (!AC) {
          return {
            createGain: () => ({ connect: () => undefined, gain: { value: 1 } }),
            createOscillator: () => ({ connect: () => undefined, start: () => undefined, stop: () => undefined }),
            close: () => Promise.resolve(),
            state: 'closed'
          };
        }
        const context = new AC();
        this.webAudios.add(context);
        return new Proxy(context, {
          get: (target, key) => {
            if (key === 'close')
              return () => {
                this.webAudios.delete(target);
                return target.close();
              };
            const value = (target as any)[key];
            if (typeof value === 'function') return value.bind(target);
            if (key === 'state') return target.state;
            return value;
          }
        });
      }
    };
  }

  private async preview(sources: { url: string; type?: string; poster?: string }[], startIndex: number) {
    const resolved: { url: string; release(): void }[] = [];
    try {
      for (const source of sources) {
        resolved.push(await mediaSource(source.url, this.pending.signal));
      }
      this.assertOpen();
    } catch (error) {
      resolved.forEach(source => source.release());
      throw error;
    }
    let index = Math.min(Math.max(startIndex, 0), sources.length - 1);
    const layer = document.createElement('div');
    layer.className = 'fmp-preview';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-label', '媒体预览');
    layer.setAttribute('aria-modal', 'true');
    const content = document.createElement('div');
    content.className = 'fmp-preview-content';
    const position = document.createElement('div');
    position.className = 'fmp-preview-position';
    const clear = () => {
      const video = content.querySelector('video');
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      content.replaceChildren();
    };
    const close = () => {
      clear();
      layer.remove();
      resolved.forEach(source => source.release());
      this.contextCleanups.delete(close);
    };
    const paint = () => {
      clear();
      const source = sources[index];
      if (source.type === 'video') {
        const video = document.createElement('video');
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.src = resolved[index].url;
        if (source.poster) video.poster = source.poster;
        content.appendChild(video);
      } else {
        const image = document.createElement('img');
        image.src = resolved[index].url;
        image.alt = '预览图片';
        image.addEventListener('click', close);
        content.appendChild(image);
      }
      position.textContent = sources.length > 1 ? `${index + 1}/${sources.length}` : '';
    };
    const button = (text: string, label: string, action: () => void) => {
      const el = document.createElement('button');
      el.type = 'button'; el.textContent = text; el.setAttribute('aria-label', label);
      el.addEventListener('click', event => { event.stopPropagation(); action(); });
      return el;
    };
    if (sources.length > 1) {
      const previous = button('‹', '上一张', () => { index = (index + sources.length - 1) % sources.length; paint(); });
      previous.className = 'fmp-preview-prev';
      const next = button('›', '下一张', () => { index = (index + 1) % sources.length; paint(); });
      next.className = 'fmp-preview-next';
      layer.append(previous, next);
    }
    const dismiss = button('×', '关闭', close);
    dismiss.className = 'fmp-preview-close';
    layer.append(content, position, dismiss);
    layer.addEventListener('click', event => { if (event.target === layer || event.target === content) close(); });
    this.contextCleanups.add(close);
    paint();
    this.host.overlay().appendChild(layer);
  }

  private backgroundManager() {
    this.assertOpen();
    return (this.background ??= this.createBackground());
  }

  private legacyBackgroundListener(name: string, callback: Listener) {
    this.backgroundManager();
    this.backgroundListenLegacy!(name, callback);
  }

  private createBackground() {
    const audio = new Audio();
    audio.loop = false;
    let stopped = true;
    let playback = 0;
    let startTime = 0;
    let source = '';
    let loadedSource = '';
    let playbackRate = 1;
    let progressTime = 0;
    let pending: Record<string, any> = {};
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    const metadata: Record<string, any> = { title: '', coverImgUrl: '', epname: undefined, singer: undefined, webUrl: undefined, protocol: undefined, referrerPolicy: '', referrerPath: '', audioType: undefined };
    const listeners = new Map<string, Map<'manager' | 'legacy', Listener>>();
    const emit = (name: string, payload: any) => {
      if (this.disposed) return;
      for (const callback of Array.from(listeners.get(name)?.values() ?? [])) deliver(callback, payload);
    };
    const on = (name: string, callback: Listener, scope: 'manager' | 'legacy' = 'manager') => {
      let scopes = listeners.get(name);
      if (!scopes) {
        scopes = new Map();
        listeners.set(name, scopes);
      }
      scopes.set(scope, callback);
    };
    const off = (name: string, callback?: Listener) => {
      const scopes = listeners.get(name);
      if (!callback || scopes?.get('manager') === callback) scopes?.delete('manager');
    };
    this.backgroundListenLegacy = (name, callback) => {
      on(name, callback, 'legacy');
      if (name === 'stop') on('ended', callback, 'legacy');
    };

    audio.addEventListener('play', () => {
      if (!stopped) emit('play', {});
    });
    audio.addEventListener('ended', () => {
      stopped = true;
      emit('ended', {});
    });
    audio.addEventListener('waiting', () => emit('waiting', {}));
    audio.addEventListener('seeking', () => emit('seeking', {}));
    audio.addEventListener('seeked', () => emit('seeked', {}));
    audio.addEventListener('loadedmetadata', () => {
      const time = Number(startTime);
      if (!this.disposed && Number.isFinite(time) && time > 0) audio.currentTime = time;
    });
    audio.addEventListener('canplay', () => emit('canplay', {}));
    audio.addEventListener('timeupdate', () => {
      const currentTime = audio.currentTime;
      if (currentTime === progressTime) return;
      progressTime = currentTime;
      if (typeof document === 'undefined' || !document.hidden) emit('timeUpdate', currentTime);
    });
    audio.addEventListener('error', () => emit('error', { errMsg: 'background audio error' }));

    const play = async (nextSource?: string, legacyMetadata?: { title: any; coverImgUrl: any }) => {
      if (this.disposed) return;
      if (legacyMetadata) Object.assign(metadata, legacyMetadata);
      const request = ++playback;
      if (nextSource !== undefined) {
        source = loadedSource = nextSource;
        audio.src = nextSource;
      }
      stopped = false;
      try {
        await audio.play();
      } catch (error) {
        if (request === playback) stopped = true;
        throw error;
      }
    };
    this.backgroundPlay = play;
    this.backgroundState = () => {
      if (stopped || !audio.src) return { status: 2 };
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      const buffered = audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0;
      return {
        status: audio.paused ? 0 : 1,
        currentPosition: audio.currentTime,
        duration,
        downloadPercent: duration > 0 ? Math.max(0, Math.min(100, (buffered / duration) * 100)) : 0,
        dataUrl: audio.src
      };
    };
    const commit = () => {
      commitTimer = null;
      const changes = pending;
      pending = {};
      if (this.disposed) return;
      for (const [name, value] of Object.entries(changes)) {
        if (name === 'src') source = value;
        else if (name === 'startTime') startTime = value;
        else if (name === 'playbackRate') playbackRate = value;
        else metadata[name] = value;
      }
      if (!source || !metadata.title) return;
      audio.defaultPlaybackRate = playbackRate;
      audio.playbackRate = playbackRate;
      if (source !== loadedSource) void play(source).catch(error => emit('error', { errMsg: error?.message ?? 'background audio error' }));
    };
    const stage = (name: string, value: any) => {
      if (this.disposed) return;
      pending[name] = value;
      if (commitTimer === null) commitTimer = setTimeout(commit, 0);
    };
    const manager: any = {
      play: () => void play().catch(error => emit('error', { errMsg: error?.message ?? 'background audio error' })),
      pause: () => {
        if (this.disposed || stopped || audio.paused) return;
        audio.pause();
        // Native pause events can arrive after stop and the next play have already run.
        emit('pause', {});
      },
      stop: () => {
        if (this.disposed) return;
        playback++;
        stopped = true;
        audio.pause();
        audio.currentTime = 0;
        emit('stop', {});
      },
      seek: (time: number) => {
        if (typeof time !== 'number') throw new Error(`BackgroundAudioManager.seek(currentTime): unexpected type ${typeof time}`);
        if (!this.disposed) audio.currentTime = Number.isFinite(time) ? Math.max(0, time) : 0;
      },
      onCanplay: (cb: Listener) => on('canplay', cb),
      onPlay: (cb: Listener) => on('play', cb),
      onPause: (cb: Listener) => on('pause', cb),
      onStop: (cb: Listener) => on('stop', cb),
      onEnded: (cb: Listener) => on('ended', cb),
      onTimeUpdate: (cb: Listener) => {
        progressTime = audio.currentTime;
        on('timeUpdate', cb);
      },
      onError: (cb: Listener) => on('error', cb),
      onWaiting: (cb: Listener) => on('waiting', cb),
      onSeeking: (cb: Listener) => on('seeking', cb),
      onSeeked: (cb: Listener) => on('seeked', cb),
      onNext: (cb: Listener) => on('next', cb),
      onPrev: (cb: Listener) => on('prev', cb),
      offCanplay: (cb?: Listener) => off('canplay', cb),
      offPlay: (cb?: Listener) => off('play', cb),
      offPause: (cb?: Listener) => off('pause', cb),
      offStop: (cb?: Listener) => off('stop', cb),
      offEnded: (cb?: Listener) => off('ended', cb),
      offTimeUpdate: (cb?: Listener) => off('timeUpdate', cb),
      offError: (cb?: Listener) => off('error', cb),
      offWaiting: (cb?: Listener) => off('waiting', cb),
      offSeeking: (cb?: Listener) => off('seeking', cb),
      offSeeked: (cb?: Listener) => off('seeked', cb),
      offNext: (cb?: Listener) => off('next', cb),
      offPrev: (cb?: Listener) => off('prev', cb)
    };
    for (const name of Object.keys(metadata)) {
      Object.defineProperty(manager, name, {
        get: () => metadata[name],
        set: (value: any) => {
          if (this.disposed) return;
          if (name === 'referrerPath') {
            if (typeof value === 'string' && value.trim()) stage(name, value.trim().replace(/(\?|$)/, '.html$1'));
          } else stage(name, value);
        }
      });
    }
    Object.defineProperties(manager, {
      src: {
        get: () => source,
        set: (value: string) => {
          if (this.disposed) return;
          if (!value) throw new Error(`invalid BackgroundAudioManager.src: ${value}`);
          stage('src', value);
        }
      },
      startTime: {
        get: () => startTime,
        set: (value: number) => { stage('startTime', value); }
      },
      playbackRate: {
        get: () => playbackRate,
        set: (value: number) => { stage('playbackRate', value); }
      },
      currentTime: { get: () => audio.currentTime, set() {} },
      duration: { get: () => (Number.isFinite(audio.duration) ? audio.duration : 0), set() {} },
      paused: { get: () => audio.paused, set() {} },
      buffered: { get: () => (audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0), set() {} }
    });
    this.backgroundCleanup = () => {
      stopped = true;
      playback++;
      if (commitTimer !== null) clearTimeout(commitTimer);
      commitTimer = null;
      pending = {};
      listeners.clear();
      this.backgroundListenLegacy = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
    return manager;
  }

  private recordLegacy() {
    if (this.legacyRecording) throw new Error('already recording');
    const manager = (this.recorderManager ??= this.createRecorder());
    return new Promise<{ tempFilePath: string }>((resolve, reject) => {
      const cleanup = () => {
        this.recorderLegacyCallbacks = {};
        if (this.legacyRecording === session) this.legacyRecording = null;
      };
      const started = () => {
        session.started = true;
      };
      const stopped = (result: any) => {
        cleanup();
        resolve({ tempFilePath: result.tempFilePath });
      };
      const failed = (error: any) => {
        cleanup();
        reject(new Error(error?.errMsg ?? error?.message ?? 'record failed'));
      };
      const session = {
        started: false,
        cancel: (error: Error) => {
          cleanup();
          reject(error);
        }
      };
      this.legacyRecording = session;
      this.recorderLegacyCallbacks = { Start: started, Stop: stopped, Error: failed };
      manager.start({ duration: 60000 });
    });
  }

  private createRecorder() {
    const manager: any = {};
    let starting = false;
    const emit = (name: string, ...args: any[]) => {
      if (this.disposed) return;
      const callbacks = [this.recorderCallbacks[name], this.recorderLegacyCallbacks[name]];
      for (const callback of callbacks) deliver(callback, ...args);
    };
    const store = (name: string) => (callback: Listener) => {
      this.recorderCallbacks[name] = callback;
    };

    manager.start = (options: any = {}) => {
      if (this.disposed) return;
      options = { format: 'aac', sampleRate: 8000, encodeBitRate: 48000, numberOfChannels: 2, audioSource: 'auto', ...options };
      const rates = typeof options.sampleRate === 'number' ? RECORDING_BIT_RATES[options.sampleRate] : undefined;
      if (!rates) throw new Error(`invalid sampleRate "${options.sampleRate}", sampleRate should be one of ${JSON.stringify(Object.keys(RECORDING_BIT_RATES))}`);
      if (options.encodeBitRate < rates[0] || options.encodeBitRate > rates[1]) {
        throw new Error(`invalid encodeBitRate "${options.encodeBitRate}", encodeBitRate should be greater than ${rates[0]} and less than ${rates[1]}`);
      }
      if (starting || (this.recorder && this.recorder.state !== 'inactive')) {
        emit('Error', { errMsg: 'record start failed: already recording' });
        return;
      }
      starting = true;
      const generation = ++this.recorderGeneration;
      void (async () => {
        let stream: MediaStream | undefined;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (this.disposed || generation !== this.recorderGeneration) {
            stream.getTracks().forEach(track => track.stop());
            return;
          }
          starting = false;
          const pcm = options.format === 'wav' || options.format === 'PCM' || options.format === 'mp3';
          const aac = options.format === 'aac' && (typeof AudioContext === 'function' || typeof (globalThis as any).webkitAudioContext === 'function') && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(AAC_MEDIA_TYPE);
          const mime = pcm || aac ? '' : MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/mp4')
              ? 'audio/mp4'
              : '';
          const chunks: Blob[] = [];
          const recorder = aac ? new AacRecorder(stream, options) : pcm ? new PcmRecorder(stream, options) : new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
          this.recorder = recorder;
          this.recorderStream = stream;
          const startedAt = Date.now();
          let pausedAt: number | null = null;
          let pausedDuration = 0;
          let timer: ReturnType<typeof setTimeout> | null = null;
          let frames = Promise.resolve();
          let pending = new Uint8Array(0);
          const frameSize = options.format === 'wav' ? 0 : Math.max(0, Math.round(Number(options.frameSize ?? 0) * 1024));
          const flushFrames = (last: boolean) => {
            if (!frameSize) return;
            while (pending.length >= frameSize || (last && pending.length)) {
              const length = Math.min(frameSize, pending.length);
              const frame = pending.slice(0, length).buffer;
              pending = pending.slice(length);
              emit('FrameRecorded', { frameBuffer: frame, isLastFrame: last && pending.length === 0 });
            }
          };
          recorder.ondataavailable = (event: { data: Blob }) => {
            if (!event.data.size || this.disposed) return;
            chunks.push(event.data);
            if (!frameSize) return;
            const last = recorder.state === 'inactive';
            frames = frames.then(async () => {
              const bytes = new Uint8Array(await event.data.arrayBuffer());
              const merged = new Uint8Array(pending.length + bytes.length);
              merged.set(pending);
              merged.set(bytes, pending.length);
              pending = merged;
              flushFrames(last);
            });
          };
          recorder.onstart = () => emit('Start');
          recorder.onpause = () => {
            pausedAt = Date.now();
            emit('Pause');
          };
          recorder.onresume = () => {
            if (pausedAt !== null) pausedDuration += Date.now() - pausedAt;
            pausedAt = null;
            emit('Resume');
          };
          recorder.onerror = (event: any) => emit('Error', { errMsg: event?.error?.message ?? 'record error' });
          recorder.onstop = () => {
            if (timer) clearTimeout(timer);
            if (this.recorderTimer === timer) this.recorderTimer = null;
            stream!.getTracks().forEach(track => track.stop());
            if (this.recorderStream === stream) this.recorderStream = null;
            const duration = recorder instanceof PcmRecorder || recorder instanceof AacRecorder ? recorder.duration : Math.max(0, Date.now() - startedAt - pausedDuration - (pausedAt === null ? 0 : Date.now() - pausedAt));
            void frames
              .then(() => {
                if (this.disposed) return;
                flushFrames(true);
                const blob = new Blob(chunks, { type: chunks[0]?.type ?? recorder.mimeType ?? 'audio/webm' });
                const extension = aac ? 'aac' : options.format === 'wav' ? 'wav' : options.format === 'PCM' ? 'pcm' : options.format === 'mp3' ? 'mp3' : 'webm';
                const record = addTempFile(blob, `record.${extension}`);
                emit('Stop', { tempFilePath: record.path, duration, fileSize: blob.size });
              })
              .catch(error => emit('Error', { errMsg: error?.message ?? 'record data failed' }));
          };
          await recorder.start(frameSize ? 100 : undefined);
          if (this.disposed || generation !== this.recorderGeneration || recorder.state === 'inactive') return;
          timer = setTimeout(
            () => {
              if (this.recorder === recorder && recorder.state !== 'inactive') manager.stop();
            },
            Math.min(600000, Math.max(1, numberOr(options.duration, 60000)))
          );
          this.recorderTimer = timer;
        } catch (error: any) {
          stream?.getTracks().forEach(track => track.stop());
          if (generation === this.recorderGeneration) {
            starting = false;
            emit('Error', { errMsg: error?.message ?? 'record start failed' });
          }
        }
      })();
    };
    manager.pause = () => this.recorder?.state === 'recording' && this.recorder.pause();
    manager.resume = () => this.recorder?.state === 'paused' && this.recorder.resume();
    manager.stop = () => {
      starting = false;
      this.recorderGeneration++;
      if (this.recorderTimer) clearTimeout(this.recorderTimer);
      this.recorderTimer = null;
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    };

    for (const name of ['Start', 'Pause', 'Resume', 'Stop', 'Error', 'FrameRecorded', 'InterruptionBegin', 'InterruptionEnd']) {
      manager[`on${name}`] = store(name);
      manager[`off${name}`] = (callback?: Listener) => {
        if (!callback || this.recorderCallbacks[name] === callback) delete this.recorderCallbacks[name];
      };
    }
    return manager;
  }

  private createCamera() {
    const root = this.pageRoot();
    let camera = this.cameras.get(root);
    if (!camera || camera.disposed) {
      const created = new BrowserCamera(root, () => {
        if (this.cameras.get(root) === created) this.cameras.delete(root);
      });
      camera = created;
      this.cameras.set(root, camera);
    }
    if (this.disposed) camera.dispose();
    return camera.api();
  }

  private createLive(tag: string, id: string) {
    const root = this.pageRoot();
    const el = root.querySelector(`${tag}#${CSS.escape(id)}`) ?? root.querySelector(tag);
    const video = el?.querySelector('video') ?? null;
    const result: any = {
      play: () => void video?.play().catch(() => undefined),
      pause: () => video?.pause(),
      stop: () => {
        if (video) {
          video.pause();
          video.currentTime = 0;
        }
        video?.removeAttribute('src');
      },
      mute: () => video && (video.muted = true),
      unmute: () => video && (video.muted = false),
      requestFullScreen: (options: any) => {
        void video?.requestFullscreen?.().catch(() => undefined);
        options?.success?.({});
      },
      exitFullScreen: (options: any) => {
        if (document.fullscreenElement) void document.exitFullscreen();
        options?.success?.({});
      },
      snapshot: (options: any) =>
        this.call('LivePlayerContext.snapshot', options, () => {
          if (!video) throw new Error('live player is not found');
          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          canvas.getContext('2d')!.drawImage(video, 0, 0);
          return { tempImagePath: addTempFile(dataUrlToBlob(canvas.toDataURL())).path };
        }),
      onStateChange: (callback: Listener) => video?.addEventListener('statechange', () => callback({})),
      offStateChange: () => undefined
    };
    return result;
  }
}

function downloadBlob(blob: Blob, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, data] = dataUrl.split(',');
  const type = /:(.*?);/.exec(meta)?.[1] ?? 'image/png';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

export { showActionSheet };
