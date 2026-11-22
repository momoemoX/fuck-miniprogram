import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationApi } from '../../packages/engine/src/runtime/api/location';

let location: LocationApi, api: any, geolocation: any, emitted: any[], watches: any[];
const position = {
  coords: { latitude: 39.90882312345, longitude: 116.39747012345, speed: 2, accuracy: 5, altitude: 8, altitudeAccuracy: 9 }
};

beforeEach(() => {
  watches = [];
  emitted = [];
  geolocation = {
    getCurrentPosition: vi.fn((success: any) => success(position)),
    watchPosition: vi.fn((success: any, error: any) => {
      watches.push({ success, error });
      return watches.length - 1;
    }),
    clearWatch: vi.fn()
  };
  vi.stubGlobal('navigator', { geolocation });
  location = new LocationApi({ emit: (name: string, value: any) => emitted.push({ name, value }) } as any);
  api = location.api();
});
afterEach(() => {
  location.dispose();
  vi.unstubAllGlobals();
});

describe('定位坐标与监测生命周期', () => {
  it('应用未声明定位接口时在请求设备位置前返回官方失败信息', async () => {
    const restricted = new LocationApi({} as any, []);
    await expect(restricted.api().getLocation({})).rejects.toEqual({
      errMsg: 'getLocation:fail the api need to be declared in the requiredPrivateInfos field in app.json/ext.json'
    });
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
    restricted.dispose();
  });
  it('定位默认返回 WGS84 并保留设备坐标精度', async () => {
    expect(await api.getLocation({})).toMatchObject({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      verticalAccuracy: 9
    });
  });

  it('定位显式启用 GCJ02 和高精度时转换坐标并传递定位期限', async () => {
    const result = await api.getLocation({ type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 5000 });
    expect(result.latitude).toBeCloseTo(39.91022662, 7);
    expect(result.longitude).toBeCloseTo(116.40371371, 7);
    expect(geolocation.getCurrentPosition.mock.calls[0][2]).toEqual({ enableHighAccuracy: true, timeout: 5000, maximumAge: 0 });
  });

  it('停止后重新开始监测会丢弃旧监测的坐标和错误', async () => {
    await api.startLocationUpdate({ type: 'wgs84' });
    watches[0].success(position);
    expect(emitted).toHaveLength(1);
    await api.stopLocationUpdate({});
    await api.startLocationUpdate({ type: 'wgs84' });
    watches[0].success(position);
    watches[0].error({ code: 2, message: 'stale' });
    expect(emitted).toHaveLength(1);
    watches[1].success(position);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].value.latitude).toBe(position.coords.latitude);
    expect(geolocation.clearWatch).toHaveBeenCalledWith(0);
  });

  for (const result of ['success', 'error']) {
    it(`应用销毁后忽略迟到的单次定位 ${result} 回调`, async () => {
      let complete: any, fail: any;
      geolocation.getCurrentPosition = vi.fn((success: any, error: any) => {
        complete = success;
        fail = error;
      });
      const events: string[] = [];
      api.getLocation({ success: () => events.push('success'), fail: () => events.push('fail'), complete: () => events.push('complete') });
      location.dispose();
      if (result === 'success') complete(position);
      else fail({ code: 1, message: 'denied' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toEqual([]);
    });
  }

  it('应用销毁清除监测并阻止所有迟到事件', async () => {
    await api.startLocationUpdate({});
    location.dispose();
    watches[0].success(position);
    watches[0].error({ code: 2, message: 'stale' });
    expect(emitted).toEqual([]);
    expect(geolocation.clearWatch).toHaveBeenCalledTimes(1);
  });

  it('startLocationUpdateBackground 复用前台 watch 流程并派发 locationChange', async () => {
    await api.startLocationUpdateBackground({});
    expect(watches).toHaveLength(1);
    watches[0].success(position);
    expect(emitted.some(item => item.name === 'locationChange')).toBe(true);
    await api.stopLocationUpdate({});
    expect(geolocation.clearWatch).toHaveBeenCalledTimes(1);
  });

  it('后台定位进行中再次启动不重复 watch', async () => {
    await api.startLocationUpdateBackground({});
    await api.startLocationUpdateBackground({});
    expect(watches).toHaveLength(1);
    await api.stopLocationUpdate({});
    expect(geolocation.clearWatch).toHaveBeenCalledTimes(1);
  });
});
