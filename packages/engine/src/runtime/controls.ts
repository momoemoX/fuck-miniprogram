/**
 * 基础库内置组件（表单、滚动、展示类）
 *
 * 与 native.ts 里的媒体组件分开：这里都是布局 / 表单语义的组件，
 * 行为按微信文档实现（事件 detail、受控属性、表单收集规则）。
 */

import { eventOwner } from './events';
import { cloneData } from './definition';
import { boundAttribute, hasBoundAttribute } from './attributes';
import { normalizeSize } from './geometry';
import { logicalElements, logicalParent } from './hosts';

const elementStates = {
  bound: new WeakSet<Element>(),
  ready: new WeakSet<Element>()
};

function fire(el: Element, type: string, detail: any = {}) {
  el.dispatchEvent(new CustomEvent(type, { detail }));
}

function parseJson(value: string | null, fallback: any) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boolAttr(el: Element, name: string): boolean {
  const value = el.getAttribute(name);
  return value !== null && value !== 'false';
}

function numberAttr(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function sizeAttr(el: Element, name: string, fallback: number): number {
  return el.hasAttribute(name) || hasBoundAttribute(el, name) ? normalizeSize(boundAttribute(el, name)) : fallback;
}

/* ------------------------------------------------------------- scroll-view */

class WxScrollView extends HTMLElement {
  static get observedAttributes() {
    return ['scroll-x', 'scroll-y', 'scroll-top', 'scroll-left', 'scroll-into-view', 'scroll-with-animation'];
  }

  private lastTop = 0;
  private lastLeft = 0;
  private upperLocked = { x: true, y: true };
  private lowerLocked = { x: false, y: false };
  private bound = false;

  connectedCallback() {
    if (this.bound) return;
    this.bound = true;
    this.addEventListener('scroll', () => this.onScroll(), { passive: true });
    queueMicrotask(() => this.applyScrollPosition());
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === 'scroll-into-view' && value) {
      const target = this.querySelector(`#${CSS.escape(value)}`) as HTMLElement | null;
      if (target) {
        const smooth = boolAttr(this, 'scroll-with-animation');
        this.scrollTo({
          top: target.offsetTop,
          left: target.offsetLeft,
          behavior: smooth ? 'smooth' : 'auto'
        });
      }
      return;
    }
    if (name === 'scroll-top' || name === 'scroll-left') {
      queueMicrotask(() => this.applyScrollPosition(name));
    }
  }

  private applyScrollPosition(attribute?: string) {
    const top = attribute === 'scroll-left' ? NaN : sizeAttr(this, 'scroll-top', NaN);
    const left = attribute === 'scroll-top' ? NaN : sizeAttr(this, 'scroll-left', NaN);
    const smooth = boolAttr(this, 'scroll-with-animation');
    if (Number.isFinite(top) && Math.abs(top - this.scrollTop) > 0.5) {
      this.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
    }
    if (Number.isFinite(left) && Math.abs(left - this.scrollLeft) > 0.5) {
      this.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    }
  }

  private onScroll() {
    const top = this.scrollTop;
    const left = this.scrollLeft;
    const upper = sizeAttr(this, 'upper-threshold', 50);
    const lower = sizeAttr(this, 'lower-threshold', 50);

    const deltaX = this.lastLeft - left;
    const deltaY = this.lastTop - top;
    if (!deltaX && !deltaY) return;
    this.lastTop = top;
    this.lastLeft = left;
    fire(this, 'wx-scroll', {
      scrollTop: top,
      scrollLeft: left,
      scrollHeight: this.scrollHeight,
      scrollWidth: this.scrollWidth,
      deltaX,
      deltaY
    });

    for (const axis of ['x', 'y'] as const) {
      const delta = axis === 'x' ? deltaX : deltaY;
      if (!delta || !boolAttr(this, `scroll-${axis}`)) continue;
      const position = axis === 'x' ? left : top;
      const remaining = axis === 'x' ? this.scrollWidth - this.clientWidth - left : this.scrollHeight - this.clientHeight - top;
      const atUpper = position <= upper;
      const atLower = remaining <= lower;
      if (atUpper && !this.upperLocked[axis]) fire(this, 'scrolltoupper', { direction: axis === 'x' ? 'left' : 'top' });
      if (atLower && !this.lowerLocked[axis]) fire(this, 'scrolltolower', { direction: axis === 'x' ? 'right' : 'bottom' });
      this.upperLocked[axis] = atUpper;
      this.lowerLocked[axis] = atLower;
    }
  }

  /** ScrollViewContext */
  scrollTo(options: any = {}) {
    const top = options.scrollTop ?? options.top;
    const left = options.scrollLeft ?? options.left;
    const smooth = options.animated ?? options.behavior === 'smooth';
    super.scrollTo({
      ...(top === undefined ? {} : { top: Number(top) }),
      ...(left === undefined ? {} : { left: Number(left) }),
      behavior: smooth ? 'smooth' : 'auto'
    });
    options.success?.({ errMsg: 'scrollTo:ok' });
    options.complete?.({ errMsg: 'scrollTo:ok' });
  }

  scrollIntoView(id?: string | boolean | ScrollIntoViewOptions, options: any = {}) {
    if (typeof id !== 'string') return super.scrollIntoView(id);
    const target = this.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
    if (target) this.scrollTo({ top: target.offsetTop, left: target.offsetLeft, animated: options.animated });
  }
}

/* ---------------------------------------------------------------- button */

class WxButton extends HTMLElement {
  private bound = false;

  connectedCallback() {
    if (this.bound) return;
    this.bound = true;
    this.setAttribute('role', 'button');
    this.addEventListener('click', event => this.onClick(event));
  }

  private onClick(event: MouseEvent) {
    if (boolAttr(this, 'disabled') || this.hasAttribute('loading')) {
      event.stopPropagation();
      return;
    }

    const formType = this.getAttribute('form-type');
    if (formType) {
      const form = findForm(this, true) as any;
      if (form) {
        event.stopPropagation();
        if (formType === 'submit') form.submit();
        else if (formType === 'reset') form.reset();
        return;
      }
    }

    const openType = this.getAttribute('open-type');
    if (!openType) return;
    const wx = (globalThis as any).wx;
    if (!wx) return;

    switch (openType) {
      case 'share':
        fire(this, 'share', {});
        break;
      case 'getUserInfo':
        wx.getUserInfo({
          withCredentials: this.hasAttribute('with-credentials'),
          success: (res: any) => fire(this, 'getuserinfo', res),
          fail: (res: any) => fire(this, 'getuserinfo', res)
        });
        break;
      case 'getPhoneNumber':
        fire(this, 'getphonenumber', { code: 'fmp-phone-code', errMsg: 'getPhoneNumber:ok' });
        break;
      case 'getRealtimePhoneNumber':
        fire(this, 'getrealtimephonenumber', { code: 'fmp-phone-code', errMsg: 'ok' });
        break;
      case 'contact':
        fire(this, 'contact', { errMsg: 'contact:ok' });
        break;
      case 'openSetting':
        wx.openSetting({ success: (res: any) => fire(this, 'opensetting', res) });
        break;
      case 'chooseAvatar': {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) return;
          fire(this, 'chooseavatar', { avatarUrl: URL.createObjectURL(file) });
        };
        input.click();
        break;
      }
      case 'feedback':
        fire(this, 'feedback', {});
        break;
      case 'agreePrivacy':
        fire(this, 'agreeprivacyauthorization', { errMsg: 'agreePrivacyAuthorization:ok' });
        break;
      default:
        fire(this, openType, {});
    }
  }
}

/* ------------------------------------------------------------------ form */

const FORM_CONTROLS = 'wx-input, wx-textarea, wx-switch, wx-slider, wx-checkbox-group, wx-radio-group, wx-picker, wx-editor';

function findForm(el: Element, button = false): Element | null {
  for (let form = logicalParent(el); form; form = logicalParent(form)) {
    if (form.tagName !== 'WX-FORM') continue;
    const target = eventOwner(form);
    let owner = eventOwner(el);
    while (owner && owner !== target) {
      if (!owner.hasBehavior?.('wx://form-field-group') && !(button && owner.hasBehavior?.('wx://form-field-button'))) break;
      owner = owner.__owner;
    }
    if (owner === target) return form;
  }
  return null;
}

function formFields(form: Element) {
  return logicalElements(form).filter(
    el => (el.matches(FORM_CONTROLS) || (el as any).__wxComponent?.hasBehavior('wx://form-field')) && findForm(el) === form
  );
}

function fieldName(el: Element) {
  const component = (el as any).__wxComponent;
  return component?.hasBehavior('wx://form-field') ? component.data.name : el.getAttribute('name');
}

function readValue(el: any): any {
  if (el.__wxComponent?.hasBehavior('wx://form-field')) return cloneData(el.__wxComponent.data.value);
  if (el.tagName === 'WX-CHECKBOX-GROUP') return el.__value?.() ?? [];
  if (el.tagName === 'WX-RADIO-GROUP') return el.__value?.() ?? '';
  if (el.tagName === 'WX-SWITCH') return boolAttr(el, 'checked');
  if (el.tagName === 'WX-SLIDER') return numberAttr(el, 'value', 0);
  if (el.tagName === 'WX-PICKER') return el.__value?.() ?? el.getAttribute('value') ?? '';
  if (el.tagName === 'WX-INPUT' || el.tagName === 'WX-TEXTAREA' || el.tagName === 'WX-EDITOR') {
    const inner = el.querySelector('input, textarea, [contenteditable]') as HTMLInputElement | null;
    return inner?.value ?? inner?.textContent ?? '';
  }
  return el.getAttribute('value') ?? '';
}

class WxForm extends HTMLElement {
  private collect(): Record<string, any> {
    const value: Record<string, any> = Object.create(null);
    for (const el of formFields(this)) {
      const name = fieldName(el);
      if (!name) continue;
      value[name] = readValue(el);
    }
    return value;
  }

  submit() {
    fire(this, 'submit', { value: this.collect() });
  }

  reset() {
    for (const el of formFields(this) as any[]) {
      if (!el.matches(FORM_CONTROLS) || eventOwner(el) !== eventOwner(this)) continue;
      if (el.tagName === 'WX-CHECKBOX-GROUP') el.__setValue?.([]);
      else if (el.tagName === 'WX-RADIO-GROUP') el.__setValue?.('');
      else if (el.tagName === 'WX-SWITCH') el.removeAttribute('checked');
      else if (el.tagName === 'WX-SLIDER') el.setAttribute('value', String(numberAttr(el, 'min', 0)));
      else if (el.tagName === 'WX-PICKER') el.__reset?.();
      else if (el.tagName === 'WX-INPUT' || el.tagName === 'WX-TEXTAREA') el.__reset?.();
      else el.setAttribute('value', '');
    }
    fire(this, 'reset', {});
  }
}

/* ----------------------------------------------------------------- label */

class WxLabel extends HTMLElement {
  connectedCallback() {
    if (elementStates.bound.has(this)) return;
    elementStates.bound.add(this);
    this.addEventListener('click', () => {
      const id = this.getAttribute('for');
      const target = id
        ? (this.getRootNode() as Document | ShadowRoot).querySelector(`#${CSS.escape(id)}`)
        : this.querySelector('wx-checkbox, wx-radio, wx-input, wx-textarea, wx-switch, wx-slider');
      if (!target) return;
      if (target.tagName === 'WX-CHECKBOX' || target.tagName === 'WX-RADIO' || target.tagName === 'WX-SWITCH') {
        (target as any).toggle?.();
      } else {
        const inner = target.querySelector('input, textarea') as HTMLElement | null;
        (inner ?? (target as HTMLElement)).focus?.();
      }
    });
  }
}

/* -------------------------------------------------------------- checkbox */

class WxCheckbox extends HTMLElement {
  connectedCallback() {
    if (elementStates.bound.has(this)) return;
    elementStates.bound.add(this);
    this.setAttribute('role', 'checkbox');
    if (!this.querySelector('.wx-checkbox-box')) {
      const box = document.createElement('span');
      box.className = 'wx-checkbox-box';
      this.insertBefore(box, this.firstChild);
    }
    this.sync();
    this.addEventListener('click', event => {
      event.stopPropagation();
      this.toggle();
    });
  }

  static get observedAttributes() {
    return ['checked', 'disabled'];
  }

  attributeChangedCallback() {
    this.sync();
  }

  private sync() {
    const checked = boolAttr(this, 'checked');
    this.setAttribute('aria-checked', String(checked));
    this.classList.toggle('is-checked', checked);
    this.classList.toggle('is-disabled', boolAttr(this, 'disabled'));
  }

  get value(): string {
    return this.getAttribute('value') ?? '';
  }

  get checked(): boolean {
    return boolAttr(this, 'checked');
  }

  toggle() {
    if (boolAttr(this, 'disabled')) return;
    const group = this.closest('wx-checkbox-group') as any;
    if (group) {
      group.__toggle(this);
      return;
    }
    if (this.checked) this.removeAttribute('checked');
    else this.setAttribute('checked', '');
    fire(this, 'change', { value: this.checked });
  }
}

class WxCheckboxGroup extends HTMLElement {
  connectedCallback() {
    if (elementStates.bound.has(this)) return;
    elementStates.bound.add(this);
    if (this.hasAttribute('value')) this.__setValue(parseJson(this.getAttribute('value'), []));
  }

  static get observedAttributes() {
    return ['value'];
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === 'value') this.__setValue(parseJson(value, []));
  }

  __setValue(value: string[]) {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    for (const child of Array.from(this.querySelectorAll('wx-checkbox'))) {
      if (child.closest('wx-checkbox-group') !== this) continue;
      if (selected.has((child as any).value)) child.setAttribute('checked', '');
      else child.removeAttribute('checked');
    }
  }

  __toggle(child: Element) {
    if (boolAttr(child, 'checked')) child.removeAttribute('checked');
    else child.setAttribute('checked', '');
    fire(this, 'change', { value: this.__value() });
  }

  __value(): string[] {
    return Array.from(this.querySelectorAll('wx-checkbox'))
      .filter(child => child.closest('wx-checkbox-group') === this && boolAttr(child, 'checked'))
      .map(child => (child as any).value);
  }
}

/* ----------------------------------------------------------------- radio */

class WxRadio extends HTMLElement {
  connectedCallback() {
    if (elementStates.bound.has(this)) return;
    elementStates.bound.add(this);
    this.setAttribute('role', 'radio');
    if (!this.querySelector('.wx-radio-box')) {
      const box = document.createElement('span');
      box.className = 'wx-radio-box';
      this.insertBefore(box, this.firstChild);
    }
    this.sync();
    this.addEventListener('click', event => {
      event.stopPropagation();
      this.toggle();
    });
  }

  static get observedAttributes() {
    return ['checked', 'disabled'];
  }

  attributeChangedCallback() {
    this.sync();
  }

  private sync() {
    const checked = boolAttr(this, 'checked');
    this.setAttribute('aria-checked', String(checked));
    this.classList.toggle('is-checked', checked);
    this.classList.toggle('is-disabled', boolAttr(this, 'disabled'));
  }

  get value(): string {
    return this.getAttribute('value') ?? '';
  }

  get checked(): boolean {
    return boolAttr(this, 'checked');
  }

  toggle() {
    if (boolAttr(this, 'disabled') || this.checked) return;
    const group = this.closest('wx-radio-group') as any;
    if (group) {
      group.__select(this);
      return;
    }
    this.setAttribute('checked', '');
    fire(this, 'change', { value: this.value });
  }
}

class WxRadioGroup extends HTMLElement {
  connectedCallback() {
    if (elementStates.bound.has(this)) return;
    elementStates.bound.add(this);
    if (this.hasAttribute('value')) this.__setValue(this.getAttribute('value') ?? '');
  }

  static get observedAttributes() {
    return ['value'];
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === 'value') this.__setValue(value ?? '');
  }

  __setValue(value: string) {
    const selected = value == null ? '' : String(value);
    let chosen = false;
    for (const child of Array.from(this.querySelectorAll('wx-radio'))) {
      if (child.closest('wx-radio-group') !== this) continue;
      if (!chosen && selected && (child as any).value === selected) {
        child.setAttribute('checked', '');
        chosen = true;
      } else child.removeAttribute('checked');
    }
  }

  __select(selected: Element) {
    for (const child of Array.from(this.querySelectorAll('wx-radio'))) {
      if (child.closest('wx-radio-group') !== this) continue;
      if (child === selected) child.setAttribute('checked', '');
      else child.removeAttribute('checked');
    }
    fire(this, 'change', { value: this.__value() });
  }

  __value(): string {
    const child = Array.from(this.querySelectorAll('wx-radio')).find(
      child => child.closest('wx-radio-group') === this && boolAttr(child, 'checked')
    );
    return (child as any)?.value ?? '';
  }
}

/* ------------------------------------------------------------------ icon */

const ICONS: Record<string, string> = {
  success:
    '<path d="M4 12.5 9 17.5 20 6.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
  success_no_circle:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M7.5 12.5 10.5 15.5 16.5 8.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  info: '<circle cx="12" cy="12" r="9.5" fill="currentColor"/><path d="M12 7.2v1.6M12 11v6" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>',
  warn: '<circle cx="12" cy="12" r="9.5" fill="currentColor"/><path d="M12 6.8v6.4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17" r="1.4" fill="#fff"/>',
  waiting:
    '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="14 10" stroke-linecap="round"/>',
  cancel:
    '<circle cx="12" cy="12" r="9.5" fill="currentColor"/><path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  download:
    '<path d="M12 4v11m0 0 4.5-4.5M12 15 7.5 10.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  search:
    '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="m16 16 5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  clear:
    '<circle cx="12" cy="12" r="9.5" fill="currentColor"/><path d="M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  circle: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/>'
};

class WxIcon extends HTMLElement {
  static get observedAttributes() {
    return ['type', 'size', 'color'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  private render() {
    const type = this.getAttribute('type') ?? 'success';
    const size = numberAttr(this, 'size', 23);
    const color = this.getAttribute('color') ?? '';
    this.style.display = 'inline-block';
    this.style.width = `${size}px`;
    this.style.height = `${size}px`;
    if (color) this.style.color = color;
    this.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">${ICONS[type] ?? ICONS.success}</svg>`;
  }
}

/* -------------------------------------------------------------- progress */

class WxProgress extends HTMLElement {
  static get observedAttributes() {
    return ['percent', 'stroke-width', 'active-color', 'background-color', 'show-info', 'active', 'active-mode'];
  }

  connectedCallback() {
    if (!this.querySelector('.wx-progress-bar')) {
      this.innerHTML = '<div class="wx-progress-track"><div class="wx-progress-bar"></div></div><span class="wx-progress-info"></span>';
    }
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  private render() {
    const percent = Math.min(100, Math.max(0, numberAttr(this, 'percent', 0)));
    const height = numberAttr(this, 'stroke-width', 6);
    const active = this.getAttribute('active-color') ?? '#09bb07';
    const background = this.getAttribute('background-color') ?? '#ebebeb';
    const track = this.querySelector('.wx-progress-track') as HTMLElement;
    const bar = this.querySelector('.wx-progress-bar') as HTMLElement;
    const info = this.querySelector('.wx-progress-info') as HTMLElement;
    if (!track || !bar || !info) return;
    track.style.cssText = `height:${height}px;background:${background};border-radius:${height}px;overflow:hidden;`;
    bar.style.cssText = `width:${percent}%;height:100%;background:${active};border-radius:${height}px;`;
    if (boolAttr(this, 'active')) {
      bar.style.backgroundImage = `linear-gradient(45deg, rgba(255,255,255,.35) 25%, transparent 25%, transparent 50%, rgba(255,255,255,.35) 50%, rgba(255,255,255,.35) 75%, transparent 75%)`;
      bar.style.backgroundSize = '20px 20px';
      bar.style.animation = 'wx-progress-move 1s linear infinite';
    }
    info.textContent = boolAttr(this, 'show-info') ? `${percent}%` : '';
    info.style.display = boolAttr(this, 'show-info') ? 'block' : 'none';
  }
}

/* ------------------------------------------------------------ rich-text */

const RICH_TAGS = new Set(
  'a abbr b blockquote br code col colgroup dd del div dl dt em fieldset font h1 h2 h3 h4 h5 h6 hr i img ins label legend li ol p q span strong sub sup table tbody td tfoot th thead tr u ul'.split(
    ' '
  )
);

function richTextContent(value: unknown) {
  const decoder = document.createElement('textarea');
  decoder.innerHTML = String(value ?? '');
  return decoder.value;
}

class WxRichText extends HTMLElement {
  static get observedAttributes() {
    return ['nodes', 'user-select'];
  }

  connectedCallback() {
    if (!elementStates.bound.has(this)) {
      elementStates.bound.add(this);
      this.addEventListener('click', event => {
        const target = event.target as Element;
        if (target.closest('a')) event.preventDefault();
      });
    }
    this.render();
  }

  attributeChangedCallback(name: string) {
    if (name === 'nodes') this.render();
  }

  private render() {
    const nodes = boundAttribute(this, 'nodes');
    if (typeof nodes === 'string') {
      this.innerHTML = sanitize(nodes);
      return;
    }
    if (!Array.isArray(nodes)) {
      this.replaceChildren();
      return;
    }
    this.replaceChildren(...nodes.map((node: any) => buildNode(node)));
  }
}

function buildNode(node: any): Node {
  if (node == null) return document.createTextNode('');
  if (typeof node !== 'object') return document.createTextNode('');
  if (node.type === 'text') return document.createTextNode(richTextContent(node.text));
  if (typeof node.name !== 'string' || !RICH_TAGS.has(node.name.toLowerCase())) return document.createTextNode('');
  const el = document.createElement(node.name);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (/^on/i.test(key)) continue;
    if (typeof value === 'string') el.setAttribute(key, value);
    else if (value !== undefined && value !== null) el.setAttribute(key, String(value));
  }
  for (const child of node.children ?? []) el.appendChild(buildNode(child));
  return el;
}

/** rich-text 只允许基础排版标签 */
function sanitize(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) {
        if (!RICH_TAGS.has((child as Element).tagName.toLowerCase())) {
          child.remove();
          continue;
        }
        for (const attr of Array.from((child as Element).attributes)) {
          if (/^on/i.test(attr.name)) (child as Element).removeAttribute(attr.name);
        }
        walk(child);
      }
    }
  };
  walk(template.content);
  return template.innerHTML;
}

/* -------------------------------------------------------------- page-meta */

class WxPageMeta extends HTMLElement {
  private prevRootFontSize: string | null = null;
  private appliedRootFontSize = false;

  static get observedAttributes() {
    return ['background-color', 'page-style', 'root-font-size', 'scroll-top', 'page-orientation'];
  }

  connectedCallback() {
    this.prevRootFontSize = document.documentElement.style.fontSize;
    this.apply();
  }

  disconnectedCallback() {
    if (this.appliedRootFontSize) {
      document.documentElement.style.fontSize = this.prevRootFontSize ?? '';
      this.appliedRootFontSize = false;
    }
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    const page = this.closest('wx-page') as HTMLElement | null;
    if (!page) return;
    const background = this.getAttribute('background-color');
    if (background) page.style.background = background;
    const style = this.getAttribute('page-style');
    if (style) page.setAttribute('style', `${page.getAttribute('style') ?? ''};${style}`);
    const fontSize = this.getAttribute('root-font-size');
    if (fontSize) {
      page.style.fontSize = fontSize;
      document.documentElement.style.fontSize = fontSize;
      this.appliedRootFontSize = true;
    }
    const rotate = this.getAttribute('page-orientation');
    if (rotate) page.style.transform = `rotate(${rotate === 'landscape' ? 90 : 0}deg)`;
    const rawTop = this.getAttribute('scroll-top');
    if (rawTop !== null && rawTop !== '') {
      const parsed = parseFloat(rawTop);
      if (Number.isFinite(parsed)) {
        const px = rawTop.trim().endsWith('rpx') ? parsed * (window.innerWidth / 750) : parsed;
        page.scrollTop = px;
      }
    }
  }
}

/* --------------------------------------------------------- navigation-bar */

class WxNavigationBar extends HTMLElement {
  static get observedAttributes() {
    return ['title', 'background', 'color', 'loading', 'back'];
  }

  connectedCallback() {
    this.apply();
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    const wx = (globalThis as any).wx;
    if (!wx) return;
    const title = this.getAttribute('title');
    if (title) wx.setNavigationBarTitle({ title });
    const background = this.getAttribute('background');
    const color = this.getAttribute('color');
    if (background || color) {
      wx.setNavigationBarColor({
        backgroundColor: background ?? '#000000',
        frontColor: color ?? '#ffffff'
      });
    }
    if (boolAttr(this, 'loading')) wx.showNavigationBarLoading();
    else wx.hideNavigationBarLoading();
  }
}

/* --------------------------------------------------------- page-container */

class WxPageContainer extends HTMLElement {
  static get observedAttributes() {
    return ['show'];
  }

  connectedCallback() {
    this.classList.add('wx-page-container');
    this.apply();
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    const show = boolAttr(this, 'show');
    const position = this.getAttribute('position') ?? 'bottom';
    const overlay = this.getAttribute('overlay') !== 'false';
    this.setAttribute('fmp-position', position);
    this.classList.toggle('is-show', show);
    this.classList.toggle('no-overlay', !overlay);
    if (show) {
      fire(this, 'beforeenter', {});
      fire(this, 'enter', {});
      setTimeout(() => fire(this, 'afterenter', {}), 300);
    } else if (this.classList.contains('was-show')) {
      fire(this, 'beforeleave', {});
      fire(this, 'leave', {});
      setTimeout(() => fire(this, 'afterleave', {}), 300);
    }
    if (show) this.classList.add('was-show');
  }
}

/* ------------------------------------------------------------- cover-view */

class WxCoverView extends HTMLElement {}

class WxCoverImage extends HTMLElement {
  static get observedAttributes() {
    return ['src'];
  }

  connectedCallback() {
    if (!this.querySelector('img')) {
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;display:block';
      this.appendChild(img);
    }
    this.sync();
  }

  attributeChangedCallback() {
    this.sync();
  }

  private sync() {
    const img = this.querySelector('img');
    const src = this.getAttribute('src');
    if (img && src) img.src = src;
  }
}

/* --------------------------------------------------------------- open-data */

class WxOpenData extends HTMLElement {
  static get observedAttributes() {
    return ['type'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  private render() {
    const type = this.getAttribute('type') ?? '';
    const wx = (globalThis as any).wx;
    if (!type) return;
    if (type === 'userAvatarUrl') {
      wx?.getUserInfo?.({
        success: (res: any) => {
          this.innerHTML = `<img src="${res.userInfo.avatarUrl}" style="width:100%;height:100%;display:block" />`;
        }
      });
      return;
    }
    const labels: Record<string, string> = {
      userNickName: 'fmp 用户',
      userGender: '未知',
      userCity: '深圳',
      userProvince: '广东',
      userCountry: '中国',
      userLanguage: 'zh_CN'
    };
    this.textContent = labels[type] ?? '';
  }
}

/* ------------------------------------------------------------ match-media */

class WxMatchMedia extends HTMLElement {
  static get observedAttributes() {
    return ['min-width', 'max-width', 'min-height', 'max-height', 'orientation'];
  }

  connectedCallback() {
    this.apply();
    window.addEventListener('resize', () => this.apply());
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    let matched = true;
    const minWidth = numberAttr(this, 'min-width', NaN);
    const maxWidth = numberAttr(this, 'max-width', NaN);
    const minHeight = numberAttr(this, 'min-height', NaN);
    const maxHeight = numberAttr(this, 'max-height', NaN);
    if (Number.isFinite(minWidth) && width < minWidth) matched = false;
    if (Number.isFinite(maxWidth) && width > maxWidth) matched = false;
    if (Number.isFinite(minHeight) && height < minHeight) matched = false;
    if (Number.isFinite(maxHeight) && height > maxHeight) matched = false;
    const orientation = this.getAttribute('orientation');
    if (orientation === 'portrait' && width > height) matched = false;
    if (orientation === 'landscape' && height >= width) matched = false;
    this.style.display = matched ? '' : 'none';
  }
}

/* -------------------------------------------------------------- root-portal */

class WxRootPortal extends HTMLElement {
  connectedCallback() {
    queueMicrotask(() => {
      const page = this.closest('wx-page');
      if (!page || this.parentElement === page) return;
      const host = document.createElement('div');
      host.className = 'wx-root-portal';
      host.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:20';
      host.append(...Array.from(this.childNodes));
      host.querySelectorAll('*').forEach(node => ((node as HTMLElement).style.pointerEvents = 'auto'));
      page.appendChild(host);
    });
  }
}

/* ------------------------------------------------------------- live-player */

class WxLivePlayer extends HTMLElement {
  static get observedAttributes() {
    return ['src'];
  }

  connectedCallback() {
    if (!this.querySelector('video')) {
      const video = document.createElement('video');
      video.setAttribute('playsinline', '');
      video.style.cssText = 'width:100%;height:100%;display:block;background:#000';
      this.appendChild(video);
      this.sync();
    }
  }

  attributeChangedCallback() {
    this.sync();
  }

  private sync() {
    const video = this.querySelector('video');
    const src = this.getAttribute('src');
    if (video && src && video.src !== src) video.src = src;
  }
}

class WxLivePusher extends HTMLElement {
  connectedCallback() {
    if (elementStates.ready.has(this)) return;
    elementStates.ready.add(this);
    const box = document.createElement('div');
    box.className = 'wx-live-pusher-placeholder';
    box.textContent = '推流预览';
    this.appendChild(box);
  }
}

/* ------------------------------------------------------------------ misc */

class WxOfficialAccount extends HTMLElement {
  connectedCallback() {
    if (elementStates.ready.has(this)) return;
    elementStates.ready.add(this);
    this.innerHTML = '<div class="wx-official-account">关注公众号</div>';
  }
}

class WxFunctionalPageNavigator extends HTMLElement {
  connectedCallback() {
    this.style.display = 'none';
  }
}

class WxAd extends HTMLElement {
  connectedCallback() {
    if (elementStates.ready.has(this)) return;
    elementStates.ready.add(this);
    this.innerHTML = '<div class="wx-ad-placeholder">广告</div>';
  }
}

export const CONTROL_ELEMENTS: Record<string, CustomElementConstructor> = {
  'wx-scroll-view': WxScrollView,
  'wx-button': WxButton,
  'wx-form': WxForm,
  'wx-label': WxLabel,
  'wx-checkbox': WxCheckbox,
  'wx-checkbox-group': WxCheckboxGroup,
  'wx-radio': WxRadio,
  'wx-radio-group': WxRadioGroup,
  'wx-icon': WxIcon,
  'wx-progress': WxProgress,
  'wx-rich-text': WxRichText,
  'wx-page-meta': WxPageMeta,
  'wx-navigation-bar': WxNavigationBar,
  'wx-page-container': WxPageContainer,
  'wx-cover-view': WxCoverView,
  'wx-cover-image': WxCoverImage,
  'wx-open-data': WxOpenData,
  'wx-match-media': WxMatchMedia,
  'wx-root-portal': WxRootPortal,
  'wx-live-player': WxLivePlayer,
  'wx-live-pusher': WxLivePusher,
  'wx-official-account': WxOfficialAccount,
  'wx-functional-page-navigator': WxFunctionalPageNavigator,
  'wx-ad': WxAd
};

export const CONTROL_CSS = `
wx-scroll-view { position: relative; }
wx-button[loading] { color: transparent; }
wx-button[loading]::before { content: ''; position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px;
  border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: fmp-spin .8s linear infinite; color: #999; }
wx-checkbox, wx-radio { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; vertical-align: middle; }
.wx-checkbox-box, .wx-radio-box { width: 18px; height: 18px; box-sizing: border-box; border: 1px solid #d1d1d1; background: #fff; flex: none; position: relative; }
.wx-checkbox-box { border-radius: 3px; }
.wx-radio-box { border-radius: 50%; }
wx-checkbox.is-checked .wx-checkbox-box { background: #07c160; border-color: #07c160; }
wx-checkbox.is-checked .wx-checkbox-box::after { content: ''; position: absolute; left: 5px; top: 2px; width: 5px; height: 9px;
  border-right: 2px solid #fff; border-bottom: 2px solid #fff; transform: rotate(45deg); }
wx-radio.is-checked .wx-radio-box { border-color: #07c160; }
wx-radio.is-checked .wx-radio-box::after { content: ''; position: absolute; left: 4px; top: 4px; width: 8px; height: 8px; border-radius: 50%; background: #07c160; }
wx-checkbox.is-disabled, wx-radio.is-disabled { opacity: .5; }
wx-icon { display: inline-block; vertical-align: middle; }
wx-progress { display: flex; align-items: center; gap: 8px; }
.wx-progress-track { flex: 1; min-width: 0; }
.wx-progress-info { font-size: 12px; color: #666; flex: none; }
wx-rich-text { display: block; }
wx-rich-text p { margin:0; }
wx-page-meta, wx-navigation-bar { display: none; }
wx-root-portal { display: contents; }
wx-page-container { position: fixed; inset: 0; display: none; z-index: 100; }
wx-page-container.is-show { display: block; }
wx-page-container::before { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,.5); opacity: 0; transition: opacity .3s; }
wx-page-container.is-show::before { opacity: 1; }
wx-page-container.no-overlay::before { display: none; }
wx-page-container > * { position: absolute; left: 0; right: 0; bottom: 0; max-height: 80%; overflow: auto; background: #fff;
  transform: translateY(100%); transition: transform .3s; }
wx-page-container.is-show > * { transform: translateY(0); }
wx-page-container[fmp-position="top"] > * { top: 0; bottom: auto; transform: translateY(-100%); }
wx-page-container[fmp-position="top"].is-show > * { transform: translateY(0); }
wx-page-container[fmp-position="center"] > * { top: 50%; left: 50%; right: auto; bottom: auto; transform: translate(-50%, -50%) scale(.9); opacity: 0; border-radius: 12px; }
wx-page-container[fmp-position="center"].is-show > * { transform: translate(-50%, -50%) scale(1); opacity: 1; }
wx-cover-view { position: relative; z-index: 1; }
wx-cover-image { display: block; overflow: hidden; }
wx-open-data { display: inline-block; overflow: hidden; }
wx-live-player { display: block; position: relative; overflow: hidden; background: #000; }
.wx-live-pusher-placeholder { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; background: #111; color: #888; }
.wx-official-account { padding: 8px 12px; font-size: 12px; color: #576b95; background: #f7f7f7; }
.wx-ad-placeholder { display: flex; align-items: center; justify-content: center; min-height: 60px; background: #f2f2f2; color: #999; font-size: 12px; }
@keyframes wx-progress-move { from { background-position: 0 0; } to { background-position: 20px 0; } }
`;
