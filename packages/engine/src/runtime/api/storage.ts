/**
 * 数据缓存
 *
 * 与微信一致：单个 key 1MB、总量 10MB，值按 JSON 序列化存到 localStorage，
 * 因此字符串、数字、对象、数组都能原样取回；不存在的 key 同步接口返回 ''。
 */

import type { WxHost } from './types';
import { invoke, syncResult } from './util';

const PREFIX = 'fmp:storage:';
const MAX_KEY = 1024; // 字节
const MAX_ITEM = 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;

interface Record {
  value: any;
  size: number;
}

export class Storage {
  private cache = new Map<string, Record>();
  private loaded = false;

  constructor(_host: WxHost) {}

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(PREFIX)) continue;
        const raw = localStorage.getItem(key)!;
        const name = key.slice(PREFIX.length);
        try {
          this.cache.set(name, { value: JSON.parse(raw), size: byteLength(raw) });
        } catch {
          this.cache.set(name, { value: raw, size: byteLength(raw) });
        }
      }
    } catch {
      /* 隐私模式下不可用 */
    }
  }

  private total(): number {
    let size = 0;
    for (const record of this.cache.values()) size += record.size;
    return size;
  }

  private read(key: string): any {
    this.load();
    const record = this.cache.get(key);
    return record ? record.value : '';
  }

  private has(key: string): boolean {
    this.load();
    return this.cache.has(key);
  }

  private write(key: string, value: any) {
    if (typeof key !== 'string' || !key) throw new Error('parameter error: "key" should be a non-empty string');
    if (byteLength(key) > MAX_KEY) throw new Error(`key "${key}" is too long`);
    const raw = JSON.stringify(value === undefined ? null : value);
    if (raw === undefined) throw new Error('value is not serializable');
    const size = byteLength(raw);
    if (size > MAX_ITEM) throw new Error(`data size exceeds the limit of ${MAX_ITEM} bytes`);

    this.load();
    const previous = this.cache.get(key)?.size ?? 0;
    if (this.total() - previous + size > MAX_TOTAL) throw new Error('exceed storage max size 10MB');

    this.cache.set(key, { value, size });
    try {
      localStorage.setItem(PREFIX + key, raw);
    } catch {
      /* 配额满了也不影响内存缓存 */
    }
  }

  private remove(key: string) {
    this.load();
    this.cache.delete(key);
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* 忽略 */
    }
  }

  private clear() {
    this.load();
    const keys = Array.from(this.cache.keys());
    this.cache.clear();
    try {
      for (const key of keys) localStorage.removeItem(PREFIX + key);
    } catch {
      /* 忽略 */
    }
  }

  private info() {
    this.load();
    return {
      keys: Array.from(this.cache.keys()),
      currentSize: Math.ceil(this.total() / 1024),
      limitSize: MAX_TOTAL / 1024
    };
  }

  api() {
    return {
      setStorage: (options: any) =>
        invoke('setStorage', options, opts => {
          this.write(opts.key, opts.data);
          return {};
        }),
      setStorageSync: (key: string, data: any) => {
        this.write(key, data);
      },
      getStorage: (options: any) =>
        invoke('getStorage', options, opts => {
          // 官方在 key 不存在时失败，不是返回空字符串
          if (!this.has(String(opts.key ?? ''))) throw new Error('data not found');
          return { data: this.read(opts.key) };
        }),
      getStorageSync: (key: string) => {
        const value = this.read(String(key ?? ''));
        return value === undefined ? '' : value;
      },
      removeStorage: (options: any) =>
        invoke('removeStorage', options, opts => {
          this.remove(opts.key);
          return {};
        }),
      removeStorageSync: (key: string) => {
        this.remove(String(key ?? ''));
      },
      clearStorage: (options: any) =>
        invoke('clearStorage', options, () => {
          this.clear();
          return {};
        }),
      clearStorageSync: () => {
        this.clear();
      },
      getStorageInfo: (options: any) => invoke('getStorageInfo', options, () => this.info()),
      getStorageInfoSync: () => syncResult('getStorageInfoSync', this.info()),
      batchSetStorage: (options: any) =>
        invoke('batchSetStorage', options, opts => {
          const list = Array.isArray(opts.kvList) ? opts.kvList : [];
          for (const item of list) this.write(item.key, item.value);
          return {};
        }),
      batchSetStorageSync: (kvList: Array<{ key: string; value: any }>) => {
        for (const item of kvList ?? []) this.write(item.key, item.value);
      },
      batchGetStorage: (options: any) =>
        invoke('batchGetStorage', options, opts => {
          const keys = Array.isArray(opts.keyList) ? opts.keyList : [];
          return { data: keys.map((key: string) => this.read(key)) };
        }),
      batchGetStorageSync: (keyList: string[]) => (keyList ?? []).map(key => this.read(key))
    };
  }
}

function byteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}
