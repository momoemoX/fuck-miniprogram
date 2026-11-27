/**
 * WXS 视图层描述符（`ComponentDescriptor`）
 *
 * `change:`、`bind:` 指向 WXS 函数时，WXS 拿到两个对象：
 * - `ownerInstance`：绑定所在组件的描述符，可跨节点查询、调方法、派事件；
 * - `instance`：触发这次调用的元素本身的描述符，可读写自身样式 / 类名 / dataset / 状态。
 *
 * 描述符按元素缓存，`getState()` 返回的对象因此在多次调用间保持同一份。
 */

import { invoke } from './callbacks';
import { readDataset } from './events';
import { selectElements } from './selectors';

export interface Descriptor {
  selectComponent(selector: string): unknown;
  selectAllComponents(selector: string): unknown[];
  setStyle(style: string | Record<string, unknown>): void;
  addClass(name: string): void;
  removeClass(name: string): void;
  hasClass(name: string): boolean;
  getDataset(): Record<string, unknown>;
  getState(): Record<string, unknown>;
  getComputedStyle(names: string[]): Record<string, string>;
  callMethod(name: string, ...args: unknown[]): unknown;
  triggerEvent(name: string, detail?: unknown, options?: Record<string, unknown>): void;
  requestAnimationFrame(callback: () => void): number;
}

const pendingCalls: Array<() => void> = [];
export function flushDescriptorCalls() {
  while (pendingCalls.length) pendingCalls.shift()!();
}
const states = new WeakMap<Element, Record<string, unknown>>();
const descriptors = new WeakMap<Element, Descriptor>();

const kebab = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

const overrides = new WeakMap<Element, { styles: Map<string, string>; classes: Map<string, boolean> }>();
const unitless = new Set(['opacity', 'z-index', 'font-weight', 'line-height', 'flex-grow', 'flex-shrink', 'order']);
function overlay(el: Element) {
  let value = overrides.get(el);
  if (!value) overrides.set(el, value = { styles: new Map(), classes: new Map() });
  return value;
}
export function refreshDescriptorAttributes(el: Element) {
  const value = overrides.get(el);
  if (!value) return;
  for (const [name, text] of value.styles) (el as HTMLElement).style.setProperty(name, text);
  for (const [name, present] of value.classes) el.classList.toggle(name, present);
}
function applyStyle(el: Element, style: string | Record<string, unknown>) {
  const declarations = document.createElement('div').style;
  if (typeof style === 'string') declarations.cssText = style.replace(/(-?[\d.]+)rpx/g, 'calc($1 * var(--fmp-rpx))');
  else for (const [name, value] of Object.entries(style ?? {})) {
    if (value == null) continue;
    const key = kebab(name);
    const text = typeof value === 'number' && !unitless.has(key) ? `${value}px` : String(value);
    declarations.setProperty(key, text.replace(/(-?[\d.]+)rpx/g, 'calc($1 * var(--fmp-rpx))'));
  }
  for (const name of Array.from(declarations)) overlay(el).styles.set(name, declarations.getPropertyValue(name));
  refreshDescriptorAttributes(el);
}

/** 元素上的描述符；带组件实例的元素额外把这些属性代理到实例上 */
export function descriptorOf(el: Element, component: any): Descriptor {
  const existing = descriptors.get(el);
  if (existing) return existing;

  const own = () => (el as any).__wxComponent ?? component;
  const classTokens = (name: string) => name.split(/\s+/).filter(Boolean).flatMap(token => [token, ...(own()?.__styleScopes ?? []).map((scope: string) => `${token}--fmp-${scope}`)]);
  const base: Descriptor = {
    selectComponent(selector) {
      const node = selectElements(el, selector)[0];
      return node ? descriptorOf(node, component) : undefined;
    },
    selectAllComponents(selector) {
      return selectElements(el, selector).map(node => descriptorOf(node, component));
    },
    setStyle(style) {
      if (el.tagName !== 'WX-PAGE') applyStyle(el, style);
    },
    addClass(name) {
      if (el.tagName === 'WX-PAGE') return;
      for (const token of classTokens(name)) overlay(el).classes.set(token, true);
      refreshDescriptorAttributes(el);
    },
    removeClass(name) {
      if (el.tagName === 'WX-PAGE') return;
      for (const token of classTokens(name)) overlay(el).classes.set(token, false);
      refreshDescriptorAttributes(el);
    },
    hasClass(name) {
      return el.classList.contains(name);
    },
    getDataset() {
      return readDataset(el);
    },
    getState() {
      let state = states.get(el);
      if (!state) states.set(el, (state = {}));
      return state;
    },
    getComputedStyle(names) {
      const computed = getComputedStyle(el as HTMLElement);
      const out: Record<string, string> = {};
      for (const name of names ?? []) out[name] = computed.getPropertyValue(kebab(name));
      return out;
    },
    callMethod(name, ...args) {
      const target = own();
      const fn = target?.[name];
      if (typeof fn === 'function') {
        const payload = structuredClone(args);
        pendingCalls.push(() => { if (!target.__destroyed) invoke(target, fn, payload); });
        queueMicrotask(flushDescriptorCalls);
      }
      return undefined;
    },
    triggerEvent(name, detail, options) {
      own()?.triggerEvent?.(name, detail, options);
    },
    requestAnimationFrame(callback) {
      return requestAnimationFrame(() => { if (!own()?.__destroyed) callback(); });
    }
  };

  const descriptor = (el as any).__wxComponent
    ? new Proxy(base, {
        get(target, key) {
          if (key in target) return (target as any)[key];
          return (el as any).__wxComponent?.[key];
        }
      })
    : base;

  descriptors.set(el, descriptor);
  return descriptor;
}
