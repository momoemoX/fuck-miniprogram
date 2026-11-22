const booleans = new Set([
  'hidden',
  'disabled',
  'loading',
  'checked',
  'password',
  'focus',
  'auto-focus',
  'auto-height',
  'lazy-load',
  'webp',
  'show-menu-by-longpress',
  'disable-scroll',
  'show-value',
  'loop',
  'muted',
  'autoplay',
  'controls',
  'enable-danmu',
  'danmu-btn',
  'show-progress',
  'show-fullscreen-btn',
  'show-play-btn',
  'show-center-play-btn',
  'show-mute-btn',
  'enable-scroll',
  'enable-zoom',
  'show-location',
  'out-of-bounds',
  'circular',
  'vertical',
  'indicator-dots',
  'active',
  'show-info',
  'scroll-x',
  'scroll-y',
  'scroll-with-animation',
  'show',
  'overlay',
  'selectable',
  'user-select',
  'decode',
  'plain',
  'read-only',
  'disable-context-menu'
]);
const enabledByDefault = new Set(['controls', 'overlay', 'show-progress', 'show-fullscreen-btn', 'show-play-btn', 'show-center-play-btn', 'enable-scroll', 'enable-zoom']);
const buttonBooleans = new Set(['disabled', 'loading', 'plain']);
const bindings = new WeakMap<Element, Map<string, { value: unknown; text: string | null }>>();

export function setBoundAttribute(el: Element, name: string, value: unknown, text: string | null) {
  let values = bindings.get(el);
  if (!values) bindings.set(el, (values = new Map()));
  values.set(name, { value, text });
}

export function boundAttribute(el: Element, name: string) {
  const text = el.getAttribute(name);
  const binding = bindings.get(el)?.get(name);
  return binding && binding.text === text ? binding.value : text;
}

export function hasBoundAttribute(el: Element, name: string): boolean {
  const binding = bindings.get(el)?.get(name);
  return !!binding && binding.text === el.getAttribute(name);
}

export function writeBooleanAttribute(el: Element, name: string, value: unknown): boolean {
  if (!booleans.has(name)) return false;
  if (value) el.setAttribute(name, '');
  else if (enabledByDefault.has(name)) el.setAttribute(name, 'false');
  else el.removeAttribute(name);
  setBoundAttribute(el, name, value, el.getAttribute(name));
  return true;
}

export function booleanProperty(el: Element, name: string): boolean | undefined {
  const attr = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  if (!booleans.has(attr)) return undefined;
  const observed: string[] = (el.constructor as any).observedAttributes ?? [];
  if (attr !== 'hidden' && !observed.includes(attr) && !(el.tagName === 'WX-BUTTON' && buttonBooleans.has(attr))) return undefined;
  const value = el.getAttribute(attr);
  if (value === null && attr === 'controls' && el.tagName === 'WX-AUDIO') return false;
  return value === null ? enabledByDefault.has(attr) : value !== 'false';
}

