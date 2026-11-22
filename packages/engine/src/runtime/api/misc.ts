/**
 * 广告、加密、扩展配置、插件与调试工具
 */

import { fileData } from './file-codecs';
import { loadModule } from '../modules';
import type { WxHost } from './types';
import { invoke, syncResult } from './util';

function adUnit(kind: string, options: any) {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const emit = (name: string, payload?: any) => {
    for (const callback of Array.from(listeners.get(name) ?? [])) callback(payload);
  };
  const on = (name: string) => (callback: (...args: any[]) => void) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(callback);
  };
  const off = (name: string) => (callback?: (...args: any[]) => void) => {
    if (!callback) listeners.delete(name);
    else listeners.get(name)?.delete(callback);
  };

  const ad: any = {
    adUnitId: options?.adUnitId ?? '',
    style: { left: 0, top: 0, width: 300, height: kind === 'banner' ? 100 : 0 },
    load: () => {
      setTimeout(() => emit('load', {}), 200);
      return Promise.resolve();
    },
    show: () =>
      new Promise<void>(resolve => {
        emit('show', {});
        setTimeout(() => {
          if (kind === 'rewarded') emit('close', { isEnded: true });
          resolve();
        }, 300);
      }),
    hide: () => {
      emit('hide', {});
      return Promise.resolve();
    },
    destroy: () => {
      emit('destroy', {});
      listeners.clear();
    },
    onLoad: on('load'),
    offLoad: off('load'),
    onError: on('error'),
    offError: off('error'),
    onClose: on('close'),
    offClose: off('close'),
    onResize: on('resize'),
    offResize: off('resize'),
    onShow: on('show'),
    offShow: off('show'),
    onHide: on('hide'),
    offHide: off('hide')
  };

  setTimeout(() => emit('load', {}), 200);
  return ad;
}

export class MiscApi {
  private readonly bufferUrls = new Set<string>();

  private logs: Array<{ level: string; args: any[] }> = [];

  constructor(private readonly host: WxHost) {}

  api() {
    return {
      arrayBufferToBase64: (value: ArrayBuffer) => {
        try {
          return fileData(new Uint8Array(value), 'base64');
        } catch {
          return undefined;
        }
      },
      base64ToArrayBuffer: (value: string) => {
        try {
          return Uint8Array.from(atob(value), letter => letter.charCodeAt(0)).buffer;
        } catch {
          return undefined;
        }
      },
      // ---------------------------------------------------------------- 广告
      createBannerAd: (options: any) => adUnit('banner', options),
      createRewardedVideoAd: (options: any) => adUnit('rewarded', options),
      createInterstitialAd: (options: any) => adUnit('interstitial', options),
      createGridAd: (options: any) => adUnit('grid', options),
      createCustomAd: (options: any) => adUnit('custom', options),
      createVideAd: (options: any) => adUnit('video', options),

      // ---------------------------------------------------------------- 加密
      getRandomValues: (options: any) =>
        invoke('getRandomValues', options, opts => {
          const length = Math.max(1, Number(opts?.length ?? 16));
          const bytes = new Uint8Array(length);
          if (globalThis.crypto) crypto.getRandomValues(bytes);
          else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
          return { randomValues: bytes.buffer };
        }),

      getUserCryptoManager: () => ({
        getRandomValues: (length: number) => {
          const bytes = new Uint8Array(Math.max(1, Number(length) || 16));
          if (globalThis.crypto) crypto.getRandomValues(bytes);
          return bytes.buffer;
        },
        getLatestUserKey: () =>
          Promise.resolve({
            encryptKey: '',
            iv: '',
            version: 1,
            expireTime: Math.floor(Date.now() / 1000) + 86400 * 30
          })
      }),

      // ---------------------------------------------------------------- 缓冲 URL
      createBufferURL: (buffer: ArrayBuffer | ArrayBufferView, type?: string) => {
        if (!buffer) throw new Error('createBufferURL:fail parameter error');
        const blob = buffer instanceof Blob ? buffer : new Blob([buffer as any], { type: type ?? 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        this.bufferUrls.add(url);
        return url;
      },
      revokeBufferURL: (url: string) => {
        if (!this.bufferUrls.has(url)) return;
        URL.revokeObjectURL(url);
        this.bufferUrls.delete(url);
      },

      // ---------------------------------------------------------------- 扩展配置
      getExtConfig: (options: any) =>
        invoke('getExtConfig', options, () => ({ extConfig: (globalThis as any).__wxConfig?.extConfig ?? {} })),
      getExtConfigSync: () => syncResult('getExtConfigSync', { extConfig: (globalThis as any).__wxConfig?.extConfig ?? {} }),

      // ---------------------------------------------------------------- 插件
      requirePlugin: (name: string) => {
        const entry = (globalThis as any).__wxConfig?.pluginEntries?.[name];
        if (!entry) {
          console.warn(`[fmp-engine] 插件 ${name} 没有本地实现（app.json plugins 里配置 path 即可）`);
          return {};
        }
        return loadModule(entry);
      },
      requireMiniProgram: () => ({}),
      getPluginExtAppReloadInfo: () => syncResult('getPluginExtAppReloadInfo', {}),

      // ---------------------------------------------------------------- 日志 / 性能
      reportMonitor: (name: string, value: number) => {
        this.logs.push({ level: 'monitor', args: [name, value] });
      },
      getRealtimeLogManager: () => ({
        log: (...args: any[]) => this.logs.push({ level: 'log', args }),
        info: (...args: any[]) => this.logs.push({ level: 'info', args }),
        warn: (...args: any[]) => this.logs.push({ level: 'warn', args }),
        error: (...args: any[]) => this.logs.push({ level: 'error', args }),
        setFilterMsg: () => undefined,
        addFilterMsg: () => undefined,
        getCurrentState: () => ({})
      }),
      getLogManager: () => ({
        log: (...args: any[]) => this.logs.push({ level: 'log', args }),
        info: (...args: any[]) => this.logs.push({ level: 'info', args }),
        warn: (...args: any[]) => this.logs.push({ level: 'warn', args }),
        error: (...args: any[]) => this.logs.push({ level: 'error', args }),
        setFilterMsg: () => undefined,
        addFilterMsg: () => undefined,
        getCurrentState: () => ({})
      }),
      reportPerformance: () => undefined,
      reportAnalytics: (name: string, data: any) => {
        this.host.emit('analytics', { name, data });
      },
      reportEvent: () => undefined,
      setEnableDebug: (options: any) => invoke('setEnableDebug', options, () => ({})),

      // ---------------------------------------------------------------- 运行时信息
      getSkylineInfo: () => syncResult('getSkylineInfo', { isSupported: false, version: '', reason: 'webview renderer' }),
      getSkylineRendererInfo: () => syncResult('getSkylineRendererInfo', {}),
      checkIsAddedToMyMiniProgram: (options: any) => invoke('checkIsAddedToMyMiniProgram', options, () => ({ added: false })),
      getChannelsShareKey: (options: any) => invoke('getChannelsShareKey', options, () => ({}))
    };
  }
}
