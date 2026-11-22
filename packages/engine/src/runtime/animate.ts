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

export interface ScrollTimelineOptions {
  scrollSource: string;
  orientation?: 'vertical' | 'horizontal';
  startScrollOffset?: number;
  endScrollOffset?: number;
  timeRange?: number;
}

/** this.animate(selector, keyframes, duration, [scrollTimeline | delay | ease | callback]) */
export function parseAnimateOptions(duration: number, rest: any[]): AnimateOptions {
  let delay = 0;
  let easing = 'ease';
  let scrollTimeline: ScrollTimelineOptions | undefined;
  for (const item of rest) {
    if (typeof item === 'number') delay = item;
    else if (typeof item === 'string') easing = item;
    else if (item && typeof item === 'object' && typeof item.scrollSource === 'string') {
      scrollTimeline = item as ScrollTimelineOptions;
    }
  }
  return { duration, delay, easing, scrollTimeline };
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
  scrollTimeline?: ScrollTimelineOptions;
}

/** 记下每个元素最后一次动画的终态，clearAnimation 只清一部分属性时要靠它回填 */
const applied = new WeakMap<Element, Record<string, string>>();
const scrollCleanups = new WeakMap<Element, () => void>();

function bindScrollAnimation(
  root: Element,
  target: HTMLElement,
  keyframes: Keyframe[],
  duration: number,
  timeline: ScrollTimelineOptions
) {
  scrollCleanups.get(target)?.();
  scrollCleanups.delete(target);

  const source =
    (ownedElements(root, timeline.scrollSource)[0] as HTMLElement | undefined) ??
    (document.querySelector(timeline.scrollSource) as HTMLElement | null);
  const timeRange = typeof timeline.timeRange === 'number' && timeline.timeRange > 0 ? timeline.timeRange : duration || 200;
  const start = typeof timeline.startScrollOffset === 'number' ? timeline.startScrollOffset : 0;
  const orientation = timeline.orientation === 'horizontal' ? 'horizontal' : 'vertical';

  const animation = target.animate(keyframes, {
    duration: timeRange,
    easing: 'linear',
    fill: 'both'
  });
  animation.pause();

  const sync = () => {
    if (!source) return;
    const offset = orientation === 'horizontal' ? source.scrollLeft : source.scrollTop;
    const maxScroll =
      orientation === 'horizontal'
        ? Math.max(0, source.scrollWidth - source.clientWidth)
        : Math.max(0, source.scrollHeight - source.clientHeight);
    const end = typeof timeline.endScrollOffset === 'number' ? timeline.endScrollOffset : maxScroll;
    const span = end - start;
    const progress = span <= 0 ? (offset >= end ? 1 : 0) : Math.min(1, Math.max(0, (offset - start) / span));
    animation.currentTime = progress * timeRange;
  };

  sync();
  if (source) source.addEventListener('scroll', sync, { passive: true });
  scrollCleanups.set(target, () => {
    if (source) source.removeEventListener('scroll', sync);
    animation.cancel();
  });
}

/** 在 root（页面或组件）里按选择器找元素，播放关键帧，全部结束后回调 */
export function animateIn(root: Element, selector: string, frames: any[], options: AnimateOptions = {}, callback?: () => void): void {
  const keyframes = toKeyframes(frames);
  const targets = selector
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .flatMap(item => ownedElements(root, item));

  if (!targets.length) {
    callback?.();
    return;
  }

  const last = keyframes[keyframes.length - 1] ?? {};
  if (options.scrollTimeline) {
    for (const target of targets) {
      const host = target as HTMLElement;
      if (!host.animate) continue;
      const values: Record<string, string> = {};
      for (const [name, value] of Object.entries(last)) {
        if (name === 'offset' || name === 'easing' || value == null) continue;
        values[name] = String(value);
      }
      applied.set(target, values);
      bindScrollAnimation(root, host, keyframes, options.duration ?? 400, options.scrollTimeline);
    }
    callback?.();
    return;
  }

  let remaining = targets.length;
  for (const target of targets) {
    const host = target as HTMLElement;
    if (!host.animate) continue;
    scrollCleanups.get(target)?.();
    scrollCleanups.delete(target);
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(last)) {
      if (name === 'offset' || name === 'easing' || value == null) continue;
      values[name] = String(value);
    }
    applied.set(target, values);
    const animation = host.animate(keyframes, {
      duration: options.duration ?? 400,
      delay: options.delay ?? 0,
      easing: options.easing ?? 'ease',
      fill: 'forwards'
    });
    animation.onfinish = () => {
      remaining -= 1;
      if (remaining === 0) callback?.();
    };
  }
}

/** this.clearAnimation(selector, [options], callback)：options 里的属性恢复原值，其余保留终态 */
export function clearIn(
  root: Element,
  selector: string,
  options?: Record<string, unknown> | (() => void),
  callback?: () => void
): void {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  const keep = options ? new Set(Object.keys(options).map(kebab)) : null;
  const targets = selector
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .flatMap(item => ownedElements(root, item));

  for (const target of targets) {
    const host = target as HTMLElement;
    scrollCleanups.get(target)?.();
    scrollCleanups.delete(target);
    const values = applied.get(target);
    if (!values) continue;
    for (const animation of host.getAnimations?.() ?? []) animation.cancel();
    for (const name of Object.keys(values)) host.style.removeProperty(name);
    if (keep) {
      // 保留的属性写成内联值，并留在记录里，下一次 clearAnimation 才能一起清掉
      const retained = Object.fromEntries(Object.entries(values).filter(([name]) => !keep.has(name)));
      for (const [name, value] of Object.entries(retained)) host.style.setProperty(name, value);
      applied.set(target, retained);
    } else applied.delete(target);
  }
  callback?.();
}
