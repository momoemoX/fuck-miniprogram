/**
 * wx API 的宿主接口
 *
 * API 层只依赖这个接口，不直接碰 Runtime / DOM：路由、外壳、事件总线都由
 * Runtime 注入，方便单独测试，也避免 API 模块之间互相引用。
 */

export interface DeviceInfo {
  model: string;
  system: string;
  platform: string;
  screenWidth: number;
  screenHeight: number;
  statusBarHeight: number;
  safeAreaBottom: number;
  windowHeight: number;
  windowTop: number;
  pixelRatio: number;
}

export interface TabBarMark {
  type: 'text';
  text: string;
}

export type TabBarMarkValue = TabBarMark | { type: 'redDot' } | null;

export interface NavigationColor {
  frontColor?: string;
  backgroundColor?: string;
  animation?: { duration?: number; timingFunc?: string };
}

export interface LaunchOptions {
  path: string;
  query: Record<string, string>;
  scene: number;
  referrerInfo: { appId?: string; extraData?: Record<string, any> };
}

export interface WxHost {
  /** 路由：返回 false / 抛错表示失败，API 层负责转成 fail 回调 */
  navigate(url: string, mode?: 'navigate' | 'redirect' | 'reLaunch' | 'switchTab'): boolean | void;
  back(delta?: number): void;

  /** 应用重启（restartMiniProgram）：销毁当前运行时并按原 boot 配置重新启动 */
  restart(path?: string): void;

  pageElement(): Element | null;
  pageInstance(): any;
  pages(): any[];

  setNavigationBarTitle(title: string): void;
  setNavigationBarColor(option: NavigationColor): void;
  setNavigationBarLoading(loading: boolean): void;
  setStatusBarHidden(hidden: boolean): void;

  /** 系统弹层挂载点（手机屏幕内，不是浏览器窗口） */
  overlay(): HTMLElement;
  deviceInfo(): DeviceInfo;

  setTabBarHidden(hidden: boolean): void;
  hasTabBar(route: string): boolean;
  updateTabBarItem(index: number, item: { text?: string; iconPath?: string; selectedIconPath?: string }): boolean;
  updateTabBarStyle(style: { color?: string; selectedColor?: string; backgroundColor?: string; borderStyle?: string }): void;
  setTabBarMark(index: number, mark: TabBarMarkValue): boolean;

  /** 页面窗口背景与下拉刷新 */
  setBackgroundColor(color: string): void;
  setBackgroundTextStyle(style: string): void;
  startPullDownRefresh(): void;
  stopPullDownRefresh(): void;
  setPageScrollTop(top: number, duration?: number): void;
  setPageOrientation?(orientation: string): void;

  /** 全局事件总线：wx.onXxx / offXxx、App 生命周期、页面事件都走这里 */
  on(event: string, callback: (...args: any[]) => void): void;
  off(event: string, callback?: (...args: any[]) => void): void;
  emit(event: string, ...args: any[]): void;

  appInstance(): any;
  launchOptions(): LaunchOptions;

  /** 页面栈中页面的 query / 页面实例，供 eventChannel 使用 */
  pageStack(): any[];
  setOpenerChannel(channel: any): void;
}

export interface ApiOptions {
  success?: (res: any) => void;
  fail?: (res: any) => void;
  complete?: (res: any) => void;
}

export type ApiHandler = (options: any) => any;
