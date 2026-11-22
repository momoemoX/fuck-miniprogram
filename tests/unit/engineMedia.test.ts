import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaApi } from '../../packages/engine/src/runtime/api/media';
import { clearTempFiles, getTempFile } from '../../packages/engine/src/runtime/api/temp-files';

let media: MediaApi;
let api: any;
let track: { readyState: string; stop(): void };
let stream: any;
let recorders: FakeRecorder[];
let audios: FakeAudio[];

class FakeRecorder {
  static isTypeSupported() {
    return true;
  }
  state = 'inactive';
  onstart: any;
  onpause: any;
  onresume: any;
  onstop: any;
  ondataavailable: any;
  constructor() {
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
    this.onstart?.();
  }
  pause() {
    this.state = 'paused';
    this.onpause?.();
  }
  resume() {
    this.state = 'recording';
    this.onresume?.();
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

class FakeAudio extends EventTarget {
  paused = true;
  src = '';
  currentTime = 0;
  duration = 0;
  buffered = { length: 0 };
  constructor() {
    super();
    audios.push(this);
  }
  play() {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  recorders = [];
  audios = [];
  track = {
    readyState: 'live',
    stop() {
      this.readyState = 'ended';
    }
  };
  stream = { getTracks: () => [track] };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve(stream) } });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('Audio', FakeAudio);
  media = new MediaApi({} as any);
  api = media.api();
});

afterEach(() => {
  media.dispose();
  clearTempFiles();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('媒体管理器的状态与应用生命周期', () => {
  it('应用级音频中断事件注册触发与移除走宿主总线', () => {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    const bus = {
      on: (name: string, callback: (...args: any[]) => void) => (listeners[name] ??= []).push(callback),
      off: (name: string, callback?: (...args: any[]) => void) => {
        if (!callback) delete listeners[name];
        else {
          const list = listeners[name] ?? [], index = list.indexOf(callback);
          if (index >= 0) list.splice(index, 1);
        }
      },
      emit: (name: string, ...args: any[]) => (listeners[name] ?? []).forEach(callback => callback(...args))
    };
    const local = new MediaApi(bus as any).api();
    const begin: any[] = [], end: any[] = [];
    const onBegin = (res: any) => begin.push(res), onEnd = (res: any) => end.push(res);
    local.onAudioInterruptionBegin(onBegin);
    local.onAudioInterruptionEnd(onEnd);
    bus.emit('audioInterruptionBegin', {});
    bus.emit('audioInterruptionEnd', {});
    bus.emit('audioInterruptionBegin', {});
    expect(begin).toEqual([{}, {}]);
    expect(end).toEqual([{}]);
    local.offAudioInterruptionBegin(onBegin);
    local.offAudioInterruptionEnd(onEnd);
    bus.emit('audioInterruptionBegin', {});
    bus.emit('audioInterruptionEnd', {});
    expect(begin).toEqual([{}, {}]);
    expect(end).toEqual([{}]);
  });

  function pickerScene() {
    const inputs: any[] = [];
    const body: any = { appendChild: (input: any) => inputs.push(input) };
    vi.stubGlobal('document', {
      body,
      createElement: () => {
        const input: any = new EventTarget();
        input.style = {};
        input.files = [];
        input.click = vi.fn();
        input.setAttribute = vi.fn();
        input.remove = () => {
          const index = inputs.indexOf(input);
          if (index >= 0) inputs.splice(index, 1);
        };
        return input;
      }
    });
    return inputs;
  }

  for (const name of ['chooseImage', 'chooseMedia', 'chooseVideo', 'chooseMessageFile']) {
    it(`${name} 在应用销毁后移除未完成选取器并停止旧回调`, async () => {
      const inputs = pickerScene(),
        events: string[] = [];
      api[name]({ success: () => events.push('success'), fail: () => events.push('fail'), complete: () => events.push('complete') });
      expect(inputs).toHaveLength(1);
      const input = inputs[0];
      media.dispose();
      input.dispatchEvent(new Event('cancel'));
      await vi.advanceTimersByTimeAsync(0);
      expect(inputs).toHaveLength(0);
      expect(events).toEqual([]);
    });
  }

  it('用户取消文件选取时移除输入节点并只报告一次取消', async () => {
    const inputs = pickerScene(),
      events: string[] = [];
    api.chooseImage({ fail: (result: any) => events.push(result.errMsg), complete: () => events.push('complete') });
    const input = inputs[0];
    input.dispatchEvent(new Event('cancel'));
    input.dispatchEvent(new Event('change'));
    await vi.advanceTimersByTimeAsync(0);
    expect(inputs).toHaveLength(0);
    expect(events).toEqual(['chooseImage:fail cancel', 'complete']);
  });

  it('图片选取限制返回数量且保留官方文件字段', async () => {
    const inputs = pickerScene();
    const picked = api.chooseImage({ count: 2, sourceType: ['camera'], sizeType: ['original'] });
    const input = inputs[0];
    expect(input.setAttribute).toHaveBeenCalledWith('capture', 'environment');
    input.files = [1, 2, 3].map(index => new File(['image'], `${index}.png`, { type: 'image/png' }));
    input.dispatchEvent(new Event('change'));
    const result = await picked;
    expect(result.tempFiles).toHaveLength(2);
    expect(result.tempFiles.map((file: any) => Object.keys(file).sort())).toEqual([
      ['path', 'size'],
      ['path', 'size']
    ]);
    expect(result.tempFilePaths).toEqual(result.tempFiles.map((file: any) => file.path));
  });

  it('会话文件选取按数量类型和扩展名返回标准文件类型', async () => {
    const inputs = pickerScene();
    const picked = api.chooseMessageFile({ count: 1, type: 'file', extension: ['txt', '.json'] });
    const input = inputs[0];
    expect(input.accept).toBe('.txt,.json');
    input.files = [new File(['text'], 'readme.txt', { type: 'text/plain' }), new File(['json'], 'data.json', { type: 'application/json' })];
    input.dispatchEvent(new Event('change'));
    const result = await picked;
    expect(result.tempFiles).toHaveLength(1);
    expect(result.tempFiles[0]).toMatchObject({ name: 'readme.txt', type: 'file', size: 4 });
  });

  it('应用销毁中断未完成的图片和视频元数据加载并停止旧回调', async () => {
    const images: any[] = [],
      videos: any[] = [],
      events: string[] = [];
    class PendingImage {
      src = '';
      onload: any;
      onerror: any;
      constructor() {
        images.push(this);
      }
      removeAttribute() {
        this.src = '';
      }
    }
    vi.stubGlobal('Image', PendingImage);
    vi.stubGlobal('document', {
      createElement: () => {
        const video: any = {
          src: '',
          pause: vi.fn(),
          load: vi.fn(),
          removeAttribute() {
            this.src = '';
          }
        };
        videos.push(video);
        return video;
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['video']) }))
    );
    api.getImageInfo({ src: 'https://media.test/slow.png', success: () => events.push('image'), fail: () => events.push('image-fail') });
    api.getVideoInfo({ src: 'https://media.test/slow.mp4', success: () => events.push('video'), fail: () => events.push('video-fail') });
    await vi.advanceTimersByTimeAsync(0);
    expect(images).toHaveLength(1);
    expect(videos).toHaveLength(1);
    media.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(images[0].src).toBe('');
    expect(videos[0].src).toBe('');
    expect(images[0].onload).toBe(null);
    expect(videos[0].onloadedmetadata).toBe(null);
    expect(events).toEqual([]);
  });

  it('图片压缩失败时仍释放已经解码的位图', async () => {
    const bitmap = { width: 10, height: 20, close: vi.fn() };
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap)
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image']) }))
    );
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ({
          drawImage() {
            throw new Error('encode failed');
          }
        })
      })
    });
    await expect(api.compressImage({ src: 'https://media.test/image' })).rejects.toMatchObject({
      errMsg: expect.stringContaining('encode failed')
    });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  function cameraScene() {
    const video: any = { srcObject: null, videoWidth: 2, videoHeight: 1, play: () => Promise.resolve(), pause: vi.fn() };
    const holder: any = {
      isConnected: true,
      querySelector: () => video,
      appendChild: vi.fn(),
      matches: (selector: string) => selector === 'wx-camera'
    };
    const root: any = { querySelector: () => holder, querySelectorAll: () => [holder] };
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('document', {
      body: root,
      createElement: (tag: string) =>
        tag === 'video'
          ? video
          : {
              width: 0,
              height: 0,
              getContext: () => ({
                drawImage() {},
                getImageData: () => ({ data: new Uint8ClampedArray([0, 255, 0, 255, 0, 255, 0, 255]) })
              }),
              toBlob: (callback: (blob: Blob) => void) => callback(new Blob(['photo'], { type: 'image/jpeg' }))
            }
    });
    media.dispose();
    media = new MediaApi({ pageElement: () => root, on: vi.fn(), off: vi.fn() } as any);
    api = media.api();
    return { video, holder, frames, camera: api.createCameraContext() };
  }

  it('相机帧监听注册后保持停止状态并支持显式启动和停止', async () => {
    const { camera, frames } = cameraScene();
    const acquire = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: acquire } });
    const values: any[] = [];
    const listener = camera.onCameraFrame((frame: any) => values.push(frame));
    expect(acquire).not.toHaveBeenCalled();
    expect(typeof listener.start).toBe('function');
    await listener.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(values).toEqual([{ data: new Uint8Array([0, 255, 0, 255, 0, 255, 0, 255]).buffer, width: 2, height: 1 }]);
    await listener.stop();
    expect(frames.size).toBe(0);
  });

  it('相机权限迟到时应用销毁释放音轨且不发送拍照回调', async () => {
    const { camera, video } = cameraScene();
    let allow: (value: any) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise(resolve => {
            allow = resolve;
          })
      }
    });
    const events: any[] = [];
    camera.takePhoto({ success: () => events.push('success'), fail: () => events.push('fail'), complete: () => events.push('complete') });
    media.dispose();
    allow!(stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(track.readyState).toBe('ended');
    expect(video.srcObject).toBe(null);
    expect(events).toEqual([]);
  });

  it('相机重复录像失败且结束录像保留预览并返回独立缩略图', async () => {
    const { camera, video } = cameraScene();
    await camera.startRecord({});
    await expect(camera.startRecord({})).rejects.toMatchObject({ errMsg: expect.stringContaining('already recording') });
    const result = await camera.stopRecord({});
    expect(getTempFile(result.tempVideoPath)!.blob.type).toBe('video/webm');
    expect(getTempFile(result.tempThumbPath)!.blob.type).toBe('image/jpeg');
    expect(result.tempThumbPath).not.toBe(result.tempVideoPath);
    expect(video.srcObject).toBe(stream);
    expect(track.readyState).toBe('live');
    await camera.startRecord({});
    media.dispose();
    expect(recorders.every(recorder => recorder.state === 'inactive')).toBe(true);
    expect(track.readyState).toBe('ended');
  });

  it('相机缩放使用设备能力范围并报告实际缩放级别', async () => {
    const { camera } = cameraScene();
    const applyConstraints = vi.fn(async () => {});
    (stream as any).getVideoTracks = () => [{ getCapabilities: () => ({ zoom: { min: 1, max: 3 } }), applyConstraints }];
    expect(await camera.setZoom({ zoom: 2.14 })).toMatchObject({ zoom: 2.1 });
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 2.1 }] });
    await expect(camera.setZoom({ zoom: 4 })).rejects.toMatchObject({ errMsg: expect.stringContaining('out of range') });
    expect(applyConstraints).toHaveBeenCalledTimes(1);
  });

  it('并发相机操作共用权限请求且销毁后停止帧循环并释放预览', async () => {
    const { camera, video, frames } = cameraScene();
    const acquire = vi.fn(async () => stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: acquire } });
    const listener = camera.onCameraFrame(vi.fn());
    expect(typeof listener.start).toBe('function');
    const started = listener.start();
    const photo = camera.takePhoto({});
    await Promise.all([started, photo]);
    expect(acquire).toHaveBeenCalledTimes(1);
    media.dispose();
    expect(frames.size).toBe(0);
    expect(track.readyState).toBe('ended');
    expect(video.srcObject).toBe(null);
  });

  it('相机预览节点在权限返回前移除时释放迟到的音轨', async () => {
    const { camera, holder, video } = cameraScene();
    let allow: (value: any) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise(resolve => {
            allow = resolve;
          })
      }
    });
    const result = camera.takePhoto({});
    holder.isConnected = false;
    allow!(stream);
    await expect(result).rejects.toMatchObject({ errMsg: expect.stringContaining('fail') });
    expect(track.readyState).toBe('ended');
    expect(video.srcObject).toBe(null);
  });

  it('录音管理器在同一应用内保持唯一实例', () => {
    expect(api.getRecorderManager()).toBe(api.getRecorderManager());
  });

  it('音频输入源返回可用于录音的模式且调用者修改不污染后续查询', async () => {
    const result = await api.getAvailableAudioSources();
    expect(result.errMsg).toBe('getAvailableAudioSources:ok');
    expect(result.audioSources).toContain('auto');
    const allowed = ['auto', 'buildInMic', 'headsetMic', 'mic', 'camcorder', 'voice_communication', 'voice_recognition'];
    expect(result.audioSources.every((source: string) => allowed.includes(source))).toBe(true);
    result.audioSources.push('changed');
    expect((await api.getAvailableAudioSources()).audioSources).not.toContain('changed');
  });

  it('音频输入源查询不申请麦克风权限', async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    expect((await api.getAvailableAudioSources()).audioSources).toEqual(['auto']);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  for (const missing of ['capture', 'encoder']) {
    it(`浏览器缺少 ${missing} 时不报告可用录音输入源`, async () => {
      if (missing === 'capture') vi.stubGlobal('navigator', {});
      else vi.stubGlobal('MediaRecorder', undefined);
      expect((await api.getAvailableAudioSources()).audioSources).toEqual([]);
    });
  }

  it('旧录音进行中替换管理器监听不会覆盖旧接口的完成通知', async () => {
    const manager = api.getRecorderManager(), events: string[] = [];
    manager.onStart(() => events.push('start-first'));
    manager.onStart(() => events.push('start-last'));
    const recording = api.startRecord({});
    await vi.advanceTimersByTimeAsync(0);
    manager.onStop(() => events.push('stop-first'));
    manager.onStop(() => events.push('stop-last'));
    await api.stopRecord({});
    await expect(recording).resolves.toMatchObject({ tempFilePath: expect.any(String) });
    expect(events).toEqual(['start-last', 'stop-last']);
  });

  it('旧录音接口在结束后返回实际临时文件并释放麦克风', async () => {
    const events: string[] = [];
    let recording: any;
    api.startRecord({
      success: (result: any) => {
        recording = result;
        events.push('recorded');
      },
      complete: () => events.push('complete')
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(recorders).toHaveLength(1);
    await api.stopRecord({});
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['recorded', 'complete']);
    expect(await getTempFile(recording.tempFilePath)!.blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(track.readyState).toBe('ended');
  });

  it('旧录音达到一分钟后完成并允许再次开始且拒绝并发录音', async () => {
    const recording = api.startRecord({});
    await expect(api.startRecord({})).rejects.toMatchObject({ errMsg: expect.stringContaining('already recording') });
    await vi.advanceTimersByTimeAsync(60000);
    expect(await recording).toMatchObject({ tempFilePath: expect.any(String) });
    expect(track.readyState).toBe('ended');
    const next = api.startRecord({});
    await vi.advanceTimersByTimeAsync(0);
    await api.stopRecord({});
    expect(await next).toMatchObject({ tempFilePath: expect.any(String) });
    expect(recorders).toHaveLength(2);
  });

  it('停止或销毁等待权限的旧录音会释放迟到音轨并停止旧回调', async () => {
    let allow: (value: any) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise(resolve => {
            allow = resolve;
          })
      }
    });
    const events: string[] = [];
    api.startRecord({ success: () => events.push('success'), fail: () => events.push('fail') });
    media.dispose();
    allow!(stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(track.readyState).toBe('ended');
    expect(events).toEqual([]);
    expect(recorders).toHaveLength(0);
  });

  it('录音管理器发送开始暂停恢复和停止事件并返回毫秒时长与字节大小', async () => {
    const recorder = api.getRecorderManager();
    const events: string[] = [];
    let result: any;
    recorder.onStart(() => events.push('start'));
    recorder.onPause(() => events.push('pause'));
    recorder.onResume(() => events.push('resume'));
    recorder.onStop((value: any) => {
      result = value;
      events.push('stop');
    });
    recorder.start();
    await vi.advanceTimersByTimeAsync(0);
    recorder.pause();
    recorder.resume();
    await vi.advanceTimersByTimeAsync(1250);
    recorder.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['start', 'pause', 'resume', 'stop']);
    expect(result).toMatchObject({ duration: 1250, fileSize: 3 });
    expect(await getTempFile(result.tempFilePath)!.blob.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(track.readyState).toBe('ended');
  });

  it('录音分片回调返回 ArrayBuffer 并标记最后一帧', async () => {
    const recorder = api.getRecorderManager();
    const frames: any[] = [];
    recorder.onFrameRecorded(() => frames.push('stale'));
    recorder.onFrameRecorded((value: any) => frames.push(value));
    recorder.start({ frameSize: 1 });
    await vi.advanceTimersByTimeAsync(0);
    recorder.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([{ frameBuffer: new Uint8Array([1, 2, 3]).buffer, isLastFrame: true }]);
  });

  it('录音错误只通知最新监听且重复启动不申请第二路麦克风', async () => {
    const recorder = api.getRecorderManager(), errors: any[] = [];
    recorder.onError(() => errors.push('stale'));
    recorder.onError((value: any) => errors.push(value));
    recorder.start();
    await vi.advanceTimersByTimeAsync(0);
    recorder.start();
    expect(errors).toEqual([{ errMsg: 'record start failed: already recording' }]);
    expect(recorders).toHaveLength(1);
  });

  it('录音停止后旧时限不会终止随后开始的新录音', async () => {
    const recorder = api.getRecorderManager();
    recorder.start({ duration: 100 });
    await vi.advanceTimersByTimeAsync(50);
    recorder.stop();
    recorder.start({ duration: 1000 });
    await vi.advanceTimersByTimeAsync(50);
    expect(recorders[1].state).toBe('recording');
    await vi.advanceTimersByTimeAsync(950);
    expect(recorders[1].state).toBe('inactive');
  });

  for (const action of ['stop', 'dispose']) {
    it(`录音权限请求未返回时 ${action} 会释放迟到的麦克风并停止回调`, async () => {
      let allow: (value: any) => void;
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => (allow = resolve)) } });
      const recorder = api.getRecorderManager();
      const events: string[] = [];
      recorder.onStart(() => events.push('start'));
      recorder.onError(() => events.push('error'));
      recorder.start();
      if (action === 'stop') recorder.stop();
      else media.dispose();
      allow!(stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(recorders).toEqual([]);
      expect(track.readyState).toBe('ended');
      expect(events).toEqual([]);
    });
  }

  it('应用销毁停止暂停中的录音并释放麦克风且不发送旧回调', async () => {
    const recorder = api.getRecorderManager();
    const events: string[] = [];
    recorder.onStop(() => events.push('stop'));
    recorder.start();
    await vi.advanceTimersByTimeAsync(0);
    recorder.pause();
    media.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(recorders[0].state).toBe('inactive');
    expect(track.readyState).toBe('ended');
    expect(events).toEqual([]);
  });

  it('背景音频提交地址和标题后播放并在应用销毁时释放资源', async () => {
    const background = api.getBackgroundAudioManager();
    const events: string[] = [];
    background.onPause(() => events.push('pause'));
    background.title = 'song';
    background.src = 'https://media.test/song.mp3';
    expect(background.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(background.paused).toBe(false);
    media.dispose();
    expect(background.paused).toBe(true);
    expect(audios[0].src).toBe('');
    expect(events).toEqual([]);
  });

  it('旧版背景音频与管理器共享播放、暂停、定位和停止状态', async () => {
    await expect(api.getBackgroundAudioPlayerState()).rejects.toEqual({ errMsg: 'getBackgroundAudioPlayerState: fail not playing' });
    const manager = api.getBackgroundAudioManager();
    const events: string[] = [];
    api.onBackgroundAudioPlay(() => events.push('legacy-play'));
    api.onBackgroundAudioPause(() => events.push('legacy-pause'));
    api.onBackgroundAudioStop(() => events.push('legacy-stop'));
    manager.onPlay(() => events.push('manager-play'));
    manager.onPause(() => events.push('manager-pause'));
    manager.onStop(() => events.push('manager-stop'));
    await api.playBackgroundAudio({ dataUrl: 'https://media.test/song.mp3', title: 'song', coverImgUrl: 'cover.png' });
    expect(manager.src).toBe('https://media.test/song.mp3');
    expect(manager.title).toBe('song');
    expect(manager.coverImgUrl).toBe('cover.png');
    audios[0].duration = 90;
    audios[0].buffered = { length: 1, end: () => 45 } as any;
    await api.seekBackgroundAudio({ position: 11.25 });
    expect(await api.getBackgroundAudioPlayerState()).toEqual({
      errMsg: 'getBackgroundAudioPlayerState:ok',
      status: 1,
      currentPosition: 11.25,
      duration: 90,
      downloadPercent: 50,
      dataUrl: 'https://media.test/song.mp3'
    });
    await api.pauseBackgroundAudio();
    expect((await api.getBackgroundAudioPlayerState()).status).toBe(0);
    manager.play();
    await api.stopBackgroundAudio();
    expect(manager.currentTime).toBe(0);
    await expect(api.getBackgroundAudioPlayerState()).rejects.toEqual({ errMsg: 'getBackgroundAudioPlayerState: fail not playing' });
    expect(events).toEqual([
      'legacy-play',
      'manager-play',
      'legacy-pause',
      'manager-pause',
      'legacy-play',
      'manager-play',
      'legacy-stop',
      'manager-stop'
    ]);
  });

  it('旧版背景音频的播放失败进入 fail 和 complete', async () => {
    const manager = api.getBackgroundAudioManager();
    audios[0].play = () => Promise.reject(new Error('media blocked'));
    const events: any[] = [];
    expect(
      api.playBackgroundAudio({
        dataUrl: 'https://media.test/song.mp3',
        fail: (value: any) => events.push(['fail', value]),
        complete: (value: any) => events.push(['complete', value])
      })
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      ['fail', { errMsg: 'playBackgroundAudio:fail media blocked' }],
      ['complete', { errMsg: 'playBackgroundAudio:fail media blocked' }]
    ]);
    expect(manager.paused).toBe(true);
  });

  it('后台音频的播放暂停和停止监听分别替换同一接口的旧回调', async () => {
    const manager = api.getBackgroundAudioManager();
    const events: string[] = [];
    for (const name of ['Play', 'Pause', 'Stop']) {
      (api as any)[`onBackgroundAudio${name}`](() => events.push(`legacy-${name}-first`));
      (api as any)[`onBackgroundAudio${name}`](() => events.push(`legacy-${name}-last`));
      manager[`on${name}`](() => events.push(`manager-${name}-first`));
      manager[`on${name}`](() => events.push(`manager-${name}-last`));
    }
    await api.playBackgroundAudio({ dataUrl: 'https://media.test/song.mp3' });
    await api.pauseBackgroundAudio();
    await api.stopBackgroundAudio();
    expect(events).toEqual(['legacy-Play-last', 'manager-Play-last', 'legacy-Pause-last', 'manager-Pause-last', 'legacy-Stop-last', 'manager-Stop-last']);
  });

  it('后台音频拒绝空资源地址时保留原有播放状态和资源', async () => {
    const manager = api.getBackgroundAudioManager();
    manager.title = 'song';
    manager.src = 'https://media.test/song.mp3';
    await vi.advanceTimersByTimeAsync(0);
    expect(() => { manager.src = ''; }).toThrow('invalid BackgroundAudioManager.src: ');
    expect(manager.src).toBe('https://media.test/song.mp3');
    expect(manager.paused).toBe(false);
  });

  it('后台音频等待提交时销毁不会加载资源或发送旧回调', async () => {
    const manager = api.getBackgroundAudioManager();
    const events: string[] = [];
    manager.onPlay(() => events.push('play'));
    manager.title = 'stale'; manager.src = 'https://media.test/stale.mp3';
    media.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(audios[0].src).toBe('');
    expect(events).toEqual([]);
  });

  it('应用销毁后旧版背景音频不播放或调用监听器', async () => {
    const events: string[] = [];
    api.onBackgroundAudioPlay(() => events.push('play'));
    api.onBackgroundAudioStop(() => events.push('stop'));
    const manager = api.getBackgroundAudioManager();
    media.dispose();
    manager.src = 'https://media.test/stale.mp3';
    manager.play();
    api.playBackgroundAudio({ dataUrl: 'https://media.test/stale.mp3', complete: () => events.push('complete') });
    await vi.advanceTimersByTimeAsync(0);
    expect(audios[0].src).toBe('');
    expect(audios[0].paused).toBe(true);
    expect(events).toEqual([]);
  });

  it('内部音频停止后发送 onStop 且销毁后停止播放和事件', () => {
    const audio = api.createInnerAudioContext();
    const events: string[] = [];
    audio.onStop(() => events.push('stop'));
    audio.onPause(() => events.push('pause'));
    audio.play();
    audio.stop();
    expect(events).toEqual(['stop']);
    events.length = 0;
    audio.onPause(() => events.push('pause'));
    audio.play();
    media.dispose();
    expect(audio.paused).toBe(true);
    expect(events).toEqual([]);
  });

  it('应用销毁关闭创建的全部 WebAudio 上下文', () => {
    const contexts: any[] = [];
    vi.stubGlobal('window', {
      AudioContext: class {
        state = 'running';
        constructor() {
          contexts.push(this);
        }
        close() {
          this.state = 'closed';
          return Promise.resolve();
        }
      }
    });
    api.createWebAudioContext();
    api.createWebAudioContext();
    media.dispose();
    expect(contexts.map(context => context.state)).toEqual(['closed', 'closed']);
  });
});
