/**
 * 运行时入口：应用外壳（导航栏 / tabBar）、页面栈、模板与组件注册
 *
 * 单文档、单 realm：页面就是 `<wx-page>` 容器，没有 iframe，也没有消息桥。
 */

import { createApi, type LaunchOptions } from './api';
import { Builder, type ScopeMark } from './builder';
import { selectedComponents } from './selectors';
import { filterDefinition, registerBehavior } from './behaviors';
import { pageStyles } from './styles';
import { createComponent, flattenPage, flushComponentLifecycles, type ComponentContext, type ComponentHandle } from './component';
import { createRequire, currentModule, hasModule, loadModule, normalize, registerModule, resetModules, setResolveAlias } from './modules';
import { defineNativeElements, NATIVE_CSS, setNavigator } from './native';
import { animateIn, clearIn, disposeAnimations, lastFunction, parseAnimateOptions } from './animate';
import { installGestureLayer } from './gesture';
import { logicalElements } from './hosts';
import type { RenderParent } from './range';
import { DEFAULT_DEVICE, PhoneShell, type DeviceProfile } from './shell';
import { afterRender, Store, type Scope } from './store';

type TemplateFn = (builder: Builder, parent: RenderParent) => void;

export interface PageConfig {
  navigationBarTitleText?: string;
  navigationBarBackgroundColor?: string;
  navigationBarTextStyle?: string;
  navigationStyle?: string;
  backgroundColor?: string;
  backgroundColorTop?: string;
  backgroundColorBottom?: string;
  backgroundTextStyle?: string;
  enablePullDownRefresh?: boolean;
  onReachBottomDistance?: number;
  disableScroll?: boolean;
  usingComponents?: Record<string, string>;
}

export interface AppConfig {
  pages: string[];
  lazyCodeLoading?: 'requiredComponents';
  subpackages?: Array<{ root: string; pages: string[]; independent?: boolean }>;
  networkTimeout?: Record<string, number>;
  requiredPrivateInfos?: string[];
  permission?: Record<string, { desc?: string }>;
  /** 构建期打包好的 worker 入口 */
  workers?: string[];
  /** app.json.plugins 里带本地 path 的插件：名字 → 模块 id */
  pluginEntries?: Record<string, string>;
  /** ext.json 里的 ext 字段 */
  extConfig?: Record<string, any>;
  /** app.json 的 resolveAlias：仅影响 require 路径 */
  resolveAlias?: Record<string, string>;
  entry?: string;
  window?: {
    navigationBarTitleText?: string;
    navigationBarBackgroundColor?: string;
    navigationBarTextStyle?: string;
    navigationStyle?: string;
    backgroundColor?: string;
    backgroundTextStyle?: string;
  };
  tabBar?: {
    custom?: boolean;
    color?: string;
    selectedColor?: string;
    backgroundColor?: string;
    borderStyle?: string;
    list: Array<{ pagePath: string; text?: string }>;
  };
  pageConfig?: Record<string, PageConfig>;
  componentConfig?: Record<string, any>;
  scopes?: { pages?: Record<string, string>; components?: Record<string, string> };
}

const templates = new Map<string, { fn: TemplateFn; wxs: Record<string, string> }>();
const pageDefs = new Map<string, any>();
const componentDefs = new Map<string, any>();

let appDef: any = null;
let runtime: Runtime | null = null;

export function define(id: string, fn: TemplateFn, wxs: Record<string, string> = {}) {
  templates.set(id, { fn, wxs });
}

export function module(id: string, fn: (require: (request: string) => any, module: any, exports: any) => void) {
  registerModule(id, fn);
}

/** 把 Page / Component 的调用记到「当前正在执行的模块」名下 */
export function Page(definition: any) {
  const id = currentModule();
  if (id) pageDefs.set(id, definition);
}

export function Component(definition: any) {
  filterDefinition(definition);
  const id = currentModule();
  if (id) componentDefs.set(id, definition);
}

export function App(definition: any) {
  appDef = definition;
}

export function Behavior(definition: any) {
  return registerBehavior(definition);
}

export function getApp(options?: { allowDefault?: boolean }) {
  return runtime?.application(options?.allowDefault === true);
}

const PAGE_CSS = `
:root { --fmp-rpx: 0.5px; }
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.fmp-pages { --fmp-pull: 0px; }
.fmp-pages wx-page { position: absolute; top: var(--fmp-pull, 0px); right: 0; bottom: 0; left: 0; display: block; overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch; box-sizing: border-box;
  /* position:fixed 由外层非滚动容器 .fmp-pages (transform: translateZ(0)) 充当包含块；
     wx-page 自身不能设 transform，否则 fixed 元素会跟随 wx-page 一起滚动 */
  transition: top .2s ease-out; }
.fmp-pages wx-page[hidden] { display: none; }
.fmp-refresher { transition: opacity .2s ease; }
wx-slot, wx-slot-body { display: contents; }
wx-page [hidden] { display: none !important; }
.fmp-choose-location, .fmp-choose-poi { position: absolute; inset: 0; z-index: 20; display: flex; align-items: flex-end; background: rgba(0,0,0,.5); pointer-events: auto; }
.fmp-open-location { position: absolute; inset: 0; z-index: 20; background: #fff; color: #222; padding: 16px; box-sizing: border-box; overflow: auto; pointer-events: auto; }
.fmp-open-location > button { float: right; padding: 8px 16px; border: 0; border-radius: 4px; cursor: pointer; }
.fmp-location-center { display: block; width: 100%; padding: 12px; border: 0; background: #f2f2f2; text-align: left; cursor: pointer; }
.fmp-choose-location-panel, .fmp-choose-poi-panel { width: 100%; max-height: 88%; overflow: auto; background: #fff; border-radius: 12px 12px 0 0; padding: 16px; box-sizing: border-box; }
.fmp-choose-location-title, .fmp-choose-poi-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
.fmp-choose-location-map { position: relative; height: 160px; background: linear-gradient(135deg, #dfe8dc, #eef2ea 45%, #dce7f2); border-radius: 8px; overflow: hidden; }
.fmp-choose-location-pin { position: absolute; left: 50%; top: 50%; width: 12px; height: 12px; margin: -14px 0 0 -6px; border-radius: 50% 50% 50% 0; background: #fa5151; transform: rotate(-45deg); box-shadow: 0 1px 3px rgba(0,0,0,.3); }
.fmp-choose-location-hint { position: absolute; left: 8px; bottom: 8px; font-size: 11px; color: #5a6b5a; }
.fmp-choose-location-fields { display: grid; gap: 8px; margin: 12px 0; }
.fmp-choose-location-fields label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #555; }
.fmp-choose-location-fields input { flex: 1; min-width: 0; border: 1px solid #e0e0e0; border-radius: 6px; padding: 6px 8px; font-size: 13px; }
.fmp-choose-location-actions { display: flex; gap: 8px; }
.fmp-choose-location-actions button { flex: 1; height: 40px; border: 0; border-radius: 6px; font-size: 15px; background: #f2f2f2; }
.fmp-choose-location-actions .fmp-choose-location-ok { background: #07c160; color: #fff; }
.fmp-choose-poi-item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 10px 8px; border: 0; border-bottom: 1px solid #f0f0f0; background: none; font-size: 14px; text-align: left; }
.fmp-choose-poi-item span { font-size: 12px; color: #999; }
.fmp-choose-poi-cancel { width: 100%; height: 42px; margin-top: 8px; border: 0; border-radius: 6px; background: #f2f2f2; font-size: 15px; }
`;

function injectStyles(screenWidth: number) {
  const style = document.createElement('style');
  style.setAttribute('data-fmp', 'page');
  style.textContent = PAGE_CSS + NATIVE_CSS;
  document.head.appendChild(style);

  // rpx 基准是「页面宽度」，外壳里的页面宽度就是设备宽度（不是浏览器窗口）
  const sync = () => document.documentElement.style.setProperty('--fmp-rpx', `${screenWidth / 750}px`);
  sync();
}

interface PageRecord {
  route: string;
  query: Record<string, string>;
  el: HTMLElement;
  store: Store;
  instance: any;
  holder: ReturnType<Store['holder']>;
  builder: Builder;
  cleanups: Array<() => void>;
  component?: ComponentHandle;
  tabBar?: ComponentHandle;
}

function parseUrl(url: string, from = ''): { route: string; query: Record<string, string> } {
  const [pathPart, ...queryParts] = url.split('?');
  const queryPart = queryParts.join('?');
  const path = decodeURIComponent(pathPart).replace(/\.html$/, '');
  const route = normalize(path.startsWith('.') ? `${from.slice(0, from.lastIndexOf('/'))}/${path}` : path);
  const query: Record<string, string> = {};
  if (queryPart) {
    // 官方把查询串原样交给页面：已编码的 %XX 不再解码一次
    for (const pair of queryPart.split('&')) {
      if (!pair) continue;
      const at = pair.indexOf('=');
      query[at < 0 ? pair : pair.slice(0, at)] = at < 0 ? '' : pair.slice(at + 1);
    }
  }
  return { route, query };
}

function clone<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

class Runtime {
  appInstance: any;
  private defaultApp: any;
  private readyPackages = new Set<string>();
  private loadingPackages = new Map<string, Promise<void>>();

  application(allowDefault = false) {
    if (this.appInstance) return this.appInstance;
    if (allowDefault) return (this.defaultApp ??= {});
    return undefined;
  }

  private packageOf(id: string) {
    const pkgs: Array<{ root: string; pages?: string[]; independent?: boolean }> =
      this.config.subpackages ?? (this.config as any).subPackages ?? [];
    return pkgs.find(pkg => {
      const base = String(pkg?.root ?? '').replace(/^\/+|\/+$/g, '');
      return base && (id === base || id.startsWith(`${base}/`));
    });
  }

  private initializeApp() {
    if (this.appInstance) return;
    if (hasModule('app')) loadModule('app');
    if (!appDef) return;
    this.appInstance = this.defaultApp ?? {};
    Object.setPrototypeOf(this.appInstance, appDef);
    this.appInstance.globalData = { ...appDef.globalData, ...this.appInstance.globalData };
    this.safely(() => appDef.onLaunch?.call(this.appInstance, { ...this.launch }), 'app.onLaunch');
    this.safely(() => appDef.onShow?.call(this.appInstance, { ...this.launch }), 'app.onShow');
  }

  private preparePackage(root: string): Promise<void> {
    if (this.readyPackages.has(root)) return Promise.resolve();
    let pending = this.loadingPackages.get(root);
    if (!pending) {
      pending = Promise.resolve().then(() => {
        this.readyPackages.add(root);
      });
      this.loadingPackages.set(root, pending);
    }
    return pending;
  }

  private mountComponent(
    el: Element,
    id: string,
    parent: any,
    listeners: Record<string, string>,
    props: Record<string, unknown>,
    options?: Parameters<ComponentContext['mount']>[5]
  ): ComponentHandle {
    const mount = (target: string, values: Record<string, unknown>) =>
      createComponent(this.context, el, target, values, listeners, parent, {
        ...options,
        attributeProps: true,
        page: options?.page ?? this.top()?.instance ?? null,
        onDispose: callback => this.top()?.cleanups.push(callback)
      });
    const config = this.context.configOf?.(parent?.is ?? parent?.route) ?? {};
    const tag = Object.keys(config.usingComponents ?? {}).find(name => config.usingComponents[name] === id);
    const placeholder = config.componentPlaceholder?.[tag ?? ''];
    const pkg = this.packageOf(id);
    if (!pkg || this.readyPackages.has(pkg.root) || !placeholder) return mount(id, props);
    const target = config.usingComponents?.[placeholder];
    let current: ComponentHandle | undefined;
    let native: Element | undefined;
    let disposed = false;
    let latest = props;
    if (target) current = mount(target, latest);
    else {
      native = document.createElement(`wx-${placeholder}`);
      el.appendChild(native);
      for (const [key, value] of Object.entries(latest)) native.setAttribute(key, String(value ?? ''));
    }
    void this.preparePackage(pkg.root)
      .then(() => {
        if (disposed || this.destroyed || parent?.__destroyed) return;
        current?.dispose();
        el.replaceChildren();
        delete (el as any).__wxComponent;
        current = mount(id, latest);
        native = undefined;
        flushComponentLifecycles();
      })
      .catch(error => this.reportError(error));
    return {
      get instance() {
        return current?.instance;
      },
      setProps(next) {
        latest = next;
        current?.setProps(next);
        if (native) for (const [key, value] of Object.entries(next)) native.setAttribute(key, String(value ?? ''));
      },
      dispose() {
        disposed = true;
        current?.dispose();
        native?.remove();
      }
    };
  }

  private stack: PageRecord[] = [];
  private cachedTabs = new Map<string, PageRecord>();
  private launched = false;
  private shell!: PhoneShell;
  private tabRoutes: string[] = [];
  private bus = new Map<string, Array<(...args: any[]) => void>>();
  private pendingChannel: any = null;
  private routeEventId = '';
  private routeSequence = 0;
  private pageSequence = 0;
  private launch: LaunchOptions;
  private bindings: Array<() => void> = [];
  private tabBarCallbacks = new WeakMap<any, Array<(tabBar: any) => void>>();
  readonly context: ComponentContext;
  readonly wx: any;
  private destroyed = false;
  private readonly ready: Promise<void>;
  private readonly disposeApi: () => void;

  constructor(
    readonly config: AppConfig,
    private readonly container: Element,
    private readonly device: DeviceProfile = DEFAULT_DEVICE
  ) {
    setResolveAlias(config.resolveAlias);
    this.launch = {
      path: (config.entry ?? config.pages[0]).replace(/^\//, ''),
      query: {},
      scene: 1001,      referrerInfo: {}
    };

    this.context = {
      render: (id, builder, el) => this.render(id, builder, el),
      define: id => {
        if (!componentDefs.has(id)) loadModule(id);
        return componentDefs.get(id);
      },
      mount: (el, id, parentInstance, listeners, props, options) => this.mountComponent(el, id, parentInstance, listeners, props, options),
      reportError: error => this.reportError(error),
      configOf: id => config.componentConfig?.[id] ?? config.pageConfig?.[id] ?? {},
      scopeOf: id => this.scopeOf('components', 'fmp-component', id)
    };

    const host = {
      navigate: (url: string, mode?: 'navigate' | 'redirect' | 'reLaunch' | 'switchTab') => this.navigate(url, mode),
      back: (delta?: number) => this.back(delta),
      restart: (path?: string) => {
        // 微信的 restart 是异步重启：先响应当前任务，销毁重建放到下一轮任务
        queueMicrotask(() => restartRuntime(path));
      },
      pageElement: () => this.top()?.el ?? null,
      pageInstance: () => this.top()?.instance ?? null,
      pages: () => this.stack.map(record => record.instance),
      setNavigationBarTitle: (title: string) => {
        this.shell.setNavigation({ title });
      },
      setNavigationBarColor: (option: { frontColor?: string; backgroundColor?: string }) => {
        const current = this.shell.getNavigation();
        this.shell.setNavigation({
          backgroundColor: option.backgroundColor ?? current.backgroundColor,
          textStyle: option.frontColor ? (option.frontColor.toLowerCase() === '#ffffff' ? 'white' : 'black') : current.textStyle
        });
      },
      setNavigationBarLoading: (loading: boolean) => this.shell.setNavigationLoading(loading),
      setStatusBarHidden: (hidden: boolean) => this.shell.setStatusBarHidden(hidden),
      overlay: () => this.shell.overlay,
      deviceInfo: () => ({
        model: this.device.model,
        system: this.device.system,
        platform: this.device.platform,
        screenWidth: this.device.screenWidth,
        screenHeight: this.device.screenHeight,
        statusBarHeight: this.device.statusBarHeight,
        safeAreaBottom: this.device.safeAreaBottom,
        windowHeight: this.shell ? this.shell.windowHeight() : this.device.screenHeight - this.device.statusBarHeight - 44,
        windowTop: this.shell ? this.shell.screenTop() : this.device.statusBarHeight + 44,
        pixelRatio: this.device.pixelRatio
      }),
      setTabBarHidden: (hidden: boolean) => this.shell.setTabBarHidden(hidden),
      hasTabBar: (route: string) => this.shell.hasTabBar(parseUrl(route, this.top()?.route).route),
      updateTabBarItem: (index: number, item: any) => this.shell.updateTabBarItem(index, item),
      updateTabBarStyle: (style: any) => this.shell.updateTabBarStyle(style),
      setTabBarMark: (index: number, mark: any) => (this.config.tabBar?.custom ? false : this.shell.setTabBarMark(index, mark)),
      setBackgroundColor: (color: string) => this.shell.setBackgroundColor(color),
      setBackgroundTextStyle: (style: string) => this.shell.setBackgroundTextStyle(style),
      startPullDownRefresh: () => {
        this.shell.startPullDownRefresh();
        this.top()?.instance?.onPullDownRefresh?.call(this.top()!.instance);
      },
      stopPullDownRefresh: () => this.shell.stopPullDownRefresh(),
      setPageScrollTop: () => undefined,
      setPageOrientation: (orientation: string) => {
        const w = this.device.screenWidth;
        const h = this.shell ? this.shell.windowHeight() : this.device.screenHeight;
        const size =
          orientation === 'landscape'
            ? { windowWidth: Math.max(w, h), windowHeight: Math.min(w, h) }
            : { windowWidth: Math.min(w, h), windowHeight: Math.max(w, h) };
        const page = this.top();
        this.notifyComponents(page, 'resize', { size });
        this.safely(() => page?.instance?.onResize?.call(page.instance, { size }), 'page.onResize');
        this.emit('windowResize', { size });
      },
      on: (event: string, callback: (...args: any[]) => void) => this.on(event, callback),
      off: (event: string, callback?: (...args: any[]) => void) => this.off(event, callback),
      emit: (event: string, ...args: any[]) => this.emit(event, ...args),
      appInstance: () => this.appInstance,
      launchOptions: () => ({ ...this.launch }),
      pageStack: () => this.stack.map(record => record.instance),
      setOpenerChannel: (channel: any) => {
        this.pendingChannel = channel;
      }
    };

    const bundle = createApi(host, { networkTimeout: config.networkTimeout, requiredPrivateInfos: config.requiredPrivateInfos });
    this.wx = bundle.wx;
    this.ready = bundle.ready;
    this.disposeApi = bundle.dispose;
    (globalThis as any).wx = this.wx;
    (globalThis as any).require = createRequire('');
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    while (this.stack.length) this.destroyTop();
    for (const record of this.cachedTabs.values()) this.dispose(record);
    this.cachedTabs.clear();
    for (const cleanup of this.bindings) cleanup();
    this.bindings = [];
    this.disposeApi();
    this.shell?.destroy();
    this.bus.clear();
  }

  get pages() {
    return this.stack.map(record => record.instance);
  }

  private safely(fn: () => void, label: string) {
    try {
      fn();
    } catch (error) {
      console.error(`[fmp-engine] ${label} 出错`, error);
      this.reportError(error);
    }
  }

  private reportError(error: unknown) {
    setTimeout(() => this.deliverError(error), 0);
  }

  private deliverError(error: any) {
    if (this.destroyed) return;
    const message = String(error?.stack ?? error?.message ?? error);
    try {
      this.appInstance?.onError?.(message);
    } catch (nested) {
      console.error('[fmp-engine] app.onError 出错', nested);
    }
    this.emit('error', message);
  }

  on(event: string, callback: (...args: any[]) => void) {
    let listeners = this.bus.get(event);
    if (!listeners) {
      listeners = [];
      this.bus.set(event, listeners);
    }
    listeners.push(callback);
  }

  off(event: string, callback?: (...args: any[]) => void) {
    if (!callback) this.bus.delete(event);
    else {
      const listeners = this.bus.get(event);
      if (listeners) this.bus.set(event, listeners.filter(listener => listener !== callback));
    }
  }

  emit(event: string, ...args: any[]) {
    for (const callback of Array.from(this.bus.get(event) ?? [])) {
      try {
        callback(...args);
      } catch (error) {
        console.error(`[fmp-engine] ${event} 监听器抛错`, error);
      }
    }
  }

  private scopeOf(kind: 'pages' | 'components', attr: string, id: string): ScopeMark | undefined {
    const value = this.config.scopes?.[kind]?.[id];
    return value === undefined ? undefined : { attr, value };
  }

  flush() {
    this.top()?.store.flushSync();
  }

  async start() {
    await this.ready;
    if (this.destroyed) return;
    injectStyles(this.device.screenWidth);
    defineNativeElements();
    setNavigator((url, openType) => this.navigate(url, openType === 'redirect' ? 'redirect' : 'navigate'));

    this.shell = new PhoneShell(this.device, this.container);
    // 触摸序列 / 长按 / hover-class / catchtouchmove 都由手势层统一处理
    this.bindings.push(installGestureLayer(() => this.top()?.el ?? null));
    this.shell.on({
      onBack: () => this.back(1),
      onTabTap: (route, index) => {
        if (this.top()?.route === route) {
          const item = this.config.tabBar?.list?.[index];
          this.top()?.instance?.onTabItemTap?.call(this.top()!.instance, {
            index,
            pagePath: route,
            text: item?.text ?? ''
          });
          return;
        }
        this.navigate(route, 'switchTab');
      }
    });
    this.shell.onPullDown(() => {
      const page = this.top();
      if (!page) return;
      if (typeof page.instance?.onPullDownRefresh === 'function') {
        this.safely(() => page.instance.onPullDownRefresh.call(page.instance), `${page.route}.onPullDownRefresh`);
      } else {
        this.shell.stopPullDownRefresh();
      }
    });

    const tabBar = this.config.tabBar;
    if (tabBar?.list?.length) {
      this.tabRoutes = tabBar.list.map(item => item.pagePath);
      this.shell.setTabBarConfig(tabBar);
    }

    this.bindAppEvents();

    const entry = this.config.entry ?? this.config.pages[0];
    const pkg = this.packageOf(entry.split('?')[0]);
    if (pkg) this.readyPackages.add(pkg.root);
    if (!pkg?.independent) this.initializeApp();
    this.navigate(entry, 'reLaunch');
  }

  private bindAppEvents() {
    const onVisibility = () => {
      if (document.hidden) {
        this.safely(() => this.appInstance?.onHide?.(), 'app.onHide');
        this.emit('appHide');
      } else {
        this.safely(() => this.appInstance?.onShow?.({ ...this.launch }), 'app.onShow');
        this.emit('appShow', { ...this.launch });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.bindings.push(() => document.removeEventListener('visibilitychange', onVisibility));

    const onError = (event: ErrorEvent) => {
      this.deliverError(event.error ?? event.message);
    };
    window.addEventListener('error', onError);
    this.bindings.push(() => window.removeEventListener('error', onError));

    const onRejection = (event: PromiseRejectionEvent) => {
      const payload = { reason: event.reason, promise: event.promise };
      this.safely(() => appDef?.onUnhandledRejection?.call(this.appInstance, payload), 'app.onUnhandledRejection');
      this.emit('unhandledRejection', payload);
    };
    window.addEventListener('unhandledrejection', onRejection);
    this.bindings.push(() => window.removeEventListener('unhandledrejection', onRejection));

    const onResize = () => {
      const size = { windowWidth: this.device.screenWidth, windowHeight: this.shell.windowHeight() };
      const page = this.top();
      this.notifyComponents(page, 'resize', { size });
      this.safely(() => page?.instance?.onResize?.call(page.instance, { size }), 'page.onResize');
      this.emit('windowResize', { size });
    };
    window.addEventListener('resize', onResize);
    this.bindings.push(() => window.removeEventListener('resize', onResize));
  }

  /** 页面 onReady 所在的帧之后再执行：routeDone 的时序依赖它 */
  private afterReady(callback: () => void) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => callback());
    else queueMicrotask(callback);
  }

  private top(): PageRecord | undefined {
    return this.stack[this.stack.length - 1];
  }

  /** 组件 pageLifetimes：show / hide / resize / routeDone 跟随页面 */
  private notifyComponents(record: PageRecord | undefined, hook: 'show' | 'hide' | 'resize' | 'routeDone', payload: any = {}) {
    if (!record) return;
    for (const el of logicalElements(record.el)) {
      const instance = (el as any).__wxComponent;
      const hooks = instance?.__pageLifetimes?.[hook];
      if (!hooks?.length) continue;
      for (const fn of hooks) this.safely(() => fn.call(instance, payload), `${record.route}.pageLifetimes.${hook}`);
    }
  }

  private render(id: string, builder: Builder, el: RenderParent) {
    const record = templates.get(id);
    if (!record) {
      console.warn(`[fmp-engine] 没有模板：${id}`);
      return;
    }
    builder.setWxs(record.wxs);
    record.fn(builder, el);
  }

  private knownRoutes(): string[] {
    return this.config.pages;
  }

  /** 路由事件：beforeAppRoute → appRoute → appRouteDone */
  private navigate(url: string, mode: 'navigate' | 'redirect' | 'reLaunch' | 'switchTab' = 'navigate'): boolean {
    const previousEvent = this.routeEventId;
    this.routeEventId = String(++this.routeSequence);
    try {
      const { route, query } = parseUrl(url, this.top()?.route);
      const openType =
        mode === 'switchTab' ? 'switchTab' : mode === 'redirect' ? 'redirectTo' : mode === 'reLaunch' ? 'reLaunch' : 'navigateTo';
      const info = { path: `/${route}`, query, openType };
      this.emit('beforeAppRoute', info);
      const ok = this.navigateInner(url, mode);
      if (ok) {
        this.emit('appRoute', info);
        queueMicrotask(() => this.emit('appRouteDone', info));
        // routeDone 在页面 onReady 之后到达；onReady 排在同帧的 rAF 里，这里排在它后面
        const record = this.top();
        this.afterReady(() => {
          // 期间又发生了导航就不要再补发，否则上一页的组件会收到迟到的 routeDone
          if (this.top() === record) this.notifyComponents(record, 'routeDone');
        });
      }
      return ok;
    } finally {
      this.routeEventId = previousEvent;
    }
  }

  private navigateInner(url: string, mode: 'navigate' | 'redirect' | 'reLaunch' | 'switchTab' = 'navigate'): boolean {
    const { route, query } = parseUrl(url, this.top()?.route);
    const target = this.knownRoutes().find(page => page === route);
    if (!target) {
      console.warn(`[fmp-engine] 页面不存在：${route}`);
      // 官方 3.7.12 只在小程序启动的入口页不存在时触发 onPageNotFound；
      // navigateTo / redirectTo 指向未声明的页面只是失败，不派发这个钩子。
      if (!this.stack.length) {
        const payload = { path: route, query, isEntryPage: true };
        this.safely(() => this.appInstance?.onPageNotFound?.(payload), 'app.onPageNotFound');
        this.emit('pageNotFound', payload);
      }
      return false;
    }

    const pkg = this.packageOf(target);
    if (pkg) this.readyPackages.add(pkg.root);
    if (!pkg?.independent) this.initializeApp();
    if (this.config.lazyCodeLoading !== 'requiredComponents') {
      for (const id of Object.values(this.config.pageConfig?.[target]?.usingComponents ?? {})) {
        if (!this.packageOf(id) && hasModule(id)) loadModule(id);
      }
    }

    if (!pageDefs.has(target) && !componentDefs.has(target)) {
      try {
        loadModule(target);
      } catch {
        return false;
      }
      if (!pageDefs.has(target) && !componentDefs.has(target)) return false;
    }

    if (mode === 'switchTab') {
      if (this.stack.length === 1 && this.top()?.route === target) return true;
      const visible = this.top();
      while (this.stack.length) {
        const record = this.top()!;
        if (this.tabRoutes.includes(record.route)) {
          this.stack.pop();
          if (record === visible && record.route !== target) this.hide(record);
          this.cachedTabs.set(record.route, record);
        } else this.dispose(record);
      }
      const cached = this.cachedTabs.get(target);
      if (cached) {
        this.cachedTabs.delete(target);
        this.stack.push(cached);
        this.show(cached);
        return true;
      }
      return this.create(target, {});
    }

    if (mode === 'reLaunch') {
      while (this.stack.length) this.destroyTop();
      for (const record of this.cachedTabs.values()) this.dispose(record);
      this.cachedTabs.clear();
      return this.create(target, query);
    }

    if (mode === 'redirect') {
      this.destroyTop();
      return this.create(target, query);
    }

    const current = this.top();
    if (current) this.hide(current);
    const created = this.create(target, query);
    if (!created && current) this.show(current);
    return created;
  }

  private hide(record: PageRecord) {
    record.el.style.display = 'none';
    this.safely(() => record.instance.onHide?.call(record.instance), `${record.route}.onHide`);
    this.notifyComponents(record, 'hide');
  }

  private show(record: PageRecord) {
    record.el.style.display = '';
    this.applyPageChrome(record.route);
    this.safely(() => record.instance.onShow?.call(record.instance), `${record.route}.onShow`);
    this.notifyComponents(record, 'show');
    (globalThis as any).__fmp_page__ = record.instance;
  }

  private back(delta = 1) {
    if (this.stack.length <= 1) return;
    const previousEvent = this.routeEventId;
    this.routeEventId = String(++this.routeSequence);
    try {
      const index = Math.max(0, this.stack.length - 1 - delta);
      const record = this.stack[index];
      // 返回同样是一次完整路由：beforeAppRoute → beforePageUnload → appRoute → appRouteDone
      const info = { path: `/${record.route}`, query: {}, openType: 'navigateBack' };
      this.emit('beforeAppRoute', info);
      for (let i = 0; i < delta && this.stack.length > 1; i++) this.destroyTop();
      const current = this.top();
      if (!current) return;
      this.show(current);
      this.emit('appRoute', info);
      const shown = current;
      queueMicrotask(() => this.emit('appRouteDone', info));
      this.afterReady(() => {
        if (this.top() === shown) this.notifyComponents(shown, 'routeDone');
      });
    } finally {
      this.routeEventId = previousEvent;
    }
  }

  private destroyTop() {
    const record = this.top();
    if (record) this.dispose(record);
  }

  private dispose(record: PageRecord) {
    const event = { path: record.route, routeEventId: this.routeEventId };
    this.emit('beforePageUnload', { ...event, page: record.instance });
    this.safely(() => record.instance.onUnload?.call(record.instance), `${record.route}.onUnload`);
    record.tabBar?.dispose();
    record.tabBar?.instance.__el.remove();
    for (const cleanup of record.cleanups) {
      try {
        cleanup();
      } catch {
        /* 忽略清理异常 */
      }
    }
    if (record.component) record.component.dispose();
    else {
      record.builder.dispose();
      record.holder.dispose();
    }
    record.el.remove();
    const index = this.stack.indexOf(record);
    if (index >= 0) this.stack.splice(index, 1);
    this.emit('afterPageUnload', event);
  }

  private isIndependentPage(route: string): boolean {
    const pkgs: Array<{ root?: string; independent?: boolean }> =
      (this.config as any).subpackages ?? (this.config as any).subPackages ?? [];
    for (const pkg of pkgs) {
      if (!pkg?.independent) continue;
      const base = String(pkg.root ?? '').replace(/^\/+|\/+$/g, '');
      if (base && (route === base || route.startsWith(`${base}/`))) return true;
    }
    return false;
  }

  private create(route: string, query: Record<string, string>): boolean {
    try {
      if (!pageDefs.has(route) && !componentDefs.has(route)) loadModule(route);
    } catch (error) {
      console.error(`[fmp-engine] 加载页面失败：${route}`, error);
      return false;
    }
    const raw = pageDefs.get(route) ?? componentDefs.get(route);
    if (!raw) {
      console.warn(`[fmp-engine] 没有页面定义：${route}`);
      return false;
    }
    const definition = flattenPage(raw);
    const pageConfig = this.config.pageConfig?.[route] ?? {};
    this.emit('beforePageLoad', { path: route, query, componentFramework: 'exparser', routeEventId: this.routeEventId });

    if (!this.launched) {
      this.launch = { ...this.launch, path: route, query };
      this.launched = true;
    }

    const el = document.createElement('wx-page');
    const pageScope = this.scopeOf('pages', 'fmp-page', route);
    if (pageScope) el.setAttribute(pageScope.attr, pageScope.value);
    const pageBackground = pageConfig.backgroundColor ?? this.config.window?.backgroundColor;
    if (pageBackground) el.style.background = pageBackground;
    if (pageConfig.disableScroll) el.style.overflow = 'hidden';

    if (componentDefs.has(route) && !pageDefs.has(route)) return this.createComponentPage(route, query, el, pageConfig, pageScope);

    const store = new Store(clone(typeof definition.data === 'function' ? definition.data() : (definition.data ?? {})));
    const instance: any = Object.create(definition);
    instance.data = store.data;
    instance.route = route;
    instance.options = query;
    instance.__el = el;
    instance.__page = instance;
    const pageId = String(++this.pageSequence);
    instance.getPageId = () => pageId;
    instance.__handleError = (error: unknown) => this.reportError(error);
    instance.__onDispose = (callback: () => void) => record.cleanups.push(callback);
    const independent = this.isIndependentPage(route);
    instance.__independent = independent;
    pageStyles(instance, el, pageScope, independent);
    instance.__store = store;
    instance.setData = (patch: Record<string, any>, callback?: () => void) => {
      store.setData(patch, callback ? () => this.safely(() => callback.call(instance), `${route}.setData`) : undefined);
    };
    (el as any).__wxSelectorOwner = instance;
    instance.selectComponent = (selector: string) => selectedComponents(el, selector)[0] ?? null;
    instance.selectAllComponents = (selector: string) => selectedComponents(el, selector);
    instance.createSelectorQuery = () => this.wx.createSelectorQuery().in(instance);
    instance.createIntersectionObserver = (options?: any) => this.wx.createIntersectionObserver(instance, options);
    instance.createMediaQueryObserver = () => this.wx.createMediaQueryObserver(instance);
    instance.getTabBar = (callback?: (tabBar: any) => void) => this.getTabBar(instance, callback);
    instance.animate = (selector: string, keyframes: any[], duration: number, ...rest: any[]) =>
      animateIn(el, selector, keyframes, parseAnimateOptions(duration, rest), lastFunction(rest));
    instance.clearAnimation = (selector: string, ...rest: any[]) => {
      const options = rest.find(item => item && typeof item === 'object');
      clearIn(el, selector, options, lastFunction(rest));
    };
    const openerChannel = this.pendingChannel;
    instance.getOpenerEventChannel = () => openerChannel;

    const record: PageRecord = {
      route,
      query,
      el,
      store,
      instance,
      holder: store.holder(store.rootScope() as Scope),
      builder: null as any,
      cleanups: [() => disposeAnimations(el)]
    };

    // 先入栈：组件挂载、页面事件里都要能拿到当前页
    this.stack.push(record);
    this.shell.pages.appendChild(el);
    if (this.config.tabBar?.custom && this.tabRoutes.includes(route)) this.ensureCustomTabBar(route);

    if (definition.onLoad) this.safely(() => definition.onLoad.call(instance, query), `${route}.onLoad`);

    const builder = new Builder(store, instance, this.context, pageScope);
    record.builder = builder;
    builder.root(record.holder);

    this.render(route, builder, el);
    flushComponentLifecycles();
    this.pendingChannel = null;

    this.bindPageEvents(record, pageConfig);
    (globalThis as any).__fmp_page__ = instance;

    this.applyPageChrome(route);
    // 微信的顺序：onLoad → onShow → onReady
    if (definition.onShow) this.safely(() => definition.onShow.call(instance), `${route}.onShow`);
    this.notifyComponents(record, 'show');
    this.emit('afterPageLoad', { path: route, query, componentFramework: 'exparser', routeEventId: this.routeEventId, page: instance });
    if (definition.onReady) {
      requestAnimationFrame(() => {
        if (el.isConnected) this.safely(() => definition.onReady.call(instance), `${route}.onReady`);
      });
    }
    return true;
  }

  private createComponentPage(
    route: string,
    query: Record<string, string>,
    el: HTMLElement,
    pageConfig: PageConfig,
    scope?: ScopeMark
  ): boolean {
    const record: PageRecord = {
      route,
      query,
      el,
      instance: null,
      store: null!,
      builder: null!,
      holder: null!,
      cleanups: [() => disposeAnimations(el)]
    };
    const openerChannel = this.pendingChannel;
    const decodedQuery: Record<string, string> = {};
    for (const [k, v] of Object.entries(query)) {
      try {
        decodedQuery[k] = decodeURIComponent(v);
      } catch {
        decodedQuery[k] = v;
      }
    }
    const handle = createComponent(this.context, el, route, decodedQuery, {}, null, {
      pageId: String(++this.pageSequence),
      deferReady: true,
      scope,
      initialize: (instance, store) => {
        instance.__independent = this.isIndependentPage(route);
        instance.route = route;
        instance.__page = instance;
        instance.options = query;
        instance.__store = store;
        instance.getOpenerEventChannel = () => openerChannel;
        instance.getTabBar = (callback?: (tabBar: any) => void) => this.getTabBar(instance, callback);
        record.instance = instance;
        record.store = store;
        this.stack.push(record);
        this.shell.pages.appendChild(el);
        if (this.config.tabBar?.custom && this.tabRoutes.includes(route)) this.ensureCustomTabBar(route);
      }
    });
    record.component = handle;
    record.builder = handle.builder!;
    record.holder = handle.holder!;
    const instance = handle.instance;
    flushComponentLifecycles();
    this.safely(() => instance.onLoad?.call(instance, query), `${route}.onLoad`);
    this.safely(() => instance.onShow?.call(instance), `${route}.onShow`);
    this.notifyComponents(record, 'show');
    this.emit('afterPageLoad', { path: route, query, componentFramework: 'exparser', routeEventId: this.routeEventId, page: instance });
    this.pendingChannel = null;
    this.bindPageEvents(record, pageConfig);
    this.applyPageChrome(route);
    (globalThis as any).__fmp_page__ = instance;
    afterRender(() => {
      if (!el.isConnected) return;
      flushComponentLifecycles(true);
      queueMicrotask(() => {
        if (el.isConnected) this.safely(() => instance.onReady?.call(instance), `${route}.onReady`);
      });
    });
    return true;
  }

  private bindPageEvents(record: PageRecord, pageConfig: PageConfig) {
    const instance = record.instance;
    const el = record.el;
    let lastScroll = 0;
    let scheduled = false;
    let reached = false;

    const onScroll = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (!el.isConnected) return;
        const top = el.scrollTop;
        if (Math.abs(top - lastScroll) < 1) return;
        lastScroll = top;
        if (typeof instance.onPageScroll === 'function') {
          this.safely(() => instance.onPageScroll.call(instance, { scrollTop: top }), `${record.route}.onPageScroll`);
        }
        const distance = pageConfig.onReachBottomDistance ?? 50;
        const bottom = el.scrollHeight - el.clientHeight - top;
        if (bottom <= distance) {
          if (!reached) {
            reached = true;
            if (typeof instance.onReachBottom === 'function') {
              this.safely(() => instance.onReachBottom.call(instance), `${record.route}.onReachBottom`);
            }
          }
        } else if (bottom > distance + 10) {
          reached = false;
        }
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    record.cleanups.push(() => el.removeEventListener('scroll', onScroll));

    if (pageConfig.enablePullDownRefresh && typeof instance.onPullDownRefresh === 'function') {
      // 手势由外壳统一处理，回调里取当前页
    }
  }

  private applyPageChrome(route: string) {
    const pageConfig = this.config.pageConfig?.[route] ?? {};
    const appWindow = this.config.window ?? {};
    const custom = pageConfig.navigationStyle === 'custom' || appWindow.navigationStyle === 'custom';

    this.shell.setRoute(route);
    this.shell.setNavigation({
      title: pageConfig.navigationBarTitleText ?? appWindow.navigationBarTitleText ?? '',
      backgroundColor: pageConfig.navigationBarBackgroundColor ?? appWindow.navigationBarBackgroundColor ?? '#000000',
      textStyle: pageConfig.navigationBarTextStyle ?? appWindow.navigationBarTextStyle ?? 'white',
      showBack: this.stack.length > 1,
      custom
    });
    this.shell.setBackgroundColor(pageConfig.backgroundColor ?? appWindow.backgroundColor ?? '#ffffff');
    this.shell.setBackgroundTextStyle(pageConfig.backgroundTextStyle ?? appWindow.backgroundTextStyle ?? 'dark');
    if (this.config.tabBar?.custom) {
      this.shell.setCustomTabBarMode(true);
      if (this.tabRoutes.includes(route)) this.ensureCustomTabBar(route);
    } else {
      this.shell.setCustomTabBarMode(false);
    }
    this.shell.renderTabBar(this.tabRoutes.includes(route) ? route : null);
    this.applySafeArea(this.top());
  }

  private getTabBar(page: any, callback?: (tabBar: any) => void) {
    const record = [...this.stack, ...this.cachedTabs.values()].find(record => record.instance === page);
    const tabBar = record?.tabBar?.instance ?? null;
    if (typeof callback === 'function') {
      if (tabBar) this.safely(() => callback(tabBar), 'getTabBar');
      else if (this.config.tabBar?.custom && record && this.tabRoutes.includes(record.route)) {
        const callbacks = this.tabBarCallbacks.get(page) ?? [];
        callbacks.push(callback);
        this.tabBarCallbacks.set(page, callbacks);
      }
    }
    return tabBar;
  }

  private ensureCustomTabBar(route: string) {
    const record = this.top();
    if (!record || !this.tabRoutes.includes(route)) return;
    if (!record.tabBar) {
      if (!hasModule('custom-tab-bar/index')) {
        console.warn('[fmp-engine] tabBar.custom 已开启，但项目里没有 custom-tab-bar/index 组件');
        return;
      }
      const host = document.createElement('wx-custom-tab-bar');
      this.shell.customTabBarElement().appendChild(host);
      record.tabBar = createComponent(this.context, host, 'custom-tab-bar/index', {}, {}, null, { page: record.instance });
      flushComponentLifecycles();
      const callbacks = this.tabBarCallbacks.get(record.instance) ?? [];
      this.tabBarCallbacks.delete(record.instance);
      if (callbacks.length)
        queueMicrotask(() => {
          for (const callback of callbacks) this.safely(() => callback(record.tabBar!.instance), 'getTabBar');
        });
    }
    for (const host of Array.from(this.shell.customTabBarElement().children) as HTMLElement[]) {
      host.style.display = host === record.tabBar.instance.__el ? '' : 'none';
    }
  }

  /**
   * 页面窗口的 env(safe-area-inset-*)：窗口贴着屏幕边缘的一侧才有安全区。
   * 默认导航栏下窗口在导航栏下方，tabBar 页面的窗口止于 tabBar 上方。
   */
  private applySafeArea(record: PageRecord | undefined) {
    if (!record) return;
    const custom = this.shell.getNavigation().custom;
    const tabBar = this.shell.hasTabBar(record.route);
    const values = {
      top: custom ? this.device.statusBarHeight : 0,
      right: 0,
      bottom: tabBar ? 0 : this.device.safeAreaBottom,
      left: 0
    };
    for (const [side, value] of Object.entries(values)) {
      record.el.style.setProperty(`--fmp-safe-area-inset-${side}`, `${value}px`);
    }
  }
}

export interface BootOptions {
  config?: AppConfig;
  /** 兼容单页启动：只给一个页面路径 */
  page?: string;
  container?: Element;
  device?: DeviceProfile;
}

/** 最近一次 boot 的配置，restartMiniProgram 时按它重启 */
let lastBootOptions: BootOptions | null = null;

function restartRuntime(path?: string) {
  if (!lastBootOptions) return;
  const page = path?.replace(/^\/+/, '');
  const config = page && lastBootOptions.config ? { ...lastBootOptions.config, entry: page } : lastBootOptions.config;
  boot({ ...lastBootOptions, page: page ?? lastBootOptions.page, config });
}

export function boot(options: BootOptions = {}) {
  if (typeof document === 'undefined') throw new Error('boot() 只能在浏览器里调用');
  lastBootOptions = options;
  const config: AppConfig = options.config ?? {
    pages: options.page ? [options.page] : [],
    entry: options.page
  };
  if (!config.pages.length) throw new Error('没有配置页面');
  if (runtime) {
    runtime.destroy();
    resetModules();
    pageDefs.clear();
    componentDefs.clear();
    appDef = null;
    delete (globalThis as any).__fmp_page__;
  }
  // 业务代码通过 __wxConfig 读扩展配置 / 插件入口
  (globalThis as any).__wxConfig = {
    envVersion: 'develop',
    appId: 'fmp-engine',
    ...(globalThis as any).__wxConfig,
    ...config
  };
  runtime = new Runtime(config, options.container ?? document.body, options.device);
  void runtime.start().catch(error => console.error('[fmp-engine] 启动失败', error));
  (globalThis as any).__fmp_runtime__ = runtime;
}

export function flushSync() {
  runtime?.flush();
}

/** 已执行的绑定次数，用来验证「只更新命中的节点」 */
export function stats() {
  const page = runtime?.pages[runtime.pages.length - 1];
  return page?.__store?.stats ?? { runs: 0, flushes: 0 };
}

export function currentPage() {
  return runtime?.pages[runtime.pages.length - 1] ?? null;
}

export { Builder, Store };
export { wxsProperty, wxsCall } from './wxs';

const globals = globalThis as any;
globals.Page = Page;
globals.Component = Component;
globals.App = App;
globals.Behavior = Behavior;
globals.getApp = getApp;
globals.getCurrentPages = () => runtime?.pages ?? [];
globals.requirePlugin = (name: string) => (globalThis as any).wx?.requirePlugin?.(name) ?? {};
// WXS 里的全局工具
globals.getRegExp = (pattern: string, flags?: string) => new RegExp(pattern, flags);
globals.getDate = (...args: any[]) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (Date as any)(...args);
globals.__wxConfig = { envVersion: 'develop', appId: 'fmp-engine' };
