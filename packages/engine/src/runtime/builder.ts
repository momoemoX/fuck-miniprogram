/**
 * 渲染辅助：编译产物调用的那组 `$` 方法
 *
 * 每个方法都只做一件事，没有 diff、没有 vnode。效果（effect）按需注册到
 * 当前 holder 上，holder 被销毁时一起注销。
 */

import type { ComponentContext } from './component';
import { invoke as callCallback } from './callbacks';
import { writeText } from './text';
import { RenderRange, type RenderParent } from './range';
import { appendComponent } from './hosts';
import { exposeWxs } from './wxs';
import { setBoundAttribute, writeBooleanAttribute } from './attributes';
import { loadModule, type ModuleCache } from './modules';
import { markCatch } from './gesture';
import {
  allowsNativeEventCapture,
  bindComponentEvent,
  customTapSurfaces,
  forwardVirtualCapture,
  handleMutEvent,
  miniEvent,
  nativeEventName,
  refreshVirtualEvents,
  setDataset,
  setEventOwner,
  setMark,
  setEventResult
} from './events';
import { SlotProjection, slotProjections } from './slots';
import { notifyComponentMoves } from './relations';
import { descriptorOf } from './wxs-descriptor';
import { Holder, KEY_MARK, Store, type Scope } from './store';

interface CondBranch {
  deps: string[][];
  test: (scope: Scope) => boolean;
  build: (host: RenderParent) => void;
}

interface ListOptions {
  key: ((item: any, index: number) => unknown) | null;
  path: string[] | null;
  /** wx:for-item / wx:for-index 的名字，默认 item / index */
  item?: string;
  index?: string;
  /** 用当前作用域求值：嵌套列表要读的是「所在项」上的字段，不是根数据 */
  get: (scope: Scope) => unknown;
  create: (host: RenderParent) => void;
}

interface PropSpec {
  deps: string[][];
  get: (scope: Scope) => unknown;
}

interface ItemRecord {
  key: string;
  item: any;
  index: number | string;
  el: RenderRange;
  holder: Holder;
}

/** 统一加前缀：`<view>` 渲染成 `<wx-view>`，避免和 input / image / video 等 HTML 标签冲突 */
const TAG_PREFIX = 'wx-';

export function str(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

const PIXEL_KEYS = new Set(['width', 'height', 'top', 'left', 'bottom', 'right']);
const SCALE_KEYS = new Set(['scale', 'scaleX', 'scaleY', 'scaleZ']);
const DEGREE_KEYS = new Set(['rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY']);
const PX_TRANSFORM = new Set(['translateX', 'translateY', 'translateZ']);

/** wx.createAnimation().export() 的结果直接绑在 animation 属性上，用 Web Animations 播放 */
function applyAnimation(el: Element, data: any) {
  if (!data || !(el as HTMLElement).animate) return;
  const actions: any[] = Array.isArray(data) ? data : (data.actions ?? data.animation ?? []);
  if (!Array.isArray(actions) || !actions.length) return;

  const frames: Keyframe[] = [];
  let duration = 400;
  let easing = 'linear';
  let delay = 0;

  for (const action of actions) {
    const frame: Record<string, any> = {};
    const transform: string[] = [];
    for (const [key, value] of Object.entries<any>(action ?? {})) {
      if (key === '__options') {
        duration = Number(value?.duration ?? duration);
        easing = String(value?.timingFunction ?? easing);
        delay = Number(value?.delay ?? delay);
        continue;
      }
      if (key === 'opacity') frame.opacity = String(value);
      else if (key === 'backgroundColor') frame.backgroundColor = String(value);
      else if (PIXEL_KEYS.has(key)) frame[key] = typeof value === 'number' ? `${value}px` : String(value);
      else if (PX_TRANSFORM.has(key)) transform.push(`${key}(${value}px)`);
      else if (SCALE_KEYS.has(key)) transform.push(`${key}(${value})`);
      else if (DEGREE_KEYS.has(key)) transform.push(`${key}(${value}deg)`);
      else if (key === 'translate') transform.push(`translate(${value[0]}px,${value[1]}px)`);
      else if (key === 'scale3d') transform.push(`scale3d(${value.join(',')})`);
      else if (key === 'translate3d') transform.push(`translate3d(${value[0]}px,${value[1]}px,${value[2]}px)`);
      else if (key === 'rotate3d') transform.push(`rotate3d(${value.join(',')}deg)`);
      else if (key === 'skew') transform.push(`skew(${value[0]}deg,${value[1]}deg)`);
    }
    if (transform.length) frame.transform = transform.join(' ');
    frames.push(frame as Keyframe);
  }

  if (!frames.length) return;
  try {
    (el as HTMLElement).animate(frames, { duration, delay, easing, fill: 'forwards' });
  } catch {
    /* 关键帧不合法时忽略 */
  }
}

/** 样式作用域标记：页面 fmp-page，组件 fmp-component */
export interface ScopeMark {
  attr: string;
  value: string;
}

export class Builder {
  private locals = new WeakMap<Scope, Map<string, string[]>>();
  private holders: Holder[] = [];
  private wxs: Record<string, any> = {};
  private classNodes = new WeakSet<Element>();
  private projections = new WeakMap<RenderParent, SlotProjection>();
  private moduleCache: ModuleCache = new Map();

  constructor(
    private readonly store: Store,
    private readonly instance: any,
    private readonly context: ComponentContext,
    private readonly scope?: ScopeMark
  ) {}

  /** 根 holder：页面级绑定挂在这里，整页销毁时一次性注销 */
  root(holder: Holder) {
    this.holders = [holder];
    holder.scope.wxs = this.wxs;
  }

  /** 模板里引用的 wxs 模块 */
  private wxsModules(modules: Record<string, string>) {
    return Object.fromEntries(Object.entries(modules).map(([name, id]) => [name, exposeWxs(loadModule(id, undefined, this.moduleCache))]));
  }

  setWxs(modules: Record<string, string>) {
    this.wxs = this.wxsModules(modules);
    for (const holder of this.holders) holder.scope.wxs = this.wxs;
  }

  useWxs(modules: Record<string, string>) {
    this.current().scope.wxs = this.wxsModules(modules);
  }

  callTemplate(template: object, build: () => void) {
    const scope = this.current().scope;
    const templates: Set<object> = scope.templates ?? new Set();
    if (templates.has(template)) return;
    scope.templates = new Set([...templates, template]);
    build();
  }

  scopeWxs(parent: RenderParent, modules: Record<string, string>, build: (host: RenderParent) => void) {
    const owner = this.current();
    const scope: Scope = Object.create(owner.scope);
    const holder = this.store.holder(scope, owner);
    this.locals.set(scope, new Map(this.locals.get(owner.scope)));
    const host = this.range(parent);
    this.holders.push(holder);
    try {
      this.useWxs(modules);
      build(host);
    } finally {
      this.holders.pop();
    }
    host.move(parent);
    this.projections.get(parent)?.refresh();
  }

  dispose() {
    this.holders[0]?.dispose();
  }

  private current(): Holder {
    return this.holders[this.holders.length - 1];
  }

  private absolute(dep: string[]): string[] {
    const path = this.locals.get(this.current().scope)?.get(dep[0]);
    if (path) return path.concat(dep.slice(1));
    return dep.slice();
  }

  el(tag: string): Element {
    const el = document.createElement(TAG_PREFIX + tag);
    setEventOwner(el, this.instance);
    if (this.scope) el.setAttribute(this.scope.attr, this.scope.value);
    if (this.instance.__styleScopes) el.setAttribute('fmp-style', this.instance.__styleScopes.join(' '));
    return el;
  }

  private range(parent: RenderParent) {
    const range = new RenderRange();
    const projection = this.projections.get(parent);
    if (projection) this.projections.set(range, projection);
    return range;
  }

  slotBody(host: Element, build: (host: RenderParent) => void) {
    const projection = new SlotProjection();
    slotProjections.set(host, projection);
    this.current().onDispose(() => projection.dispose());
    const root = new RenderRange();
    this.projections.set(root, projection);
    build(root);
    projection.refresh();
  }

  slotSource(parent: RenderParent, spec: PropSpec, build: (host: RenderParent) => void) {
    const projection = this.projections.get(parent);
    if (!projection) {
      build(parent);
      return;
    }
    const owner = this.current();
    const anchor = document.createComment('slot-source');
    parent.appendChild(anchor);
    const range = new RenderRange();
    build(range);
    const source = projection.add(range, str(spec.get(owner.scope) ?? ''), anchor);
    owner.onDispose(() => projection.remove(source));
    if (spec.deps.length)
      this.store.register(
        spec.deps.map(dep => this.absolute(dep)),
        () => projection.rename(source, str(spec.get(owner.scope) ?? '')),
        owner
      );
  }

  slot(parent: RenderParent, name = '') {
    const range = new RenderRange();
    range.move(parent);
    const projection = slotProjections.get(this.instance?.__el);
    if (projection) {
      const remove = projection.outlet(range, name, !!this.instance.__multipleSlots);
      this.current().onDispose(remove);
    }
    return range;
  }

  /** 编译产物里的 `$.str()`：undefined 为空，null 保留字面文本。 */
  str(value: unknown): string {
    return str(value);
  }

  txt(parent: Node | RenderRange, value?: string): Text {
    const node = document.createTextNode(value ?? '');
    parent.appendChild(node);
    writeText(node, value ?? '');
    return node;
  }

  text(node: Text, deps: string[][], fn: (scope: Scope) => string) {
    const holder = this.current();
    this.store.register(
      deps.map(dep => this.absolute(dep)),
      () => {
        writeText(node, str(fn(holder.scope)));
      },
      holder
    );
    writeText(node, str(fn(holder.scope)));
  }

  classes(el: Element, value: unknown) {
    const text = value == null ? '' : str(value);
    if (this.instance.__applyClasses) {
      this.instance.__applyClasses(el, text);
      if (!this.classNodes.has(el)) {
        this.classNodes.add(el);
        this.current().onDispose(() => this.instance.__forgetClasses?.(el));
      }
    } else el.setAttribute('class', text);
  }

  attr(el: Element, name: string, deps: string[][], fn: (scope: Scope) => unknown) {
    const holder = this.current();
    const apply = () => this.attribute(el, name, fn(holder.scope));
    this.store.register(
      deps.map(dep => this.absolute(dep)),
      apply,
      holder
    );
    apply();
  }

  attribute(el: Element, name: string, value: unknown) {
    if (name === 'style' && (el as any).__wxVirtual) return;
    if (name.startsWith('data-')) setDataset(el, name, value);
    if (name.startsWith('mark:')) setMark(el, name, value);
    if (name === 'class') {
      this.classes(el, value);
      return;
    }
    if (name === 'hidden') {
      el.toggleAttribute(name, !!value);
      return;
    }
    if (name === 'animation') {
      applyAnimation(el, value);
      return;
    }
    if (writeBooleanAttribute(el, name, value)) return;
    // 数组 / 对象属性保留结构：picker 的 range、value 都要按原类型读取
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // 内联 style 里的 rpx 也要换算
    if (name === 'style' && text.includes('rpx')) {
      text = text.replace(/(-?\d*\.?\d+)rpx/g, (_match, size: string) => `calc(${size} * var(--fmp-rpx))`);
    }
    setBoundAttribute(el, name, value, text);
    el.setAttribute(name, text);
  }

  on(
    el: Element,
    type: string,
    handler: string | ((scope: Scope) => unknown),
    stop: boolean,
    capture = false,
    custom = false,
    mut = false
  ) {
    const holder = this.current();
    const invoke = (event: any, native?: Event) => {
      const resolved = typeof handler === 'function' ? handler(holder.scope) : handler;
      if (typeof resolved === 'function') {
        // WXS 事件响应器：在视图层执行 (event, ownerInstance)，返回 false 阻止冒泡
        event.instance = descriptorOf(el, this.instance);
        if (event.touches == null) event.touches = event.detail?.touches;
        if (event.changedTouches == null) event.changedTouches = event.detail?.changedTouches;
        const result = resolved(event, descriptorOf(this.instance?.__el ?? el, this.instance));
        if (result === false) native?.stopPropagation();
        return result;
      }
      const fn = typeof resolved === 'string' ? this.instance?.[resolved] : null;
      return callCallback(this.instance, fn, [event]);
    };
    holder.onDispose(bindComponentEvent(el, type, { owner: this.instance, capture, stop, mut, invoke }));
    const eventName = nativeEventName(type, el);
    // catchtouchmove 需要在原生 touchmove 上 preventDefault，先登记到手势层
    if (stop && type.startsWith('touch')) markCatch(el, type);
    const listen = (event: any) => {
      if (type === 'tap' && event.type === 'click' && customTapSurfaces.has(event.target)) return;
      if (capture && !allowsNativeEventCapture(event)) return;
      if (capture && forwardVirtualCapture(event, el)) return;
      if (mut && !handleMutEvent(event)) return;
      if (stop) event.stopPropagation();
      // 输入类事件补上小程序约定的 detail.value（原生 UIEvent 的 detail 只读）
      if (!event.detail && (type === 'input' || type === 'change') && 'value' in event.target) {
        const el = event.target as HTMLInputElement;
        const detail: Record<string, unknown> = { value: el.value, cursor: el.selectionStart ?? el.value.length };
        try {
          Object.defineProperty(event, 'detail', { value: detail, configurable: true });
        } catch {
          /* 只读就算了，业务代码仍能读 target.value */
        }
      }
      const result = invoke(miniEvent(event, el, type, this.instance), event);
      if (type === 'input' && event.target === el && typeof result === 'string') setEventResult(event, result);
    };
    el.addEventListener(eventName, listen, capture);
    if (custom && eventName !== type) el.addEventListener(type, listen, capture);
    holder.onDispose(() => {
      el.removeEventListener(eventName, listen, capture);
      if (custom && eventName !== type) el.removeEventListener(type, listen, capture);
    });
  }

  /**
   * `model:value="{{field}}"`（原生组件）：属性照常下发，用户输入再写回数据。
   * 官方只支持单一数据字段，复杂表达式没有可回写的路径。
   */
  model(el: Element, name: string, spec: PropSpec) {
    const holder = this.current();
    const path = this.absolute(spec.deps[0] ?? []);
    if (spec.deps.length) {
      this.store.register(
        spec.deps.map(dep => this.absolute(dep)),
        () => this.attribute(el, name, spec.get(holder.scope)),
        holder
      );
    }
    this.attribute(el, name, spec.get(holder.scope));

    if (!path.length) return;
    const write = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const value = detail && 'value' in detail ? detail.value : (el as any).value;
      this.store.setByPath(path, value);
    };
    // input 覆盖 input / textarea，change 覆盖 picker / slider / switch / checkbox
    el.addEventListener('input', write);
    el.addEventListener('change', write);
    holder.onDispose(() => {
      el.removeEventListener('input', write);
      el.removeEventListener('change', write);
    });
  }

  /**
   * `change:<prop>="{{module.fn}}"`：属性值首次渲染及变更时调用 WXS 函数
   * `(newVal, oldVal, ownerInstance, instance)`。
   */
  change(el: Element, name: string, spec: PropSpec, handler: (scope: Scope) => unknown) {
    const holder = this.current();
    const owner = descriptorOf(this.instance?.__el ?? el, this.instance);
    const target = descriptorOf(el, this.instance);
    let last: unknown;
    let started = false;
    const queue: Array<[unknown, unknown]> = [];

    const deliver = (value: unknown, previous: unknown) => {
      const fn = handler(holder.scope);
      if (typeof fn !== 'function') return;
      try {
        fn(value, previous, owner, target);
      } catch (error) {
        this.context.reportError?.(error);
      }
    };

    const capture = () => {
      if (!started) return;
      const value = spec.get(holder.scope);
      if (Object.is(value, last)) return;
      const previous = last;
      last = value;
      queue.push([value, previous]);
    };

    const run = () => {
      if (queue.length) {
        const items = queue.splice(0, queue.length);
        for (const [value, previous] of items) deliver(value, previous);
      }
      const value = spec.get(holder.scope);
      if (started && Object.is(value, last)) return;
      const previous = started ? last : undefined;
      started = true;
      last = value;
      deliver(value, previous);
    };

    this.store.onCommit(capture, holder);
    this.store.register(spec.deps.length ? spec.deps.map(dep => this.absolute(dep)) : [[]], run, holder);
    // 首次调用要等整棵模板建完：#flag / .wxs-chip 这类后续兄弟节点此时才存在
    this.store.afterFlush(run);
    void name;
  }

  component(
    el: Element,
    id: string,
    specs: Record<string, PropSpec>,
    events: Record<string, string>,
    generics: Record<string, string> = {},
    models: Record<string, PropSpec> = {}
  ) {
    const holder = this.current();
    const evaluate = () => {
      const props: Record<string, unknown> = {};
      for (const name of Object.keys(specs)) props[name] = specs[name].get(holder.scope);
      return props;
    };

    const resolve = (id: string) => (id.startsWith('@generic:') ? this.instance.__generics?.[id.slice(9)] : id);
    id = resolve(id);
    if (!id) return;
    (el as any).__wxGenerics = Object.fromEntries(Object.entries(generics).map(([name, id]) => [name, resolve(id)]));

    // model:<prop>：子组件 setData 该属性时回写到父级数据路径
    const writers: Record<string, (value: unknown) => void> = {};
    for (const [prop, spec] of Object.entries(models)) {
      const path = this.absolute(spec.deps[0] ?? []);
      if (!path.length) continue;
      writers[prop] = value => this.store.setByPath(path, value);
    }

    const handle = this.context.mount(el, id, this.instance, events, evaluate(), { models: writers });
    holder.onDispose(() => handle.dispose());

    const deps = Object.keys(specs).flatMap(name => specs[name].deps.map(dep => this.absolute(dep)));
    if (deps.length) this.store.register(deps, () => handle.setProps(evaluate()), holder);
  }

  appendComponent(parent: RenderParent, host: Element) {
    appendComponent(parent, host);
    refreshVirtualEvents();
  }

  cond(parent: RenderParent, branches: CondBranch[]) {
    const anchor = document.createComment('if');
    parent.appendChild(anchor);

    let holder: Holder | null = null;
    let nodes: RenderRange[] = [];
    let currentIndex = -1;

    const owner = this.current();
    const paint = () => {
      const scope = owner.scope;
      let index = -1;
      for (let i = 0; i < branches.length; i++) {
        if (branches[i].test(scope)) {
          index = i;
          break;
        }
      }
      if (index === currentIndex) return;
      currentIndex = index;

      if (holder) holder.dispose();
      for (const node of nodes) node.remove();
      nodes = [];
      holder = null;
      if (index < 0) return;

      const box = this.range(parent);
      const childHolder = this.store.holder(scope, owner);
      this.holders.push(childHolder);
      branches[index].build(box);
      this.holders.pop();

      box.move(parent, anchor);
      this.projections.get(parent)?.refresh();
      nodes = [box];
      holder = childHolder;
    };

    const deps = branches.flatMap(branch => branch.deps.map(dep => this.absolute(dep)));
    this.store.register(deps.length ? deps : [[]], paint, owner);
    paint();
  }

  /**
   * template：数据变化时整块重建。
   * 模板作用域只能看到 data 传进来的字段，看不到外层的 item / index。
   */
  template(
    parent: RenderParent,
    deps: string[][],
    dataFn: (scope: Scope) => any,
    build: (host: RenderParent, name?: unknown) => void,
    select?: (scope: Scope) => unknown
  ) {
    const owner = this.current();
    const anchor = document.createComment('template');
    parent.appendChild(anchor);
    let holder: Holder | null = null;
    let nodes: RenderRange[] = [];

    const paint = () => {
      holder?.dispose();
      for (const node of nodes) node.remove();
      nodes = [];

      const value = dataFn(owner.scope) ?? {};
      const merged = Object.assign(Object.create(null), value);
      const scope: Scope = {
        get data() {
          return merged;
        },
        wxs: this.wxs,
        templates: owner.scope.templates
      };

      const child = this.store.holder(scope, owner);
      const box = this.range(parent);
      this.holders.push(child);
      build(box, select?.(owner.scope));
      this.holders.pop();

      box.move(parent, anchor);
      this.projections.get(parent)?.refresh();
      nodes = [box];
      holder = child;
    };

    this.store.register(deps.length ? deps.map(dep => this.absolute(dep)) : [[]], paint, owner);
    paint();
  }

  list(parent: RenderParent, deps: string[][], options: ListOptions) {
    const anchor = document.createComment('for');
    parent.appendChild(anchor);

    const dep = deps[0] ?? [];
    const itemName = options.item ?? 'item';
    const indexName = options.index ?? 'index';
    const abs = this.absolute(options.path ?? dep);
    const keyFn = (item: any, index: any) => options.key?.(item, index) ?? index;
    const owner = this.current();
    // 复合表达式不是可按下标寻址的数据路径，依赖变化时重新求值。
    const direct = options.path !== null;
    if (direct) owner.onDispose(this.store.setKeyed(abs, keyFn));

    let records: ItemRecord[] = [];

    const createRecord = (item: any, index: number | string, key: string): ItemRecord => {
      const el = this.range(parent);
      const scope: Scope = Object.create(owner.scope);
      scope[itemName] = item;
      scope[indexName] = index;
      const locals = new Map(this.locals.get(owner.scope));
      locals.set(itemName, abs.concat([KEY_MARK + key]));
      locals.set(indexName, abs.concat([KEY_MARK + key]));
      this.locals.set(scope, locals);
      const holder = this.store.holder(scope, owner);

      this.holders.push(holder);
      options.create(el);
      this.holders.pop();

      return { key, item, index, el, holder };
    };

    const diff = () => {
      const value = options.get(owner.scope);
      const entries: Array<[number | string, any]> = Array.isArray(value)
        ? Array.from(value, (item, index) => [index, item])
        : value && typeof value === 'object'
          ? Object.entries(value)
          : [];
      const nextKeys = entries.map(([index, item]) => String(keyFn(item, index)));

      const byKey = new Map<string, ItemRecord>();
      for (const record of records) byKey.set(record.key, record);

      const next: ItemRecord[] = [];
      const alive = new Set(nextKeys);

      for (const record of records) {
        if (!alive.has(record.key)) {
          record.holder.dispose();
          record.el.remove();
        }
      }

      for (let i = 0; i < entries.length; i++) {
        const key = nextKeys[i];
        const [index, item] = entries[i];
        let record = byKey.get(key);

        if (!record) {
          record = createRecord(item, index, key);
        } else if (record.item !== item || record.index !== index || !direct) {
          record.item = item;
          record.index = index;
          const scope = record.holder.scope;
          scope[itemName] = item;
          scope[indexName] = index;
          record.holder.refresh();
        }

        next.push(record);
        if (!record.el.parentNode) record.el.move(parent, anchor);
      }

      // 重排：按新顺序插到锚点前，已经就位的节点不动
      let cursor: Node = anchor;
      const moved: Element[] = [];
      for (let i = next.length - 1; i >= 0; i--) {
        const el = next[i].el;
        if (el.nextSibling !== cursor) {
          el.move(parent, cursor);
          moved.push(...el.elements());
        }
        cursor = el.start;
      }

      records = next;
      this.projections.get(parent)?.refresh();
      notifyComponentMoves(moved);
    };

    this.store.register(deps.length ? deps.map(dep => this.absolute(dep)) : [[]], diff, owner, !direct);
    diff();
  }
}
