/**
 * wx API 组装
 *
 * 每个能力一个模块；不存在的属性保持 undefined，供业务代码检测能力。
 */

import { CanvasApi } from './canvas';
import { createCacheManager } from './cache-manager';
import { DeviceApi } from './device';
import { FsApi } from './fs';
import { LocationApi } from './location';
import { MapApi } from './map';
import { MediaApi } from './media';
import { MiscApi } from './misc';
import { NetworkApi } from './network';
import { OpenApi } from './open';
import { Query } from './query';
import { RouteApi } from './route';
import { Storage } from './storage';
import { SystemApi } from './system';
import type { WxHost } from './types';
import { UiApi } from './ui';
import { clearTempFiles } from './temp-files';
import { CONTEXT_METHODS } from '../contexts';

export type { DeviceInfo, LaunchOptions, WxHost } from './types';

export interface ApiBundle {
  ready: Promise<void>;
  wx: any;
  dispose(): void;
}

export function createApi(
  host: WxHost,
  options: { networkTimeout?: Record<string, number>; requiredPrivateInfos?: string[] } = {}
): ApiBundle {
  const storage = new Storage(host);
  const system = new SystemApi(host);
  system.attach();
  const fs = new FsApi(host);
  const media = new MediaApi(host);
  const network = new NetworkApi(host, fs, options.networkTimeout ?? {});
  const ui = new UiApi(host);
  const route = new RouteApi(host);
  const open = new OpenApi(host);
  const device = new DeviceApi(host);
  const canvas = new CanvasApi(host, fs);
  const query = new Query(host, holder => canvas.nodeContext(holder), holder => media.videoContextForNode(holder));
  const misc = new MiscApi(host);
  const map = new MapApi(host);
  const location = new LocationApi(host, options.requiredPrivateInfos ?? []);

  const deviceApi = device.api();
  const queryApi = query.api();

  const api: Record<string, any> = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    ...storage.api(),
    ...system.api(),
    ...ui.api(),
    ...route.api(),
    ...network.api(),
    ...fs.api(),
    ...media.api(),
    ...canvas.api(),
    ...open.api(),
    ...deviceApi,
    ...map.api(),
    ...location.api(),
    ...misc.api(),
    ...queryApi
  };

  // 值为 undefined 的键不覆盖已有实现（例如 misc 里占位的 getNFCAdapter）
  for (const [key, value] of Object.entries(api)) {
    if (value === undefined) delete api[key];
  }

  api.createSelectorQuery = queryApi.createSelectorQuery;
  api.createIntersectionObserver = queryApi.createIntersectionObserver;
  api.createMediaQueryObserver = queryApi.createMediaQueryObserver;
  api.createCacheManager = createCacheManager;

  const plainComponents = new Set(['view', 'text', 'block', 'slot', 'movable-area', 'swiper-item', 'picker-view-column']);
  const commonAttributes = new Set(['id', 'class', 'style', 'hidden', 'hover-class', 'hover-start-time', 'hover-stay-time']);
  const buttonOpenTypes = new Set([
    'share',
    'getUserInfo',
    'getPhoneNumber',
    'getRealtimePhoneNumber',
    'contact',
    'openSetting',
    'chooseAvatar',
    'feedback',
    'agreePrivacyAuthorization'
  ]);
  api.canIUse = (schema: string) => {
    if (typeof schema !== 'string' || !schema) return false;
    const [name, attribute, value] = schema.split('.');
    const contextMethods: readonly string[] | undefined = Object.prototype.hasOwnProperty.call(CONTEXT_METHODS, name)
      ? CONTEXT_METHODS[name as keyof typeof CONTEXT_METHODS] : undefined;
    if (contextMethods) return !attribute || (!value && contextMethods.includes(attribute));
    if (Object.prototype.hasOwnProperty.call(api, name)) return !attribute;
    const component = typeof customElements === 'undefined' ? undefined : customElements.get(`wx-${name}`);
    if (!component && !plainComponents.has(name)) return false;
    if (!attribute) return true;
    if (name === 'button' && attribute === 'open-type') return value ? buttonOpenTypes.has(value) : true;
    if (value) return false;
    return commonAttributes.has(attribute) || ((component as any)?.observedAttributes ?? []).includes(attribute);
  };

  // 自定义事件总线（业务侧 wx.on / wx.triggerEvent）
  api.on = (name: string, callback: (...args: any[]) => void) => host.on(name, callback);
  api.off = (name: string, callback?: (...args: any[]) => void) => host.off(name, callback);
  api.triggerEvent = (name: string, ...args: any[]) => host.emit(name, ...args);

  const wx = new Proxy(api, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === '__unimplemented') return [];
      if (key === '__dispose') return () => media.dispose();
      return undefined;
    }
  });

  return {
    wx,
    ready: fs.ready,
    dispose: () => {
      network.dispose();
      media.dispose();
      canvas.dispose();
      system.dispose();
      device.dispose();
      location.dispose();
      fs.dispose();
      clearTempFiles();
    }
  };
}
