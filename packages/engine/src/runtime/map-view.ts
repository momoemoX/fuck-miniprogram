/**
 * 地图组件
 *
 * 浏览器里没有腾讯地图瓦片，所以底图用「示意路网」绘制，但交互与数据都是真的：
 * - Web Mercator 投影，markers / polyline / polygons / circles / callout / label / show-location 都按经纬度绘制
 * - 拖动平移、滚轮缩放，会更新 MapContext 读到的中心点与缩放级别，并派发 regionchange
 * - 点击 marker / callout / label 派发 markertap / callouttap / labeltap，点击空白处派发 tap
 * - MapContext 的 moveToLocation / includePoints / translateMarker / addMarkers / removeMarkers 直接驱动视图
 */

import { blobFromPath } from './api/temp-files';
import { booleanProperty, boundAttribute, hasBoundAttribute } from './attributes';
import { DEFAULT_MAP_VIEW, type MapView } from './map-state';
import { customTapSurfaces, nativeEventName, setNativeEventFields } from './events';
export type { MapView } from './map-state';

const TILE_SIZE = 256;

export interface GroundOverlayOptions {
  id: number;
  src: string;
  bounds: {
    southwest: { latitude: number; longitude: number };
    northeast: { latitude: number; longitude: number };
  };
  visible?: boolean;
  opacity?: number;
  zIndex?: number;
}

interface GroundOverlay extends GroundOverlayOptions {
  bitmap: ImageBitmap;
}

function project(latitude: number, longitude: number, scale: number) {
  const size = TILE_SIZE * 2 ** scale;
  const x = ((longitude + 180) / 360) * size;
  const sin = Math.sin((latitude * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
  return { x, y };
}

function unproject(x: number, y: number, scale: number) {
  const size = TILE_SIZE * 2 ** scale;
  const longitude = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const latitude = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { latitude, longitude };
}

interface HitArea {
  kind: 'marker' | 'callout' | 'label';
  id: any;
  x: number;
  y: number;
  width: number;
  height: number;
}

export class WxMap extends HTMLElement {
  static observedAttributes = [
    'latitude', 'longitude', 'scale', 'min-scale', 'max-scale', 'markers', 'polyline', 'polygons', 'circles', 'show-location', 'rotate', 'enable-scroll', 'enable-zoom'
  ];

  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D | null = null;
  private view: MapView = { ...DEFAULT_MAP_VIEW };
  private centerOffset = { x: 0.5, y: 0.5 };
  private readonly groundOverlays = new Map<number, GroundOverlay>();
  private readonly pendingGroundOverlays = new Map<number, AbortController>();
  private readonly imageCache = new Map<string, HTMLImageElement>();
  private extraMarkers: any[] = [];
  private hideAttributeMarkers = false;
  private removed = new Set<string>();
  private hits: HitArea[] = [];
  private selected: any = null;
  private drag: { x: number; y: number; view: MapView } | null = null;
  private moved = false;
  private frame = 0;
  private initialized = false;
  private markerFrame = 0;
  private readonly markerPositions = new Map<string, { latitude: number; longitude: number }>();
  // 不要叫 translate：HTMLElement.translate 是反射属性，赋值会写 translate 属性
  private markerMove: { id: any; from: MapView; to: MapView; start: number; duration: number; done?: () => void } | null = null;

  connectedCallback() {
    if (this.initialized) {
      this.observeSize();
      this.requestDraw();
      return;
    }
    this.initialized = true;

    this.canvas.className = 'wx-map-canvas';
    this.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    const attr = document.createElement('div');
    attr.className = 'wx-map-attr';
    attr.innerHTML = '<span class="wx-map-logo">Map</span>';
    this.appendChild(attr);

    this.syncFromAttributes();
    this.bindPointer();
    this.observeSize();
    this.requestDraw();
  }

  attributeChangedCallback(name: string) {
    if (name === 'markers') {
      this.hideAttributeMarkers = false;
      this.extraMarkers = [];
      this.removed.clear();
      this.markerPositions.clear();
      this.markerMove = null;
      if (this.markerFrame) cancelAnimationFrame(this.markerFrame);
      this.markerFrame = 0;
    }
    if (!this.initialized) return;
    this.syncFromAttributes(name);
    this.requestDraw();
  }

  /* ---------------------------------------------------------------- 视图状态 */

  get latitude() { return this.numberAttribute('latitude', DEFAULT_MAP_VIEW.latitude); }
  get longitude() { return this.numberAttribute('longitude', DEFAULT_MAP_VIEW.longitude); }
  get scale() { return this.hasAttribute('scale') ? boundAttribute(this, 'scale') : DEFAULT_MAP_VIEW.scale; }
  get rotate() { return this.numberAttribute('rotate', 0); }
  get minScale() { return this.numberAttribute('min-scale', 3); }
  get maxScale() { return this.numberAttribute('max-scale', 20); }
  get enableScroll() { return booleanProperty(this, 'enable-scroll') ?? true; }
  get enableZoom() { return booleanProperty(this, 'enable-zoom') ?? true; }
  get showLocation() { return booleanProperty(this, 'show-location') ?? false; }
  get markers() { return this.list('markers'); }
  get polyline() { return this.list('polyline'); }
  get circles() { return this.list('circles'); }
  get polygons() { return this.list('polygons'); }

  private numberAttribute(name: string, fallback: number) {
    const value = this.hasAttribute(name) ? Number(boundAttribute(this, name)) : fallback;
    return Number.isFinite(value) ? value : fallback;
  }

  private scaleLimits() {
    const minimum = Math.max(3, Math.min(20, this.minScale));
    return { minimum, maximum: Math.max(minimum, Math.min(20, this.maxScale)) };
  }

  private clampScale(scale: number) {
    const { minimum, maximum } = this.scaleLimits();
    return Math.max(minimum, Math.min(maximum, scale));
  }

  private syncFromAttributes(name?: string) {
    if (!name || name === 'latitude' || name === 'longitude') {
      this.view.latitude = this.latitude;
      this.view.longitude = this.longitude;
    }
    if (!name || name === 'scale') {
      const scale = Number(this.scale);
      if (Number.isFinite(scale)) this.view.scale = scale;
    }
    if (!name || name === 'scale' || name === 'min-scale' || name === 'max-scale') this.view.scale = this.clampScale(this.view.scale);
  }

  private get renderedMarkers(): any[] {
    const overrides = new Set(this.extraMarkers.filter(marker => marker?.id !== undefined).map(marker => String(marker.id)));
    const attributes = this.hideAttributeMarkers ? [] : this.list('markers').filter(marker => !overrides.has(String(marker?.id)));
    return [...attributes, ...this.extraMarkers]
      .filter(item => !this.removed.has(String(item?.id)))
      .map(item => ({ ...item, ...this.markerPositions.get(String(item?.id)) }));
  }

  private list(name: string): any[] {
    if (hasBoundAttribute(this, name)) {
      const value = boundAttribute(this, name);
      return Array.isArray(value) ? structuredClone(value) : [];
    }
    const raw = this.getAttribute(name);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  private byId(id: any) {
    return this.renderedMarkers.find(item => String(item?.id) === String(id));
  }

  /* ---------------------------------------------------------------- 绘制 */

  private requestDraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private observeSize() {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = (this as any).__mapObserver ?? new ResizeObserver(() => this.requestDraw());
    observer.observe(this);
    (this as any).__mapObserver = observer;
  }

  disconnectedCallback() {
    (this as any).__mapObserver?.disconnect?.();
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.markerFrame) cancelAnimationFrame(this.markerFrame);
    this.frame = this.markerFrame = 0;
    this.markerMove = null;
    this.drag = null;
    queueMicrotask(() => {
      if (this.isConnected) return;
      for (const pending of this.pendingGroundOverlays.values()) pending.abort();
      this.pendingGroundOverlays.clear();
      for (const overlay of this.groundOverlays.values()) overlay.bitmap.close();
      this.groundOverlays.clear();
      for (const image of this.imageCache.values()) {
        image.onload = image.onerror = null;
        image.removeAttribute('src');
      }
      this.imageCache.clear();
    });
  }

  draw() {
    const ctx = this.ctx;
    const width = this.clientWidth;
    const height = this.clientHeight;
    if (!ctx || !width || !height) return;

    const ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const { scale } = this.view;
    const center = project(this.view.latitude, this.view.longitude, scale);
    const toPixel = (latitude: number, longitude: number) => this.toScreenLocation(latitude, longitude);

    this.drawBase(ctx, width, height, center);
    this.drawGroundOverlays(ctx);
    this.drawPolygons(ctx, toPixel);
    this.drawCircles(ctx, toPixel);
    this.drawPolyline(ctx, toPixel);
    this.hits = [];
    this.drawMarkers(ctx, toPixel);

    if (this.showLocation) {
      const location = this.byId('__location__')?.location;
      const point = location ? toPixel(location.latitude, location.longitude) : this.centerPixel();
      this.drawLocation(ctx, point.x, point.y);
    }
  }

  private drawGroundOverlays(ctx: CanvasRenderingContext2D) {
    const overlays = [...this.groundOverlays.values()].sort((a, b) => (a.zIndex ?? 1) - (b.zIndex ?? 1));
    for (const overlay of overlays) {
      if (overlay.visible === false) continue;
      const southwest = this.toScreenLocation(overlay.bounds.southwest.latitude, overlay.bounds.southwest.longitude);
      const northeast = this.toScreenLocation(overlay.bounds.northeast.latitude, overlay.bounds.northeast.longitude);
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, overlay.opacity ?? 1));
      ctx.drawImage(overlay.bitmap, southwest.x, northeast.y, northeast.x - southwest.x, southwest.y - northeast.y);
      ctx.restore();
    }
  }

  /** 示意路网：底色 + 街区 + 白色道路 + 一条主干道，避免大片空白 */
  private drawBase(ctx: CanvasRenderingContext2D, width: number, height: number, center: { x: number; y: number }) {
    ctx.fillStyle = '#eef1ea';
    ctx.fillRect(0, 0, width, height);

    const block = 96;
    const offsetX = -((center.x * 0.6) % (block * 2));
    const offsetY = -((center.y * 0.6) % (block * 2));
    ctx.fillStyle = '#e6eade';
    for (let x = offsetX - block * 2; x < width + block * 2; x += block * 2) {
      for (let y = offsetY - block * 2; y < height + block * 2; y += block * 2) {
        ctx.fillRect(x + 6, y + 6, block - 12, block - 12);
      }
    }

    const step = 96;
    const shiftX = (center.x * 0.6) % step;
    const shiftY = (center.y * 0.6) % step;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 10;
    for (let x = -shiftX; x < width + step; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = -shiftY; y < height + step; y += step) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    ctx.strokeStyle = '#f6d9a0';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(-20, height * 0.72 - shiftY * 0.3);
    ctx.lineTo(width + 20, height * 0.38 - shiftY * 0.3);
    ctx.stroke();
    ctx.strokeStyle = '#fbe9c6';
    ctx.lineWidth = 6;
    ctx.stroke();
  }

  private drawPolyline(ctx: CanvasRenderingContext2D, toPixel: (lat: number, lng: number) => { x: number; y: number }) {
    for (const line of this.list('polyline')) {
      const points: any[] = line?.points ?? [];
      if (points.length < 2) continue;
      ctx.beginPath();
      points.forEach((point, index) => {
        const pixel = toPixel(Number(point.latitude), Number(point.longitude));
        if (index === 0) ctx.moveTo(pixel.x, pixel.y);
        else ctx.lineTo(pixel.x, pixel.y);
      });
      ctx.strokeStyle = String(line.color ?? '#1677ff');
      ctx.lineWidth = Number(line.width ?? 4);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  private drawPolygons(ctx: CanvasRenderingContext2D, toPixel: (lat: number, lng: number) => { x: number; y: number }) {
    const polygons = this.list('polygons').sort((left, right) => (Number(left?.zIndex) || 0) - (Number(right?.zIndex) || 0));
    for (const polygon of polygons) {
      if (!Array.isArray(polygon?.points) || polygon.points.length < 3) continue;
      const points = polygon.points.map((point: any) => toPixel(Number(point?.latitude), Number(point?.longitude)));
      if (!points.every((point: { x: number; y: number }) => Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
      ctx.save();
      ctx.beginPath();
      points.forEach((point: { x: number; y: number }, index: number) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.closePath();
      if (polygon.fillColor) {
        ctx.fillStyle = String(polygon.fillColor);
        ctx.fill();
      }
      const width = Number(polygon.strokeWidth ?? 1);
      if (polygon.strokeColor && Number.isFinite(width) && width > 0) {
        const dash: unknown = polygon.dashArray;
        ctx.setLineDash(Array.isArray(dash) && dash.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ? dash : []);
        ctx.strokeStyle = String(polygon.strokeColor);
        ctx.lineWidth = width;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawCircles(ctx: CanvasRenderingContext2D, toPixel: (lat: number, lng: number) => { x: number; y: number }) {
    const metersPerPixel = (156543.03392 * Math.cos((this.view.latitude * Math.PI) / 180)) / 2 ** this.view.scale;
    for (const circle of this.list('circles')) {
      const center = toPixel(Number(circle.latitude), Number(circle.longitude));
      const radius = Number(circle.radius ?? 0) / Math.max(metersPerPixel, 0.001);
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      if (circle.fillColor) {
        ctx.fillStyle = String(circle.fillColor);
        ctx.fill();
      }
      if (circle.color) {
        ctx.strokeStyle = String(circle.color);
        ctx.lineWidth = Number(circle.strokeWidth ?? 1);
        ctx.stroke();
      }
    }
  }

  private drawMarkers(ctx: CanvasRenderingContext2D, toPixel: (lat: number, lng: number) => { x: number; y: number }) {
    for (const marker of this.renderedMarkers) {
      const point = toPixel(Number(marker.latitude), Number(marker.longitude));
      const width = Number(marker.width ?? 26);
      const height = Number(marker.height ?? 32);

      if (marker.iconPath) {
        const image = this.loadImage(String(marker.iconPath));
        if (image?.complete && image.naturalWidth) ctx.drawImage(image, point.x - width / 2, point.y - height, width, height);
        else {
          ctx.fillStyle = '#fa5151';
          ctx.beginPath();
          ctx.arc(point.x, point.y - height / 2, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        this.drawPin(ctx, point.x, point.y, width, height);
      }

      this.hits.push({ kind: 'marker', id: marker.id, x: point.x - width / 2, y: point.y - height, width, height });

      const label = marker.label;
      if (label) {
        const anchorX = Number(label.anchorX ?? 0);
        const anchorY = Number(label.anchorY ?? 0);
        this.drawBadge(ctx, String(label.content ?? ''), point.x + anchorX, point.y - height + anchorY, label, 'label', marker.id);
      }

      const callout = marker.callout;
      const visible = callout && (callout.display === 'ALWAYS' || String(this.selected) === String(marker.id));
      if (callout && visible) {
        this.drawCallout(ctx, String(callout.content ?? ''), point.x, point.y - height - 6, callout, marker.id);
      }
    }
  }

  private drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
    ctx.save();
    ctx.fillStyle = '#fa5151';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - width / 2, y - height * 0.55, x - width / 2, y - height * 0.72);
    ctx.arc(x, y - height * 0.72, width / 2, Math.PI, 0);
    ctx.quadraticCurveTo(x + width / 2, y - height * 0.55, x, y);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y - height * 0.72, width / 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawBadge(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, style: any, kind: 'label' | 'callout', id: any) {
    if (!text) return;
    const fontSize = Number(style.fontSize ?? 12);
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", sans-serif`;
    const padding = Number(style.padding ?? 4);
    const width = ctx.measureText(text).width + padding * 2;
    const height = fontSize + padding * 2;
    const left = x - width / 2;
    const top = y - height;

    const radius = Number(style.borderRadius ?? (kind === 'callout' ? 6 : 2));
    ctx.fillStyle = String(style.bgColor ?? '#ffffff');
    this.roundRect(ctx, left, top, width, height, radius);
    ctx.fill();
    if (kind === 'callout') {
      ctx.strokeStyle = 'rgba(0,0,0,.08)';
      ctx.lineWidth = 1;
      this.roundRect(ctx, left, top, width, height, radius);
      ctx.stroke();
      ctx.fillStyle = String(style.bgColor ?? '#ffffff');
      ctx.beginPath();
      ctx.moveTo(x - 5, top + height);
      ctx.lineTo(x + 5, top + height);
      ctx.lineTo(x, top + height + 6);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = String(style.color ?? '#333333');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, top + height / 2);

    this.hits.push({ kind, id, x: left, y: top, width, height: height + (kind === 'callout' ? 6 : 0) });
  }

  private drawCallout(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, style: any, id: any) {
    this.drawBadge(ctx, text, x, y, style, 'callout', id);
  }

  private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  private drawLocation(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(22,119,255,.15)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#1677ff';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private loadImage(src: string): HTMLImageElement | null {
    let image = this.imageCache.get(src);
    if (!image) {
      image = new Image();
      image.onload = image.onerror = () => { if (this.isConnected) this.requestDraw(); };
      image.src = src;
      this.imageCache.set(src, image);
    }
    return image;
  }

  /* ---------------------------------------------------------------- 交互 */

  private bindPointer() {
    customTapSurfaces.add(this.canvas);
    this.canvas.addEventListener('pointerdown', event => {
      this.drag = { ...this.pointerLocation(event), view: { ...this.view } };
      this.moved = false;
      this.canvas.setPointerCapture?.(event.pointerId);
    });

    this.canvas.addEventListener('pointermove', event => {
      if (!this.drag || !this.enableScroll) return;
      const point = this.pointerLocation(event);
      const dx = point.x - this.drag.x;
      const dy = point.y - this.drag.y;
      if (!this.moved && Math.hypot(dx, dy) < 3) return;
      if (!this.moved) this.emit('regionchange', { type: 'begin', causedBy: 'drag' });
      this.moved = true;
      const scale = this.drag.view.scale;
      const center = project(this.drag.view.latitude, this.drag.view.longitude, scale);
      const next = unproject(center.x - dx, center.y - dy, scale);
      this.view.latitude = next.latitude;
      this.view.longitude = next.longitude;
      this.requestDraw();
    });

    const end = (event: PointerEvent) => {
      if (!this.drag) return;
      const dragging = this.drag;
      this.drag = null;
      if (this.moved) {
        this.emit('regionchange', { type: 'end', causedBy: 'drag', detail: this.regionPayload() });
        return;
      }
      this.handleTap(event, dragging);
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', () => {
      this.drag = null;
    });

    this.canvas.addEventListener(
      'wheel',
      event => {
        if (!this.enableZoom || !event.deltaY) return;
        event.preventDefault();
        const scale = this.clampScale(this.view.scale + (event.deltaY < 0 ? 1 : -1));
        if (scale === this.view.scale) return;
        this.view.scale = scale;
        this.emit('regionchange', { type: 'end', causedBy: 'update', detail: this.regionPayload() });
        this.requestDraw();
      },
      { passive: false }
    );
  }

  private handleTap(event: PointerEvent, dragging: { x: number; y: number; view: MapView }) {
    const { x, y } = this.pointerLocation(event);
    // 后画的在上层，倒序命中
    for (let index = this.hits.length - 1; index >= 0; index -= 1) {
      const hit = this.hits[index];
      if (x < hit.x || y < hit.y || x > hit.x + hit.width || y > hit.y + hit.height) continue;
      if (hit.kind === 'callout') this.emit('callouttap', { markerId: hit.id });
      else if (hit.kind === 'label') this.emit('labeltap', { markerId: hit.id });
      else this.emit('markertap', { markerId: hit.id });
      this.selected = hit.id;
      this.requestDraw();
      return;
    }

    const scale = dragging.view.scale;
    const center = project(dragging.view.latitude, dragging.view.longitude, scale);
    const anchor = this.centerPixel();
    const point = unproject(center.x + x - anchor.x, center.y + y - anchor.y, scale);
    this.emit('tap', { latitude: point.latitude, longitude: point.longitude });
  }

  private emit(type: string, detail: Record<string, any>) {
    const event = new CustomEvent(nativeEventName(type, this), { detail });
    if (type === 'markertap' || type === 'callouttap' || type === 'labeltap') setNativeEventFields(event, { markerId: detail.markerId });
    this.dispatchEvent(event);
  }

  private regionPayload() {
    const scale = this.view.scale;
    const southWest = this.fromScreenLocation(0, this.clientHeight);
    const northEast = this.fromScreenLocation(this.clientWidth, 0);
    return {
      centerLocation: { latitude: this.view.latitude, longitude: this.view.longitude },
      scale,
      region: {
        southwest: { latitude: southWest.latitude, longitude: southWest.longitude },
        northeast: { latitude: northEast.latitude, longitude: northEast.longitude }
      }
    };
  }

  /* ---------------------------------------------------------------- 给 MapContext 用 */

  private centerPixel() {
    return { x: this.clientWidth * this.centerOffset.x, y: this.clientHeight * this.centerOffset.y };
  }

  private pointerLocation(event: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * this.clientWidth) / (rect.width || 1),
      y: ((event.clientY - rect.top) * this.clientHeight) / (rect.height || 1)
    };
  }

  toScreenLocation(latitude: number, longitude: number) {
    const center = project(this.view.latitude, this.view.longitude, this.view.scale);
    const point = project(latitude, longitude, this.view.scale);
    const anchor = this.centerPixel();
    return { x: anchor.x + point.x - center.x, y: anchor.y + point.y - center.y };
  }

  fromScreenLocation(x: number, y: number) {
    const center = project(this.view.latitude, this.view.longitude, this.view.scale);
    const anchor = this.centerPixel();
    return unproject(center.x + x - anchor.x, center.y + y - anchor.y, this.view.scale);
  }

  setCenterOffset(offset: number[]) {
    this.centerOffset = { x: offset[0], y: offset[1] };
    this.requestDraw();
  }

  getView(): MapView {
    return { ...this.view };
  }

  getRegion() {
    return this.regionPayload();
  }

  async addGroundOverlay(options: GroundOverlayOptions): Promise<boolean> {
    const southwest = options.bounds?.southwest;
    const northeast = options.bounds?.northeast;
    if (!southwest || !northeast || ![southwest.latitude, southwest.longitude, northeast.latitude, northeast.longitude].every(Number.isFinite)) {
      throw new Error('invalid bounds');
    }
    const snapshot = { ...options, bounds: { southwest: { ...southwest }, northeast: { ...northeast } } };
    const id = options.id;
    this.pendingGroundOverlays.get(id)?.abort();
    const controller = new AbortController();
    this.pendingGroundOverlays.set(id, controller);
    const current = () => this.isConnected && !controller.signal.aborted && this.pendingGroundOverlays.get(id) === controller;
    try {
      const blob = await blobFromPath(options.src, controller.signal);
      if (!current()) return false;
      const bitmap = await createImageBitmap(blob);
      if (!current()) { bitmap.close(); return false; }
      this.groundOverlays.get(id)?.bitmap.close();
      this.groundOverlays.set(id, { ...snapshot, bitmap });
      this.requestDraw();
      return true;
    } catch (error) {
      if (!current()) return false;
      throw error;
    } finally {
      if (this.pendingGroundOverlays.get(id) === controller) this.pendingGroundOverlays.delete(id);
    }
  }

  updateGroundOverlay(options: GroundOverlayOptions): Promise<boolean> {
    if (!this.groundOverlays.has(options.id)) return Promise.reject(new Error('overlay not found'));
    return this.addGroundOverlay(options);
  }

  removeGroundOverlay(id: number): boolean {
    this.pendingGroundOverlays.get(id)?.abort();
    this.pendingGroundOverlays.delete(id);
    this.groundOverlays.get(id)?.bitmap.close();
    this.groundOverlays.delete(id);
    this.requestDraw();
    return true;
  }

  moveTo(latitude: number, longitude: number, scale?: number) {
    this.view.latitude = latitude;
    this.view.longitude = longitude;
    if (scale !== undefined) this.view.scale = this.clampScale(scale);
    this.requestDraw();
  }

  includePoints(points: Array<{ latitude: number; longitude: number }>, padding: number[] = [0, 0, 0, 0]) {
    if (!points.length) return;
    const projected = points.map(point => project(Number(point.latitude), Number(point.longitude), 0));
    const minX = Math.min(...projected.map(point => point.x));
    const maxX = Math.max(...projected.map(point => point.x));
    const minY = Math.min(...projected.map(point => point.y));
    const maxY = Math.max(...projected.map(point => point.y));
    const [top = 0, right = 0, bottom = 0, left = 0] = padding;
    const availableWidth = Math.max(1, this.clientWidth - right - left);
    const availableHeight = Math.max(1, this.clientHeight - top - bottom);

    const { minimum, maximum } = this.scaleLimits();
    let scale = maximum;
    for (; scale > minimum; scale -= 1) {
      if ((maxX - minX) * 2 ** scale <= availableWidth && (maxY - minY) * 2 ** scale <= availableHeight) break;
    }
    scale = this.clampScale(scale);
    const anchor = this.centerPixel();
    const { latitude, longitude } = unproject(
      ((minX + maxX) / 2) * 2 ** scale + anchor.x - (left + availableWidth / 2),
      ((minY + maxY) / 2) * 2 ** scale + anchor.y - (top + availableHeight / 2),
      scale
    );
    this.view = { latitude, longitude, scale };
    this.requestDraw();
  }

  translateMarker(id: any, destination: { latitude: number; longitude: number }, duration = 300, done?: () => void) {
    const marker = this.byId(id);
    if (!marker) return;
    const from = { latitude: Number(marker.latitude), longitude: Number(marker.longitude), scale: this.view.scale };
    if (this.markerFrame) cancelAnimationFrame(this.markerFrame);
    this.markerFrame = 0;
    this.markerMove = {
      id,
      from,
      to: { latitude: Number(destination.latitude), longitude: Number(destination.longitude), scale: from.scale },
      start: performance.now(),
      duration,
      done
    };
    this.stepTranslate();
  }

  private stepTranslate = () => {
    this.markerFrame = 0;
    const translate = this.markerMove;
    if (!translate || !this.isConnected) return;
    const progress = Math.min(1, (performance.now() - translate.start) / Math.max(1, translate.duration));
    const ease = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
    const marker = this.byId(translate.id);
    if (marker) {
      this.markerPositions.set(String(translate.id), {
        latitude: translate.from.latitude + (translate.to.latitude - translate.from.latitude) * ease,
        longitude: translate.from.longitude + (translate.to.longitude - translate.from.longitude) * ease
      });
    }
    this.requestDraw();
    if (progress < 1) this.markerFrame = requestAnimationFrame(this.stepTranslate);
    else {
      this.markerMove = null;
      translate.done?.();
    }
  };

  addMarkers(markers: any[], clear = false) {
    if (clear) {
      this.hideAttributeMarkers = true;
      this.extraMarkers = [];
      this.removed.clear();
      this.markerPositions.clear();
      this.selected = null;
      this.markerMove = null;
      if (this.markerFrame) cancelAnimationFrame(this.markerFrame);
      this.markerFrame = 0;
    }
    for (const marker of markers ?? []) {
      if (!marker || typeof marker !== 'object') continue;
      const id = marker.id;
      const index = id === undefined ? -1 : this.extraMarkers.findIndex(item => String(item?.id) === String(id));
      if (id !== undefined) {
        this.removed.delete(String(id));
        this.markerPositions.delete(String(id));
      }
      const snapshot = JSON.parse(JSON.stringify(marker));
      if (index < 0) this.extraMarkers.push(snapshot);
      else this.extraMarkers[index] = snapshot;
    }
    this.requestDraw();
  }

  removeMarkers(ids: any[]) {
    for (const id of ids ?? []) this.removed.add(String(id));
    this.extraMarkers = this.extraMarkers.filter(marker => !this.removed.has(String(marker?.id)));
    this.requestDraw();
  }
}
