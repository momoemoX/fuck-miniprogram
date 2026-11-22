import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenApi } from '../../packages/engine/src/runtime/api/open';
import { RouteApi } from '../../packages/engine/src/runtime/api/route';
import { SystemApi } from '../../packages/engine/src/runtime/api/system';
import { loadModule, registerModule, resetModules } from '../../packages/engine/src/runtime/modules';

let host: any;

const makeHost = (device: any = { screenWidth: 375, screenHeight: 667, statusBarHeight: 20, safeAreaBottom: 34, model: 'iPhone', system: 'iOS', platform: 'ios', windowHeight: 600, windowTop: 64, pixelRatio: 2 }) => {
  const listeners = new Map<string, any[]>();
  return {
    listeners,
    deviceInfo: () => device,
    on: vi.fn((name: string, callback: any) => {
      listeners.set(name, [...(listeners.get(name) ?? []), callback]);
    }),
    off: vi.fn((name: string, callback?: any) => {
      if (!callback) listeners.delete(name);
      else listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== callback));
    }),
    emit: vi.fn((name: string, ...args: any[]) => (listeners.get(name) ?? []).forEach(callback => callback(...args)))
  };
};

beforeEach(() => {
  host = makeHost();
  resetModules();
});

afterEach(() => {
  resetModules();
  vi.unstubAllGlobals();
});

describe('应用级事件注册通道', () => {
  it.each([
    ['onBatteryInfoChange', 'offBatteryInfoChange', 'batteryInfoChange'],
    ['onNetworkWeakChange', 'offNetworkWeakChange', 'networkWeakChange'],
    ['onLazyLoadError', 'offLazyLoadError', 'lazyLoadError'],
    ['onMenuButtonBoundingClientRectWeightChange', 'offMenuButtonBoundingClientRectWeightChange', 'menuButtonRectChange']
  ])('%s 注册、触发与移除走宿主总线', (onName: string, offName: string, channel: string) => {
    const system: any = new SystemApi(host).api();
    const received: any[] = [];
    system[onName]((res: any) => received.push(res));
    host.emit(channel, { value: 1 });
    expect(received).toEqual([{ value: 1 }]);
    const callback = host.listeners.get(channel)?.[0];
    system[offName](callback);
    host.emit(channel, { value: 2 });
    expect(received).toEqual([{ value: 1 }]);
    expect(host.on).toHaveBeenCalledWith(channel, callback);
    expect(host.off).toHaveBeenCalledWith(channel, callback);
  });

  it('胶囊矩形变化时派发 onMenuButtonBoundingClientRectWeightChange', () => {
    const handlers: Record<string, any> = {};
    vi.stubGlobal('window', {
      addEventListener: vi.fn((name: string, callback: any) => {
        handlers[name] = callback;
      }),
      removeEventListener: vi.fn()
    });
    const system = new SystemApi(host);
    const api = system.api();
    const received: any[] = [];
    api.onMenuButtonBoundingClientRectWeightChange((res: any) => received.push(res));
    system.attach();
    handlers.resize?.();
    handlers.resize?.();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ width: 87, height: 32, top: 26 });
    const device = host.deviceInfo();
    host.deviceInfo = () => ({ ...device, screenWidth: 414, statusBarHeight: 24 });
    handlers.resize?.();
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ top: 30, right: 407 });
  });
});

describe('checkDeviceSupportHevc', () => {
  it('按浏览器真实解码能力回答 supportHevc', async () => {
    vi.stubGlobal('document', { createElement: () => ({ canPlayType: (type: string) => (type.includes('hvc1') ? 'probably' : '') }) });
    const system = new SystemApi(host).api();
    await expect(system.checkDeviceSupportHevc({})).resolves.toMatchObject({ supportHevc: true });
  });

  it('浏览器不支持 HEVC 时返回 false 而不是失败', async () => {
    vi.stubGlobal('document', { createElement: () => ({ canPlayType: () => '' }) });
    const system = new SystemApi(host).api();
    await expect(system.checkDeviceSupportHevc({})).resolves.toMatchObject({ supportHevc: false });
  });
});

describe('restartMiniProgram 与 preDownloadSubpackage', () => {
  const routeHost = () => ({ ...host, restart: vi.fn(), pages: vi.fn(() => []), navigate: vi.fn(), back: vi.fn() });

  it('重启调用宿主 restart 且带 path / 缺省语义正确', async () => {
    const hostStub = routeHost();
    const route = new RouteApi(hostStub).api();
    await route.restartMiniProgram({ path: 'pages/other/index' });
    expect(hostStub.restart).toHaveBeenCalledWith('pages/other/index');
    await route.restartMiniProgram({});
    expect(hostStub.restart).toHaveBeenLastCalledWith(undefined);
  });

  it('分包不存在时返回官方 module not found，packageType 越界报错', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal('__wxConfig', { subpackages: [{ root: 'pkg-a', pages: ['pages/leaf'] }] });
    const route = new RouteApi(routeHost()).api();
    await expect(route.preDownloadSubpackage({ name: 'pkg-missing' })).rejects.toEqual({
      errMsg: 'preDownloadSubpackage:fail module not found'
    });
    await expect(route.preDownloadSubpackage({ name: 'pkg-a', packageType: 'video' })).rejects.toEqual({
      errMsg: 'preDownloadSubpackage:fail invalid packageType "video"'
    });
    await expect(route.preDownloadSubpackage({ name: 'pkg-a', packageType: 'workers' })).resolves.toMatchObject({ errMsg: 'preDownloadSubpackage:ok' });
  });

  it('预下载会提前执行分包页面模块', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    vi.stubGlobal('__wxConfig', { subpackages: [{ root: '/pkg-a/', pages: ['pages/leaf'] }] });
    let executed = false;
    registerModule('pkg-a/pages/leaf', (_request: any, _module: any, exports: any) => {
      executed = true;
      exports.marker = 'leaf';
    });
    const route = new RouteApi(routeHost()).api();
    await expect(route.preDownloadSubpackage({ name: 'pkg-a' })).resolves.toMatchObject({ errMsg: 'preDownloadSubpackage:ok' });
    expect(executed).toBe(true);
    expect(loadModule('pkg-a/pages/leaf').marker).toBe('leaf');
  });
});

describe('authorizeForMiniProgram', () => {
  it('白名单外的 scope 返回官方失败信息且不弹授权框', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
    const overlay = vi.fn();
    const open = new OpenApi({ overlay } as any);
    await expect(open.api().authorizeForMiniProgram({ scope: 'scope.userInfo' })).rejects.toEqual({
      errMsg: 'authorizeForMiniProgram:fail scope "scope.userInfo" is not supported to be authorized by plugin.'
    });
    expect(overlay).not.toHaveBeenCalled();
  });
});
