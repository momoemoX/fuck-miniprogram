import { booleanProperty, boundAttribute, hasBoundAttribute } from './attributes';

type PropertyKind = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any' | 'size' | 'live';
interface Property {
  kind: PropertyKind;
  initial: unknown;
}
const string = (initial = ''): Property => ({ kind: 'string', initial });
const number = (initial = 0): Property => ({ kind: 'number', initial });
const boolean = (initial: unknown = false): Property => ({ kind: 'boolean', initial });
const array = (initial: unknown[] = []): Property => ({ kind: 'array', initial });
const object = (initial: Record<string, unknown> = {}): Property => ({ kind: 'object', initial });
const any = (initial: unknown): Property => ({ kind: 'any', initial });
const size = (initial: unknown = ''): Property => ({ kind: 'size', initial });
const live = (initial: unknown): Property => ({ kind: 'live', initial });

const schemas: Record<string, Record<string, Property>> = {
  'WX-VIEW': {
    hoverClass: string(),
    hoverStopPropagation: boolean(),
    hoverStartTime: number(50),
    hoverStayTime: number(400)
  },
  'WX-COVER-VIEW': {
    scrollTop: size(-1)
  },
  'WX-COVER-IMAGE': {
    src: string(),
    referrerPolicy: string('no-referrer')
  },
  'WX-IMAGE': {
    src: string(),
    mode: string(),
    lazyLoad: boolean(),
    showMenuByLongpress: boolean(),
    webp: boolean()
  },
  'WX-ICON': {
    type: string(),
    size: size('23px'),
    color: string()
  },
  'WX-TEXT': {
    selectable: boolean(),
    userSelect: boolean(),
    space: string(),
    decode: boolean()
  },
  'WX-RICH-TEXT': {
    nodes: any(null),
    space: string(),
    userSelect: boolean()
  },
  'WX-PROGRESS': {
    percent: number(0),
    showInfo: boolean(),
    borderRadius: size(0),
    fontSize: size(16),
    strokeWidth: size(6),
    color: string('#09BB07'),
    activeColor: string('#09BB07'),
    backgroundColor: string('#EBEBEB'),
    active: boolean(),
    activeMode: string('backwards'),
    duration: number(30)
  },
  'WX-BUTTON': {
    size: string('default'),
    type: string('default'),
    plain: boolean(),
    disabled: boolean(),
    loading: boolean(),
    formType: string(),
    openType: string(),
    hoverClass: string(),
    hoverStopPropagation: boolean(),
    hoverStartTime: number(20),
    hoverStayTime: number(70),
    lang: string('en'),
    sessionFrom: string(['wx', 'app'].join('')),
    sendMessageTitle: string(),
    sendMessagePath: string(),
    sendMessageImg: string(),
    appParameter: string(),
    showMessageCard: boolean(),
    phoneNumberNoQuotaToast: boolean(true),
    needShowEntrance: boolean(true),
    entrancePath: string()
  },
  'WX-FORM': {
    reportSubmit: boolean(),
    reportSubmitTimeout: number(0)
  },
  'WX-LABEL': {
    for: string()
  },
  'WX-CHECKBOX': {
    value: string(),
    checked: boolean(),
    disabled: boolean(),
    color: string()
  },
  'WX-RADIO': {
    value: string(),
    checked: boolean(),
    disabled: boolean(),
    color: string()
  },
  'WX-SWITCH': {
    checked: boolean(),
    disabled: boolean(),
    type: string('switch'),
    color: string()
  },
  'WX-SLIDER': {
    value: number(),
    min: number(),
    max: number(100),
    step: number(1),
    disabled: boolean(),
    showValue: boolean(),
    color: string(),
    selectedColor: string('#1AAD19'),
    activeColor: string('#1AAD19'),
    backgroundColor: string('#E9E9E9'),
    blockSize: number(28),
    blockColor: string('#FFFFFF')
  },
  'WX-INPUT': {
    value: live(''),
    type: string('text'),
    password: boolean(),
    placeholder: string(),
    placeholderStyle: string(),
    disabled: boolean(),
    maxlength: number(140),
    focus: boolean(0),
    autoFocus: boolean(),
    confirmHold: boolean(),
    cursor: any(-1),
    selectionStart: number(-1),
    selectionEnd: number(-1),
    safePasswordCustomHash: string()
  },
  'WX-TEXTAREA': {
    value: live(''),
    placeholder: string(),
    placeholderStyle: string(),
    disabled: boolean(),
    maxlength: number(140),
    autoFocus: boolean(),
    focus: boolean(0),
    autoHeight: boolean(),
    cursor: any(-1),
    selectionStart: number(-1),
    selectionEnd: number(-1),
    confirmType: string('return'),
    confirmHold: boolean(),
    adjustKeyboardTo: string('cursor')
  },
  'WX-EDITOR': {
    readOnly: boolean(),
    placeholder: string(),
    showImgSize: boolean(),
    showImgToolbar: boolean(),
    showImgResize: boolean(),
    enableFormats: array(['bold', 'italic', 'underline']),
    enterkeyhint: string('enter'),
    confirmHold: boolean(true)
  },
  'WX-PICKER': {
    mode: string('selector'),
    value: any(''),
    range: array(),
    rangeKey: string(),
    disabled: boolean(),
    start: string(),
    end: string(),
    fields: string('day'),
    headerText: string(),
    customItem: string(),
    level: string()
  },
  'WX-PICKER-VIEW': {
    value: array(),
    indicatorStyle: string(),
    indicatorClass: string(),
    maskStyle: string(),
    maskClass: string(),
    immediateChange: boolean()
  },
  'WX-NAVIGATOR': {
    target: string('self'),
    url: string(),
    openType: string('navigate'),
    delta: number(1),
    appId: string(),
    path: string(),
    extraData: any(''),
    version: string('release'),
    shortLink: string(),
    hoverClass: string(),
    hoverStopPropagation: boolean(),
    hoverStartTime: number(50),
    hoverStayTime: number(600)
  },
  'WX-SCROLL-VIEW': {
    scrollX: boolean(),
    scrollY: boolean(),
    upperThreshold: size(50),
    lowerThreshold: size(50),
    scrollTop: size(''),
    scrollLeft: size(''),
    scrollIntoView: string(),
    scrollIntoViewOffset: number(0),
    scrollWithAnimation: boolean(),
    enableBackToTop: boolean(),
    enablePassive: boolean(),
    refresherEnabled: boolean(),
    refresherThreshold: number(45),
    refresherDefaultStyle: string('black'),
    refresherBackground: string(),
    refresherTriggered: boolean(),
    bounces: boolean(true),
    showScrollbar: boolean(true),
    fastDeceleration: boolean(),
    scrollAnchoring: boolean()
  },
  'WX-SWIPER': {
    indicatorDots: boolean(),
    indicatorColor: string(),
    indicatorActiveColor: string(),
    autoplay: boolean(),
    current: number(0),
    interval: number(5000),
    duration: number(500),
    circular: boolean(),
    vertical: boolean(),
    previousMargin: string(),
    nextMargin: string(),
    snapToEdge: boolean(),
    displayMultipleItems: number(1),
    easingFunction: string('default')
  },
  'WX-SWIPER-ITEM': {
    itemId: string()
  },
  'WX-MOVABLE-AREA': {
    scaleArea: boolean()
  },
  'WX-MOVABLE-VIEW': {
    direction: string('none'),
    inertia: boolean(),
    outOfBounds: boolean(),
    x: number(0),
    y: number(0),
    damping: number(20),
    friction: number(2),
    disabled: boolean(),
    scale: boolean(),
    scaleMin: number(0.1),
    scaleMax: number(10),
    scaleValue: number(1),
    animation: boolean(true)
  },
  'WX-MATCH-MEDIA': {
    minWidth: number(0),
    maxWidth: number(0),
    width: number(0),
    minHeight: number(0),
    maxHeight: number(0),
    height: number(0),
    orientation: string()
  },
  'WX-MAP': {
    longitude: number(116.46),
    latitude: number(39.92),
    scale: number(16),
    minScale: number(3),
    maxScale: number(20),
    markers: array(),
    covers: array(),
    polyline: array(),
    circles: array(),
    controls: array(),
    includePoints: array(),
    showLocation: boolean(),
    polygons: array(),
    subkey: string(),
    layerStyle: number(1),
    rotate: number(0),
    skew: number(0),
    enable3D: boolean(),
    showCompass: boolean(),
    showScale: boolean(),
    enableOverlooking: boolean(),
    enableZoom: boolean(true),
    enableScroll: boolean(true),
    enableRotate: boolean(),
    enableSatellite: boolean(),
    enableTraffic: boolean(),
    enablePoi: boolean(true),
    enableBuilding: boolean(true),
    setting: object()
  },
  'WX-AUDIO': {
    src: string(),
    poster: string(),
    name: string('未知歌曲'),
    author: string('未知作者'),
    controls: boolean(),
    loop: boolean()
  },
  'WX-VIDEO': {
    src: string(),
    duration: number(),
    controls: boolean(true),
    danmuList: array(),
    danmuBtn: boolean(),
    enableDanmu: live(false),
    autoplay: boolean(),
    loop: boolean(),
    muted: boolean(),
    initialTime: number(),
    pageGesture: boolean(),
    direction: number(-1),
    showProgress: boolean(true),
    showFullscreenBtn: boolean(true),
    showPlayBtn: boolean(true),
    showCenterPlayBtn: boolean(true),
    enableProgressGesture: boolean(true),
    objectFit: string('contain'),
    poster: string(),
    showMuteBtn: boolean(),
    title: string(),
    playBtnPosition: string('bottom'),
    enablePlayGesture: boolean(),
    autoPauseIfNavigate: boolean(true),
    autoPauseIfOpenNative: boolean(true),
    vslideGesture: boolean(),
    vslideGestureInFullscreen: boolean(true),
    showBottomProgress: boolean(true),
    adUnitId: string(),
    posterForCrawler: string(),
    showCastingButton: boolean(),
    pictureInPictureMode: string(),
    pictureInPictureShowProgress: boolean(),
    pictureInPictureInitPosition: string(),
    enableAutoRotation: boolean(),
    showScreenLockButton: boolean(),
    showSnapshotButton: boolean(),
    showBackgroundPlaybackButton: boolean(true),
    backgroundPoster: string(),
    referrerPolicy: string('no-referrer'),
    isDrm: boolean(),
    isLive: boolean(),
    provisionUrl: string(),
    certificateUrl: string(),
    licenseUrl: string(),
    preferredPeakBitRate: number(-1)
  },
  'WX-CANVAS': {
    type: string(),
    canvasId: string(),
    disableScroll: boolean()
  }
};

function resolveAttrName(el: Element, name: string): string | null {
  const kebab = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  if (el.hasAttribute(kebab) || hasBoundAttribute(el, kebab)) return kebab;
  const digitKebab = name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
  if (digitKebab !== kebab && (el.hasAttribute(digitKebab) || hasBoundAttribute(el, digitKebab))) return digitKebab;
  const lower = name.toLowerCase();
  if (lower !== kebab && (el.hasAttribute(lower) || hasBoundAttribute(el, lower))) return lower;
  return null;
}

function readProperty(el: Element, name: string, property: Property): unknown {
  if (property.kind === 'live') return (el as any)[name] ?? property.initial;
  const attribute = resolveAttrName(el, name);
  if (!attribute) return structuredClone(property.initial);
  const value = boundAttribute(el, attribute);
  switch (property.kind) {
    case 'boolean':
      return el.hasAttribute(attribute) && el.getAttribute(attribute) !== 'false';
    case 'string':
      return value == null ? '' : String(value);
    case 'number':
      return Number(value) || 0;
    case 'array':
      return Array.isArray(value) ? structuredClone(value) : [];
    case 'object':
      return value && typeof value === 'object' ? structuredClone(value) : {};
    case 'size':
      return value == null ? '' : String(value);
    case 'any':
      return structuredClone(value);
  }
}

export function nodeProperty(el: Element, name: string): unknown {
  if ((el as any).__wxComponent) return undefined;
  if (name.includes('-')) return undefined;
  const attribute = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  const schema = schemas[el.tagName];
  const property = schema && Object.prototype.hasOwnProperty.call(schema, name) ? schema[name] : name === 'hidden' ? boolean() : undefined;
  if (property) return readProperty(el, name, property);
  if (schema) return undefined;
  const observed: string[] = (el.constructor as any).observedAttributes ?? [];
  if (!observed.includes(attribute)) return undefined;
  const value = booleanProperty(el, name) ?? (el as any)[name] ?? boundAttribute(el, attribute);
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}
