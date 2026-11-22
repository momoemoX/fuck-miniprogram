/**
 * 路由与页面间通信
 *
 * navigateTo / redirectTo / reLaunch / switchTab 的失败原因、页面栈上限、
 * eventChannel 的语义都按微信的规则实现。
 */

import type { WxHost } from './types';
import { loadModule } from '../modules';
import { invoke } from './util';

type ChannelListener = { callback: (...args: any[]) => void; once: boolean };

export class EventChannel {
  private listeners = new Map<string, ChannelListener[]>();
  private pending = new Map<string, any[][]>();

  private add(event: string, callback: (...args: any[]) => void, once: boolean) {
    const list = this.listeners.get(event) ?? [];
    list.push({ callback, once });
    this.listeners.set(event, list);
    const messages = this.pending.get(event) ?? [];
    this.pending.delete(event);
    for (const args of messages) this.emit(event, ...args);
  }

  on(event: string, callback: (...args: any[]) => void) {
    this.add(event, callback, false);
  }

  once(event: string, callback: (...args: any[]) => void) {
    this.add(event, callback, true);
  }

  off(event: string, callback?: (...args: any[]) => void) {
    if (!callback) this.listeners.delete(event);
    else
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter(entry => entry.callback !== callback)
      );
  }

  emit(event: string, ...args: any[]) {
    const list = this.listeners.get(event);
    if (!list?.length) {
      const pending = this.pending.get(event) ?? [];
      pending.push(args);
      this.pending.set(event, pending);
      return;
    }
    for (const entry of list.slice()) {
      if (entry.once) {
        const active = this.listeners.get(event);
        const index = active?.indexOf(entry) ?? -1;
        if (index >= 0) active!.splice(index, 1);
      }
      try {
        entry.callback(...args);
      } catch (error) {
        console.error('[fmp-engine] eventChannel 回调抛错', error);
      }
    }
  }
}

export class RouteApi {
  constructor(private readonly host: WxHost) {}

  private push(url: string, mode: 'navigate' | 'redirect' | 'reLaunch' | 'switchTab', options: any): EventChannel | null {
    if (!url) throw new Error('parameter error: "url" is required');
    const path = url.split('?')[0].replace(/^\//, '');

    if (mode === 'navigate' && this.host.hasTabBar(path)) throw new Error('can not navigateTo a tabbar page');
    if (mode === 'switchTab' && !this.host.hasTabBar(path)) throw new Error('can not switch to no-tabBar page');

    const channel = mode === 'navigate' ? new EventChannel() : null;
    if (channel) {
      for (const [event, handler] of Object.entries<any>(options?.events ?? {})) {
        if (typeof handler === 'function') channel.on(event, handler);
      }
    }
    this.host.setOpenerChannel(channel);

    const ok = this.host.navigate(url, mode);
    if (ok === false) {
      this.host.setOpenerChannel(null);
      throw new Error(`page "${path}" is not found`);
    }
    return channel;
  }

  api() {
    return {
      navigateTo: (options: any) =>
        invoke('navigateTo', options, opts => {
          if (this.host.pages().length >= 10) throw new Error('webview count limit exceed');
          const eventChannel = this.push(opts.url, 'navigate', opts);
          return { eventChannel };
        }),
      redirectTo: (options: any) =>
        invoke('redirectTo', options, opts => {
          this.push(opts.url, 'redirect', opts);
          return {};
        }),
      reLaunch: (options: any) =>
        invoke('reLaunch', options, opts => {
          this.push(opts.url, 'reLaunch', opts);
          return {};
        }),
      // 官方 3.7.0：restart 以 force 重建应用并落在 path（缺省回到入口页）
      restartMiniProgram: (options: any) =>
        invoke('restartMiniProgram', options, opts => {
          const path = typeof opts?.path === 'string' && opts.path.length > 0 ? opts.path : undefined;
          this.host.restart(path);
          return {};
        }),
      // 官方 3.7.0：分包与主包一起编译、模块按需执行；预下载 = 提前执行分包页面模块。
      // name 不存在 → fail module not found；packageType 仅接受 '' 与 'workers'
      preDownloadSubpackage: (options: any) =>
        invoke('preDownloadSubpackage', options, opts => {
          const packageType = opts?.packageType;
          if (packageType !== undefined && packageType !== null && packageType !== '' && packageType !== 'workers')
            throw new Error(`invalid packageType "${packageType}"`);
          if (packageType === 'workers') return {};
          const name = String(opts?.name ?? '').replace(/^\/+|\/+$/g, '');
          const pkg = (globalThis as any).__wxConfig?.subpackages?.find(
            (item: any) => String(item.root ?? '').replace(/^\/+|\/+$/g, '') === name
          );
          if (!pkg) throw new Error('preDownloadSubpackage:fail module not found');
          for (const page of pkg.pages) loadModule(`${name}/${page}`);
          return {};
        }),
      switchTab: (options: any) =>
        invoke('switchTab', options, opts => {
          this.push(opts.url, 'switchTab', opts);
          return {};
        }),
      navigateBack: (options: any) =>
        invoke('navigateBack', options, opts => {
          const pages = this.host.pages().length;
          if (pages <= 1) throw new Error('cannot navigate back at first page');
          const delta = Math.max(1, Number(opts?.delta ?? 1));
          this.host.back(Math.min(delta, pages - 1));
          return {};
        }),

      // 小程序跳转：浏览器里没有对应能力，保留参数供埋点/调试
      navigateToMiniProgram: (options: any) =>
        invoke('navigateToMiniProgram', options, opts => {
          this.host.emit('navigateToMiniProgram', opts);
          return {};
        }),
      navigateBackMiniProgram: (options: any) => invoke('navigateBackMiniProgram', options, () => ({})),
      exitMiniProgram: (options: any) =>
        invoke('exitMiniProgram', options, () => {
          window.close();
          return {};
        }),

      // 路由事件（2.30+）：beforeAppRoute → appRoute → appRouteDone
      onAppRoute: (callback: (res: any) => void) => this.host.on('appRoute', callback),
      offAppRoute: (callback?: (res: any) => void) => this.host.off('appRoute', callback),
      onAppRouteDone: (callback: (res: any) => void) => this.host.on('appRouteDone', callback),
      offAppRouteDone: (callback?: (res: any) => void) => this.host.off('appRouteDone', callback),
      onBeforeAppRoute: (callback: (res: any) => void) => this.host.on('beforeAppRoute', callback),
      offBeforeAppRoute: (callback?: (res: any) => void) => this.host.off('beforeAppRoute', callback),
      onBeforePageLoad: (callback: (res: any) => void) => this.host.on('beforePageLoad', callback),
      offBeforePageLoad: (callback?: (res: any) => void) => this.host.off('beforePageLoad', callback),
      onAfterPageLoad: (callback: (res: any) => void) => this.host.on('afterPageLoad', callback),
      offAfterPageLoad: (callback?: (res: any) => void) => this.host.off('afterPageLoad', callback),
      onBeforePageUnload: (callback: (res: any) => void) => this.host.on('beforePageUnload', callback),
      offBeforePageUnload: (callback?: (res: any) => void) => this.host.off('beforePageUnload', callback),
      onAfterPageUnload: (callback: (res: any) => void) => this.host.on('afterPageUnload', callback),
      offAfterPageUnload: (callback?: (res: any) => void) => this.host.off('afterPageUnload', callback),

      // 页面栈
      getCurrentPages: () => this.host.pages(),

      // 自定义路由（Skyline 的 wx.router）暂不支持，保留同名方法以便探测
      router: undefined
    };
  }
}
