/**
 * Worker 运行时
 *
 * 构建期把 `wx.createWorker('workers/index.js')` 指向的脚本连同它 require 的模块
 * 打包成一段独立代码（见 compiler/build.ts 的 bundleWorker），这里用 Blob 建成
 * 真正的 Web Worker。Worker 内部的 `worker.onMessage` / `worker.postMessage`
 * 由打包时注入的 shim 提供，业务代码不用改。
 */

export interface WxWorker {
  postMessage(message: any, transfer?: Transferable[]): void;
  terminate(): void;
  /** 回调直接收到 worker 发出的数据，官方不再包一层 message 字段 */
  onMessage(callback: (message: any) => void): void;
  onProcessKilled(callback: () => void): void;
}

interface WorkerLike {
  postMessage(message: any): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export function createWorker(source: string, name?: string): WxWorker {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('createWorker:fail Worker is not supported in this environment');
  }

  const blob = new Blob([source], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  let worker: WorkerLike;
  try {
    worker = new Worker(url, { name: name || 'wx-worker' }) as unknown as WorkerLike;
  } finally {
    // Worker 构造完成后就可以释放 Blob URL
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  let onMessage: ((message: any) => void) | null = null;
  let onKilled: (() => void) | null = null;
  let alive = true;

  worker.onmessage = event => {
    onMessage?.(event.data);
  };
  worker.onerror = event => {
    console.error(`[fmp-engine] worker ${name ?? ''} 出错：${event.message}`);
    alive = false;
    onKilled?.();
  };

  return {
    postMessage(message: any) {
      if (!alive) return;
      worker.postMessage(message);
    },
    terminate() {
      if (!alive) return;
      alive = false;
      worker.terminate();
    },
    onMessage(callback) {
      onMessage = callback;
    },
    onProcessKilled(callback) {
      onKilled = callback;
    }
  };
}

export function workerSource(path: string): string | undefined {
  const registry = (globalThis as any).__FMP_WORKERS__ as Record<string, string> | undefined;
  if (!registry) return undefined;
  const key = path.replace(/^\.?\//, '');
  return registry[key] ?? registry[`${key}.js`] ?? registry[key.replace(/\.js$/, '')];
}
