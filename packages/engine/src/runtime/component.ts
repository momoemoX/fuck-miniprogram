/**
 * 自定义组件实例
 *
 * 组件的 data 是独立的 store：父级改 props 只会触发组件内依赖那几条绑定，
 * 不会重跑整个组件模板。behaviors 在创建时摊平成一个定义。
 */

import { Builder, type ScopeMark } from './builder';
import { animateIn, clearIn, disposeAnimations, lastFunction, parseAnimateOptions } from './animate';
import { afterRender, parsePath, Store, type Holder } from './store';
import { cloneData, definitionChain, equalData, mergeData, propertyDefault, propertySpec, propertyValue } from './definition';
import { attachRelations, detachRelations, reconcileRelations, registerRelations } from './relations';
import { dispatchComponentEvent, readDataset, refreshVirtualEvents } from './events';
import { selectedComponents } from './selectors';
import { componentStyles } from './styles';
import { callObserver, dataObserver, notifyObservers, type DataObserver } from './observers';
import { invoke } from './callbacks';
import { createVirtualHost, disposeVirtualHost } from './hosts';
import type { RenderParent } from './range';

export interface ComponentContext {
  /** 渲染指定模板：加载它用到的 wxs，把渲染函数执行到 el 里 */
  render(id: string, builder: Builder, el: RenderParent): void;
  define(id: string): any;
  configOf?(id: string): any;
  reportError?(error: unknown): void;
  /** 组件样式的 fmp-component 作用域值 */
  scopeOf(id: string): ScopeMark | undefined;
  mount(
    host: Element,
    id: string,
    parentInstance: any,
    listeners: Record<string, string>,
    props: Record<string, unknown>,
    options?: {
      page?: any;
      onDispose?: (callback: () => void) => void;
      /** `model:<prop>` 的回写通道：子组件 setData 后写回父级数据路径 */
      models?: Record<string, (value: unknown) => void>;
    }
  ): ComponentHandle;
}

export interface ComponentHandle {
  instance: any;
  store?: Store;
  builder?: Builder;
  holder?: Holder;
  setProps(next: Record<string, unknown>): void;
  dispose(): void;
}

const EMPTY: ComponentHandle = {
  instance: null,
  setProps() {},
  dispose() {}
};

const pendingComponents = new Map<any, { parent: any; attach: () => void; ready: () => void; attached: boolean }>();

function enqueueComponent(instance: any, parent: any, attach: () => void, ready: () => void) {
  pendingComponents.set(instance, { parent, attach, ready, attached: false });
  afterRender(() => flushComponentLifecycles());
}

export function flushComponentLifecycles(includeDeferred = false) {
  let attached = false;
  for (const entry of pendingComponents.values()) {
    if (entry.attached) continue;
    entry.attached = true;
    entry.attach();
    attached = true;
  }
  if (attached) reconcileRelations();
  const pending = new Map(Array.from(pendingComponents).filter(([instance]) => includeDeferred || !instance.__deferReady));
  for (const instance of pending.keys()) {
    pendingComponents.delete(instance);
    instance.__deferReady = false;
  }
  const ready = (instance: any) => {
    for (const [child, entry] of pending) if (entry.parent === instance) ready(child);
    pending.get(instance)?.ready();
  };
  for (const [instance, entry] of pending) if (!pending.has(entry.parent)) ready(instance);
}

/** 相对地址按基准路径的目录解析：'../lifecycle/index' + 'pages/suite/index' → '/pages/lifecycle/index' */
export function resolveRoute(base: string, url: string): string {
  if (!url) return url;
  const [path, ...rest] = url.split('?');
  if (path.startsWith('/')) return url;
  const segments: string[] = [];
  for (const segment of `${base.slice(0, base.lastIndexOf('/'))}/${path}`.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}${rest.length ? `?${rest.join('?')}` : ''}`;
}

const ROUTE_METHODS = ['navigateTo', 'redirectTo', 'reLaunch', 'switchTab', 'navigateBack'] as const;

/** this.router / this.pageRouter：地址按基准解析后交给同名 wx 接口 */
function createRouter(base: () => string) {
  const router: Record<string, (options?: any) => unknown> = {};
  for (const method of ROUTE_METHODS) {
    router[method] = (options: any = {}) => {
      const wx = (globalThis as any).wx;
      if (typeof wx?.[method] !== 'function') return undefined;
      if (method === 'navigateBack') return wx[method](options);
      return wx[method]({ ...options, url: resolveRoute(base(), String(options?.url ?? '')) });
    };
  }
  return router;
}

const HOOKS = ['created', 'attached', 'ready', 'detached', 'moved', 'error'] as const;const PAGE_HOOKS = ['show', 'hide', 'resize', 'routeDone'] as const;

interface Normalized {
  data: Record<string, any>;
  methods: Record<string, any>;
  properties: Record<string, any>;
  observers: DataObserver[];
  behaviors: Set<any>;
  hooks: Record<string, Array<(...args: any[]) => void>>;
  pageHooks: Record<string, Array<(...args: any[]) => void>>;
  relations: Record<string, any>;
  externalClasses: string[];
  options: Record<string, any>;
  exporter?: (this: any) => unknown;
}

/** behaviors 按声明顺序摊平，自身定义最后覆盖 */
function normalize(def: any): Normalized {
  const chain = definitionChain(def);

  const result: Normalized = {
    data: {},
    methods: {},
    properties: {},
    observers: [],
    behaviors: new Set(chain),
    hooks: {},
    pageHooks: {},
    relations: {},
    externalClasses: [],
    options: {}
  };
  for (const hook of HOOKS) result.hooks[hook] = [];
  for (const hook of PAGE_HOOKS) result.pageHooks[hook] = [];

  for (const item of chain) {
    if (!item) continue;
    for (const behavior of item.behaviors ?? []) if (typeof behavior === 'string') result.behaviors.add(behavior);
    if (typeof item.export === 'function') result.exporter = item.export;
    mergeData(result.data, typeof item.data === 'function' ? item.data() : item.data);
    Object.assign(result.methods, item.methods);
    for (const [name, spec] of Object.entries(item.properties ?? {})) result.properties[name] = propertySpec(spec);
    for (const [pattern, observer] of Object.entries(item.observers ?? {})) result.observers.push(dataObserver(pattern, observer as any));
    Object.assign(result.relations, item.relations);
    Object.assign(result.options, item.options);
    for (const name of item.externalClasses ?? []) {
      if (!result.externalClasses.includes(name)) result.externalClasses.push(name);
    }
    for (const hook of HOOKS) {
      const fn = item.lifetimes?.[hook] ?? item[hook];
      if (typeof fn === 'function') result.hooks[hook].push(fn);
    }
    for (const hook of PAGE_HOOKS) {
      if (typeof item.pageLifetimes?.[hook] === 'function') result.pageHooks[hook].push(item.pageLifetimes[hook]);
    }
  }

  return result;
}

/**
 * 页面也支持 behaviors：按声明顺序摊平，方法和 data 合并，后面的覆盖前面的。
 * 生命周期是普通方法，摊平后自然按覆盖规则生效。
 */
export function flattenPage(definition: any) {
  const chain = definitionChain(definition);

  const merged: any = { data: {} };
  for (const item of chain) {
    if (!item) continue;
    for (const [key, value] of Object.entries(item)) {
      if (key === 'behaviors' || key === 'data') continue;
      // behavior 的 methods 要摊到页面上，页面自己也是顶层方法
      if (key === 'methods') Object.assign(merged, value);
      else merged[key] = value;
    }
    mergeData(merged.data, typeof item.data === 'function' ? item.data() : item.data);
  }
  delete merged.behaviors;
  return merged;
}

function runHooks(hooks: Array<(...args: any[]) => void>, instance: any, args: any[] = []) {
  for (const hook of hooks) invoke(instance, hook, args);
}

export function createComponent(
  context: ComponentContext,
  el: Element,
  id: string,
  initialProps: Record<string, unknown>,
  listeners: Record<string, string>,
  parentInstance: any,
  options: {
    page?: any;
    onDispose?: (callback: () => void) => void;
    initialize?: (instance: any, store: Store) => void;
    deferReady?: boolean;
    scope?: ScopeMark;
    pageId?: string;
    attributeProps?: boolean;
    models?: Record<string, (value: unknown) => void>;
  } = {}
): ComponentHandle {
  const raw = context.define(id);
  if (!raw) {
    console.warn(`[fmp-engine] 找不到组件定义：${id}`);
    return EMPTY;
  }
  (el as any).__wxComponentPath = id;
  const def = normalize(raw);
  const propertyName = (name: string) =>
    options.attributeProps && !Object.prototype.hasOwnProperty.call(def.properties, name)
      ? name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
      : name;
  const virtualHost = !!def.options?.virtualHost;
  if (virtualHost) {
    (el as any).__wxVirtual = true;
    el.setAttribute('style', 'display:contents');
  }

  const data: Record<string, any> = cloneData(def.data);
  for (const [name, spec] of Object.entries<any>(def.properties)) data[name] = propertyDefault(spec);

  const pattern = def.options.pureDataPattern;
  const pure =
    pattern instanceof RegExp
      ? (name: string) => {
          pattern.lastIndex = 0;
          return pattern.test(name);
        }
      : undefined;
  const store = new Store(data, pure);
  const instance: any = Object.create(def.methods);
  const cleanups: Array<() => void> = [];
  instance.__onDispose = (callback: () => void) => cleanups.push(callback);
  instance.is = id;
  instance.id = el.id || '';
  Object.defineProperty(instance, 'dataset', { get: () => readDataset(el) });
  instance.data = store.data;
  instance.properties = store.data;
  instance.__el = el;
  instance.__path = id;
  instance.__owner = parentInstance;
  const page = options.page ?? parentInstance?.__page ?? parentInstance;
  instance.__page = page;
  const pageId = options.pageId ?? page?.getPageId?.() ?? '';
  instance.getPageId = () => pageId;
  instance.getTabBar = (callback?: (tabBar: any) => void) => page?.getTabBar?.(callback) ?? null;
  // this.router 以组件自身路径为基准解析相对地址，this.pageRouter 以所属页面为基准
  Object.defineProperty(instance, 'router', { get: () => createRouter(() => id), configurable: true });
  Object.defineProperty(instance, 'pageRouter', {
    get: () => createRouter(() => page?.route ?? page?.__path ?? id),
    configurable: true
  });
  instance.__virtualHost = virtualHost;
  instance.__multipleSlots = !!def.options?.multipleSlots;
  instance.__generics = { ...context.configOf?.(id)?.generics, ...(el as any).__wxGenerics };
  instance.__deferReady = options.deferReady ?? parentInstance?.__deferReady ?? false;
  instance.__relations = new Map<string, any[]>();
  instance.__pageLifetimes = def.pageHooks;
  instance.__handleError = (error: unknown, componentError = true) => {
    if (componentError) {
      for (const hook of def.hooks.error) {
        try {
          hook.call(instance, error);
        } catch (nested) {
          context.reportError?.(nested);
        }
      }
    }
    context.reportError?.(error);
  };
  instance.__onMoved = () => runHooks(def.hooks.moved, instance);
  (el as any).__wxComponent = instance;
  registerRelations(instance, el, id, def.relations, parentInstance);

  let disposed = false;
  const models = Object.fromEntries(Object.entries(options.models ?? {}).map(([name, write]) => [propertyName(name), write]));
  const lastModel = new Map<string, unknown>();
  const update = (patch: Record<string, any>, callback?: () => void, fromParent = false) => {
    if (disposed) return;
    patch = Object.fromEntries(
      Object.entries(patch).map(([name, value]) => {
        const path = parsePath(name);
        const spec = path.length === 1 ? def.properties[path[0]] : undefined;
        return [name, spec ? propertyValue(spec, value) : value];
      })
    );
    const paths = Object.keys(patch).map(parsePath);
    const previous = new Map<string, any>();
    for (const path of paths) {
      if (def.properties[path[0]]) previous.set(path[0], cloneData(store.data[path[0]]));
    }
    store.setData(patch);
    notifyObservers(instance, def.observers, paths);
    for (const [name, oldValue] of previous) {
      const observer = def.properties[name].observer;
      const value = store.data[name];
      if (observer && !pure?.(name) && (value !== oldValue || paths.some(path => path[0] === name && path.length > 1))) {
        callObserver(instance, observer, [value, oldValue]);
      }
    }
    // model:<prop> 回写父级；与父级同步过来的值相同就不再回写，避免来回弹
    for (const path of paths) {
      const write = models[path[0]];
      if (!write) continue;
      const value = store.data[path[0]];
      if (fromParent || (lastModel.has(path[0]) && Object.is(lastModel.get(path[0]), value))) {
        lastModel.set(path[0], value);
        continue;
      }
      lastModel.set(path[0], value);
      write(value);
    }
    if (callback) afterRender(() => invoke(instance, callback));
  };
  instance.setData = update;

  instance.triggerEvent = (name: string, detail?: any, options?: { bubbles?: boolean; composed?: boolean; capturePhase?: boolean }) =>
    dispatchComponentEvent(instance, name, detail, options);

  instance.selectComponent = (selector: string) => selectedComponents(el, selector)[0] ?? null;
  instance.selectAllComponents = (selector: string) => selectedComponents(el, selector);
  instance.selectOwnerComponent = () => parentInstance ?? null;
  instance.hasBehavior = (behavior: any) => def.behaviors.has(behavior);
  if (def.behaviors.has('wx://component-export') && def.exporter) {
    instance.__exportValue = () => {
      const value = def.exporter!.call(instance);
      return value === undefined ? instance : value;
    };
  }
  instance.getRelationNodes = (name: string) => instance.__relations.get(name) ?? [];
  const pendingData: Record<string, any> = Object.create(null);
  instance.replaceDataOnPath = (path: Array<string | number>, value: any) => {
    if (!Array.isArray(path) || !path.length) throw new Error('replaceDataOnPath requires a non-empty path');
    pendingData[path.map(segment => `[${JSON.stringify(segment)}]`).join('')] = value;
  };
  instance.applyDataUpdates = () => {
    const patch = { ...pendingData };
    for (const path of Object.keys(pendingData)) delete pendingData[path];
    if (Object.keys(patch).length) update(patch);
  };
  instance.groupSetData = (fn?: () => void) => fn?.call(instance);
  instance.createSelectorQuery = () => (globalThis as any).wx?.createSelectorQuery?.().in(instance);
  instance.createIntersectionObserver = (options?: any) => (globalThis as any).wx.createIntersectionObserver(instance, options);
  instance.createMediaQueryObserver = () => (globalThis as any).wx.createMediaQueryObserver(instance);
  instance.animate = (selector: string, keyframes: any[], duration: number, ...rest: any[]) =>
    animateIn(el, selector, keyframes, parseAnimateOptions(duration, rest), lastFunction(rest));
  instance.clearAnimation = (selector: string, ...rest: any[]) => {
    const options = rest.find(item => item && typeof item === 'object');
    clearIn(el, selector, options, lastFunction(rest));
  };

  runHooks(def.hooks.created, instance);
  options.initialize?.(instance, store);
  const lastProps = cloneData(initialProps);
  const componentScope = options.scope ?? context.scopeOf(id);
  const config = context.configOf?.(id) ?? {};
  const styleMode =
    config.styleIsolation ??
    def.options.styleIsolation ??
    (componentScope?.attr === 'fmp-page' && !config.component ? 'shared' : def.options.addGlobalClass ? 'apply-shared' : 'isolated');
  const disposeStyles = componentStyles(instance, el, componentScope, styleMode, parentInstance, def.externalClasses, () => lastProps);
  const initial: Record<string, any> = {};
  for (const [name, value] of Object.entries(initialProps)) {
    const property = propertyName(name);
    if (Object.prototype.hasOwnProperty.call(def.properties, property)) initial[property] = propertyValue(def.properties[property], value);
  }
  // 初始值来自父级，挂载阶段不触发回写
  for (const name of Object.keys(models)) {
    lastModel.set(name, Object.prototype.hasOwnProperty.call(initial, name) ? initial[name] : store.data[name]);
  }
  if (Object.keys(initial).length) update(initial, undefined, true);

  enqueueComponent(
    instance,
    parentInstance,
    () => attach(),
    () => {
      for (const hook of def.hooks.ready) invoke(instance, hook, [], false);
    }
  );

  const builder = new Builder(store, instance, context, options.scope ?? context.scopeOf(id));
  const holder = store.holder(store.rootScope());
  builder.root(holder);

  context.render(id, builder, virtualHost ? createVirtualHost(el) : el);
  if (virtualHost) refreshVirtualEvents();

  for (const [event, handler] of Object.entries(listeners)) {
    el.addEventListener(event === 'tap' ? 'click' : event, (event_: any) => {
      if (typeof parentInstance?.[handler] === 'function') parentInstance[handler].call(parentInstance, event_);
    });
  }

  const attach = () => {
    runHooks(def.hooks.attached, instance);
    attachRelations(instance);
  };

  const handle: ComponentHandle = {
    instance,
    store,
    builder,
    holder,
    setProps(next) {
      if (disposed) return;
      const patch: Record<string, any> = {};
      for (const [name, rawValue] of Object.entries(next)) {
        const property = propertyName(name);
        const spec = Object.prototype.hasOwnProperty.call(def.properties, property) ? def.properties[property] : undefined;
        if (equalData(rawValue, lastProps[name])) continue;
        lastProps[name] = cloneData(rawValue);
        if (spec) patch[property] = propertyValue(spec, rawValue);
      }
      instance.__refreshClasses();
      if (Object.keys(patch).length) update(patch, undefined, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      instance.__destroyed = true;
      disposeAnimations(el);
      pendingComponents.delete(instance);
      runHooks(def.hooks.detached, instance);
      for (const cleanup of cleanups.splice(0)) cleanup();
      holder.dispose();
      builder.dispose();
      disposeStyles();
      detachRelations(instance);
      if (virtualHost) {
        disposeVirtualHost(el);
        refreshVirtualEvents();
      }
    }
  };

  return handle;
}
