/**
 * 界面交互、导航栏、tabBar、页面滚动与分享菜单
 */

import {
  showActionSheet as overlayActionSheet,
  showModal as overlayModal,
  showToast as overlayToast,
  type ToastHandle
} from '../overlay';
import type { WxHost } from './types';
import { invoke, numberOr, syncResult } from './util';

export class UiApi {
  private toast: ToastHandle | null = null;
  private shareMenu: Record<string, any> = { withShareTicket: false, menus: [] };
  private alertBeforeUnload: ((event: BeforeUnloadEvent) => void) | null = null;

  constructor(private readonly host: WxHost) {}

  private presentToast(options: any) {
    this.toast?.hide();
    this.toast = overlayToast(this.host.overlay(), options ?? {});
  }

  private dismissToast() {
    this.toast?.hide();
    this.toast = null;
  }

  private scrollPage(top: number, duration = 0) {
    const page = this.host.pageElement() as HTMLElement | null;
    if (!page) return;
    if (duration > 0 && page.scrollTo) page.scrollTo({ top, behavior: 'smooth' });
    else page.scrollTop = top;
    this.host.setPageScrollTop(top, duration);
  }

  api() {
    return {
      showToast: (options: any) =>
        invoke('showToast', options, opts => {
          this.presentToast(opts);
          return {};
        }),
      hideToast: (options: any) =>
        invoke('hideToast', options, () => {
          this.dismissToast();
          return {};
        }),
      showLoading: (options: any) =>
        invoke('showLoading', options, opts => {
          this.presentToast({ ...opts, icon: 'loading', duration: 0 });
          return {};
        }),
      hideLoading: (options: any) =>
        invoke('hideLoading', options, () => {
          this.dismissToast();
          return {};
        }),
      showModal: (options: any) =>
        invoke('showModal', options, opts =>
          overlayModal(this.host.overlay(), opts).then(result => ({
            confirm: result.confirm,
            cancel: result.cancel,
            ...(opts.editable ? { content: result.content } : {})
          }))
        ),
      showActionSheet: (options: any) =>
        invoke('showActionSheet', options, opts => {
          const list = opts.itemList ?? [];
          if (!Array.isArray(list) || list.length === 0) throw new Error('parameter error: "itemList" is required');
          if (list.length > 6) throw new Error('parameter error: "itemList" can not exceed 6 items');
          return overlayActionSheet(this.host.overlay(), opts).then(index => {
            if (index === null) throw new Error('cancel');
            return { tapIndex: index };
          });
        }),

      // 导航栏
      setNavigationBarTitle: (options: any) =>
        invoke('setNavigationBarTitle', options, opts => {
          if (typeof opts?.title !== 'string') throw new Error('parameter error: "title" should be a string');
          this.host.setNavigationBarTitle(opts.title);
          return {};
        }),
      setNavigationBarColor: (options: any) =>
        invoke('setNavigationBarColor', options, opts => {
          this.host.setNavigationBarColor(opts);
          return {};
        }),
      showNavigationBarLoading: (options: any) =>
        invoke('showNavigationBarLoading', options, () => {
          this.host.setNavigationBarLoading(true);
          return {};
        }),
      hideNavigationBarLoading: (options: any) =>
        invoke('hideNavigationBarLoading', options, () => {
          this.host.setNavigationBarLoading(false);
          return {};
        }),
      setTopBarText: (options: any) => invoke('setTopBarText', options, () => ({})),

      // 背景 / 下拉刷新
      setBackgroundColor: (options: any) =>
        invoke('setBackgroundColor', options, opts => {
          const color = opts.backgroundColor || [opts.backgroundColorTop, opts.backgroundColorBottom].filter(Boolean).join(',');
          this.host.setBackgroundColor(color || '#ffffff');
          return {};
        }),
      setBackgroundTextStyle: (options: any) =>
        invoke('setBackgroundTextStyle', options, opts => {
          this.host.setBackgroundTextStyle(String(opts.textStyle ?? 'dark'));
          return {};
        }),
      startPullDownRefresh: (options: any) =>
        invoke('startPullDownRefresh', options, () => {
          this.host.startPullDownRefresh();
          return {};
        }),
      stopPullDownRefresh: (options: any) =>
        invoke('stopPullDownRefresh', options, () => {
          this.host.stopPullDownRefresh();
          return {};
        }),

      pageScrollTo: (options: any) =>
        invoke('pageScrollTo', options, opts => {
          const duration = numberOr(opts.duration, 300);
          let top = numberOr(opts.scrollTop, 0);
          if (opts.selector) {
            const page = this.host.pageElement();
            const target = page?.querySelector(String(opts.selector).replace(/^#/, '#'));
            if (target) {
              const rect = target.getBoundingClientRect();
              const base = page!.getBoundingClientRect();
              top = (page as HTMLElement).scrollTop + rect.top - base.top;
            }
          }
          this.scrollPage(top, duration);
          return {};
        }),

      // 分享菜单（在浏览器里只记录状态，转发由页面 onShareAppMessage 决定）
      showShareMenu: (options: any) =>
        invoke('showShareMenu', options, opts => {
          Object.assign(this.shareMenu, opts, { visible: true });
          this.host.emit('shareMenuChange', { ...this.shareMenu });
          return {};
        }),
      hideShareMenu: (options: any) =>
        invoke('hideShareMenu', options, () => {
          this.shareMenu.visible = false;
          this.host.emit('shareMenuChange', { ...this.shareMenu });
          return {};
        }),
      updateShareMenu: (options: any) =>
        invoke('updateShareMenu', options, opts => {
          Object.assign(this.shareMenu, opts);
          this.host.emit('shareMenuChange', { ...this.shareMenu });
          return {};
        }),
      getShareInfo: (options: any) => invoke('getShareInfo', options, () => ({ errMsg: 'getShareInfo:ok' })),
      showShareImageMenu: (options: any) =>
        invoke('showShareImageMenu', options, opts => {
          if (opts.path) window.open(opts.path, '_blank');
          return {};
        }),

      // 离开确认
      enableAlertBeforeUnload: (options: any) =>
        invoke('enableAlertBeforeUnload', options, opts => {
          if (this.alertBeforeUnload) window.removeEventListener('beforeunload', this.alertBeforeUnload);
          this.alertBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = String(opts.message ?? '');
            return String(opts.message ?? '');
          };
          window.addEventListener('beforeunload', this.alertBeforeUnload);
          return {};
        }),
      disableAlertBeforeUnload: (options: any) =>
        invoke('disableAlertBeforeUnload', options, () => {
          if (this.alertBeforeUnload) window.removeEventListener('beforeunload', this.alertBeforeUnload);
          this.alertBeforeUnload = null;
          return {};
        }),

      // 窗口尺寸（桌面端能力）
      setWindowSize: (options: any) =>
        invoke('setWindowSize', options, opts => {
          const width = numberOr(opts.width, window.innerWidth);
          const height = numberOr(opts.height, window.innerHeight);
          window.resizeTo?.(width, height);
          return {};
        }),

      // 动画
      createAnimation: (options: any) => {
        const queue: Array<Record<string, any>> = [];
        let current: Record<string, any> = {};
        const animation: any = {
          export() {
            const actions = queue.splice(0, queue.length);
            current = {};
            return { actions, animation: actions };
          },
          step(opts?: any) {
            queue.push({ ...current, __options: opts });
            current = {};
            return animation;
          }
        };
        const add = (key: string) => (value: any) => {
          current[key] = value;
          return animation;
        };
        for (const name of ['opacity', 'backgroundColor', 'width', 'height', 'top', 'left', 'bottom', 'right']) {
          animation[name] = add(name);
        }
        for (const name of [
          'rotate', 'rotateX', 'rotateY', 'rotateZ', 'scale', 'scaleX', 'scaleY', 'scaleZ',
          'translate', 'translateX', 'translateY', 'translateZ', 'skew', 'skewX', 'skewY'
        ]) {
          animation[name] = add(name);
        }
        animation.rotate3d = (x: number, y: number, z: number, deg: number) => {
          current.rotate3d = [x, y, z, deg];
          return animation;
        };
        animation.scale3d = (x: number, y: number, z: number) => {
          current.scale3d = [x, y, z];
          return animation;
        };
        animation.translate3d = (x: number, y: number, z: number) => {
          current.translate3d = [x, y, z];
          return animation;
        };
        void options;
        return animation;
      },

      // tabBar
      showTabBar: (options: any) =>
        invoke('showTabBar', options, () => {
          this.host.setTabBarHidden(false);
          return {};
        }),
      hideTabBar: (options: any) =>
        invoke('hideTabBar', options, () => {
          this.host.setTabBarHidden(true);
          return {};
        }),
      setTabBarStyle: (options: any) =>
        invoke('setTabBarStyle', options, opts => {
          this.host.updateTabBarStyle({
            color: opts.color,
            selectedColor: opts.selectedColor,
            backgroundColor: opts.backgroundColor,
            borderStyle: opts.borderStyle
          });
          return {};
        }),
      setTabBarItem: (options: any) =>
        invoke('setTabBarItem', options, opts => {
          if (!this.host.updateTabBarItem(opts.index, { text: opts.text, iconPath: opts.iconPath, selectedIconPath: opts.selectedIconPath })) {
            throw new Error('tabBar item not found');
          }
          return {};
        }),
      setTabBarBadge: (options: any) =>
        invoke('setTabBarBadge', options, opts => {
          if (!this.host.setTabBarMark(opts.index, { type: 'text', text: String(opts.text ?? '') })) {
            throw new Error('tabBar item not found');
          }
          return {};
        }),
      removeTabBarBadge: (options: any) =>
        invoke('removeTabBarBadge', options, opts => {
          if (!this.host.setTabBarMark(opts.index, null)) {
            throw new Error('tabBar item not found');
          }
          return {};
        }),
      showTabBarRedDot: (options: any) =>
        invoke('showTabBarRedDot', options, opts => {
          if (!this.host.setTabBarMark(opts.index, { type: 'redDot' })) {
            throw new Error('tabBar item not found');
          }
          return {};
        }),
      hideTabBarRedDot: (options: any) =>
        invoke('hideTabBarRedDot', options, opts => {
          if (!this.host.setTabBarMark(opts.index, null)) {
            throw new Error('tabBar item not found');
          }
          return {};
        }),
      setPageOrientation: (options: any) =>
        invoke('setPageOrientation', options, opts => {
          const orientation = String(opts?.orientation ?? 'portrait');
          this.host.setPageOrientation?.(orientation);
          return {};
        }),
      authPrivateMessage: (options: any) =>
        invoke('authPrivateMessage', options, () => ({ valid: false, encryptedData: '', iv: '' })),

      setFullScreen: (options: any) =>
        invoke('setFullScreen', options, async opts => {
          if (opts?.fullScreen) await document.documentElement.requestFullscreen?.();
          else if (document.fullscreenElement) await document.exitFullscreen?.();
          return {};
        }),

      // 全屏 / 屏幕方向
      checkIsSupportFullScreen: () => syncResult('checkIsSupportFullScreen', { support: true }),
      onWindowStateChange: (callback: (res: any) => void) => this.host.on('windowStateChange', callback),
      offWindowStateChange: (callback?: (res: any) => void) => this.host.off('windowStateChange', callback)
    };
  }
}
