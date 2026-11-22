/**
 * API 通用工具：回调 + Promise 双形态、错误信息、参数校验
 *
 * 微信基础库的约定：
 * - 传了 success / fail / complete 就只走回调，返回 undefined；
 * - 一个回调都没传时返回 Promise，resolve 成功结果、reject 失败结果；
 * - 结果里始终带 `errMsg`，形如 `showToast:ok` / `request:fail timeout`。
 */

export function errText(error: unknown): string {
  if (error == null) return '';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'errMsg' in (error as any)) return String((error as any).errMsg);
  return String(error);
}

export function failMessage(name: string, error: unknown): string {
  const text = errText(error);
  if (!text) return `${name}:fail`;
  if (text.startsWith(`${name}:`)) return text;
  return `${name}:fail ${text}`;
}

export function hasCallback(options: any): boolean {
  return (
    !!options && (typeof options.success === 'function' || typeof options.fail === 'function' || typeof options.complete === 'function')
  );
}

export function deliver(fn: unknown, ...args: any[]) {
  if (typeof fn === 'function') {
    try {
      fn(...args);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

/**
 * 执行一个异步 API。
 * @param name API 名，用于拼 errMsg
 * @param options 调用参数
 * @param run 实际逻辑，返回结果对象（不含 errMsg）或抛错
 */
export function invoke<T extends Record<string, any> | void>(
  name: string,
  options: any,
  run: (opts: any) => T | Promise<T>
): Promise<any> | void {
  const opts = options ?? {};
  const callback = hasCallback(opts);
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(run(opts));
  } catch (error) {
    promise = Promise.reject(error);
  }

  const settled = promise.then(
    value => {
      const result = { errMsg: `${name}:ok`, ...value };
      deliver(opts.success, result);
      deliver(opts.complete, result);
      return result;
    },
    error => {
      const result = { errMsg: failMessage(name, error) };
      if (error && typeof error === 'object' && 'errMsg' in (error as any)) {
        Object.assign(result, error);
        result.errMsg = failMessage(name, error);
      }
      deliver(opts.fail, result);
      deliver(opts.complete, result);
      throw result;
    }
  );

  if (callback) {
    // 回调形态：失败已经交给 fail，不要再产生未处理的 rejection
    settled.catch(() => undefined);
    return;
  }
  return settled;
}

/** 同步 API：补齐 errMsg，并在结果里带上调用方关心的字段 */
export function syncResult<T extends Record<string, any>>(name: string, value: T): T & { errMsg: string } {
  return { ...value, errMsg: `${name}:ok` };
}

export function assert(condition: any, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function requireParam(options: any, key: string, name: string): any {
  const value = options?.[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`parameter error: "${key}" is required for ${name}`);
  }
  return value;
}

export function numberOr(value: any, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clone<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

export function queryString(data: any, jsonObjects = true): string {
  if (!data) return '';
  if (typeof data === 'string') return data.replace(/^\?/, '');
  return Object.entries(data)
    .map(([key, value]) => {
      const text = jsonObjects && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${encodeURIComponent(key)}=${encodeURIComponent(text)}`;
    })
    .join('&');
}

export function parseQuery(url: string): Record<string, string> {
  const query: Record<string, string> = {};
  const mark = url.indexOf('?');
  if (mark < 0) return query;
  for (const [key, value] of new URLSearchParams(url.slice(mark + 1))) query[key] = value;
  return query;
}

let seed = 0;

/** 临时文件 / 页面 id：同一会话内唯一即可 */
export function uid(prefix = 'tmp'): string {
  seed += 1;
  return `${prefix}-${Date.now().toString(36)}-${seed.toString(36)}`;
}

/** 按小程序规则把相对路径补成绝对 URL */
export function absoluteUrl(path: string): string {
  if (!path) return path;
  if (/^(https?:|blob:|data:|wxfile:)/.test(path)) return path;
  if (path.startsWith('//')) return location.protocol + path;
  return path.startsWith('/') ? path : `/${path}`;
}

export function isRemote(path: string): boolean {
  return /^https?:\/\//.test(path) || path.startsWith('//');
}

/** 简单事件通道，用于 onXxx / offXxx */
export class Channel {
  private map = new Map<string, Set<(...args: any[]) => void>>();

  on(name: string, callback: (...args: any[]) => void) {
    let set = this.map.get(name);
    if (!set) {
      set = new Set();
      this.map.set(name, set);
    }
    set.add(callback);
  }

  off(name: string, callback?: (...args: any[]) => void) {
    if (!callback) this.map.delete(name);
    else this.map.get(name)?.delete(callback);
  }

  emit(name: string, ...args: any[]) {
    const set = this.map.get(name);
    if (!set) return;
    for (const callback of Array.from(set)) {
      try {
        callback(...args);
      } catch (error) {
        console.error(`[fmp-engine] ${name} 监听器抛错`, error);
      }
    }
  }

  has(name: string): boolean {
    return !!this.map.get(name)?.size;
  }
}
