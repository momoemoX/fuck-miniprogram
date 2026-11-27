/**
 * 触摸手势层
 *
 * 浏览器的 pointer / touch 事件和小程序的触摸事件不是一回事：
 * - 小程序有 `touchstart` / `touchmove` / `touchend` / `touchcancel` 的完整序列，
 *   事件对象带 `touches` / `changedTouches`（identifier、pageX/pageY、clientX/clientY）
 * - `longpress` 是按住 350ms 后触发
 * - `catchtouchmove` 要能阻止页面滚动
 * - `hover-class` 是按下时切换的类名
 *
 * 这里统一用 Pointer Events 驱动（鼠标、触摸、手写笔都覆盖），向页面派发 `wx-touch*` /
 * `wx-longpress` 自定义事件；`tap` 仍然复用原生 click（保留输入框聚焦、label 关联等行为），
 * 但会把事件对象补齐成小程序形状。
 */

export interface WxTouch {
  identifier: number;
  pageX: number;
  pageY: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  force: number;
}

type Phase = 'start' | 'move' | 'end' | 'cancel';

const CATCHERS = new WeakMap<Element, Set<string>>();

/** catchtouchmove 之类需要在原生 touchmove 上 preventDefault，先登记 */
export function markCatch(el: Element, type: string) {
  let set = CATCHERS.get(el);
  if (!set) {
    set = new Set();
    CATCHERS.set(el, set);
  }
  set.add(type);
}

export function isCaught(target: EventTarget | null, type: string): boolean {
  let node = target as Element | null;
  while (node) {
    if (CATCHERS.get(node)?.has(type)) return true;
    node = node.parentElement;
  }
  return false;
}

function pagePoint(event: MouseEvent, root?: Element | null) {
  const rect = root?.getBoundingClientRect();
  const scaleX = rect?.width && root?.clientWidth ? rect.width / root.clientWidth : 1;
  const scaleY = rect?.height && root?.clientHeight ? rect.height / root.clientHeight : 1;
  const clientX = (event.clientX - (rect?.left ?? 0)) / scaleX;
  const clientY = (event.clientY - (rect?.top ?? 0)) / scaleY;
  return {
    clientX,
    clientY,
    pageX: clientX + (root?.scrollLeft ?? window.scrollX),
    pageY: clientY + (root?.scrollTop ?? window.scrollY)
  };
}

function toTouch(event: PointerEvent, root: Element | null): WxTouch {
  return {
    identifier: event.pointerId,
    ...pagePoint(event, root),
    screenX: event.screenX,
    screenY: event.screenY,
    force: event.pointerType === 'mouse' ? 0 : event.pressure
  };
}

interface PressState {
  id: number;
  target: Element;
  x: number;
  y: number;
  moved: boolean;
  mouseStarted?: boolean;
  didScroll?: boolean;
  longFired: boolean;
  scroller?: HTMLElement | null;
  snapType?: string;
  timer: ReturnType<typeof setTimeout> | null;
  hover: { el: Element; cls: string; timer: ReturnType<typeof setTimeout> | null } | null;
}

function userScrollable(el: Element, axis: 'x' | 'y') {
  const overflow = getComputedStyle(el)[axis === 'x' ? 'overflowX' : 'overflowY'];
  const overflows = axis === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight;
  return (
    overflows &&
    (el === document.scrollingElement ? overflow !== 'hidden' && overflow !== 'clip' : overflow === 'auto' || overflow === 'scroll')
  );
}

function findScroller(target: Element, dx: number, dy: number) {
  const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  const forward = (axis === 'x' ? dx : dy) < 0;
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || !userScrollable(el, axis)) continue;
    const position = axis === 'x' ? el.scrollLeft : el.scrollTop;
    const size = axis === 'x' ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (forward ? position < size - 1 : position > 0) return el;
  }
  return null;
}

/** 取 hover-class / hover-start-time / hover-stay-time，支持从祖先继承 */
function hoverFor(target: Element, state: PressState) {
  const el = target.closest('[hover-class]');
  if (!el) return null;
  const cls = el.getAttribute('hover-class') ?? 'none';
  if (!cls || cls === 'none') return null;
  const startTime = Number(el.getAttribute('hover-start-time') ?? 50);
  const stayTime = Number(el.getAttribute('hover-stay-time') ?? 70);

  const add = () => {
    for (const name of cls.split(/\s+/)) if (name) el.classList.add(name);
  };

  const hover = { el, cls, timer: null as ReturnType<typeof setTimeout> | null };
  if (startTime > 0) hover.timer = setTimeout(add, startTime);
  else add();

  state.hover = hover;
  // stayTime 在抬手时用，挂在元素上供 end 读取
  (el as any).__wxHoverStay = stayTime;
  return hover;
}

function clearHover(state: PressState | null) {
  const hover = state?.hover;
  if (!hover) return;
  if (hover.timer) clearTimeout(hover.timer);
  const stay = Number((hover.el as any).__wxHoverStay ?? 70);
  const remove = () => {
    for (const name of hover.cls.split(/\s+/)) if (name) hover.el.classList.remove(name);
  };
  if (stay > 0) setTimeout(remove, stay);
  else remove();
  state!.hover = null;
}

let uninstall: (() => void) | undefined;
let suppressClickUntil = 0;

/** 记录所有按下的触点，touches 要包含多指 */
const cancelledMoves = new WeakSet<Element>();
const active = new Map<number, { touch: WxTouch; target: Element; root: Element | null }>();

function dispatch(target: Element, type: string, source: Event, changed: WxTouch[], detail: Record<string, unknown>) {
  const event = new CustomEvent(type, { bubbles: true, composed: true, cancelable: true, detail });
  const touches = Array.from(active.values()).map(item => item.touch);
  Object.defineProperty(event, 'touches', { value: touches, configurable: true });
  Object.defineProperty(event, 'changedTouches', { value: changed, configurable: true });
  Object.defineProperty(event, 'timeStamp', { value: source.timeStamp, configurable: true });
  target.dispatchEvent(event);
  if (type === 'wx-touchstart') cancelledMoves.delete(target);
  if (event.defaultPrevented) { source.preventDefault(); return false; }
  return true;
}

/** 把 click / contextmenu 补成小程序事件对象：detail {x,y} + touches/changedTouches */
export function decorateEvent(event: Event, type: string, root?: Element | null, released?: WxTouch) {
  if (type !== 'tap' && type !== 'longpress' && type !== 'longtap') return;
  const mouse = event as MouseEvent;
  const point: WxTouch = {
    identifier: 0,
    screenX: mouse.screenX,
    screenY: mouse.screenY,
    force: 0,
    ...(released ?? pagePoint(mouse, root))
  };
  const patch = (name: string, value: unknown) => {
    try {
      Object.defineProperty(event, name, { value, configurable: true });
    } catch {
      /* 只读就算了 */
    }
  };
  patch('detail', { x: Math.round(point.pageX), y: Math.round(point.pageY) });
  patch('touches', [point]);
  patch('changedTouches', [point]);
}

export function installGestureLayer(getRoot: () => Element | null) {
  if (typeof window === 'undefined') return () => {};
  uninstall?.();

  let press: PressState | null = null;
  let released: { touch: WxTouch; target: Element; timeStamp: number } | null = null;

  const onDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const target = event.target as Element | null;
    if (!target) return;
    if (event.pointerType === 'mouse' && !target.closest('input, textarea, select, button, [contenteditable], [selectable], [user-select]'))
      event.preventDefault();

    const root = getRoot();
    const touch = toTouch(event, root);
    suppressClickUntil = 0;
    released = null;
    active.set(event.pointerId, { touch, target, root });

    if (press) {
      // 多指：只更新 touches，不再起长按
      dispatch(target, 'wx-touchstart', event, [touch], {});
      return;
    }

    press = {
      id: event.pointerId,
      target,
      x: touch.clientX,
      y: touch.clientY,
      moved: false,
      longFired: false,
      timer: null,
      hover: null
    };

    hoverFor(target, press);

    // 长按 350ms：与官方一致，移动超过 10px 取消
    press.timer = setTimeout(() => {
      if (!press || press.moved) return;
      press.longFired = true;
      suppressClickUntil = Date.now() + 800;
      dispatch(press.target, 'wx-longpress', event, [touch], { x: Math.round(touch.pageX), y: Math.round(touch.pageY) });
    }, 350);

    dispatch(target, 'wx-touchstart', event, [touch], {});
  };

  const onMove = (event: PointerEvent, force = false) => {
    const record = active.get(event.pointerId);
    if (!record) return;
    const touch = toTouch(event, record.root);
    if (event.pointerType === 'mouse' && press?.id === event.pointerId && !press.mouseStarted) {
      if (!force && Math.hypot(touch.clientX - press.x, touch.clientY - press.y) < 8) return;
      press.mouseStarted = true;
    }
    const dx = touch.clientX - record.touch.clientX;
    const dy = touch.clientY - record.touch.clientY;
    record.touch = touch;
    active.set(event.pointerId, record);

    if (press && press.id === event.pointerId && !press.moved) {
      if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) > 10) {
        press.moved = true;
        if (press.timer) clearTimeout(press.timer);
        clearHover(press);
      }
    }

    if (!dispatch(record.target, 'wx-touchmove', event, [touch], {})) {
      cancelledMoves.add(record.target);
      return;
    }
    if (event.pointerType === 'mouse' && press?.mouseStarted && press.id === event.pointerId && !isCaught(record.target, 'touchmove')) {
      if (press.scroller === undefined) {
        press.scroller = findScroller(record.target, dx, dy);
        if (press.scroller && getComputedStyle(press.scroller).scrollSnapType !== 'none') {
          press.snapType = press.scroller.style.scrollSnapType;
          press.scroller.style.scrollSnapType = 'none';
        }
      }
      const scroller = press.scroller;
      const left = scroller?.scrollLeft,
        top = scroller?.scrollTop;
      scroller?.scrollBy({
        left: userScrollable(scroller, 'x') ? -dx : 0,
        top: userScrollable(scroller, 'y') ? -dy : 0,
        behavior: 'instant'
      });
      if (scroller && (scroller.scrollLeft !== left || scroller.scrollTop !== top)) {
        press.didScroll = true;
        if (press.timer) clearTimeout(press.timer);
        clearHover(press);
      }
    }
  };

  const finish = (event: PointerEvent, phase: Phase) => {
    const record = active.get(event.pointerId);
    if (!record) return;
    const touch = toTouch(event, record.root);
    if (
      phase === 'end' &&
      event.pointerType === 'mouse' &&
      press?.id === event.pointerId &&
      !press.mouseStarted &&
      (touch.clientX !== record.touch.clientX || touch.clientY !== record.touch.clientY)
    )
      onMove(event, true);
    active.delete(event.pointerId);
    if (phase === 'end') released = { touch, target: record.target, timeStamp: event.timeStamp };

    dispatch(record.target, phase === 'cancel' ? 'wx-touchcancel' : 'wx-touchend', event, [touch], {});

    if (press && press.id === event.pointerId) {
      const state = press;
      if (state.timer) clearTimeout(state.timer);
      clearHover(state);
      if (state.longFired || state.moved || state.didScroll) suppressClickUntil = Date.now() + 400;
      if (state.scroller && state.snapType !== undefined) {
        state.scroller.style.scrollSnapType = state.snapType;
        state.scroller.scrollTo({ left: state.scroller.scrollLeft, top: state.scroller.scrollTop, behavior: 'smooth' });
      }
      press = null;
    }
  };

  const onUp = (event: PointerEvent) => finish(event, 'end');
  const onCancel = (event: PointerEvent) => finish(event, 'cancel');

  // capture 阶段监听：页面里的 stopPropagation 不会打断手势状态机
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, { capture: true, passive: false });
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onCancel, true);

  // catchtouchmove：阻止页面滚动（需要非 passive 才能 preventDefault）
  const onTouchMove = (event: TouchEvent) => {
    if (isCaught(event.target, 'touchmove') || cancelledMoves.has(event.target as Element)) event.preventDefault();
  };
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });

  // 长按之后紧跟的 click 不是 tap
  const onClick = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    const root = getRoot();
    const point = released?.target === event.target && event.timeStamp - released.timeStamp < 1000 ? released.touch : undefined;
    decorateEvent(event, 'tap', root, point);
    released = null;
  };
  document.addEventListener('click', onClick, true);

  // 右键菜单在触摸设备上不出现；桌面端保留，但补成 longpress 形状
  const onContext = (event: MouseEvent) => decorateEvent(event, 'longpress', getRoot());
  document.addEventListener('contextmenu', onContext, true);
  const dispose = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onCancel, true);
    document.removeEventListener('touchmove', onTouchMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('contextmenu', onContext, true);
    if (press?.timer) clearTimeout(press.timer);
    if (press?.scroller && press.snapType !== undefined) press.scroller.style.scrollSnapType = press.snapType;
    clearHover(press);
    press = null;
    released = null;
    active.clear();
    suppressClickUntil = 0;
    if (uninstall === dispose) uninstall = undefined;
  };
  uninstall = dispose;
  return dispose;
}
