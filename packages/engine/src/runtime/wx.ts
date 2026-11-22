/**
 * wx API 入口
 *
 * 具体实现按能力拆在 ./api 下；这里只做组装，保持对外签名不变。
 */

import { createApi } from './api';

export type { DeviceInfo, WxHost } from './api/types';

export function createWx(host: import('./api/types').WxHost): any {
  return createApi(host).wx;
}
