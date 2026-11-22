/**
 * 系统信息、设备能力、传感器、剪贴板
 *
 * 浏览器能提供的都接真实能力（网络状态、剪贴板、振动、传感器、屏幕常亮），
 * 不能提供的（机型、电量）给稳定的模拟值，保证业务代码拿到结构正确的数据。
 */

import type { WxHost } from './types';
import { afterRender } from '../store';
import { deliver, invoke, numberOr, syncResult } from './util';
import { IdleCallbacks } from './idle';

const SDK_VERSION = '3.7.0';

export class SystemApi {
  private brightness = 0.8;
  private keepScreenOn = false;
  private accelerometer = 0;
  private compass = 0;
  private gyroscope = 0;
  private motion = 0;
  private wakeLock: any = null;
  private bound = false;
  private cleanups: Array<() => void> = [];
  private idle = new IdleCallbacks();
  private disposed = false;

  constructor(private readonly host: WxHost) {}

  private menuButtonRect() {
    const device = this.host.deviceInfo();
    const width = 87;
    const height = 32;
    const top = device.statusBarHeight + 6;
    const right = device.screenWidth - 7;
    return { width, height, top, right, bottom: top + height, left: right - width };
  }

  private windowInfo() {
    const device = this.host.deviceInfo();
    const safeBottom = device.screenHeight - device.safeAreaBottom;
    return {
      pixelRatio: device.pixelRatio,
      screenWidth: device.screenWidth,
      screenHeight: device.screenHeight,
      windowWidth: device.screenWidth,
      windowHeight: device.windowHeight,
      windowTop: 0,
      windowBottom: 0,
      statusBarHeight: device.statusBarHeight,
      screenTop: device.windowTop,
      safeArea: {
        left: 0,
        right: device.screenWidth,
        top: device.statusBarHeight,
        bottom: safeBottom,
        width: device.screenWidth,
        height: Math.max(0, safeBottom - device.statusBarHeight)
      }
    };
  }

  private deviceInfo() {
    const device = this.host.deviceInfo();
    return {
      brand: 'devtools',
      model: device.model,
      system: device.system,
      platform: device.platform,
      benchmarkLevel: 1,
      abi: 'arm64',
      deviceAbi: 'arm64',
      cpuType: 'unknown',
      memorySize: 4096,
      cpuType_: undefined
    };
  }

  private appBaseInfo() {
    const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    return {
      SDKVersion: SDK_VERSION,
      enableDebug: false,
      host: { env: 'WeChat', appId: '' },
      language: 'zh_CN',
      version: '8.0.50',
      theme: dark ? 'dark' : 'light',
      fontSizeSetting: 16
    };
  }

  private systemSetting() {
    const online = typeof navigator === 'undefined' ? true : navigator.onLine;
    return {
      bluetoothEnabled: true,
      locationEnabled: true,
      wifiEnabled: online,
      deviceOrientation: 'portrait'
    };
  }

  private networkType(): string {
    const connection = (navigator as any)?.connection;
    const type = connection?.type;
    if (type === 'wifi' || type === 'ethernet') return 'wifi';
    if (type === 'none') return 'none';
    const effective = connection?.effectiveType;
    if (effective === 'slow-2g' || effective === '2g') return '2g';
    if (effective === '3g') return '3g';
    if (effective === '4g') return '4g';
    return navigator.onLine === false ? 'none' : 'wifi';
  }

  /** 把浏览器事件接到 wx.onXxx 上，只接一次 */
  attach() {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;
    const listen = <K extends keyof WindowEventMap>(name: K, callback: (event: WindowEventMap[K]) => void) => {
      window.addEventListener(name, callback);
      this.cleanups.push(() => window.removeEventListener(name, callback));
    };

    listen('online', () => this.host.emit('networkStatusChange', { isConnected: true, networkType: this.networkType() }));
    listen('offline', () => this.host.emit('networkStatusChange', { isConnected: false, networkType: 'none' }));

    // 官方 onMenuButtonBoundingClientRectWeightChange：胶囊矩形变化时触发
    let lastRect: Record<string, number> | null = null;
    const onRectChange = () => {
      const rect = this.menuButtonRect();
      if (lastRect && JSON.stringify(rect) === JSON.stringify(lastRect)) return;
      lastRect = rect;
      this.host.emit('menuButtonRectChange', { ...rect });
    };
    listen('resize', onRectChange);
    listen('orientationchange', onRectChange);

    const theme = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const onTheme = (event: MediaQueryListEvent) => this.host.emit('themeChange', { theme: event.matches ? 'dark' : 'light' });
    theme?.addEventListener?.('change', onTheme);
    this.cleanups.push(() => theme?.removeEventListener?.('change', onTheme));

    listen('devicemotion', event => {
      const acc = event.accelerationIncludingGravity;
      if (acc && this.accelerometer) {
        this.host.emit('accelerometerChange', {
          x: round(acc.x ?? 0) / 9.81,
          y: round(acc.y ?? 0) / 9.81,
          z: round(acc.z ?? 0) / 9.81
        });
      }
      if (event.rotationRate && this.gyroscope) {
        this.host.emit('gyroscopeChange', {
          x: round(event.rotationRate.beta ?? 0),
          y: round(event.rotationRate.gamma ?? 0),
          z: round(event.rotationRate.alpha ?? 0)
        });
      }
    });

    listen('deviceorientation', event => {
      if (this.compass) {
        this.host.emit('compassChange', { direction: round(event.alpha ?? 0) % 360 });
      }
      if (this.motion) {
        this.host.emit('deviceMotionChange', {
          alpha: round(event.alpha ?? 0),
          beta: round(event.beta ?? 0),
          gamma: round(event.gamma ?? 0)
        });
      }
    });

    if (navigator.storage?.estimate) {
      navigator.storage
        .estimate()
        .then(info => {
          if (info.quota && info.usage && info.usage / info.quota > 0.9) {
            this.host.emit('memoryWarning', { level: 10 });
          }
        })
        .catch(() => undefined);
    }
  }

  dispose() {
    this.disposed = true;
    this.idle.dispose();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.bound = false;
    this.accelerometer = this.compass = this.gyroscope = this.motion = 0;
    void this.setKeepScreenOn(false);
  }

  private preloadAssets(options: any = {}): void {
    if (this.disposed) return;
    const opts = options ?? {};
    const type = (value: unknown) => Object.prototype.toString.call(value).slice(8, -1);
    let error = '';
    if (type(opts) !== 'Object') error = `parameter should be Object instead of ${type(opts)};`;
    else if (!Array.isArray(opts.data)) error = `parameter.data should be Array instead of ${type(opts.data)};`;
    else if (!opts.data.length) error = 'parameter.data should have at least 1 item;';
    else if (type(opts.data[0]) !== 'Object') error = `parameter.data[0] should be Object instead of ${type(opts.data[0])};`;
    else {
      for (const name of ['src', 'type']) {
        if (typeof opts.data[0][name] !== 'string') error += `parameter.data[0].${name} should be String instead of ${type(opts.data[0][name])};`;
      }
    }
    if (error || opts.data.some((asset: any) => !asset?.src || !['image', 'font'].includes(asset?.type))) {
      const result = { errno: 1001, errMsg: error ? `preloadAssets:fail parameter error: ${error}` : 'preloadAssets:fail' };
      deliver(opts.fail, result);
      deliver(opts.complete, result);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const asset of opts.data) {
      const link = document.createElement('link');
      link.rel = 'preload';
      link.as = asset.type;
      link.href = asset.src;
      fragment.appendChild(link);
      this.cleanups.push(() => link.remove());
    }
    document.head.appendChild(fragment);
    queueMicrotask(() => {
      if (this.disposed) return;
      const result = { errMsg: 'preloadAssets:ok' };
      deliver(opts.success, result);
      deliver(opts.complete, result);
    });
  }

  async setKeepScreenOn(on: boolean): Promise<void> {
    this.keepScreenOn = on;
    const wakeLock = (navigator as any).wakeLock;
    if (!wakeLock) return;
    if (on) {
      try {
        this.wakeLock = await wakeLock.request('screen');
      } catch {
        /* 需要用户手势或页面不可见 */
      }
    } else {
      try {
        await this.wakeLock?.release?.();
      } catch {
        /* 忽略 */
      }
      this.wakeLock = null;
    }
  }

  api() {
    const system = (type?: string) => {
      if (type === 'windowInfo') return this.windowInfo();
      if (type === 'deviceInfo') return this.deviceInfo();
      if (type === 'appBaseInfo') return this.appBaseInfo();
      if (type === 'systemSetting') return this.systemSetting();
      return {
        ...this.deviceInfo(),
        ...this.windowInfo(),
        ...this.appBaseInfo(),
        ...this.systemSetting(),
        albumAuthorized: true,
        cameraAuthorized: true,
        locationAuthorized: true,
        microphoneAuthorized: true,
        notificationAuthorized: true,
        errMsg: 'getSystemInfoSync:ok'
      };
    };

    const screen = {
      width: this.host.deviceInfo().screenWidth,
      height: this.host.deviceInfo().screenHeight
    };

    return {
      preloadAssets: (options?: any) => this.preloadAssets(options),
      getRendererUserAgent: (options?: any) => new Promise<string>(resolve => {
        const userAgent = navigator.userAgent;
        const result = { userAgent, errMsg: 'getRendererUserAgent:ok' };
        deliver(options?.success, result);
        deliver(options?.complete, result);
        resolve(userAgent);
      }),
      getApiCategory: () => (globalThis as any).__wxConfig?.apiCategory ?? 'default',
      getSystemInfoSync: (options?: any) => system(options?.type),
      getSystemInfo: (options: any) => invoke('getSystemInfo', options, opts => system(opts?.type)),
      getSystemInfoAsync: (options: any) => invoke('getSystemInfoAsync', options, opts => system(opts?.type)),
      getWindowInfo: () => syncResult('getWindowInfo', this.windowInfo()),
      getDeviceInfo: () => syncResult('getDeviceInfo', this.deviceInfo()),
      getAppBaseInfo: () => syncResult('getAppBaseInfo', this.appBaseInfo()),
      getSystemSetting: () => syncResult('getSystemSetting', this.systemSetting()),
      getAppAuthorizeSetting: () =>
        syncResult('getAppAuthorizeSetting', {
          albumAuthorized: 'authorized',
          bluetoothAuthorized: 'authorized',
          cameraAuthorized: 'authorized',
          locationAuthorized: 'authorized',
          locationReducedAccuracy: false,
          microphoneAuthorized: 'authorized',
          notificationAuthorized: 'authorized',
          phoneCalendarAuthorized: 'authorized'
        }),
      getNetworkType: (options: any) =>
        invoke('getNetworkType', options, () => ({
          networkType: this.networkType(),
          signalStrength: 100,
          hasSystemProxy: false
        })),
      onNetworkStatusChange: (callback: (res: any) => void) => this.host.on('networkStatusChange', callback),
      offNetworkStatusChange: (callback?: (res: any) => void) => this.host.off('networkStatusChange', callback),
      // 官方 3.7.0：弱网事件来自原生通道（devtools 需在面板模拟），宿主没有等价触发源，
      // 这里只提供注册通道，触发由宿主桥接注入，不虚构阈值
      onNetworkWeakChange: (callback: (res: any) => void) => this.host.on('networkWeakChange', callback),
      offNetworkWeakChange: (callback?: (res: any) => void) => this.host.off('networkWeakChange', callback),
      getBatteryInfo: (options: any) =>
        invoke('getBatteryInfo', options, async () => {
          const battery = await (navigator as any).getBattery?.().catch(() => null);
          return battery ? { level: Math.round(battery.level * 100), isCharging: battery.charging } : { level: 100, isCharging: true };
        }),
      getBatteryInfoSync: () => syncResult('getBatteryInfoSync', { level: 100, isCharging: true }),
      // 官方 3.7.0：电池变化事件同样来自原生通道，宿主不虚构触发
      onBatteryInfoChange: (callback: (res: any) => void) => this.host.on('batteryInfoChange', callback),
      offBatteryInfoChange: (callback?: (res: any) => void) => this.host.off('batteryInfoChange', callback),
      // 官方 3.7.0：宿主环境用浏览器真实解码能力回答（devtools 由原生端回答）
      checkDeviceSupportHevc: (options: any) =>
        invoke('checkDeviceSupportHevc', options, () => {
          const video = document.createElement('video');
          const supportHevc =
            video.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') !== '' || video.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"') !== '';
          return { supportHevc };
        }),
      getMenuButtonBoundingClientRect: () => this.menuButtonRect(),
      onMenuButtonBoundingClientRectWeightChange: (callback: (res: any) => void) => this.host.on('menuButtonRectChange', callback),
      offMenuButtonBoundingClientRectWeightChange: (callback?: (res: any) => void) => this.host.off('menuButtonRectChange', callback),
      getScreenBrightness: (options: any) => invoke('getScreenBrightness', options, () => ({ value: this.brightness })),
      setScreenBrightness: (options: any) =>
        invoke('setScreenBrightness', options, opts => {
          this.brightness = Math.min(1, Math.max(0, numberOr(opts.value, this.brightness)));
          return {};
        }),
      setKeepScreenOn: (options: any) =>
        invoke('setKeepScreenOn', options, async opts => {
          await this.setKeepScreenOn(!!opts.keepScreenOn);
          return {};
        }),
      onUserCaptureScreen: (callback: () => void) => this.host.on('userCaptureScreen', callback),
      offUserCaptureScreen: (callback?: () => void) => this.host.off('userCaptureScreen', callback),
      onMemoryWarning: (callback: (res: any) => void) => this.host.on('memoryWarning', callback),
      offMemoryWarning: (callback?: (res: any) => void) => this.host.off('memoryWarning', callback),

      vibrateShort: (options: any) =>
        invoke('vibrateShort', options, opts => {
          navigator.vibrate?.(opts?.type === 'heavy' ? 30 : opts?.type === 'medium' ? 20 : 15);
          return {};
        }),
      vibrateLong: (options: any) =>
        invoke('vibrateLong', options, () => {
          navigator.vibrate?.(400);
          return {};
        }),

      setClipboardData: (options: any) =>
        invoke('setClipboardData', options, async opts => {
          const text = String(opts.data ?? '');
          if (navigator.clipboard?.writeText) {
            try {
              await navigator.clipboard.writeText(text);
              return {};
            } catch {
              /* 回退到 execCommand */
            }
          }
          copyFallback(text);
          return {};
        }),
      getClipboardData: (options: any) =>
        invoke('getClipboardData', options, async () => {
          if (navigator.clipboard?.readText) {
            return { data: await navigator.clipboard.readText() };
          }
          return { data: '' };
        }),

      // 传感器
      startAccelerometer: (options: any) =>
        invoke('startAccelerometer', options, opts => {
          this.accelerometer = numberOr(opts?.interval, 60);
          return {};
        }),
      stopAccelerometer: (options: any) =>
        invoke('stopAccelerometer', options, () => {
          this.accelerometer = 0;
          return {};
        }),
      onAccelerometerChange: (callback: (res: any) => void) => this.host.on('accelerometerChange', callback),
      offAccelerometerChange: (callback?: (res: any) => void) => this.host.off('accelerometerChange', callback),

      startCompass: (options: any) =>
        invoke('startCompass', options, () => {
          this.compass = 1;
          return {};
        }),
      stopCompass: (options: any) =>
        invoke('stopCompass', options, () => {
          this.compass = 0;
          return {};
        }),
      onCompassChange: (callback: (res: any) => void) => this.host.on('compassChange', callback),
      offCompassChange: (callback?: (res: any) => void) => this.host.off('compassChange', callback),

      startGyroscope: (options: any) =>
        invoke('startGyroscope', options, () => {
          this.gyroscope = 1;
          return {};
        }),
      stopGyroscope: (options: any) =>
        invoke('stopGyroscope', options, () => {
          this.gyroscope = 0;
          return {};
        }),
      onGyroscopeChange: (callback: (res: any) => void) => this.host.on('gyroscopeChange', callback),
      offGyroscopeChange: (callback?: (res: any) => void) => this.host.off('gyroscopeChange', callback),

      startDeviceMotionListening: (options: any) =>
        invoke('startDeviceMotionListening', options, () => {
          this.motion = 1;
          return {};
        }),
      stopDeviceMotionListening: (options: any) =>
        invoke('stopDeviceMotionListening', options, () => {
          this.motion = 0;
          return {};
        }),
      onDeviceMotionChange: (callback: (res: any) => void) => this.host.on('deviceMotionChange', callback),
      offDeviceMotionChange: (callback?: (res: any) => void) => this.host.off('deviceMotionChange', callback),

      // 窗口 / 主题 / 其它系统事件
      onWindowResize: (callback: (res: any) => void) => this.host.on('windowResize', callback),
      offWindowResize: (callback?: (res: any) => void) => this.host.off('windowResize', callback),
      onWindowSizeChange: (callback: (res: any) => void) => this.host.on('windowResize', callback),
      offWindowSizeChange: (callback?: (res: any) => void) => this.host.off('windowResize', callback),
      onThemeChange: (callback: (res: any) => void) => this.host.on('themeChange', callback),
      offThemeChange: (callback?: (res: any) => void) => this.host.off('themeChange', callback),
      // 官方 3.7.0：懒加载分包 js 失败事件（type/subpackage/errMsg）；
      // 引擎按 lazyCodeLoading 懒加载时才可能触发，宿主桥接也可注入
      onLazyLoadError: (callback: (res: any) => void) => this.host.on('lazyLoadError', callback),
      offLazyLoadError: (callback?: (res: any) => void) => this.host.off('lazyLoadError', callback),

      // 字体：网络字体用 FontFace 真实加载
      loadFontFace: (options: any) =>
        invoke('loadFontFace', options, async opts => {
          if (!('FontFace' in globalThis) || !opts.family) return {};
          const source = opts.source ? `url(${JSON.stringify(opts.source)})` : opts.global ? 'local("sans-serif")' : 'local("sans-serif")';
          const face = new FontFace(opts.family, source);
          await face.load();
          (document.fonts as FontFaceSet & { add(font: FontFace): void }).add(face);
          return {};
        }),

      makePhoneCall: (options: any) =>
        invoke('makePhoneCall', options, opts => {
          if (!opts.phoneNumber) throw new Error('parameter error: "phoneNumber" is required');
          window.open(`tel:${opts.phoneNumber}`, '_self');
          return {};
        }),

      // 屏幕常亮与亮度仅供查询
      getScreenInfo: () => syncResult('getScreenInfo', screen),

      nextTick: (fn: () => void) => afterRender(fn),
      requestIdleCallback: (callback: IdleRequestCallback, options?: IdleRequestOptions) => this.idle.request(callback, options),
      cancelIdleCallback: (id: number) => this.idle.cancel(id),
      getLaunchOptionsSync: () => this.host.launchOptions(),
      getEnterOptionsSync: () => this.host.launchOptions()
    };
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function copyFallback(text: string) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand?.('copy');
  area.remove();
}
