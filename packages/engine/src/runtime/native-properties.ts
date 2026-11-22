import { booleanProperty, boundAttribute, hasBoundAttribute } from './attributes';
import { normalizeSize } from './geometry';

type PropertyKind = 'string' | 'number' | 'boolean' | 'array' | 'any' | 'size' | 'live';
interface Property { kind: PropertyKind; initial: unknown }
const string = (initial = ''): Property => ({ kind: 'string', initial });
const number = (initial = 0): Property => ({ kind: 'number', initial });
const boolean = (initial: unknown = false): Property => ({ kind: 'boolean', initial });
const array = (): Property => ({ kind: 'array', initial: [] });
const any = (initial: unknown): Property => ({ kind: 'any', initial });
const size = (initial: unknown = ''): Property => ({ kind: 'size', initial });
const live = (initial: unknown): Property => ({ kind: 'live', initial });

const schemas: Record<string, Record<string, Property>> = {
  'WX-IMAGE': { src: string(), mode: string(), lazyLoad: boolean(), showMenuByLongpress: boolean(), webp: boolean() },
  'WX-INPUT': {
    value: live(''), type: string('text'), password: boolean(), placeholder: string(), disabled: boolean(),
    maxlength: number(140), focus: boolean(0), autoFocus: boolean(), cursor: any(-1)
  },
  'WX-TEXTAREA': {
    value: live(''), placeholder: string(), disabled: boolean(), maxlength: number(140), autoHeight: boolean(), focus: boolean(0), cursor: any(-1)
  },
  'WX-VIDEO': {
    src: string(), poster: string(), controls: boolean(true), autoplay: boolean(), loop: boolean(), muted: boolean(),
    objectFit: string('contain'), initialTime: number(), enableDanmu: live(false), danmuBtn: boolean(), danmuList: array(), showProgress: boolean(true),
    showMuteBtn: boolean(), showFullscreenBtn: boolean(true), showPlayBtn: boolean(true), showCenterPlayBtn: boolean(true), duration: number()
  },
  'WX-AUDIO': { src: string(), poster: string(), name: string('未知歌曲'), author: string('未知作者'), controls: boolean(), loop: boolean() },
  'WX-BUTTON': {
    type: string('default'), size: string('default'), plain: boolean(), disabled: boolean(), loading: boolean(),
    formType: string(), openType: string(), hoverClass: string()
  },
  'WX-SLIDER': {
    value: number(), min: number(), max: number(100), step: number(1), disabled: boolean(), showValue: boolean(),
    blockSize: number(28), activeColor: string('#1AAD19')
  },
  'WX-SWITCH': { checked: boolean(), disabled: boolean(), type: string('switch'), color: string() },
  'WX-CHECKBOX': { value: string(), checked: boolean(), disabled: boolean(), color: string() },
  'WX-PICKER': {
    mode: string('selector'), value: any(''), range: array(), rangeKey: string(), disabled: boolean(),
    start: string(), end: string(), fields: string('day')
  },
  'WX-SCROLL-VIEW': {
    scrollX: boolean(), scrollY: boolean(), scrollTop: size(), scrollLeft: size(), upperThreshold: size(50),
    lowerThreshold: size(50), scrollIntoView: string(), scrollWithAnimation: boolean()
  },
  'WX-TEXT': { selectable: boolean(), userSelect: boolean(), space: string(), decode: boolean() },
  'WX-CANVAS': { type: string(), canvasId: string(), disableScroll: boolean() }
};

function readProperty(el: Element, name: string, property: Property): unknown {
  if (property.kind === 'live') return (el as any)[name] ?? property.initial;
  const attribute = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  if (!el.hasAttribute(attribute) && !hasBoundAttribute(el, attribute)) return structuredClone(property.initial);
  const value = boundAttribute(el, attribute);
  switch (property.kind) {
    case 'boolean': return el.hasAttribute(attribute) && el.getAttribute(attribute) !== 'false';
    case 'string': return value == null ? '' : String(value);
    case 'number': return Number(value) || 0;
    case 'array': return Array.isArray(value) ? structuredClone(value) : [];
    case 'size': return normalizeSize(value);
    case 'any': return structuredClone(value);
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
