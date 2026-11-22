/**
 * 极简模块系统
 *
 * 构建期把每个 .js 包成 `__FMP__.module(id, fn)`，逻辑层原来的 `require('../../utils/x.js')`
 * 不用改，运行期按相对路径解析。页面/组件的定义通过把 `Page` / `Component` 的调用
 * 归属到「当前正在执行的模块」来收集。
 */

interface ModuleRecord {
  fn: (require: ModuleRequire, module: { exports: any }, exports: any) => void;
  module?: { exports: any };
  loaded?: boolean;
}

/** `require(path)` / `require(path, cb, errCb)` / `require.async(path)` */
export interface ModuleRequire {
  (request: string): any;
  (request: string, callback?: (module: any) => void, errback?: (error: any) => void): any;
  async(request: string): Promise<any>;
}
export type ModuleCache = Map<string, { exports: any }>;

const registry = new Map<string, ModuleRecord>();
const stack: string[] = [];

export function registerModule(id: string, fn: ModuleRecord['fn']) {
  registry.set(normalize(id), { fn });
}

export function resetModules() {
  for (const record of registry.values()) {
    record.loaded = false;
    record.module = undefined;
  }
}

export function normalize(path: string): string {
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/').replace(/\.js$/, '');
}

function resolvePath(from: string, request: string): string {
  if (!request.startsWith('.')) return normalize(request);
  const base = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  return normalize(base ? `${base}/${request}` : request);
}

export function currentModule(): string | undefined {
  return stack[stack.length - 1];
}

export function hasModule(id: string): boolean {
  return registry.has(normalize(id));
}

/** app.json 的 resolveAlias：只作用于 require 的路径映射 */
let aliases: Array<[string, string]> = [];

export function setResolveAlias(map?: Record<string, string>) {
  aliases = Object.entries(map ?? {});
}

function applyAlias(request: string): string {
  for (const [from, to] of aliases) {
    const star = from.indexOf('*');
    if (star < 0) {
      if (request === from) return to;
      continue;
    }
    const prefix = from.slice(0, star);
    const suffix = from.slice(star + 1);
    if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
    return to.replace('*', request.slice(prefix.length, request.length - suffix.length));
  }
  return request;
}

function moduleId(id: string, from?: string) {
  id = applyAlias(id);
  const candidates = [from ? resolvePath(from, id) : normalize(id)];
  if (!id.startsWith('.') && !id.startsWith('/')) {
    let dir = from?.slice(0, from.lastIndexOf('/')) ?? '';
    while (dir) {
      candidates.push(normalize(`${dir}/miniprogram_npm/${id}`));
      const slash = dir.lastIndexOf('/');
      dir = slash < 0 ? '' : dir.slice(0, slash);
    }
    candidates.push(normalize(`miniprogram_npm/${id}`));
  }
  for (const candidate of candidates) {
    if (registry.has(candidate)) return candidate;
    if (registry.has(`${candidate}/index`)) return `${candidate}/index`;
  }
  throw new Error(`[fmp-engine] 找不到模块：${id}${from ? ` (from ${from})` : ''}`);
}

export function loadModule(id: string, from?: string, cache?: ModuleCache): any {
  const key = moduleId(id, from);
  const record = registry.get(key)!;
  if (cache?.has(key)) return cache.get(key)!.exports;
  if (!cache && record.loaded) return record.module!.exports;

  const module = { exports: {} as any };
  if (cache) cache.set(key, module);
  else {
    record.loaded = true;
    record.module = module;
  }
  stack.push(key);
  try {
    record.fn(createRequire(key, cache), module, module.exports);
  } catch (error) {
    if (cache) cache.delete(key);
    else {
      record.loaded = false;
      record.module = undefined;
    }
    throw error;
  } finally {
    stack.pop();
  }
  return module.exports;
}

/**
 * 模块内的 require：同步形态照旧立即返回；带回调或 `.async` 的形态
 * 在下一个任务里交付，模块缺失时走 errCb / reject。
 */
export function createRequire(from: string, cache?: ModuleCache): ModuleRequire {
  const require: any = (request: string, callback?: (module: any) => void, errback?: (error: any) => void) => {
    if (typeof callback !== 'function') return loadModule(request, from, cache);
    queueMicrotask(() => {
      try {
        callback(loadModule(request, from, cache));
      } catch (error) {
        if (typeof errback === 'function') errback(error);
        else throw error;
      }
    });
    return undefined;
  };
  require.async = (request: string): Promise<any> =>
    new Promise((resolve, reject) => {
      queueMicrotask(() => {
        try {
          resolve(loadModule(request, from, cache));
        } catch (error) {
          reject(error);
        }
      });
    });
  return require;
}
