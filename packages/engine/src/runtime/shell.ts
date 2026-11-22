/**
 * Web 设备外壳：状态栏、导航栏、胶囊按钮、页面容器、tabBar 与视口缩放
 */

export interface DeviceProfile {
  model: string;
  system: string;
  platform: string;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  statusBarHeight: number;
  safeAreaBottom: number;
}

/** iPhone X 尺寸，与旧链路的默认设备参数一致 */
export const DEFAULT_DEVICE: DeviceProfile = {
  model: 'iPhone X',
  system: 'iOS 16.0',
  platform: 'devtools',
  screenWidth: 375,
  screenHeight: 812,
  pixelRatio: 3,
  statusBarHeight: 44,
  safeAreaBottom: 34
};

export const NAVIGATION_BAR_HEIGHT = 44;
export const TAB_BAR_HEIGHT = 50;
const DEVICE_BEZEL = 13;
const STAGE_PADDING = 24;
const STAGE_GAP = 16;
const MIN_SCALE = 0.5;
const SCALE_STORAGE_KEY = 'fmp:scale';

type ScaleMode = 'fit' | '1';

export interface NavigationState {
  title: string;
  backgroundColor: string;
  textStyle: string;
  showBack: boolean;
  custom: boolean;
}

export interface TabBarItem {
  pagePath: string;
  text?: string;
  iconPath?: string;
  selectedIconPath?: string;
  mark?: { type: 'text'; text: string } | { type: 'redDot' } | null;
}

export interface TabBarConfig {
  color?: string;
  selectedColor?: string;
  backgroundColor?: string;
  borderStyle?: string;
  list: TabBarItem[];
}

const BACK_ICON =
  '<svg width="12" height="20" viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const MORE_ICON =
  '<svg width="22" height="8" viewBox="0 0 22 8" fill="currentColor"><circle cx="3.5" cy="4" r="2.3"/><circle cx="11" cy="4" r="3.3"/><circle cx="18.5" cy="4" r="2.3"/></svg>';

const CLOSE_ICON =
  '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="3.4" fill="currentColor"/></svg>';

const STATUS_ICONS = [
  // 信号
  '<svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7" width="3" height="4" rx=".8"/><rect x="4.6" y="5" width="3" height="6" rx=".8"/><rect x="9.2" y="2.6" width="3" height="8.4" rx=".8"/><rect x="13.8" y="0" width="3" height="11" rx=".8"/></svg>',
  // Wi-Fi
  '<svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 11.2L5.45 8.65A3.6 3.6 0 0 1 10.55 8.65ZM2.77 5.97A7.4 7.4 0 0 1 13.23 5.97L11.68 7.52A5.2 5.2 0 0 0 4.32 7.52ZM0.08 3.28A11.2 11.2 0 0 1 15.92 3.28L14.36 4.84A9 9 0 0 0 1.64 4.84Z"/></svg>',
  // 电池
  '<svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21.5" height="11" rx="3.2" fill="none" stroke="currentColor" stroke-opacity=".4"/><rect x="2" y="2" width="18.5" height="8" rx="1.8" fill="currentColor"/><path d="M23.4 4v4a2.2 2.2 0 0 0 0-4z" fill="currentColor" fill-opacity=".45"/></svg>'
].join('');

export const SHELL_CSS = `
html, body { margin: 0; height: 100%; background: radial-gradient(120% 80% at 50% 0%, #f6f7f9 0%, #e6e9ee 100%); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
.fmp-stage { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${STAGE_GAP}px; padding: ${STAGE_PADDING}px; box-sizing: border-box; }
.fmp-device-slot { position: relative; flex: none; }
.fmp-device { position: absolute; transform-origin: 0 0; overflow: hidden; background: #fff; border-radius: 6px; display: flex; flex-direction: column; box-shadow: 0 0 0 ${DEVICE_BEZEL - 2}px #111214, 0 0 0 ${DEVICE_BEZEL - 1}px #3a3b3f, 0 0 0 ${DEVICE_BEZEL}px #1b1c1f, 0 32px 64px -12px rgba(15,23,42,.35), 0 14px 28px -8px rgba(15,23,42,.18); }
.fmp-device.has-notch { border-radius: 40px; }
.fmp-notch { position: absolute; top: 0; left: 50%; z-index: 30; width: 209px; height: 30px; transform: translateX(-50%); background: #000; border-radius: 0 0 20px 20px; pointer-events: none; }
.fmp-notch::before, .fmp-notch::after { content: ''; position: absolute; top: 0; width: 6px; height: 6px; }
.fmp-notch::before { left: -6px; background: radial-gradient(circle at 0 100%, transparent 5.5px, #000 6px); }
.fmp-notch::after { right: -6px; background: radial-gradient(circle at 100% 100%, transparent 5.5px, #000 6px); }
.fmp-home-indicator { position: absolute; bottom: 8px; left: 50%; z-index: 30; width: 134px; height: 5px; transform: translateX(-50%); border-radius: 3px; background: rgba(0,0,0,.85); pointer-events: none; }
.fmp-statusbar { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; font-size: 12px; font-weight: 600; box-sizing: border-box; user-select: none; }
.fmp-statusbar-icons { display: flex; align-items: center; gap: 5px; }
.fmp-statusbar svg { display: block; }
.has-notch .fmp-statusbar { display: grid; grid-template-columns: 1fr 209px 1fr; align-items: start; padding: 15px 0 0; font-size: 15px; letter-spacing: -.2px; }
.has-notch .fmp-statusbar-time { grid-column: 1; justify-self: center; line-height: 20px; }
.has-notch .fmp-statusbar-icons { grid-column: 3; justify-self: center; height: 20px; }
.fmp-navbar { flex: none; height: ${NAVIGATION_BAR_HEIGHT}px; position: relative; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
.fmp-navbar.is-hidden, .fmp-statusbar.is-hidden { display: none; }
.fmp-navbar-title { font-size: 17px; font-weight: 600; max-width: calc(100% - 204px); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fmp-navbar-back { position: absolute; left: 4px; top: 0; height: 44px; width: 44px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.fmp-navbar-loading { width: 14px; height: 14px; margin-right: 6px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: fmp-spin .8s linear infinite; display: none; }
.fmp-navbar.is-loading .fmp-navbar-loading { display: inline-block; }
.fmp-capsule { position: absolute; z-index: 6; display: flex; align-items: center; box-sizing: border-box; border-radius: 16px; border: .5px solid rgba(0,0,0,.12); background: rgba(255,255,255,.62); color: #000; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); user-select: none; }
.fmp-capsule.is-light { border-color: rgba(255,255,255,.28); background: rgba(0,0,0,.18); color: #fff; }
.fmp-capsule > span { flex: 1; height: 100%; display: flex; align-items: center; justify-content: center; }
.fmp-capsule > span + span { position: relative; }
.fmp-capsule > span + span::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 1px; background: currentColor; opacity: .25; transform: scaleX(.5); }
.fmp-capsule svg { display: block; }
.fmp-pages { flex: 1; position: relative; overflow: hidden; }
.fmp-pages iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
.fmp-tabbar { flex: none; height: calc(${TAB_BAR_HEIGHT}px + var(--fmp-safe-bottom, 0px)); padding-bottom: var(--fmp-safe-bottom, 0px); display: flex; border-top: .5px solid rgba(0,0,0,.1); box-sizing: border-box; }
.fmp-tabbar.is-hidden { display: none; }
.fmp-custom-tabbar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 9; pointer-events: none; }
.fmp-custom-tabbar.is-hidden { display: none; }
.fmp-custom-tabbar > * { pointer-events: auto; }
.fmp-tabbar-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; cursor: pointer; user-select: none; gap: 2px; }
.fmp-tabbar-item img { width: 24px; height: 24px; display: block; }
.fmp-tabbar-icon, .fmp-tabbar-text { position: relative; }
.fmp-tabbar-badge { position: absolute; top: -4px; left: calc(100% - 6px); min-width: 16px; height: 16px; padding: 0 5px; box-sizing: border-box; border-radius: 8px; background: #fa5151; color: #fff; font-size: 11px; line-height: 16px; text-align: center; white-space: nowrap; }
.fmp-tabbar-dot { position: absolute; top: -2px; left: calc(100% - 2px); width: 8px; height: 8px; border-radius: 50%; background: #fa5151; }
.fmp-tabbar-text > .fmp-tabbar-badge { top: -10px; left: calc(100% + 1px); }
.fmp-tabbar-text > .fmp-tabbar-dot { top: -3px; left: calc(100% + 1px); }
.fmp-overlay { position: absolute; top: 0; right: 0; left: 0; height: 100%; pointer-events: none; z-index: 10; }
.fmp-dialog-layer { position: absolute; inset: 0; pointer-events: none; }
.fmp-picker-inputs { display: flex; }
.fmp-picker-input { flex: 1; min-width: 0; display: flex; justify-content: center; align-items: center; gap: 6px; }
.fmp-picker-input input { width: 5em; padding: 6px; border: 1px solid #ddd; border-radius: 4px; font: inherit; }
.fmp-preview { position: absolute; inset: 0; z-index: 100; background: #000; color: #fff; pointer-events: auto; }
.fmp-preview-content { position: absolute; inset: 44px 0; display: flex; align-items: center; justify-content: center; }
.fmp-preview-content img, .fmp-preview-content video { display: block; width: 100%; height: 100%; object-fit: contain; }
.fmp-preview button { position: absolute; z-index: 1; border: 0; border-radius: 4px; background: rgba(0,0,0,.55); color: #fff; font-size: 36px; cursor: pointer; }
.fmp-preview-prev, .fmp-preview-next { top: 45%; padding: 8px 12px; }
.fmp-preview-prev { left: 8px; }
.fmp-preview-next { right: 8px; }
.fmp-preview-close { right: 8px; top: 4px; }
.fmp-preview-position { position: absolute; bottom: 12px; left: 0; right: 0; text-align: center; pointer-events: none; }
.fmp-document { position: absolute; inset: 0; z-index: 100; background: #f2f2f2; color: #222; pointer-events: auto; display: flex; flex-direction: column; }
.fmp-document header { display: flex; gap: 12px; align-items: center; padding: 12px; background: #fff; }
.fmp-document header span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fmp-document button { border: 0; background: #f2f2f2; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
.fmp-document-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.fmp-document-body canvas { display: block; max-width: 100%; margin: 0 auto; background: #fff; }
.fmp-document-text { background: #fff; padding: 8px; margin-bottom: 12px; white-space: pre-wrap; }
.fmp-document-text p { margin: 4px 0; }
.fmp-refresher { position: absolute; top: 0; left: 0; right: 0; height: 64px; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 1; color: #666; font-size: 13px; }
.fmp-refresher[data-style="light"] { color: #fff; }
.fmp-refresher-icon { width: 20px; height: 20px; border: 2px solid currentColor; border-radius: 50%; box-sizing: border-box; display: none; }
.fmp-refresher.is-refreshing .fmp-refresher-icon { display: block; border-color: transparent; border-top-color: currentColor; animation: fmp-spin .8s linear infinite; }
.fmp-mask { position: absolute; inset: 0; pointer-events: auto; }
.fmp-mask.is-dim { background: rgba(0,0,0,.5); }
.fmp-toast { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); min-width: 120px; max-width: 70%; padding: 14px 16px; border-radius: 8px; background: rgba(17,17,17,.75); color: #fff; font-size: 14px; text-align: center; box-sizing: border-box; pointer-events: none; }
.fmp-toast.has-icon { width: 136px; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.fmp-toast-icon { font-size: 36px; line-height: 1; }
.fmp-toast-spinner { width: 34px; height: 34px; border: 3px solid #fff; border-right-color: transparent; border-radius: 50%; animation: fmp-spin .8s linear infinite; }
.fmp-modal { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 80%; background: #fff; border-radius: 12px; overflow: hidden; pointer-events: auto; text-align: center; }
.fmp-modal-title { padding: 24px 20px 8px; font-size: 17px; font-weight: 600; }
.fmp-modal-content { padding: 8px 20px 24px; font-size: 15px; color: #666; white-space: pre-wrap; word-break: break-word; }
.fmp-modal-input { width: calc(100% - 40px); margin: 0 20px 20px; padding: 8px; font-size: 15px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; }
.fmp-modal-actions { display: flex; border-top: 1px solid rgba(0,0,0,.1); }
.fmp-modal-actions button { flex: 1; height: 50px; border: 0; background: none; font-size: 17px; font-weight: 600; cursor: pointer; }
.fmp-modal-actions button + button { border-left: 1px solid rgba(0,0,0,.1); }
.fmp-actionsheet { position: absolute; left: 0; right: 0; bottom: 0; padding-bottom: var(--fmp-safe-bottom, 0px); background: #f7f7f7; border-radius: 12px 12px 0 0; overflow: hidden; pointer-events: auto; }
.fmp-actionsheet-alert { padding: 16px; font-size: 13px; color: #888; text-align: center; background: #fff; }
.fmp-actionsheet button { display: block; width: 100%; height: 56px; border: 0; border-top: 1px solid rgba(0,0,0,.06); background: #fff; font-size: 17px; cursor: pointer; }
.fmp-actionsheet .fmp-actionsheet-cancel { margin-top: 8px; border-top: 0; }
.fmp-picker-layer .fmp-mask.is-dim { background: rgba(0,0,0,.6); animation: fmp-fade-in .3s ease forwards; }
.fmp-picker { position: absolute; left: 0; right: 0; bottom: 0; padding-bottom: var(--fmp-safe-bottom, 0px); background: #fff; pointer-events: auto; user-select: none; animation: fmp-slide-up .3s ease forwards; }
.fmp-picker-header { position: relative; display: flex; padding: 16px; font-size: 17px; line-height: 1.4; }
.fmp-picker-header::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; border-bottom: 1px solid rgba(0,0,0,.1); transform: scaleY(.5); transform-origin: 0 100%; }
.fmp-picker-header button { flex: 1; padding: 0; border: 0; background: none; font: inherit; cursor: pointer; }
.fmp-picker-cancel { color: rgba(0,0,0,.5); text-align: left; }
.fmp-picker-confirm { color: #07c160; text-align: right; }
.fmp-picker-body { position: relative; display: flex; height: 240px; overflow: hidden; }
.fmp-picker-column { flex: 1; min-width: 0; overflow-y: auto; padding: 96px 0; box-sizing: border-box; scroll-snap-type: y mandatory; overscroll-behavior: contain; scrollbar-width: none; }
.fmp-picker-column::-webkit-scrollbar { display: none; }
.fmp-picker-item { height: 48px; line-height: 48px; overflow: hidden; font-size: 11px; color: rgba(0,0,0,.9); text-align: center; white-space: nowrap; text-overflow: ellipsis; scroll-snap-align: center; cursor: pointer; }
.fmp-picker-mask { position: absolute; inset: 0; z-index: 1; pointer-events: none; background-image: linear-gradient(180deg, rgba(255,255,255,.95), rgba(255,255,255,.6)), linear-gradient(0deg, rgba(255,255,255,.95), rgba(255,255,255,.6)); background-position: top, bottom; background-size: 100% 92px; background-repeat: no-repeat; }
.fmp-picker-indicator { position: absolute; left: 0; right: 0; top: 92px; z-index: 1; height: 56px; pointer-events: none; }
.fmp-picker-indicator::before, .fmp-picker-indicator::after { content: ''; position: absolute; left: 0; right: 0; height: 1px; transform: scaleY(.5); }
.fmp-picker-indicator::before { top: 0; border-top: 1px solid rgba(0,0,0,.1); transform-origin: 0 0; }
.fmp-picker-indicator::after { bottom: 0; border-bottom: 1px solid rgba(0,0,0,.1); transform-origin: 0 100%; }
.fmp-toolbar { display: flex; align-items: center; gap: 10px; padding: 4px 4px 4px 12px; border-radius: 999px; background: rgba(255,255,255,.7); box-shadow: 0 1px 2px rgba(15,23,42,.08); font-size: 12px; color: #555; }
.fmp-toolbar button { border: 0; background: #111214; color: #fff; border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.fmp-toolbar .fmp-scale { min-width: 52px; background: #fff; color: #333; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); font-variant-numeric: tabular-nums; }
.fmp-route { font-family: Menlo, monospace; }
@keyframes fmp-spin { to { transform: rotate(360deg); } }
@keyframes fmp-fade-in { from { opacity: 0; } }
@keyframes fmp-slide-up { from { transform: translateY(100%); } }
`;

/** 手动打开时默认适应窗口；自动化环境默认 1:1，截图与视觉基线不随窗口大小变化 */
function loadScaleMode(): ScaleMode {
  try {
    const saved = localStorage.getItem(SCALE_STORAGE_KEY);
    if (saved === 'fit' || saved === '1') return saved;
  } catch {
    // 存储不可用时用默认值
  }
  return navigator.webdriver ? '1' : 'fit';
}

export interface ShellHandlers {
  onBack: () => void;
  onTabTap: (pagePath: string, index: number) => void;
}

export class PhoneShell {
  private readonly onResize = () => this.applyScale();
  readonly pages: HTMLElement;
  readonly overlay: HTMLElement;
  readonly root: HTMLElement;

  private readonly stage: HTMLElement;
  private readonly slot: HTMLElement;
  private readonly device: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly statusBar: HTMLElement;
  private readonly navBar: HTMLElement;
  private readonly capsule: HTMLElement;
  private readonly navTitle: HTMLElement;
  private readonly backButton: HTMLButtonElement;
  private readonly tabBar: HTMLElement;
  private readonly customTabBarHost: HTMLElement;
  private readonly routeLabel: HTMLElement;
  private readonly scaleButton: HTMLButtonElement;
  private readonly refresher: HTMLElement;

  private scaleMode = loadScaleMode();
  private navigation: NavigationState = { title: '', backgroundColor: '#000', textStyle: 'white', showBack: false, custom: false };
  private tabBarConfig: TabBarConfig | null = null;
  private tabBarPath: string | null = null;
  private tabBarHidden = false;
  private customTabBarMode = false;
  private handlers: ShellHandlers = { onBack: () => undefined, onTabTap: () => undefined };
  private pullHandler: (() => void) | null = null;
  private pullOffset = 0;
  private pullStart = 0;
  private pullTracking = false;
  private refreshing = false;

  constructor(
    private readonly profile: DeviceProfile,
    private readonly container: Element
  ) {
    if (!document.head.querySelector('style[data-fmp="shell"]')) {
      const style = document.createElement('style');
      style.setAttribute('data-fmp', 'shell');
      style.textContent = SHELL_CSS;
      document.head.appendChild(style);
    }

    const hasNotch = profile.statusBarHeight > 20;
    const capsule = {
      width: 87,
      height: 32,
      top: profile.statusBarHeight + 6,
      left: profile.screenWidth - 7 - 87
    };

    const root = document.createElement('div');
    root.id = 'fmp-root';
    root.innerHTML = `
      <div class="fmp-stage">
        <div class="fmp-device-slot">
          <div class="fmp-device${hasNotch ? ' has-notch' : ''}" style="width:${profile.screenWidth}px;height:${profile.screenHeight}px;--fmp-safe-bottom:${profile.safeAreaBottom}px">
            <div class="fmp-statusbar" style="height:${profile.statusBarHeight}px">
              <span class="fmp-statusbar-time">9:41</span>
              <span class="fmp-statusbar-icons">${STATUS_ICONS}</span>
            </div>
            <div class="fmp-navbar">
              <button class="fmp-navbar-back" title="返回" aria-label="返回">${BACK_ICON}</button>
              <span class="fmp-navbar-loading"></span><span class="fmp-navbar-title"></span>
            </div>
            <div class="fmp-pages"><div class="fmp-refresher"><span class="fmp-refresher-icon"></span></div></div>
            <div class="fmp-tabbar is-hidden"></div>
            <div class="fmp-custom-tabbar is-hidden"></div>
            <div class="fmp-capsule" style="top:${capsule.top}px;left:${capsule.left}px;width:${capsule.width}px;height:${capsule.height}px">
              <span class="fmp-capsule-more">${MORE_ICON}</span><span class="fmp-capsule-close">${CLOSE_ICON}</span>
            </div>
            <div class="fmp-overlay"></div>
            ${hasNotch ? '<div class="fmp-notch"></div>' : ''}
            ${profile.safeAreaBottom ? '<div class="fmp-home-indicator"></div>' : ''}
          </div>
        </div>
        <div class="fmp-toolbar">
          <span class="fmp-route"></span><button class="fmp-scale"></button><button class="fmp-reload">刷新</button>
        </div>
      </div>`;

    this.container.appendChild(root);
    this.root = root;
    this.stage = root.querySelector('.fmp-stage')!;
    this.slot = root.querySelector('.fmp-device-slot')!;
    this.device = root.querySelector('.fmp-device')!;
    this.toolbar = root.querySelector('.fmp-toolbar')!;
    this.statusBar = root.querySelector('.fmp-statusbar')!;
    this.navBar = root.querySelector('.fmp-navbar')!;
    this.capsule = root.querySelector('.fmp-capsule')!;
    this.navTitle = root.querySelector('.fmp-navbar-title')!;
    this.backButton = root.querySelector('.fmp-navbar-back')!;
    this.pages = root.querySelector('.fmp-pages')!;
    this.tabBar = root.querySelector('.fmp-tabbar')!;
    this.customTabBarHost = root.querySelector('.fmp-custom-tabbar')!;
    this.overlay = root.querySelector('.fmp-overlay')!;
    this.routeLabel = root.querySelector('.fmp-route')!;
    this.scaleButton = root.querySelector('.fmp-scale')!;
    this.refresher = root.querySelector('.fmp-refresher')!;

    root.querySelector('.fmp-reload')!.addEventListener('click', () => location.reload());
    this.backButton.addEventListener('click', () => this.handlers.onBack());
    this.scaleButton.addEventListener('click', () => {
      this.scaleMode = this.scaleMode === 'fit' ? '1' : 'fit';
      try {
        localStorage.setItem(SCALE_STORAGE_KEY, this.scaleMode);
      } catch {
        // 只影响记住选择
      }
      this.applyScale();
    });
    window.addEventListener('resize', this.onResize);
    this.applyScale();
    this.bindPullGesture();
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }

  /** 页面在 scrollTop=0 时继续下拉，超过阈值触发 onPullDownRefresh */
  private bindPullGesture() {
    const currentPage = () => {
      const pages = Array.from(this.pages.querySelectorAll('wx-page')) as HTMLElement[];
      return pages.find(page => page.style.display !== 'none') ?? pages[pages.length - 1] ?? null;
    };

    this.pages.addEventListener(
      'touchstart',
      event => {
        if (this.refreshing) return;
        const page = currentPage();
        if (!page || page.scrollTop > 0) return;
        this.pullStart = event.touches[0]?.clientY ?? 0;
        this.pullTracking = true;
      },
      { passive: true }
    );

    this.pages.addEventListener(
      'touchmove',
      event => {
        if (!this.pullTracking || this.refreshing) return;
        const distance = (event.touches[0]?.clientY ?? 0) - this.pullStart;
        if (distance <= 0) {
          if (this.pullOffset) this.setPull(0, false);
          return;
        }
        // 阻尼：越拉越沉
        const offset = Math.min(80, distance * 0.5);
        this.setPull(offset, false);
      },
      { passive: true }
    );

    const end = () => {
      if (!this.pullTracking) return;
      this.pullTracking = false;
      if (this.pullOffset >= 50 && this.pullHandler) {
        this.refreshing = true;
        this.setPull(64, true);
        this.pullHandler();
      } else {
        this.setPull(0, false);
      }
    };
    this.pages.addEventListener('touchend', end, { passive: true });
    this.pages.addEventListener('touchcancel', end, { passive: true });
  }

  onPullDown(callback: () => void) {
    this.pullHandler = callback;
  }

  setPull(offset: number, refreshing: boolean) {
    this.pullOffset = offset;
    this.refreshing = refreshing;
    this.pages.style.setProperty('--fmp-pull', `${offset}px`);
    this.refresher.classList.toggle('is-refreshing', refreshing);
  }

  startPullDownRefresh() {
    this.refreshing = true;
    this.setPull(64, true);
  }

  stopPullDownRefresh() {
    this.refreshing = false;
    this.setPull(0, false);
  }

  setNavigationLoading(loading: boolean) {
    this.navBar.classList.toggle('is-loading', loading);
  }

  setStatusBarHidden(hidden: boolean) {
    this.statusBar.style.visibility = hidden ? 'hidden' : '';
  }

  setBackgroundColor(color: string) {
    this.pages.style.background = color;
    this.device.style.background = color;
  }

  setBackgroundTextStyle(style: string) {
    this.refresher.dataset.style = style;
  }

  on(handlers: ShellHandlers) {
    this.handlers = handlers;
  }

  /**
   * 窗口放不下时整体缩小手机。只用 transform：页面内的布局、字号、坐标都不变。
   * transform 不改变占位，所以由外层 slot 按缩放后的尺寸占位。
   */
  private applyScale() {
    const width = this.profile.screenWidth + DEVICE_BEZEL * 2;
    const height = this.profile.screenHeight + DEVICE_BEZEL * 2;
    let scale = 1;
    if (this.scaleMode === 'fit') {
      const availableWidth = window.innerWidth - STAGE_PADDING * 2;
      const availableHeight = window.innerHeight - STAGE_PADDING * 2 - STAGE_GAP - this.toolbar.offsetHeight;
      const fit = Math.floor(Math.min(availableWidth / width, availableHeight / height) * 100) / 100;
      scale = Math.min(1, Math.max(MIN_SCALE, fit));
    }
    this.slot.style.width = `${width * scale}px`;
    this.slot.style.height = `${height * scale}px`;
    this.device.style.left = this.device.style.top = `${DEVICE_BEZEL * scale}px`;
    this.device.style.transform = scale === 1 ? '' : `scale(${scale})`;
    this.overlay.style.maxHeight = `${Math.max(0, (window.innerHeight - this.overlay.getBoundingClientRect().top) / scale)}px`;
    this.scaleButton.textContent = `${Math.round(scale * 100)}%`;
    this.scaleButton.title = this.scaleMode === 'fit' ? '适应窗口，点击切换为实际大小' : '实际大小，点击切换为适应窗口';
  }

  setRoute(route: string) {
    this.routeLabel.textContent = route;
  }

  setNavigation(state: Partial<NavigationState>) {
    this.navigation = { ...this.navigation, ...state };
    const { title, backgroundColor, textStyle, showBack, custom } = this.navigation;
    const color = textStyle === 'black' ? '#000' : '#fff';

    this.navTitle.textContent = title;
    this.backButton.style.visibility = showBack ? 'visible' : 'hidden';
    this.navBar.classList.toggle('is-hidden', custom);
    this.navBar.style.background = backgroundColor;
    this.navBar.style.color = color;
    // 自定义导航栏时页面从屏幕顶部开始绘制，状态栏浮在页面上
    this.statusBar.style.background = custom ? 'transparent' : backgroundColor;
    this.statusBar.style.color = color;
    this.capsule.classList.toggle('is-light', textStyle !== 'black');
    this.statusBar.style.position = custom ? 'absolute' : '';
    this.statusBar.style.left = this.statusBar.style.right = custom ? '0' : '';
    this.statusBar.style.zIndex = custom ? '5' : '';
  }

  getNavigation(): NavigationState {
    return { ...this.navigation };
  }

  /** 页面可用高度，与 getSystemInfo().windowHeight 对应；原生 tabBar 会连同底部安全区一起占掉 */
  windowHeight(): number {
    const tabBar = this.tabBarPath !== null && this.hasTabBar(this.tabBarPath);
    return (
      this.profile.screenHeight - this.screenTop() - (tabBar && !this.customTabBarMode ? TAB_BAR_HEIGHT + this.profile.safeAreaBottom : 0)
    );
  }

  /** 自定义 tabBar：默认 tabBar 不渲染，页面铺满到屏幕底部 */
  setCustomTabBarMode(enabled: boolean) {
    if (this.customTabBarMode === enabled) return;
    this.customTabBarMode = enabled;
    this.renderTabBar(this.tabBarPath);
  }

  customTabBarElement(): HTMLElement {
    return this.customTabBarHost;
  }

  /** 页面窗口顶部到屏幕顶部的距离，与 getWindowInfo().screenTop 对应 */
  screenTop(): number {
    return this.navigation.custom ? 0 : this.profile.statusBarHeight + NAVIGATION_BAR_HEIGHT;
  }

  /** 设置 tabBar 配置；传 null 表示清空 */
  setTabBarConfig(config: TabBarConfig | null) {
    this.tabBarConfig = config && config.list?.length ? config : null;
    this.renderTabBar(this.tabBarPath);
  }

  updateTabBarStyle(style: Partial<Omit<TabBarConfig, 'list'>>) {
    if (!this.tabBarConfig) return;
    Object.assign(this.tabBarConfig, Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined)));
    this.renderTabBar(this.tabBarPath);
  }

  /** 返回 false 表示 index 越界 */
  updateTabBarItem(index: number, item: Partial<Omit<TabBarItem, 'pagePath'>>): boolean {
    const target = this.tabBarConfig?.list[index];
    if (!target) return false;
    Object.assign(target, Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)));
    this.renderTabBar(this.tabBarPath);
    return true;
  }

  setTabBarMark(index: number, mark: TabBarItem['mark']): boolean {
    return this.updateTabBarItem(index, { mark });
  }

  getTabBarLength(): number {
    return this.tabBarConfig?.list.length ?? 0;
  }

  setTabBarHidden(hidden: boolean) {
    this.tabBarHidden = hidden;
    this.renderTabBar(this.tabBarPath);
  }

  hasTabBar(pagePath: string): boolean {
    return !this.tabBarHidden && !!this.tabBarConfig?.list.some(item => item.pagePath === pagePath);
  }

  /** 当前页面是 tabBar 页面时传入它的路径，否则传 null */
  renderTabBar(selectedPath: string | null) {
    const config = this.tabBarConfig;
    this.tabBarPath = selectedPath;
    const visible = selectedPath !== null && this.hasTabBar(selectedPath);
    const custom = this.customTabBarMode;
    this.tabBar.classList.toggle('is-hidden', !visible || custom);
    this.customTabBarHost.classList.toggle('is-hidden', !visible || !custom);
    if (!config || !visible || custom) return;

    this.tabBar.style.background = config.backgroundColor || '#f7f7f7';
    this.tabBar.style.borderTopColor = config.borderStyle === 'white' ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.1)';
    this.tabBar.replaceChildren(
      ...config.list.map((item, index) => {
        const selected = item.pagePath === selectedPath;
        const color = selected ? config.selectedColor || '#07c160' : config.color || '#7a7e83';
        const icon = selected ? item.selectedIconPath || item.iconPath : item.iconPath;
        const el = document.createElement('div');
        el.className = 'fmp-tabbar-item' + (selected ? ' is-selected' : '');
        el.dataset.pagePath = item.pagePath;
        el.style.color = color;

        const iconBox = document.createElement('span');
        iconBox.className = 'fmp-tabbar-icon';
        if (icon) {
          const img = document.createElement('img');
          img.src = /^https?:\/\//.test(icon) ? icon : '/' + icon.replace(/^\//, '');
          iconBox.appendChild(img);
          el.appendChild(iconBox);
        }
        const text = document.createElement('span');
        text.className = 'fmp-tabbar-text';
        text.textContent = item.text ?? '';
        el.appendChild(text);

        if (item.mark) {
          const mark = document.createElement('span');
          mark.className = item.mark.type === 'redDot' ? 'fmp-tabbar-dot' : 'fmp-tabbar-badge';
          if (item.mark.type === 'text') mark.textContent = item.mark.text;
          (icon ? iconBox : text).appendChild(mark);
        }
        el.addEventListener('click', () => this.handlers.onTabTap(item.pagePath, index));
        return el;
      })
    );
  }

  /** 清掉页面容器里的所有内容（切页/重开时用） */
  clearPages() {
    this.pages.replaceChildren();
  }
}
