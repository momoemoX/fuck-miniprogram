/**
 * 开放接口：登录、授权、用户信息、设置、扫码、客服、更新、支付
 *
 * 浏览器里没有微信账号体系：login 返回本地生成的 code，授权状态存在
 * localStorage，用户信息是稳定的模拟值。调用形态、回调与失败原因保持真实。
 */

import { showModal } from '../overlay';
import type { WxHost } from './types';
import { invoke, syncResult, uid } from './util';

const SCOPE_KEY = 'fmp:auth';

const SCOPE_NAMES: Record<string, string> = {
  'scope.userInfo': '用户信息',
  'scope.userLocation': '位置信息',
  'scope.address': '通讯地址',
  'scope.invoice': '发票',
  'scope.invoiceTitle': '发票抬头',
  'scope.werun': '微信运动步数',
  'scope.record': '录音功能',
  'scope.writePhotosAlbum': '保存到相册',
  'scope.camera': '摄像头'
};

/** 只需要系统权限、不需要弹授权框的 scope */
const SYSTEM_SCOPES = new Set(['scope.camera', 'scope.record', 'scope.writePhotosAlbum', 'scope.userLocation']);

export class OpenApi {
  private authSetting: Record<string, boolean> = {};
  private userInfo = {
    nickName: 'fmp 用户',
    avatarUrl:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="132"><rect width="132" height="132" rx="16" fill="#07c160"/><circle cx="66" cy="50" r="22" fill="#fff"/><path d="M26 118c4-24 20-36 40-36s36 12 40 36z" fill="#fff"/></svg>'
      ),
    gender: 0,
    country: '中国',
    province: '广东',
    city: '深圳',
    language: 'zh_CN'
  };

  constructor(private readonly host: WxHost) {
    try {
      const raw = localStorage.getItem(SCOPE_KEY);
      if (raw) this.authSetting = JSON.parse(raw);
    } catch {
      /* 忽略 */
    }
  }

  private save() {
    try {
      localStorage.setItem(SCOPE_KEY, JSON.stringify(this.authSetting));
    } catch {
      /* 忽略 */
    }
  }

  private settings() {
    const setting: Record<string, boolean> = {};
    for (const scope of Object.keys(SCOPE_NAMES)) {
      setting[scope] = this.authSetting[scope] ?? SYSTEM_SCOPES.has(scope);
    }
    return setting;
  }

  private async ask(scope: string): Promise<boolean> {
    const name = SCOPE_NAMES[scope] ?? scope;
    const result = await showModal(this.host.overlay(), {
      title: '授权',
      content: `fmp-engine 请求使用「${name}」`,
      confirmText: '允许',
      cancelText: '拒绝',
      confirmColor: '#07c160'
    });
    this.authSetting[scope] = result.confirm;
    this.save();
    return result.confirm;
  }

  api() {
    return {
      login: (options: any) =>
        invoke('login', options, () => ({ code: uid('code').replace(/-/g, ''), anonymousCode: '' })),
      checkSession: (options: any) => invoke('checkSession', options, () => ({})),

      authorize: (options: any) =>
        invoke('authorize', options, async opts => {
          const scope = String(opts?.scope ?? '');
          if (!scope) throw new Error('parameter error: "scope" is required');
          if (this.authSetting[scope]) return {};
          const granted = await this.ask(scope);
          if (!granted) throw new Error('authorize:fail auth deny');
          return {};
        }),

      // 官方 3.7.0：插件预授权，scope 白名单外的直接失败（官方消息原文）
      authorizeForMiniProgram: (options: any) =>
        invoke('authorizeForMiniProgram', options, async opts => {
          const scope = String(opts?.scope ?? '');
          const allowed = ['scope.record', 'scope.writePhotosAlbum', 'scope.camera', 'scope.addPhoneContact', 'scope.bluetooth', 'scope.voip'];
          if (!allowed.includes(scope)) throw new Error(`scope "${scope}" is not supported to be authorized by plugin.`);
          if (this.authSetting[scope]) return {};
          const granted = await this.ask(scope);
          if (!granted) throw new Error('authorize:fail auth deny');
          return {};
        }),

      getSetting: (options: any) =>
        invoke('getSetting', options, () => ({ authSetting: this.settings(), subscriptionsSetting: { mainSwitch: true, itemSettings: {} } })),

      openSetting: (options: any) =>
        invoke('openSetting', options, async () => {
          const entries = Object.entries(this.settings());
          const result = await showModal(this.host.overlay(), {
            title: '权限设置',
            content: entries.map(([scope, granted]) => `${SCOPE_NAMES[scope] ?? scope}：${granted ? '已允许' : '未允许'}`).join('\n'),
            confirmText: '全部允许',
            cancelText: '关闭'
          });
          if (result.confirm) {
            for (const [scope] of entries) this.authSetting[scope] = true;
            this.save();
          }
          return { authSetting: this.settings() };
        }),

      getUserInfo: (options: any) =>
        invoke('getUserInfo', options, () => ({
          userInfo: { ...this.userInfo, ...(options?.withCredentials ? {} : {}) },
          rawData: JSON.stringify(this.userInfo),
          signature: '',
          encryptedData: '',
          iv: '',
          cloudID: ''
        })),

      getUserProfile: (options: any) =>
        invoke('getUserProfile', options, opts => {
          if (!opts?.desc) throw new Error('parameter error: "desc" is required');
          return {
            userInfo: { ...this.userInfo },
            rawData: JSON.stringify(this.userInfo),
            signature: '',
            encryptedData: '',
            iv: '',
            cloudID: ''
          };
        }),

      requestSubscribeMessage: (options: any) =>
        invoke('requestSubscribeMessage', options, async opts => {
          const ids: string[] = opts?.tmplIds ?? [];
          if (!ids.length) throw new Error('parameter error: "tmplIds" is required');
          const result = await showModal(this.host.overlay(), {
            title: '订阅消息',
            content: `是否允许发送 ${ids.length} 条订阅消息？`,
            confirmText: '允许',
            cancelText: '拒绝'
          });
          const settings: Record<string, string> = {};
          for (const id of ids) settings[id] = result.confirm ? 'accept' : 'reject';
          return settings;
        }),

      chooseAddress: (options: any) =>
        invoke('chooseAddress', options, () => ({
          userName: '张三',
          postalCode: '518000',
          provinceName: '广东省',
          cityName: '深圳市',
          countyName: '南山区',
          detailInfo: '科技园 1 号',
          nationalCode: '440305',
          telNumber: '13800000000'
        })),

      chooseInvoiceTitle: (options: any) =>
        invoke('chooseInvoiceTitle', options, () => ({
          type: '0',
          title: '深圳市示例科技有限公司',
          taxNumber: '91440300MA5XXXXXXX',
          companyAddress: '深圳市南山区科技园 1 号',
          telephone: '0755-00000000',
          bankName: '招商银行',
          bankAccount: '0000 0000 0000 0000'
        })),

      chooseInvoice: (options: any) => invoke('chooseInvoice', options, () => ({ invoiceInfo: '{}' })),

      scanCode: (options: any) =>
        invoke('scanCode', options, async opts => {
          const detector = (window as any).BarcodeDetector;
          if (detector && navigator.mediaDevices) {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
              const video = document.createElement('video');
              video.srcObject = stream;
              video.muted = true;
              await video.play();
              const bar = new detector({ formats: ['qr_code', 'ean_13', 'code_128'] });
              const codes = await bar.detect(video);
              stream.getTracks().forEach(track => track.stop());
              if (codes.length) {
                return {
                  result: codes[0].rawValue,
                  scanType: 'QR_CODE',
                  charSet: 'UTF-8',
                  path: ''
                };
              }
            } catch {
              /* 回退到文件选择 */
            }
          }

          if (opts?.onlyFromCamera) throw new Error('cancel');
          const file = await new Promise<File | null>(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = () => resolve(input.files?.[0] ?? null);
            input.oncancel = () => resolve(null);
            input.click();
          });
          if (!file) throw new Error('cancel');
          const url = URL.createObjectURL(file);
          if (detector) {
            try {
              const bar = new detector({ formats: ['qr_code', 'ean_13', 'code_128'] });
              const bitmap = await createImageBitmap(file);
              const codes = await bar.detect(bitmap);
              if (codes.length) return { result: codes[0].rawValue, scanType: 'QR_CODE', charSet: 'UTF-8', path: url };
            } catch {
              /* 识别失败 */
            }
          }
          throw new Error('scanCode:fail no code found');
        }),

      // 客服
      openCustomerServiceChat: (options: any) =>
        invoke('openCustomerServiceChat', options, opts => {
          const url = opts?.extInfo?.url;
          if (url) window.open(url, '_blank');
          return {};
        }),
      openCustomerServiceConversation: (options: any) =>
        invoke('openCustomerServiceConversation', options, () => ({})),

      // 账号 / 更新 / 启动参数
      getAccountInfoSync: () =>
        syncResult('getAccountInfoSync', {
          miniProgram: {
            appId: 'fmpengine00000000',
            envVersion: 'develop',
            version: '0.0.0'
          },
          plugin: {
            appId: '',
            version: '',
            envVersion: 'develop'
          }
        }),

      getUpdateManager: () => {
        const listeners = new Map<string, Set<(...args: any[]) => void>>();
        const on = (name: string, callback: (...args: any[]) => void) => {
          let set = listeners.get(name);
          if (!set) {
            set = new Set();
            listeners.set(name, set);
          }
          set.add(callback);
        };
        const emit = (name: string, payload?: any) => {
          for (const callback of Array.from(listeners.get(name) ?? [])) callback(payload);
        };
        return {
          onCheckForUpdate: (callback: (res: { hasUpdate: boolean }) => void) => on('check', callback),
          onUpdateReady: (callback: () => void) => on('ready', callback),
          onUpdateFailed: (callback: () => void) => on('failed', callback),
          applyUpdate: () => {
            emit('ready');
            location.reload();
          },
          onCheckForUpdateEnd: () => undefined,
          __check: () => {
            emit('check', { hasUpdate: false });
          }
        };
      },

      // 运行环境
      getLaunchOptionsSync: () => this.host.launchOptions(),
      getEnterOptionsSync: () => this.host.launchOptions(),
      onAppShow: (callback: (res: any) => void) => this.host.on('appShow', callback),
      offAppShow: (callback?: (res: any) => void) => this.host.off('appShow', callback),
      onAppHide: (callback: () => void) => this.host.on('appHide', callback),
      offAppHide: (callback?: () => void) => this.host.off('appHide', callback),
      onError: (callback: (res: any) => void) => this.host.on('error', callback),
      offError: (callback?: (res: any) => void) => this.host.off('error', callback),
      onUnhandledRejection: (callback: (res: any) => void) => this.host.on('unhandledRejection', callback),
      offUnhandledRejection: (callback?: (res: any) => void) => this.host.off('unhandledRejection', callback),
      onPageNotFound: (callback: (res: any) => void) => this.host.on('pageNotFound', callback),
      offPageNotFound: (callback?: (res: any) => void) => this.host.off('pageNotFound', callback),
      onApiCategoryChange: (callback: (res: any) => void) => this.host.on('apiCategoryChange', callback),
      offApiCategoryChange: (callback?: (res: any) => void) => this.host.off('apiCategoryChange', callback),

      // 隐私
      getPrivacySetting: (options: any) =>
        invoke('getPrivacySetting', options, () => ({ needAuthorization: false, privacyContractName: '《用户隐私保护指引》' })),
      openPrivacyContract: (options: any) => invoke('openPrivacyContract', options, () => ({})),
      requirePrivacyAuthorize: (options: any) => invoke('requirePrivacyAuthorize', options, () => ({})),
      onNeedPrivacyAuthorization: (callback: (resolve: any) => void) => this.host.on('needPrivacyAuthorization', callback),

      // 微信运动 / 生物认证 / 卡券
      getWeRunData: (options: any) =>
        invoke('getWeRunData', options, () => ({ encryptedData: '', iv: '', cloudID: '' })),
      checkIsSupportSoterAuthentication: (options: any) =>
        invoke('checkIsSupportSoterAuthentication', options, () => ({ supportMode: ['fingerPrint'] })),
      checkIsSoterEnrolledInDevice: (options: any) =>
        invoke('checkIsSoterEnrolledInDevice', options, () => ({ isEnrolled: true })),
      startSoterAuthentication: (options: any) =>
        invoke('startSoterAuthentication', options, () => ({ errCode: 0, authMode: 'fingerPrint', resultJSON: '{}', resultJSONSignature: '' })),
      openCard: (options: any) => invoke('openCard', options, () => ({})),
      addCard: (options: any) => invoke('addCard', options, () => ({ cardList: [] })),

      // 支付：开发者工具同样是模拟成功，保留回调结构
      requestPayment: (options: any) =>
        invoke('requestPayment', options, opts => {
          if (!opts?.package) throw new Error('parameter error: "package" is required');
          return {};
        }),
      requestVirtualPayment: (options: any) => invoke('requestVirtualPayment', options, () => ({})),
      requestOrderPayment: (options: any) => invoke('requestOrderPayment', options, () => ({})),

      // 设备订阅消息：与订阅消息同一套授权流程
      requestSubscribeDeviceMessage: (options: any) =>
        invoke('requestSubscribeDeviceMessage', options, opts => ({
          [String(opts?.tmplIds?.[0] ?? 'default')]: 'accept'
        })),

      // 打开业务视图（需要微信客户端）
      openBusinessView: (options: any) =>
        invoke('openBusinessView', options, () => {
          throw new Error('openBusinessView is only available in WeChat client');
        }),

      // 视频号：浏览器无法唤起，保留标准失败结构
      openChannelsUserProfile: (options: any) =>
        invoke('openChannelsUserProfile', options, () => {
          throw new Error('channels is only available in WeChat client');
        }),
      openChannelsLive: (options: any) =>
        invoke('openChannelsLive', options, () => {
          throw new Error('channels is only available in WeChat client');
        }),
      openChannelsEvent: (options: any) =>
        invoke('openChannelsEvent', options, () => {
          throw new Error('channels is only available in WeChat client');
        }),
      openChannelsActivity: (options: any) =>
        invoke('openChannelsActivity', options, () => {
          throw new Error('channels is only available in WeChat client');
        }),
      getChannelsLiveInfo: (options: any) =>
        invoke('getChannelsLiveInfo', options, () => {
          throw new Error('channels is only available in WeChat client');
        }),
      getChannelsLiveNoticeInfo: (options: any) =>
        invoke('getChannelsLiveNoticeInfo', options, () => {
          throw new Error('channels is only available in WeChat client');
        }),
      reserveChannelsLive: (options: any) =>
        invoke('reserveChannelsLive', options, () => {
          throw new Error('channels is only available in WeChat client');
        }),

      // 群聊进入场景（已废弃，保留回调结构）
      getGroupEnterInfo: (options: any) =>
        invoke('getGroupEnterInfo', options, () => ({ errMsg: 'getGroupEnterInfo:ok', encryptedData: '', iv: '', cloudID: '' })),

      // 卡券
      chooseCard: (options: any) =>
        invoke('chooseCard', options, () => {
          throw new Error('chooseCard is only available in WeChat client');
        })
    };
  }
}
