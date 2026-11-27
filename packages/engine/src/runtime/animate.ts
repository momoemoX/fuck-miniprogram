/**
 * 关键帧动画（this.animate / this.clearAnimation）
 *
 * 小程序的 keyframes 是「属性 + offset」的数组，比如：
 *   [{ opacity: 0, scale: 0.8, offset: 0 }, { opacity: 1, scale: 1, offset: 1 }]
 * 这里换算成 Web Animations 的 Keyframe，transform 类属性合并成一条 transform。
 */

import { ownedElements } from './selectors';

const PX_KEYS = new Set([
  'width',
  'height',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontSize',
  'borderRadius',
  'borderWidth',
  'translateX',
  'translateY',
  'translateZ'
]);
const DEGREE_KEYS = new Set(['rotate', 'rotateX', 'rotateY', 'rotateZ', 'skewX', 'skewY']);
const SCALE_KEYS = new Set(['scale', 'scaleX', 'scaleY', 'scaleZ']);
const UNITLESS = new Set(['opacity', 'zIndex', 'flexGrow', 'flexShrink', 'order', 'lineHeight']);

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, match => `-${match.toLowerCase()}`);
}

function numeric(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toKeyframes(frames: any[]): Keyframe[] {
  return frames.map(frame => {
    const style: Record<string, any> = {};
    const transform: string[] = [];

    for (const [key, raw] of Object.entries(frame ?? {})) {
      if (key === 'offset' || key === 'ease') continue;
      if (raw === undefined || raw === null) continue;

      if (key === 'translate') transform.push(`translate(${numeric((raw as any)[0])}px, ${numeric((raw as any)[1])}px)`);
      else if (key === 'scale3d') transform.push(`scale3d(${(raw as any).join(',')})`);
      else if (key === 'rotate3d') {
        const values = raw as any[];
        transform.push(`rotate3d(${values[0]}, ${values[1]}, ${values[2]}, ${values[3]}deg)`);
      } else if (key === 'skew') transform.push(`skew(${numeric((raw as any)[0])}deg, ${numeric((raw as any)[1])}deg)`);
      else if (SCALE_KEYS.has(key)) transform.push(`${key}(${numeric(raw, 1)})`);
      else if (DEGREE_KEYS.has(key)) transform.push(`${key}(${numeric(raw)}deg)`);
      else if (key === 'translateX' || key === 'translateY' || key === 'translateZ') {
        transform.push(`${key}(${numeric(raw)}px)`);
      } else if (PX_KEYS.has(key)) {
        style[kebab(key)] = `${numeric(raw)}px`;
      } else if (UNITLESS.has(key)) {
        style[kebab(key)] = Number(raw);
      } else {
        style[kebab(key)] = String(raw);
      }
    }

    if (transform.length) style.transform = transform.join(' ');
    const keyframe: Record<string, any> = { ...style };
    if (typeof frame?.offset === 'number') keyframe.offset = frame.offset;
    if (typeof frame?.ease === 'string') keyframe.easing = frame.ease;
    return keyframe as Keyframe;
  });
}

/** this.animate(selector, keyframes, duration, [delay], [ease], [callback]) */
export function parseAnimateOptions(duration: number, rest: any[]): AnimateOptions {
  let delay = 0;
  let easing = 'ease';
  for (const item of rest) {
    if (typeof item === 'number') delay = item;
    else if (typeof item === 'string') easing = item;
  }
  const scroll = rest.find(item => item && typeof item === 'object' && 'scrollSource' in item);
  return { duration, delay, easing: scroll && !rest.some(item => typeof item === 'string') ? 'linear' : easing, scroll };
}

export function lastFunction(rest: any[]): (() => void) | undefined {
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    if (typeof rest[index] === 'function') return rest[index];
  }
  return undefined;
}

export interface AnimateOptions {
  duration?: number;
  delay?: number;
  easing?: string;
  scroll?: { scrollSource: string; timeRange: number; startScrollOffset: number; endScrollOffset: number; orientation?: 'horizontal' | 'vertical' };
}

interface PropertyAnimation {
  animation: Animation;
  original: string;
  priority: string;
  stop?: () => void;
}
const applied = new WeakMap<Element, Map<string, PropertyAnimation>>();
const roots = new WeakMap<Element, Set<Element>>();

export function disposeAnimations(root: Element) {
  for (const target of roots.get(root) ?? []) clearTarget(target);
  roots.delete(root);
}
function clearTarget(target: Element, names?: Set<string>) {
  const records = applied.get(target);
  if (!records) return;
  for (const [name, record] of records) {
    if (names && !names.has(name)) continue;
    record.stop?.(); record.animation.cancel();
    (target as HTMLElement).style.setProperty(name, record.original, record.priority);
    records.delete(name);
  }
  if (!records.size) applied.delete(target);
}
function targetsIn(root: Element, selector: string) {
  return [...new Set(selector.split(',').flatMap(item => item.trim() ? ownedElements(root, item.trim()) : []))];
}
export function animateIn(root: Element, selector: string, frames: any[], options: AnimateOptions = {}, callback?: () => void): void {
  if (!Array.isArray(frames) || !frames.length) throw new TypeError('keyframes must be a non-empty array');
  const duration = options.duration ?? 400;
  if (!Number.isFinite(duration) || duration < 0) throw new TypeError('duration must be non-negative');
  const keyframes = toKeyframes(frames);
  const targets = targetsIn(root, selector);
  const scroll = options.scroll;
  const source = scroll ? ownedElements(root, scroll.scrollSource)[0] as HTMLElement : undefined;
  if (scroll && (!source || source.tagName !== 'WX-SCROLL-VIEW' || !Number.isFinite(scroll.timeRange) || scroll.timeRange < 0 || !Number.isFinite(scroll.startScrollOffset) || !Number.isFinite(scroll.endScrollOffset) || scroll.endScrollOffset === scroll.startScrollOffset || (scroll.orientation && !['vertical','horizontal'].includes(scroll.orientation)))) throw new TypeError('invalid scroll timeline');
  if (!targets.length) { callback?.(); return; }
  let tracked = roots.get(root);
  if (!tracked) roots.set(root, tracked = new Set());
  const completions: Promise<unknown>[] = [];
  for (const target of targets) {
    const host = target as HTMLElement;
    if (!host.animate) continue;
    tracked.add(target);
    let records = applied.get(target);
    if (!records) applied.set(target, records = new Map());
    const properties = new Set(keyframes.flatMap(frame => Object.keys(frame).filter(name => !['offset','easing','composite'].includes(name))));
    for (const name of properties) {
      const previous = records.get(name);
      previous?.stop?.(); previous?.animation.cancel();
      const original = previous?.original ?? host.style.getPropertyValue(name);
      const priority = previous?.priority ?? host.style.getPropertyPriority(name);
      const animation = host.animate(keyframes.map(frame => ({ [name]: (frame as any)[name], ...(frame.offset === undefined ? {} : {offset:frame.offset}), ...(frame.easing ? {easing:frame.easing} : {}) })), { duration, delay: options.delay ?? 0, easing: options.easing ?? 'ease', fill: 'both' });
      const record: PropertyAnimation = { animation, original, priority };
      records.set(name, record);
      if (source && scroll) {
        animation.pause();
        const update = () => {
          const offset = scroll.orientation === 'horizontal' ? source.scrollLeft : source.scrollTop;
          const time = (offset - scroll.startScrollOffset) / (scroll.endScrollOffset - scroll.startScrollOffset) * scroll.timeRange;
          animation.currentTime = Math.max(0, Math.min(duration, time));
        };
        source.addEventListener('scroll', update, { passive: true });
        record.stop = () => source.removeEventListener('scroll', update);
        update();
      } else completions.push(animation.finished.catch(() => undefined));
    }
  }
  if (!scroll) void Promise.all(completions).then(() => { if (roots.has(root)) callback?.(); });
}
export function clearIn(root: Element, selector: string, options?: Record<string, unknown> | (() => void), callback?: () => void): void {
  if (typeof options === 'function') { callback = options; options = undefined; }
  const names = options ? new Set(Object.entries(options).filter(([,value]) => value === true).map(([name]) => /^(translate|rotate|scale|skew)/.test(name) ? 'transform' : kebab(name))) : undefined;
  for (const target of targetsIn(root, selector)) clearTarget(target, names);
  callback?.();
}
