import { logicalParent, virtualHosts, virtualEventHosts } from './hosts';

const aliases: Record<string, string> = {
  tap: 'click',
  scroll: 'wx-scroll',
  longpress: 'wx-longpress',
  longtap: 'wx-longpress',
  touchstart: 'wx-touchstart',
  touchmove: 'wx-touchmove',
  touchend: 'wx-touchend',
  touchcancel: 'wx-touchcancel'
};

export function nativeEventName(type: string, element?: Element): string {
  if (type === 'tap' && element?.tagName === 'WX-MAP') return 'wx-map-tap';
  return aliases[type] ?? type;
}

export function allowsNativeEventCapture(event: Event): boolean {
  if ((event.type === 'enterpictureinpicture' || event.type === 'leavepictureinpicture') && event.target instanceof Element && event.target.matches('wx-video video')) return false;
  return event.bubbles || !(event.target instanceof Element) || !event.target.closest('wx-audio,wx-video');
}

export const customTapSurfaces = new WeakSet<EventTarget>();

const datasets = new WeakMap<Element, Record<string, unknown>>();
const marks = new WeakMap<Element, Record<string, unknown>>();
const owners = new WeakMap<Element, any>();
const mutHandled = new WeakSet<object>();
const results = new WeakMap<Event, unknown>();
const nativeFields = new WeakMap<Event, Record<string, unknown>>();

export function setNativeEventFields(event: Event, fields: Record<string, unknown>) {
  nativeFields.set(event, fields);
}

export function setEventResult(event: Event, value: unknown) {
  results.set(event, value);
}
export function eventResult(event: Event) {
  return results.get(event);
}

export function eventOwner(el: Element) {
  return owners.get(el);
}
export function setEventOwner(el: Element, owner: any) {
  owners.set(el, owner);
}
export function setMark(el: Element, name: string, value: unknown) {
  let data = marks.get(el);
  if (!data) marks.set(el, (data = {}));
  data[name.slice(5)] = value;
}

export function readMarks(el: Element, boundaryOwner?: any): Record<string, unknown> {
  const scopeOwner = boundaryOwner !== undefined ? boundaryOwner : owners.get(el);
  const path: Element[] = [];
  for (let node: Element | null = el; node; node = logicalParent(node)) {
    if (scopeOwner !== undefined && owners.has(node) && owners.get(node) !== scopeOwner) break;
    path.push(node);
  }
  const mark: Record<string, unknown> = {};
  for (const node of path.reverse()) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('mark:')) {
        const key = attr.name.slice(5);
        const stored = marks.get(node);
        mark[key] = stored && key in stored ? stored[key] : attr.value;
      }
    }
  }
  return mark;
}
export function handleMutEvent(event: object): boolean {
  if (mutHandled.has(event)) return false;
  mutHandled.add(event);
  return true;
}
export function readDataset(el: Element) {
  return { ...(el as HTMLElement).dataset, ...datasets.get(el) };
}

export function setDataset(el: Element, name: string, value: unknown) {
  let data = datasets.get(el);
  if (!data) datasets.set(el, (data = {}));
  const key = name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  data[key] = value;
}

function targetInfo(target: Element | null) {
  if (!target) return { id: '', dataset: {} };
  return {
    id: target.id,
    dataset: readDataset(target),
    offsetLeft: (target as HTMLElement).offsetLeft,
    offsetTop: (target as HTMLElement).offsetTop
  };
}

function retargetNode(original: Element, receiver: any): Element {
  let target = original;
  while (!owners.has(target) && target.parentElement) target = target.parentElement;
  let owner = owners.get(target);
  let outside = target;
  while (owner && owner !== receiver) {
    outside = owner.__el;
    owner = owner.__owner;
  }
  if (owner === receiver) return outside;
  for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (owners.get(ancestor) === receiver && ancestor.tagName !== 'WX-SLOT') return ancestor;
  }
  return original;
}

export function miniEvent(event: any, current: Element, type: string, receiver?: any) {
  let target: Element = event.target instanceof Element ? event.target : current;
  if (receiver) target = retargetNode(target, receiver);
  const mark = readMarks(target, receiver ?? owners.get(current));
  return {
    ...nativeFields.get(event),
    type,
    timeStamp: event.timeStamp,
    target: targetInfo(target),
    currentTarget: targetInfo(current),
    detail: event.detail ?? {},
    touches: event.touches,
    changedTouches: event.changedTouches,
    mark
  };
}

interface ComponentListener {
  owner: any;
  capture: boolean;
  stop: boolean;
  mut?: boolean;
  invoke(event: any): void;
}

const componentListeners = new WeakMap<Element, Map<string, Set<ComponentListener>>>();
const virtualPhases = new WeakMap<Event, Map<Element, Set<string>>>();
const nativeBridges = new WeakMap<Element, Map<string, { capture: EventListener; bubble: EventListener; connected: boolean }>>();
let treeObserver: MutationObserver | null = null;

function virtualParents(node: Element): Element[] {
  const parents: Element[] = [];
  for (let parent = logicalParent(node); parent && virtualHosts.has(parent); parent = logicalParent(parent))
    if (virtualEventHosts.has(parent)) parents.push(parent);
  return parents;
}

function forwardVirtual(event: Event, root: Element, capture: boolean) {
  if (capture && !allowsNativeEventCapture(event)) return true;
  if (!(event.target instanceof Element) || (!owners.has(event.target) && event.type !== 'click' && !event.type.startsWith('wx-')))
    return false;
  const parents = virtualParents(root);
  if (capture) parents.reverse();
  let handled = virtualPhases.get(event);
  if (!handled) virtualPhases.set(event, (handled = new Map()));
  for (const host of parents) {
    let phases = handled.get(host);
    if (!phases) handled.set(host, (phases = new Set()));
    for (const [type, listeners] of componentListeners.get(host) ?? []) {
      if (nativeEventName(type) !== event.type && type !== event.type) continue;
      const key = `${type}:${capture}`;
      if (phases.has(key)) continue;
      phases.add(key);
      for (const listener of [...listeners]) {
        if (listener.capture !== capture || (listener.mut && !handleMutEvent(event))) continue;
        if (listener.stop) event.stopPropagation();
        listener.invoke(miniEvent(event, host, type, listener.owner));
      }
    }
    if (event.cancelBubble) break;
  }
  return event.cancelBubble;
}

export function forwardVirtualCapture(event: Event, root: Element) {
  return forwardVirtual(event, root, true);
}

export function refreshVirtualEvents() {
  if (!virtualHosts.size) {
    treeObserver?.disconnect();
    treeObserver = null;
    return;
  }
  if (!treeObserver) {
    treeObserver = new MutationObserver(refreshVirtualEvents);
    treeObserver.observe(document.body, { childList: true, subtree: true });
  }
  for (const range of virtualHosts.values()) {
    for (const root of range.elements()) {
      let bridges = nativeBridges.get(root);
      if (!bridges) nativeBridges.set(root, (bridges = new Map()));
      const types = new Set<string>();
      for (const parent of virtualParents(root))
        for (const type of componentListeners.get(parent)?.keys() ?? []) types.add(nativeEventName(type));
      for (const type of types) {
        let bridge = bridges.get(type);
        if (!bridge) {
          bridge = {
            capture: event => forwardVirtual(event, root, true),
            bubble: event => forwardVirtual(event, root, false),
            connected: root.isConnected
          };
          bridges.set(type, bridge);
          root.addEventListener(type, bridge.capture, true);
        } else if (!bridge.connected && root.isConnected) {
          // 首次连接后排在控件监听器后面；派发中反复重挂会丢失当前事件。
          root.removeEventListener(type, bridge.bubble);
          bridge.connected = true;
        }
        root.addEventListener(type, bridge.bubble);
      }
    }
  }
}

export function bindComponentEvent(el: Element, type: string, listener: ComponentListener) {
  let types = componentListeners.get(el);
  if (!types) componentListeners.set(el, (types = new Map()));
  let listeners = types.get(type);
  if (!listeners) types.set(type, (listeners = new Set()));
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatchComponentEvent(
  source: any,
  type: string,
  detail: any,
  options: { bubbles?: boolean; composed?: boolean; capturePhase?: boolean } = {}
) {
  const boundary: Element | undefined = options.composed ? undefined : source.__owner?.__el;
  const path: Element[] = [];
  let node: Element | null = source.__el;
  while (node && node !== boundary) {
    path.push(node);
    node = logicalParent(node);
  }
  const timeStamp = performance.now();
  let stopped = false;
  let mutated = false;
  const deliver = (el: Element, capture: boolean) => {
    for (const listener of Array.from(componentListeners.get(el)?.get(type) ?? [])) {
      if (listener.capture !== capture || (listener.mut && mutated)) continue;
      if (listener.mut) mutated = true;
      const event = miniEvent({ target: retargetNode(source.__el, listener.owner), detail, timeStamp, composedPath: () => path }, el, type);
      if (listener.stop) stopped = true;
      try {
        listener.invoke(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
  if (options.capturePhase) {
    for (const el of path.slice().reverse()) {
      deliver(el, true);
      if (stopped) return;
    }
  }
  for (const el of options.bubbles ? path : path.slice(0, 1)) {
    deliver(el, false);
    if (stopped) return;
  }
}
