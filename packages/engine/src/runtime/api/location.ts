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
          this.coordinates(opts.latitude, opts.longitude);
          const layer = document.createElement('div');
          layer.className = 'fmp-open-location';
          layer.setAttribute('role', 'dialog');
          layer.setAttribute('aria-label', '位置详情');
          const dismiss = document.createElement('button');
          dismiss.textContent = '关闭';
          const name = document.createElement('h2');
          name.textContent = opts.name || '位置';
          const address = document.createElement('p');
          address.textContent = opts.address || '';
          const map = document.createElement('div');
          map.className = 'fmp-choose-location-map';
          const pin = document.createElement('div');
          pin.className = 'fmp-choose-location-pin';
          map.appendChild(pin);
          const coordinates = document.createElement('p');
          coordinates.textContent = `${opts.latitude}, ${opts.longitude}`;
          const link = document.createElement('a');
          link.textContent = '在地图中查看';
          link.href = `https://www.openstreetmap.org/?mlat=${opts.latitude}&mlon=${opts.longitude}#map=${Math.max(1, Math.min(19, Number(opts.scale) || 16))}/${opts.latitude}/${opts.longitude}`;
          link.target = '_blank'; link.rel = 'noopener noreferrer';
          layer.append(dismiss, name, address, map, coordinates, link);
          const close = () => { layer.remove(); this.dialogs.delete(close); };
          dismiss.addEventListener('click', close);
          this.dialogs.add(close);
          this.host.overlay().appendChild(layer);
          return {};
        }),

      chooseLocation: (options: any) => this.choosePoint('chooseLocation', options),
      choosePoi: (options: any) => this.choosePoint('choosePoi', options)
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

  private coordinates(latitude: unknown, longitude: unknown) {
    if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
      !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
      throw new Error('latitude and longitude must be valid coordinates');
  }

  private choosePoint(method: 'chooseLocation' | 'choosePoi', options: any) {
    return this.call(method, options, async opts => {
      let latitude: number, longitude: number;
      if (opts.latitude !== undefined && opts.longitude !== undefined) {
        this.coordinates(opts.latitude, opts.longitude);
        latitude = opts.latitude; longitude = opts.longitude;
      } else {
        latitude = 39.908823; longitude = 116.39747;
      }
      if (this.disposed) throw new Error('location disposed');
      return new Promise((resolve, reject) => {
        const layer = document.createElement('div');
        layer.className = method === 'choosePoi' ? 'fmp-choose-poi' : 'fmp-choose-location';
        layer.setAttribute('role', 'dialog');
        layer.setAttribute('aria-label', '选择位置');
        layer.innerHTML = `<div class="fmp-choose-location-panel">
          <div class="fmp-choose-location-title">选择位置</div>
          <div class="fmp-choose-location-map"><div class="fmp-choose-location-pin"></div></div>
          <button class="fmp-location-center" type="button">地图中心</button><button class="fmp-location-locate" type="button">定位到当前位置</button>
          <div class="fmp-choose-location-fields">
            <label>名称<input name="name" value="地图中心"/></label>
            <label>地址<input name="address"/></label>
            <label>纬度<input name="latitude" type="number" min="-90" max="90" step="any"/></label>
            <label>经度<input name="longitude" type="number" min="-180" max="180" step="any"/></label>
          </div>
          <div role="alert"></div>
          <div class="fmp-choose-location-actions"><button type="button">取消</button><button class="fmp-choose-location-ok" type="button">确定</button></div>
        </div>`;
        const field = (name: string) => layer.querySelector(`input[name="${name}"]`) as HTMLInputElement;
        const update = (lat: number, lng: number) => {
          field('latitude').value = String(round(lat));
          field('longitude').value = String(round(lng));
          field('address').value = `${round(lat)}, ${round(lng)}`;
        };
        update(latitude, longitude);
        layer.querySelector('.fmp-location-locate')!.addEventListener('click', () => {
          void this.current().then(position => {
            if (!layer.isConnected || this.disposed) return;
            const selected = this.convert(position, 'gcj02');
            latitude = selected.latitude; longitude = selected.longitude;
            update(latitude, longitude);
          }, () => { if (layer.isConnected) layer.querySelector('[role="alert"]')!.textContent = '无法获取当前位置，请在地图上选择'; });
        });
        let settled = false;
        const unmount = this.trackDialog(layer, reject);
        const close = () => { if (settled) return false; settled = true; unmount(); return true; };
        const confirm = () => {
          const lat = Number.parseFloat(field('latitude').value), lng = Number.parseFloat(field('longitude').value);
          try { this.coordinates(lat, lng); }
          catch { layer.querySelector('[role="alert"]')!.textContent = '请输入有效坐标'; return; }
          const value = { name: field('name').value, address: field('address').value, latitude: lat, longitude: lng };
          if (close()) resolve(value);
        };
        const buttons = layer.querySelectorAll('.fmp-choose-location-actions button');
        buttons[0].addEventListener('click', () => { if (close()) reject(new Error('cancel')); });
        buttons[1].addEventListener('click', confirm);
        layer.querySelector('.fmp-location-center')!.addEventListener('click', () => {
          field('name').value = '地图中心';
          layer.querySelector('.fmp-location-center')!.setAttribute('aria-pressed', 'true');
        });
        const map = layer.querySelector('.fmp-choose-location-map') as HTMLElement;
        const pin = layer.querySelector('.fmp-choose-location-pin') as HTMLElement;
        map.addEventListener('click', event => {
          const rect = map.getBoundingClientRect();
          const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
          pin.style.left = `${x * 100}%`; pin.style.top = `${y * 100}%`;
          update(Math.min(90, Math.max(-90, latitude + (.5 - y) * .02)), Math.min(180, Math.max(-180, longitude + (x - .5) * .02)));
        });
        this.host.overlay().appendChild(layer);
      });
    });
  }

}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
