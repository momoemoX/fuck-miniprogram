/**
 * 地图上下文
 *
 * 按组件和页面作用域定位地图，读取视图状态并转发已实现的地图操作。
 * 浏览器底图使用示意路网；原生地图服务和完整上下文能力仍需要对应宿主。
 */

import type { WxHost } from './types';
import { deliver, hasCallback, invoke, numberOr } from './util';
import { anchorOf } from '../hosts';
import { ownedElements } from '../selectors';
import type { WxMap } from '../map-view';
import { CONTEXT_METHODS, type ContextShape } from '../contexts';
import { DEFAULT_MAP_VIEW, type MapView } from '../map-state';

interface MapState extends MapView {
  rotate: number;
}

const GROUND_OVERLAY_OPERATIONS = {
  addGroundOverlay: 'addMapGroundOverlay', updateGroundOverlay: 'updateMapGroundOverlay', removeGroundOverlay: 'removeMapGroundOverlay'
} as const;

export class MapApi {
  private state = new WeakMap<Element, Map<string, MapState>>();

  constructor(private readonly host: WxHost) {}

  api() {
    return {
      createMapContext: (mapId: string, component?: any) => {
        const root = component?.__el ?? this.host.pageElement() ?? document.body;
        const element = () => (mapId && anchorOf(root).isConnected ? (ownedElements(root, `#${CSS.escape(mapId)}`)[0] ?? null) : null);
        let states = this.state.get(root);
        if (!states) this.state.set(root, (states = new Map()));
        const readAttr = (name: string) => {
          const raw = element()?.getAttribute(name);
          if (raw === null || raw === undefined || raw === '') return NaN;
          return Number(raw);
        };
        const current = states.get(mapId) ?? {
          latitude: Number.isFinite(readAttr('latitude')) ? readAttr('latitude') : DEFAULT_MAP_VIEW.latitude,
          longitude: Number.isFinite(readAttr('longitude')) ? readAttr('longitude') : DEFAULT_MAP_VIEW.longitude,
          scale: Number.isFinite(readAttr('scale')) ? readAttr('scale') : DEFAULT_MAP_VIEW.scale,
          rotate: Number.isFinite(readAttr('rotate')) ? readAttr('rotate') : 0
        };
        states.set(mapId, current);

        const settle = (options: any, value: any, operation?: string) => {
          if (!element()) return;
          const result = { errMsg: operation ? `${operation}:ok` : 'ok', ...value };
          deliver(options?.success, result);
          if (element()) deliver(options?.complete, result);
        };
        const fail = (options: any, message: string, operation?: string) => {
          if (!element()) return;
          const result = { errMsg: `${operation ? operation + ':' : ''}fail ${message}` };
          deliver(options?.fail, result);
          if (element()) deliver(options?.complete, result);
        };
        const setAttr = (name: string, value: any) => {
          const el = element();
          if (!el) return;
          el.setAttribute(name, String(value));
        };

        const listeners = new Map<string, Set<(...args: any[]) => void>>();
        const on = (name: string, callback: (...args: any[]) => void) => {
          let set = listeners.get(name);
          if (!set) {
            set = new Set();
            listeners.set(name, set);
          }
          set.add(callback);
        };
        const off = (name: string, callback?: (...args: any[]) => void) => {
          if (!callback) listeners.delete(name);
          else listeners.get(name)?.delete(callback);
        };

        const groundOverlay = (name: 'addGroundOverlay' | 'updateGroundOverlay' | 'removeGroundOverlay', options: any = {}) => {
          const opts = options || {};
          const typeOf = (value: unknown) => Object.prototype.toString.call(value).slice(8, -1);
          const expected: Record<string, string> = name === 'removeGroundOverlay'
            ? { id: 'Number' } : { id: 'Number', src: 'String', bounds: 'Object' };
          const errors = typeOf(opts) !== 'Object' ? `parameter should be Object instead of ${typeOf(opts)};` : Object.entries(expected)
            .filter(([key, type]) => typeOf(opts[key]) !== type)
            .map(([key, type]) => `parameter.${key} should be ${type} instead of ${typeOf(opts[key])};`).join('');
          if (errors) {
            const error = { errno: 1001, errMsg: `${name}:fail parameter error: ${errors}` };
            deliver(opts.fail, error);
            deliver(opts.complete, error);
            return;
          }
          const target = element() as WxMap | null;
          const guarded = {
            ...opts,
            success: (result: any) => { if (element() === target) deliver(opts.success, result); },
            fail: (result: any) => { if (element() === target) deliver(opts.fail, result); },
            complete: (result: any) => { if (element() === target) deliver(opts.complete, result); }
          };
          return invoke(GROUND_OVERLAY_OPERATIONS[name], guarded, async () => {
            if (!target || typeof target[name] !== 'function') return new Promise<never>(() => {});
            const applied = name === 'removeGroundOverlay' ? target.removeGroundOverlay(opts.id) : await target[name](opts);
            if (!applied || element() !== target) return new Promise<never>(() => {});
            return {};
          });
        };

        // 地图组件是真实渲染的：中心点 / 缩放以组件的视图状态为准（拖动、缩放后会变）
        const view = () => {
          const live = (element() as any)?.getView?.();
          if (live) {
            current.latitude = live.latitude;
            current.longitude = live.longitude;
            current.scale = live.scale;
          }
          return current;
        };

        const context: ContextShape<'MapContext'> & Record<string, any> = {
          getCenterLocation: (options: any) => {
            const state = view();
            settle(options, { latitude: state.latitude, longitude: state.longitude }, 'getMapCenterLocation');
          },
          getScale: (options: any) => settle(options, { scale: view().scale }, 'getMapScale'),
          getRotate: (options: any) => {
            const rotate = (element() as WxMap | null)?.rotate ?? readAttr('rotate');
            if (Number.isFinite(rotate)) current.rotate = rotate;
            settle(options, { rotate: current.rotate }, 'getMapRotate');
          },
          getRegion: (options: any) => {
            const region = (element() as any)?.getRegion?.();
            if (region) {
              settle(options, { southwest: region.region.southwest, northeast: region.region.northeast }, 'getMapRegion');
              return;
            }
            const state = view();
            const delta = 0.01 * (20 - state.scale);
            settle(options, {
              southwest: { latitude: state.latitude - delta, longitude: state.longitude - delta },
              northeast: { latitude: state.latitude + delta, longitude: state.longitude + delta }
            }, 'getMapRegion');
          },
          getMapInfo: (options: any) => {
            const state = view();
            settle(options, { scale: state.scale, centerLocation: { latitude: state.latitude, longitude: state.longitude } });
          },
          moveToLocation: (options: any = {}) => {
            current.latitude = numberOr(options.latitude, current.latitude);
            current.longitude = numberOr(options.longitude, current.longitude);
            (element() as any)?.moveTo?.(current.latitude, current.longitude);
            setAttr('latitude', current.latitude);
            setAttr('longitude', current.longitude);
            settle(options, {}, 'moveToMapLocation');
          },
          moveToRegion: (options: any) => {
            const region = options?.region ?? {};
            current.latitude = numberOr(region.latitude, current.latitude);
            current.longitude = numberOr(region.longitude, current.longitude);
            (element() as any)?.moveTo?.(current.latitude, current.longitude);
            settle(options, {});
          },
          includePoints: (options: any) => {
            const points = options?.points ?? [];
            (element() as any)?.includePoints?.(points, options?.padding);
            const state = (element() as any)?.getView?.();
            if (state) {
              current.latitude = state.latitude;
              current.longitude = state.longitude;
              current.scale = state.scale;
            }
            settle(options, {}, 'includeMapPoints');
          },
          translateMarker: (options: any) => {
            const markerId = options?.markerId;
            const destination = options?.destination;
            if (destination) {
              (element() as any)?.translateMarker?.(markerId, destination, options?.duration ?? 300, () => options?.animationEnd?.());
              current.latitude = numberOr(destination.latitude, current.latitude);
              current.longitude = numberOr(destination.longitude, current.longitude);
            }
            settle(options, {}, 'translateMapMarker');
          },
          toScreenLocation: (options: any) => {
            const { latitude, longitude } = options ?? {};
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return fail(options, 'parameter error', 'toScreenLocation');
            const point = (element() as any)?.toScreenLocation?.(latitude, longitude);
            if (point) settle(options, point, 'toScreenLocation');
          },
          fromScreenLocation: (options: any) => {
            const { x, y } = options ?? {};
            if (!Number.isFinite(x) || !Number.isFinite(y)) return fail(options, 'parameter error', 'fromScreenLocation');
            const point = (element() as any)?.fromScreenLocation?.(x, y);
            if (point) settle(options, point, 'fromScreenLocation');
          },
          setCenterOffset: (options: any) => {
            const offset = options?.offset;
            if (!Array.isArray(offset) || offset.length !== 2 || offset.some(value => !Number.isFinite(value) || value < 0.25 || value > 0.75)) {
              return fail(options, 'parameter error', 'setMapCenterOffset');
            }
            (element() as any)?.setCenterOffset?.(offset);
            settle(options, {}, 'setMapCenterOffset');
          },
          setLocMarkerIcon: (options: any) => settle(options, {}),
          addMarkers: (options: any) => {
            (element() as any)?.addMarkers?.(options?.markers ?? [], options?.clear);
            settle(options, {}, 'addMapMarkers');
          },
          removeMarkers: (options: any) => {
            (element() as any)?.removeMarkers?.(options?.markerIds ?? []);
            settle(options, {}, 'removeMapMarkers');
          },
          addGroundOverlay: (options: any) => groundOverlay('addGroundOverlay', options),
          updateGroundOverlay: (options: any) => groundOverlay('updateGroundOverlay', options),
          removeGroundOverlay: (options: any) => groundOverlay('removeGroundOverlay', options),
          addGroundOverlays: (options: any) => settle(options, {}),
          removeGroundOverlays: (options: any) => settle(options, {}),
          addCustomLayer: (options: any) => settle(options, {}),
          removeCustomLayer: (options: any) => settle(options, {}),
          initMarkerCluster: (options: any) => settle(options, {}),
          openMapApp: (options: any) => {
            const { latitude, longitude, destination, name } = options ?? {};
            if (latitude === undefined || longitude === undefined) {
              fail(options, 'parameter error');
              return;
            }
            const label = encodeURIComponent(destination || name || '目的地');
            window.open(
              `https://uri.amap.com/marker?position=${longitude},${latitude}&name=${label}&coordinate=gaode&callnative=1`,
              '_blank'
            );
            settle(options, {});
          },
          on: (name: string, callback: (...args: any[]) => void) => on(name, callback),
          off: (name: string, callback?: (...args: any[]) => void) => off(name, callback),
          get __el() {
            return element();
          },
          __emit: (name: string, payload: any) => {
            if (!element()) return;
            for (const callback of Array.from(listeners.get(name) ?? [])) deliver(callback, payload);
          }
        };
        for (const name of CONTEXT_METHODS.MapContext) {
          const method = context[name];
          context[name] = (options: any = {}) => hasCallback(options) ? method(options) : new Promise((resolve, reject) => {
            method({ ...options, success: resolve, fail: reject });
          });
        }
        return context;
      }
    };
  }
}
