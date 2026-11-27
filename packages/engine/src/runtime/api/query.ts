/**
 * 选择器查询 / 交叉观察 / 媒体查询
 *
 * 查询对象按微信的链式调用建模：select().boundingClientRect().exec()。
 * 坐标是相对页面视口的（与官方一致），不是相对浏览器窗口。
 */

import { selectElements } from '../selectors';
import { virtualHosts } from '../hosts';
import { pageRect } from '../geometry';
import { nodeProperty } from '../native-properties';
import { eventOwner, readDataset, readMarks } from '../events';
import type { WxHost } from './types';
import { clamp, invoke } from './util';

function toPageRect(page: Element | null, el: Element) {
  if (virtualHosts.has(el)) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  return pageRect(el.getBoundingClientRect(), page);
}

function canvasNode(el: Element | null): any {
  if (!el) return null;
  const canvas = el.tagName === 'CANVAS' ? (el as HTMLCanvasElement) : el.querySelector('canvas');
  if (!canvas) return el;
  const node = canvas as any;
  if (!node.createImage) {
    node.createImage = () => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      return image;
    };
  }
  if (!node.createImageData) {
    node.createImageData = (width: number, height: number) => canvas.getContext('2d')!.createImageData(width, height);
  }
  if (!node.createPath2D) {
    node.createPath2D = (path?: any) => (path !== undefined ? new Path2D(path) : new Path2D());
  }
  if (!node.requestAnimationFrame) {
    node.requestAnimationFrame = (callback: FrameRequestCallback) => requestAnimationFrame(callback);
    node.cancelAnimationFrame = (handle: number) => cancelAnimationFrame(handle);
  }
  if (!node.toDataURL) {
    node.toDataURL = HTMLCanvasElement.prototype.toDataURL.bind(canvas);
  }
  return node;
}

export class Query {
  constructor(
    private readonly host: WxHost,
    private readonly canvasContext?: (holder: Element) => any,
    private readonly videoContext?: (holder: Element) => any
  ) {}

  api() {
    return {
      createSelectorQuery: () => this.createSelectorQuery(),
      createIntersectionObserver: (componentOrOptions?: any, options?: any) =>
        componentOrOptions?.__el
          ? this.createIntersectionObserver(options, componentOrOptions)
          : this.createIntersectionObserver(componentOrOptions),
      createMediaQueryObserver: (component?: any) => this.createMediaQueryObserver(component)
    };
  }

  createSelectorQuery() {
    const page = this.host.pageElement() ?? document.body;
    const tasks: Array<{ run: () => any; callback?: (value: any) => void }> = [];
    let current: Element = page;

    const boxOf = (el: Element | null) => (el ? { ...toPageRect(page, el), id: el.id, dataset: readDataset(el) } : null);

    const fields = (el: Element | null, options: any) => {
      if (!el) return null;
      const rect = toPageRect(page, el);
      const value: any = {};
      if (options?.id) value.id = el.id;
      if (options?.dataset) value.dataset = readDataset(el);
      if (options?.mark) value.mark = readMarks(el);
      if (options?.rect) {
        value.left = rect.left;
        value.top = rect.top;
        value.right = rect.right;
        value.bottom = rect.bottom;
      }
      if (options?.size) {
        value.width = rect.width;
        value.height = rect.height;
      }
      if (options?.scrollOffset) {
        value.scrollLeft = (el as HTMLElement).scrollLeft ?? 0;
        value.scrollTop = (el as HTMLElement).scrollTop ?? 0;
        value.scrollWidth = el.scrollWidth;
        value.scrollHeight = el.scrollHeight;
      }
      for (const name of options?.properties ?? []) {
        const property = nodeProperty(el, name);
        if (property !== undefined) value[name] = property;
      }
      if (options?.computedStyle) {
        const style = getComputedStyle(el);
        for (const name of options.computedStyle) {
          value[name] = style.getPropertyValue(String(name).replace(/[A-Z]/g, (ch: string) => `-${ch.toLowerCase()}`));
        }
      }
      if (options?.node) value.node = canvasNode(el);
      if (options?.context) value.context = contextOf(el);
      return value;
    };

    const contextOf = (el: Element) => {
      if (el.tagName === 'WX-CANVAS') return this.canvasContext?.(el);
      if (el.tagName === 'WX-VIDEO') return this.videoContext?.(el);
      if (el.tagName === 'WX-EDITOR' || el.tagName === 'WX-SELECTION') return (el as any).getContext?.();
      const factories: Record<string, string> = {
        'WX-VIDEO': 'createVideoContext',
        'WX-MAP': 'createMapContext',
        'WX-LIVE-PLAYER': 'createLivePlayerContext',
        'WX-LIVE-PUSHER': 'createLivePusherContext',
        'WX-CAMERA': 'createCameraContext'
      };
      const factory = (globalThis as any).wx?.[factories[el.tagName]];
      return typeof factory === 'function' ? factory(el.id, eventOwner(el)) : undefined;
    };
    const scrollOf = (el: Element | null) =>
      el
        ? {
            id: el.id,
            dataset: readDataset(el),
            scrollLeft: (el as HTMLElement).scrollLeft ?? 0,
            scrollTop: (el as HTMLElement).scrollTop ?? 0,
            scrollWidth: el.scrollWidth,
            scrollHeight: el.scrollHeight
          }
        : null;
    const single = (resolve: () => Element | null) => {
      const node: any = Object.create(query);
      const add = (read: (el: Element | null) => any, callback?: (value: any) => void) => {
        tasks.push({ run: () => read(resolve()), callback });
        return node;
      };
      Object.assign(node, {
        boundingClientRect: (callback?: (value: any) => void) => add(boxOf, callback),
        scrollOffset: (callback?: (value: any) => void) => add(scrollOf, callback),
        fields: (options: any, callback?: (value: any) => void) => add(el => fields(el, options), callback),
        node: (callback?: (value: any) => void) => add(el => (el ? { node: canvasNode(el) } : null), callback),
        context: (callback?: (value: any) => void) => add(el => (el ? { context: contextOf(el) } : null), callback)
      });
      return node;
    };

    const query: any = {
      in(component: any) {
        const el: Element | undefined = component?.__el ?? component?.$el ?? component;
        if (el && el.nodeType === 1) current = el;
        return query;
      },
      select(selector: string) {
        const root = current;
        return single(() => selectElements(root, selector)[0] ?? null);
      },
      selectAll(selector: string) {
        const root = current;
        const all: any = Object.create(query);
        const add = (read: (el: Element) => any, callback?: (value: any) => void) => {
          tasks.push({ run: () => selectElements(root, selector).map(read), callback });
          return all;
        };
        Object.assign(all, {
          boundingClientRect: (callback?: (value: any) => void) => add(boxOf, callback),
          scrollOffset: (callback?: (value: any) => void) => add(scrollOf, callback),
          fields: (options: any, callback?: (value: any) => void) => add(el => fields(el, options), callback),
          node: (callback?: (value: any) => void) => add(el => ({ node: canvasNode(el) }), callback),
          context: (callback?: (value: any) => void) => add(el => ({ context: contextOf(el) }), callback)
        });
        return all;
      },
      selectViewport() {
        const viewport = () => scrollOf(page);
        const view: any = Object.create(query);
        Object.assign(view, {
          boundingClientRect: (callback?: (value: any) => void) => {
            tasks.push({
              run: () => ({
                left: 0,
                top: 0,
                right: page.clientWidth,
                bottom: page.clientHeight,
                width: page.clientWidth,
                height: page.clientHeight
              }),
              callback
            });
            return view;
          },
          scrollOffset: (callback?: (value: any) => void) => {
            tasks.push({ run: viewport, callback });
            return view;
          }
        });
        return view;
      },
      exec(callback?: (results: any[]) => void) {
        // 微信在下一帧执行，保证布局已经稳定
        requestAnimationFrame(() => {
          const results = tasks.map(task => {
            let value: any = null;
            try {
              value = task.run();
            } catch {
              value = null;
            }
            if (typeof task.callback === 'function') task.callback(value);
            return value;
          });
          callback?.(results);
        });
        return query;
      }
    };

    return query;
  }

  createIntersectionObserver(options: any, component?: any) {
    const page = component?.__page?.__el ?? this.host.pageElement();
    const scope = component?.__el ?? page;
    const thresholds = Array.isArray(options?.thresholds) && options.thresholds.length ? options.thresholds : [0];
    let root: Element | null = page;
    let marginsSpec: { top: number; right: number; bottom: number; left: number } = { top: 0, right: 0, bottom: 0, left: 0 };
    let rootMargin = '0px';
    const observed = new Map<Element, { initial: boolean; prevRatio: number; callback: (result: any) => void }>();
    let observer: IntersectionObserver | null = null;
    let rafId: number | null = null;
    let useGeometry = false;

    const parseMargin = (input: any): number => {
      if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
      const n = parseFloat(String(input ?? '0'));
      return Number.isFinite(n) ? n : 0;
    };

    const relativeRect = (rect: { left: number; top: number; right: number; bottom: number; width: number; height: number }) => {
      const base = page?.getBoundingClientRect();
      return {
        left: rect.left - (base?.left ?? 0),
        top: rect.top - (base?.top ?? 0),
        right: rect.right - (base?.left ?? 0),
        bottom: rect.bottom - (base?.top ?? 0),
        width: rect.width,
        height: rect.height,
        x: rect.left - (base?.left ?? 0),
        y: rect.top - (base?.top ?? 0)
      };
    };

    const crossedThreshold = (prev: number, next: number): boolean => {
      if (prev === next) return false;
      const lo = Math.min(prev, next);
      const hi = Math.max(prev, next);
      for (const t of thresholds) {
        if (t === 0) {
          if ((prev === 0 && next > 0) || (prev > 0 && next === 0)) return true;
        } else if (t === 1) {
          if ((prev < 1 && next >= 1) || (prev >= 1 && next < 1)) return true;
        } else if ((prev < t && next >= t) || (prev >= t && next < t) || (lo < t && hi > t)) {
          return true;
        }
      }
      return false;
    };

    const tickGeometry = () => {
      if (!useGeometry || !observed.size) {
        rafId = null;
        return;
      }
      const rawRoot = root ? root.getBoundingClientRect() : null;
      if (rawRoot) {
        const rr = {
          left: rawRoot.left - marginsSpec.left,
          top: rawRoot.top - marginsSpec.top,
          right: rawRoot.right + marginsSpec.right,
          bottom: rawRoot.bottom + marginsSpec.bottom,
          width: rawRoot.width + marginsSpec.left + marginsSpec.right,
          height: rawRoot.height + marginsSpec.top + marginsSpec.bottom
        };
        for (const [el, meta] of Array.from(observed.entries())) {
          const tr = el.getBoundingClientRect();
          const il = Math.max(rr.left, tr.left);
          const it = Math.max(rr.top, tr.top);
          const ir = Math.min(rr.right, tr.right);
          const ib = Math.min(rr.bottom, tr.bottom);
          const iw = Math.max(0, ir - il);
          const ih = Math.max(0, ib - it);
          const area = tr.width * tr.height;
          const ratio = area > 0 ? Math.min(1, Math.max(0, (iw * ih) / area)) : 0;
          const prev = meta.prevRatio;
          const shouldFire = meta.initial
            ? prev !== ratio &&
              thresholds.some((t: number) => t >= Math.min(prev, ratio) && t <= Math.max(prev, ratio))
            : crossedThreshold(prev, ratio);
          meta.initial = false;
          if (shouldFire) {
            meta.prevRatio = ratio;
            meta.callback({
              intersectionRatio: ratio,
              intersectionRect: relativeRect({ left: il, top: it, right: il + iw, bottom: it + ih, width: iw, height: ih }),
              boundingClientRect: relativeRect(tr),
              relativeRect: relativeRect(rr),
              id: el.id,
              dataset: readDataset(el),
              time: Date.now()
            });
          } else {
            meta.prevRatio = ratio;
          }
        }
      }
      if (useGeometry && observed.size) rafId = requestAnimationFrame(tickGeometry);
      else rafId = null;
    };

    const startGeometry = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(tickGeometry);
    };

    const stopGeometry = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const ensure = () => {
      if (observer) return observer;
      observer = new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            const meta = observed.get(entry.target);
            if (!meta) continue;
            if (meta.initial) {
              meta.initial = false;
              const initial = Number(options?.initialRatio ?? 0);
              const current = entry.intersectionRatio;
              if (
                initial === current ||
                !thresholds.some((value: number) => value >= Math.min(initial, current) && value <= Math.max(initial, current))
              )
                continue;
            }
            meta.callback({
              intersectionRatio: entry.intersectionRatio,
              intersectionRect: relativeRect(entry.intersectionRect),
              boundingClientRect: relativeRect(entry.boundingClientRect),
              relativeRect: entry.rootBounds ? relativeRect(entry.rootBounds) : undefined,
              id: entry.target.id,
              dataset: readDataset(entry.target),
              time: Date.now()
            });
          }
        },
        { root, rootMargin, threshold: thresholds }
      );
      return observer;
    };

    const reset = (margins?: any) => {
      marginsSpec = {
        top: parseMargin(margins?.top),
        right: parseMargin(margins?.right),
        bottom: parseMargin(margins?.bottom),
        left: parseMargin(margins?.left)
      };
      const value = (input: any) => (typeof input === 'number' ? `${input}px` : (input ?? '0px'));
      rootMargin = `${value(margins?.top)} ${value(margins?.right)} ${value(margins?.bottom)} ${value(margins?.left)}`;
      observer?.disconnect();
      observer = null;
      stopGeometry();
      if (useGeometry) {
        if (observed.size) startGeometry();
      } else {
        for (const el of observed.keys()) ensure().observe(el);
      }
    };

    const api = {
      relativeTo: (selector: string, margins?: any) => {
        root = scope ? (selectElements(scope, selector)[0] ?? null) : null;
        useGeometry = true;
        reset(margins);
        return api;
      },
      relativeToViewport: (margins?: any) => {
        root = page;
        useGeometry = false;
        reset(margins);
        return api;
      },
      observe: (selector: string, callback: (res: any) => void) => {
        const targets = scope ? selectElements(scope, selector) : [];
        const initialRatio = Number(options?.initialRatio ?? 0);
        for (const el of options?.observeAll ? targets : targets.slice(0, 1)) {
          observed.set(el, { initial: true, prevRatio: initialRatio, callback });
          if (useGeometry) startGeometry();
          else ensure().observe(el);
        }
      },
      disconnect() {
        observer?.disconnect();
        observer = null;
        stopGeometry();
        observed.clear();
      }
    };
    (component ?? this.host.pageInstance())?.__onDispose?.(() => api.disconnect());
    return api;
  }

  createMediaQueryObserver(component?: any) {
    let query: MediaQueryList | null = null;
    let listener: ((event: MediaQueryListEvent) => void) | null = null;
    let callback: ((res: any) => void) | null = null;

    const match = (options: any) => {
      const width = this.host.deviceInfo().screenWidth;
      if (options?.minWidth !== undefined && width < options.minWidth) return false;
      if (options?.maxWidth !== undefined && width > options.maxWidth) return false;
      if (options?.minHeight !== undefined && this.host.deviceInfo().windowHeight < options.minHeight) return false;
      if (options?.maxHeight !== undefined && this.host.deviceInfo().windowHeight > options.maxHeight) return false;
      if (options?.orientation) {
        const portrait = this.host.deviceInfo().windowHeight >= this.host.deviceInfo().screenWidth;
        if (options.orientation === 'portrait' && !portrait) return false;
        if (options.orientation === 'landscape' && portrait) return false;
      }
      return true;
    };

    const api: any = {
      observe: (options: any, cb: (res: any) => void) => {
        if (query && listener) query.removeEventListener('change', listener);
        callback = cb;
        const width = this.host.deviceInfo().screenWidth;
        const parts = [`(min-width: ${options?.minWidth ?? 0}px)`];
        if (options?.maxWidth) parts.push(`(max-width: ${options.maxWidth}px)`);
        query = matchMedia(parts.join(' and '));
        listener = () => callback?.({ matches: match(options) });
        query.addEventListener('change', listener);
        const initial = { matches: match(options) };
        // 微信在 observe 后异步回调一次
        setTimeout(() => callback?.(initial), 0);
        void width;
      },
      disconnect() {
        if (query && listener) query.removeEventListener('change', listener);
        query = null;
        listener = null;
        callback = null;
      }
    };
    (component ?? this.host.pageInstance())?.__onDispose?.(() => api.disconnect());
    return api;
  }

  /** wx.createAnimation：把队列动作编译成 CSS 动画并返回 apply 方法 */
  createAnimation(options?: any) {
    let steps: string[] = [];
    const timing =
      `${options?.timingFunction ?? 'linear'} ${options?.duration ?? 400}ms ${options?.delay ?? 0}ms ${options?.transformOrigin ? '' : ''}`.trim();

    const api: any = {
      export() {
        return { actions: steps.slice(), animation: steps.slice() };
      },
      step(_options?: any) {
        return api;
      }
    };

    const transform = (value: string) => {
      steps.push(value);
      return api;
    };

    Object.assign(api, {
      opacity: (value: number) => transform(`opacity(${clamp(value, 0, 1)})`),
      backgroundColor: (value: string) => transform(`background-color(${value})`),
      width: (value: number | string) => transform(`width(${typeof value === 'number' ? `${value}px` : value})`),
      height: (value: number | string) => transform(`height(${typeof value === 'number' ? `${value}px` : value})`),
      top: (value: number | string) => transform(`top(${typeof value === 'number' ? `${value}px` : value})`),
      left: (value: number | string) => transform(`left(${typeof value === 'number' ? `${value}px` : value})`),
      bottom: (value: number | string) => transform(`bottom(${typeof value === 'number' ? `${value}px` : value})`),
      right: (value: number | string) => transform(`right(${typeof value === 'number' ? `${value}px` : value})`),
      rotate: (value: number) => transform(`rotate(${value}deg)`),
      rotateX: (value: number) => transform(`rotateX(${value}deg)`),
      rotateY: (value: number) => transform(`rotateY(${value}deg)`),
      rotateZ: (value: number) => transform(`rotateZ(${value}deg)`),
      rotate3d: (x: number, y: number, z: number, deg: number) => transform(`rotate3d(${x},${y},${z},${deg}deg)`),
      scale: (x: number, y?: number) => transform(`scale(${x},${y ?? x})`),
      scaleX: (value: number) => transform(`scaleX(${value})`),
      scaleY: (value: number) => transform(`scaleY(${value})`),
      scaleZ: (value: number) => transform(`scaleZ(${value})`),
      scale3d: (x: number, y: number, z: number) => transform(`scale3d(${x},${y},${z})`),
      translate: (x: number, y: number) => transform(`translate(${x}px,${y}px)`),
      translateX: (value: number) => transform(`translateX(${value}px)`),
      translateY: (value: number) => transform(`translateY(${value}px)`),
      translateZ: (value: number) => transform(`translateZ(${value}px)`),
      translate3d: (x: number, y: number, z: number) => transform(`translate3d(${x}px,${y}px,${z}px)`),
      skew: (x: number, y: number) => transform(`skew(${x}deg,${y}deg)`),
      skewX: (value: number) => transform(`skewX(${value}deg)`),
      skewY: (value: number) => transform(`skewY(${value}deg)`)
    });

    // 真正应用时把队列写进内联样式，用 Web Animations 播放
    api.apply = (el: Element, exported: any) => {
      if (!el) return;
      const frames = [{ transform: 'none' }];
      const last: Record<string, string> = {};
      for (const action of exported?.actions ?? []) {
        const match = /^([a-z-]+)\((.*)\)$/i.exec(action);
        if (!match) continue;
        last[match[1]] = match[2];
      }
      const transformParts: string[] = [];
      for (const [name, value] of Object.entries(last)) {
        if (name === 'opacity' || name === 'background-color') continue;
        transformParts.push(`${name}(${value})`);
      }
      frames.push({ transform: transformParts.join(' ') || 'none' });
      (el as HTMLElement).animate?.(frames, {
        duration: options?.duration ?? 400,
        delay: options?.delay ?? 0,
        easing: options?.timingFunction ?? 'linear',
        fill: 'forwards'
      });
    };
    void timing;

    return api;
  }

  /** wx.createAnimation 的 companion：把 animationData 绑到节点上 */
  createAnimationApi(_host: WxHost) {
    return this.createAnimation;
  }

  /** 图片 / 文件转临时路径：canvas.toDataURL 与 blob url 的桥 */
  async toTempFilePath(canvas: HTMLCanvasElement, options: any): Promise<any> {
    const width = options?.destWidth ?? options?.width ?? canvas.width;
    const height = options?.destHeight ?? options?.height ?? canvas.height;
    let target = canvas;
    if (width !== canvas.width || height !== canvas.height) {
      target = document.createElement('canvas');
      target.width = width;
      target.height = height;
      target.getContext('2d')!.drawImage(canvas, 0, 0, width, height);
    }
    const type = options?.fileType === 'jpg' ? 'image/jpeg' : 'image/png';
    const dataUrl = target.toDataURL(type, options?.quality ?? 1);
    const blob = await (await fetch(dataUrl)).blob();
    return { tempFilePath: URL.createObjectURL(blob), errMsg: 'canvasToTempFilePath:ok' };
  }

  /** 供 wx.canvasToTempFilePath 使用 */
  canvasToTempFilePath(options: any) {
    return invoke('canvasToTempFilePath', options, async opts => {
      const page = this.host.pageElement() ?? document.body;
      const canvas =
        (page.querySelector(`[canvas-id="${opts.canvasId}"]`) as HTMLCanvasElement | null) ??
        (page.querySelector(`#${opts.canvasId}`) as HTMLCanvasElement | null) ??
        (page.querySelector('wx-canvas canvas') as HTMLCanvasElement | null);
      if (!canvas) throw new Error('canvas is not found');
      return this.toTempFilePath(canvas, opts);
    });
  }
}
