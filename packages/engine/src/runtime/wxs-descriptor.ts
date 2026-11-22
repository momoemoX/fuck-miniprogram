/**
 * WXS 视图层描述符（`ComponentDescriptor`）
 *
 * `change:`、`bind:` 指向 WXS 函数时，WXS 拿到两个对象：
 * - `ownerInstance`：绑定所在组件的描述符，可跨节点查询、调方法、派事件；
 * - `instance`：触发这次调用的元素本身的描述符，可读写自身样式 / 类名 / dataset / 状态。
 *
 * 描述符按元素缓存，`getState()` 返回的对象因此在多次调用间保持同一份。
 */

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

const states = new WeakMap<Element, Record<string, unknown>>();
const descriptors = new WeakMap<Element, Descriptor>();

const kebab = (name: string) => name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);

function applyStyle(el: Element, style: string | Record<string, unknown>) {
  const html = el as HTMLElement;
  if (typeof style === 'string') {
    for (const declaration of style.split(';')) {
      const at = declaration.indexOf(':');
      if (at < 0) continue;
      html.style.setProperty(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim());
    }
    return;
  }
  for (const [name, value] of Object.entries(style ?? {})) {
    if (value == null) continue;
    html.style.setProperty(kebab(name), typeof value === 'number' ? `${value}px` : String(value));
  }
}

/** 元素上的描述符；带组件实例的元素额外把这些属性代理到实例上 */
export function descriptorOf(el: Element, component: any): Descriptor {
  const existing = descriptors.get(el);
  if (existing) return existing;

  const own = () => (el as any).__wxComponent ?? component;
  const base: Descriptor = {
    selectComponent(selector) {
      const node = selectElements(el, selector)[0];
      return node ? descriptorOf(node, component) : undefined;
    },
    selectAllComponents(selector) {
      return selectElements(el, selector).map(node => descriptorOf(node, component));
    },
    setStyle(style) {
      applyStyle(el, style);
    },
    addClass(name) {
      el.classList.add(name);
    },
    removeClass(name) {
      el.classList.remove(name);
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
      return typeof fn === 'function' ? fn.apply(target, args) : undefined;
    },
    triggerEvent(name, detail, options) {
      own()?.triggerEvent?.(name, detail, options);
    },
    requestAnimationFrame(callback) {
      return requestAnimationFrame(callback);
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
