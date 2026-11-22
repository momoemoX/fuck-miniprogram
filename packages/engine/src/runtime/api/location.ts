/**
 * 位置
 *
 * getLocation 走浏览器 geolocation，默认保留 WGS84；显式 gcj02 时
 * 进行坐标偏移。openLocation 交给高德 URI，chooseLocation 提供一个能拖点、
 * 能搜索坐标的选点面板。
 */

import type { WxHost } from './types';
import { invoke } from './util';

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.006693421622965943;

function outOfChina(lng: number, lat: number) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x: number, y: number) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return ret;
}

/** WGS84 → GCJ02，中国境外不偏移 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

interface Position {
  latitude: number;
  longitude: number;
  speed: number;
  accuracy: number;
  altitude: number;
  verticalAccuracy: number;
  horizontalAccuracy: number;
}

export class LocationApi {
  private watchId: number | null = null;
  private watchGeneration = 0;
  private disposed = false;
  private readonly dialogs = new Set<() => void>();

  constructor(
    private readonly host: WxHost,
    private readonly declared?: readonly string[]
  ) {}

  dispose() {
    this.disposed = true;
    this.watchGeneration++;
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    for (const cancel of this.dialogs) cancel();
    this.dialogs.clear();
  }

  private trackDialog(layer: HTMLElement, reject: (error: Error) => void) {
    const close = () => {
      layer.remove();
      this.dialogs.delete(cancel);
    };
    const cancel = () => {
      close();
      reject(new Error('location disposed'));
    };
    this.dialogs.add(cancel);
    return close;
  }

  private call(name: string, options: any, run: (options: any) => any) {
    const guarded = { ...options };
    for (const key of ['success', 'fail', 'complete']) {
      if (typeof options?.[key] === 'function')
        guarded[key] = (result: any) => {
          if (!this.disposed) options[key](result);
        };
    }
    return invoke(name, guarded, async opts => {
      if (this.disposed) throw new Error('location disposed');
      // 官方 3.7.0：仅 getLocation 做 requiredPrivateInfos 声明检查（已确认差分，勿扩大）
      if (name === 'getLocation' && this.declared && !this.declared.includes(name))
        throw new Error('the api need to be declared in the requiredPrivateInfos field in app.json/ext.json');
      const result = await run(opts);
      if (this.disposed) throw new Error('location disposed');
      return result;
    });
  }

  private current(options: any = {}): Promise<Position> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('geolocation is not supported'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        position => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            speed: position.coords.speed ?? 0,
            accuracy: position.coords.accuracy ?? 0,
            altitude: position.coords.altitude ?? 0,
            verticalAccuracy: position.coords.altitudeAccuracy ?? 0,
            horizontalAccuracy: position.coords.accuracy ?? 0
          });
        },
        error => reject(new Error(error.code === 1 ? 'auth deny' : error.message)),
        {
          enableHighAccuracy: !!(options.isHighAccuracy || options.altitude),
          timeout: options.highAccuracyExpireTime ?? 8000,
          maximumAge: 0
        }
      );
    });
  }

  private convert(position: Position, type: string) {
    if (type !== 'gcj02') return position;
    const [lng, lat] = wgs84ToGcj02(position.longitude, position.latitude);
    return { ...position, latitude: lat, longitude: lng };
  }

  api() {
    return {
      getLocation: (options: any) =>
        this.call('getLocation', options, async opts => {
          const position = this.convert(await this.current(opts), String(opts?.type ?? 'wgs84'));
          return {
            latitude: position.latitude,
            longitude: position.longitude,
            speed: position.speed,
            accuracy: position.accuracy,
            ...(opts.altitude ? { altitude: position.altitude } : {}),
            verticalAccuracy: position.verticalAccuracy,
            horizontalAccuracy: position.horizontalAccuracy
          };
        }),

      getFuzzyLocation: (options: any) =>
        this.call('getFuzzyLocation', options, async opts => {
          const position = this.convert(await this.current(), String(opts?.type ?? 'wgs84'));
          return {
            latitude: Number(position.latitude.toFixed(3)),
            longitude: Number(position.longitude.toFixed(3))
          };
        }),

      startLocationUpdate: (options: any) =>
        this.call('startLocationUpdate', options, opts => {
          this.startWatch(String(opts?.type ?? 'gcj02'));
          return {};
        }),
      // 官方 3.7.0：后台持续定位与前台共用同一 watch 流程与回调通道；
      // 真机后台运行（系统级）不在浏览器宿主验证范围
      startLocationUpdateBackground: (options: any) =>
        this.call('startLocationUpdateBackground', options, opts => {
          this.startWatch(String(opts?.type ?? 'gcj02'));
          return {};
        }),
      stopLocationUpdate: (options: any) =>
        this.call('stopLocationUpdate', options, () => {
          this.watchGeneration++;
          if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
          this.watchId = null;
          return {};
        }),
      offLocationChange: (callback?: (res: any) => void) => this.host.off('locationChange', callback),
      onLocationChangeError: (callback: (res: any) => void) => this.host.on('locationChangeError', callback),
      offLocationChangeError: (callback?: (res: any) => void) => this.host.off('locationChangeError', callback),

      openLocation: (options: any) =>
        this.call('openLocation', options, opts => {
          if (opts?.latitude === undefined || opts?.longitude === undefined) {
            throw new Error('parameter error: "latitude" and "longitude" are required');
          }
          const name = encodeURIComponent(opts.name || opts.address || '位置');
          window.open(`https://uri.amap.com/marker?position=${opts.longitude},${opts.latitude}&name=${name}&callnative=1`, '_blank');
          return {};
        }),

      chooseLocation: (options: any) => this.chooseLocation(options),
      choosePoi: (options: any) => this.choosePoi(options)
    };
  }

  private startWatch(type: string) {
    if (this.watchId !== null) return;
    if (!navigator.geolocation) throw new Error('geolocation is not supported');
    const generation = ++this.watchGeneration;
    this.watchId = navigator.geolocation.watchPosition(
      position => {
        if (this.disposed || generation !== this.watchGeneration) return;
        const value = this.convert(
          {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            speed: position.coords.speed ?? 0,
            accuracy: position.coords.accuracy ?? 0,
            altitude: position.coords.altitude ?? 0,
            verticalAccuracy: position.coords.altitudeAccuracy ?? 0,
            horizontalAccuracy: position.coords.accuracy ?? 0
          },
          type
        );
        this.host.emit('locationChange', {
          latitude: value.latitude,
          longitude: value.longitude,
          speed: value.speed,
          accuracy: value.accuracy,
          altitude: value.altitude,
          verticalAccuracy: value.verticalAccuracy,
          horizontalAccuracy: value.horizontalAccuracy
        });
      },
      error => {
        if (!this.disposed && generation === this.watchGeneration)
          this.host.emit('locationChangeError', { errMsg: error.message, errCode: error.code });
      },
      { enableHighAccuracy: true, maximumAge: 1000 }
    );
  }

  private chooseLocation(options: any) {
    return this.call('chooseLocation', options, async () => {
      const position = this.convert(
        await this.current().catch(() => ({
          latitude: 39.908823,
          longitude: 116.39747,
          speed: 0,
          accuracy: 0,
          altitude: 0,
          verticalAccuracy: 0,
          horizontalAccuracy: 0
        })),
        'gcj02'
      );
      if (this.disposed) throw new Error('location disposed');

      return new Promise((resolve, reject) => {
        const overlay = this.host.overlay();
        const layer = document.createElement('div');
        layer.className = 'fmp-choose-location';
        layer.innerHTML = `
          <div class="fmp-choose-location-panel">
            <div class="fmp-choose-location-title">选择位置</div>
            <div class="fmp-choose-location-map">
              <div class="fmp-choose-location-pin"></div>
              <div class="fmp-choose-location-hint">拖动地图调整中心点</div>
            </div>
            <div class="fmp-choose-location-fields">
              <label>名称<input class="fmp-choose-location-name" value="选定位置" /></label>
              <label>地址<input class="fmp-choose-location-address" value="当前选择的位置" /></label>
              <label>纬度<input class="fmp-choose-location-lat" value="${round(position.latitude)}" /></label>
              <label>经度<input class="fmp-choose-location-lng" value="${round(position.longitude)}" /></label>
            </div>
            <div class="fmp-choose-location-actions">
              <button class="fmp-choose-location-cancel">取消</button>
              <button class="fmp-choose-location-ok">确定</button>
            </div>
          </div>`;

        const close = this.trackDialog(layer, reject);
        layer.querySelector('.fmp-choose-location-cancel')!.addEventListener('click', () => {
          close();
          reject(new Error('cancel'));
        });
        layer.querySelector('.fmp-choose-location-ok')!.addEventListener('click', () => {
          const value = (selector: string) => (layer.querySelector(selector) as HTMLInputElement).value;
          const latitude = Number(value('.fmp-choose-location-lat'));
          const longitude = Number(value('.fmp-choose-location-lng'));
          close();
          resolve({
            name: value('.fmp-choose-location-name'),
            address: value('.fmp-choose-location-address'),
            latitude,
            longitude
          });
        });

        // 点击地图移动 pin，并同步经纬度
        const map = layer.querySelector('.fmp-choose-location-map') as HTMLElement;
        const pin = layer.querySelector('.fmp-choose-location-pin') as HTMLElement;
        map.addEventListener('click', event => {
          const rect = map.getBoundingClientRect();
          const x = (event as MouseEvent).clientX - rect.left;
          const y = (event as MouseEvent).clientY - rect.top;
          pin.style.left = `${x}px`;
          pin.style.top = `${y}px`;
          const lng = position.longitude + (x - rect.width / 2) * 0.0002;
          const lat = position.latitude - (y - rect.height / 2) * 0.0002;
          (layer.querySelector('.fmp-choose-location-lng') as HTMLInputElement).value = String(round(lng));
          (layer.querySelector('.fmp-choose-location-lat') as HTMLInputElement).value = String(round(lat));
        });

        overlay.appendChild(layer);
      });
    });
  }

  private choosePoi(options: any) {
    return this.call(
      'choosePoi',
      options,
      () =>
        new Promise((resolve, reject) => {
          const overlay = this.host.overlay();
          const layer = document.createElement('div');
          layer.className = 'fmp-choose-poi';
          const close = this.trackDialog(layer, reject);
          const pois = [
            { name: '科技园', address: '深圳市南山区科技园', latitude: 22.5405, longitude: 113.9344 },
            { name: '市民中心', address: '深圳市福田区福中路', latitude: 22.5431, longitude: 114.0579 },
            { name: '深圳湾公园', address: '深圳市南山区滨海大道', latitude: 22.5175, longitude: 113.9473 }
          ];
          layer.innerHTML = `
          <div class="fmp-choose-poi-panel">
            <div class="fmp-choose-poi-title">选择地点</div>
            ${pois
              .map(
                (poi, index) =>
                  `<button class="fmp-choose-poi-item" data-index="${index}"><b>${poi.name}</b><span>${poi.address}</span></button>`
              )
              .join('')}
            <button class="fmp-choose-poi-cancel">取消</button>
          </div>`;
          layer.querySelectorAll('.fmp-choose-poi-item').forEach(button => {
            button.addEventListener('click', () => {
              const poi = pois[Number((button as HTMLElement).dataset.index)];
              close();
              resolve({ name: poi.name, address: poi.address, latitude: poi.latitude, longitude: poi.longitude });
            });
          });
          layer.querySelector('.fmp-choose-poi-cancel')!.addEventListener('click', () => {
            close();
            reject(new Error('cancel'));
          });
          overlay.appendChild(layer);
        })
    );
  }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
