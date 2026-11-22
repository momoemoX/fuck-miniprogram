import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaRecorderApi } from '../../packages/engine/src/runtime/api/media-recorder';
import { createVideoDecoderApi } from '../../packages/engine/src/runtime/api/video-decoder';

let canvas: any;

beforeEach(() => {
  canvas = {
    width: 100,
    height: 50,
    getContext: vi.fn((type: string) => (type === 'webgl' ? {} : null))
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMediaRecorder', () => {
  it('同一 canvas 节点重复创建返回官方错误', () => {
    const { createMediaRecorder } = createMediaRecorderApi();
    const recorder = createMediaRecorder(canvas, {});
    expect(recorder).toBeTruthy();
    expect(() => createMediaRecorder(canvas, {})).toThrow('Already created by the same canvas node.');
  });

  it('没有 webgl/wgfx 上下文的节点返回官方错误', () => {
    canvas.getContext = vi.fn(() => null);
    const { createMediaRecorder } = createMediaRecorderApi();
    expect(() => createMediaRecorder(canvas, {})).toThrow('Cannot get webgl context from target.');
    expect(() => createMediaRecorder(null as any, {})).toThrow('Cannot get webgl context from target.');
  });

  it('时长与码率按官方范围钳位，缺省值与官方一致', () => {
    const { createMediaRecorder } = createMediaRecorderApi();
    expect(createMediaRecorder(canvas, { duration: 3, videoBitsPerSecond: 100 })).toMatchObject({ duration: 5, videoBitsPerSecond: 600, fps: 24, gop: 12 });
    expect(createMediaRecorder({ ...canvas }, { duration: 9000, videoBitsPerSecond: 9000 })).toMatchObject({ duration: 7200, videoBitsPerSecond: 3000 });
  });

  it('wgfx 上下文也算合法目标', () => {
    canvas.getContext = vi.fn((type: string) => (type === 'wgfx' ? {} : null));
    const { createMediaRecorder } = createMediaRecorderApi();
    expect(createMediaRecorder(canvas, {})).toBeTruthy();
  });

  it('create 事件在创建后异步派发一次', async () => {
    const { createMediaRecorder } = createMediaRecorderApi();
    const recorder = createMediaRecorder(canvas, {});
    const events: string[] = [];
    recorder.on('create', () => events.push('create'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['create']);
  });

  it('未启动时 pause/stop 返回官方失败信息', async () => {
    const { createMediaRecorder } = createMediaRecorderApi();
    const recorder = createMediaRecorder(canvas, {});
    await expect(recorder.pause()).rejects.toThrow('start:fail recorder is not started');
    await expect(recorder.stop()).rejects.toThrow('stop:fail recorder is not started');
  });
});

describe('createVideoDecoder', () => {
  it('未 start 时 getFrameData 返回 null，seek/stop 报未启动', async () => {
    const { createVideoDecoder } = createVideoDecoderApi();
    const decoder = createVideoDecoder({});
    expect(decoder.getFrameData()).toBeNull();
    await expect(decoder.seek(100)).rejects.toEqual(new Error('start:fail video decoder not started'));
  });

  it('start 缺少 source 返回官方失败信息', async () => {
    const { createVideoDecoder } = createVideoDecoderApi();
    const decoder = createVideoDecoder({});
    await expect(decoder.start({})).rejects.toEqual(new Error('start:fail parameter source is required'));
  });

  it('start 载入源后触发 start 事件，stop 触发 stop 事件且 on/off 精确匹配监听', async () => {
    const fakeVideo = {
      muted: false, preload: '', crossOrigin: '', src: '', currentTime: 0, videoWidth: 4, videoHeight: 2, readyState: 2,
      addEventListener: vi.fn((type: string, callback: any) => { if (type === 'loadeddata') queueMicrotask(callback); }),
      removeEventListener: vi.fn(),
      removeAttribute: vi.fn(), load: vi.fn(), remove: vi.fn(),
      play: vi.fn(() => Promise.resolve()), pause: vi.fn()
    };
    const fakeCanvas = {
      width: 4, height: 2,
      getContext: vi.fn(() => ({ drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(32) })) }))
    };
    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => (tag === 'video' ? fakeVideo : fakeCanvas))
    });
    const { addTempFile } = await import('../../packages/engine/src/runtime/api/temp-files');
    const source = addTempFile(new Blob(['x'], { type: 'video/webm' })).path;
    const { createVideoDecoder } = createVideoDecoderApi();
    const decoder = createVideoDecoder({});
    const started: any[] = [], stopped: any[] = [];
    const dropped: any[] = [];
    const droppedHandler = (res: any) => dropped.push(res);
    decoder.on('start', (res: any) => started.push(res));
    decoder.on('stop', droppedHandler);
    decoder.off('stop', droppedHandler);
    decoder.on('stop', (res: any) => stopped.push(res));
    const result = await decoder.start({ source });
    expect(result).toMatchObject({ video: { width: 4, height: 2 } });
    expect(started).toHaveLength(1);
    expect(decoder.getFrameData()).toMatchObject({ width: 4, height: 2, pts: 0 });
    await decoder.stop();
    expect(stopped).toHaveLength(1);
    expect(dropped).toEqual([]);
  });
});
