import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkApi } from '../../packages/engine/src/runtime/api/network';

let network: NetworkApi;
let api: any;
let signals: AbortSignal[];

beforeEach(() => {
  vi.useFakeTimers();
  signals = [];
  network = new NetworkApi({ emit() {} } as any, {} as any);
  api = network.api();
  vi.stubGlobal('fetch', (_url: string, options: RequestInit) => {
    const signal = options.signal!;
    signals.push(signal);
    const stream = new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      }
    });
    return Promise.resolve(new Response(stream));
  });
});

afterEach(() => {
  (network as any).dispose?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('网络任务的完整传输周期', () => {
  for (const name of ['request', 'downloadFile']) {
    it(`${name} 在响应头已到达但正文未完成时仍执行超时`, async () => {
      const results: unknown[] = [];
      api[name]({ url: 'https://network.test/stream', timeout: 20, fail: (result: any) => results.push(result) });
      await vi.advanceTimersByTimeAsync(20);
      expect(results).toEqual([{ errMsg: `${name}:fail timeout` }]);
      expect(signals[0].aborted).toBe(true);
    });

    it(`${name} 取消正文读取后只发送一次失败和完成回调`, async () => {
      const results: unknown[] = [];
      const task = api[name]({
        url: 'https://network.test/stream',
        success: () => results.push('success'),
        fail: (result: any) => results.push(['fail', result.errMsg]),
        complete: (result: any) => results.push(['complete', result.errMsg])
      });
      await vi.advanceTimersByTimeAsync(0);
      task.abort();
      task.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(results).toEqual([
        ['fail', `${name}:fail abort`],
        ['complete', `${name}:fail abort`]
      ]);
    });
  }

  it('应用销毁中断所有传输并停止旧应用的网络回调', async () => {
    const results: unknown[] = [];
    for (const name of ['request', 'downloadFile']) {
      api[name]({
        url: 'https://network.test/stream',
        fail: (result: any) => results.push(result),
        complete: () => results.push('complete')
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    (network as any).dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(signals.map(signal => signal.aborted)).toEqual([true, true]);
    expect(results).toEqual([]);
  });

  it('已完成的请求在应用销毁时不再收到取消信号', async () => {
    let signal: AbortSignal;
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => {
      signal = options.signal!;
      return Promise.resolve(Response.json({ value: 1 }));
    });
    const results: unknown[] = [];
    api.request({ url: 'https://network.test/done', success: (result: any) => results.push(result.data) });
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([{ value: 1 }]);
    (network as any).dispose();
    expect(signal!.aborted).toBe(false);
  });

  it('应用销毁关闭全部套接字并停止任务和全局事件', () => {
    const sockets: any[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        readyState = 0;
        onopen: any;
        onclose: any;
        onmessage: any;
        onerror: any;
        constructor() {
          sockets.push(this);
        }
        close() {
          this.readyState = 3;
          this.onclose?.({ code: 1000, reason: '', wasClean: true });
        }
      }
    );
    const events: unknown[] = [];
    for (let index = 0; index < 2; index++) {
      api.connectSocket({ url: 'wss://network.test/socket' }).onClose((event: any) => events.push(event));
    }
    (network as any).dispose();
    expect(sockets.map(socket => socket.readyState)).toEqual([3, 3]);
    expect(events).toEqual([]);
  });

  for (const action of ['abort', 'dispose']) {
    it(`上传任务在文件尚未读完时 ${action} 后不再发送文件`, async () => {
      let release: (blob: Blob) => void;
      vi.stubGlobal('fetch', () => Promise.resolve({ blob: () => new Promise<Blob>(resolve => (release = resolve)) }));
      const sent: unknown[] = [];
      vi.stubGlobal(
        'XMLHttpRequest',
        class {
          upload = {};
          open() {}
          send(value: any) {
            sent.push(value);
          }
          abort() {}
        }
      );
      const results: unknown[] = [];
      const task = api.uploadFile({
        url: 'https://network.test/upload',
        filePath: 'data:text/plain,file',
        fail: (result: any) => results.push(result)
      });
      await vi.advanceTimersByTimeAsync(0);
      if (action === 'abort') task.abort();
      else (network as any).dispose();
      release!(new Blob(['file']));
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toEqual([]);
      expect(results).toEqual(action === 'abort' ? [{ errMsg: 'uploadFile:fail abort' }] : []);
    });
  }
});
