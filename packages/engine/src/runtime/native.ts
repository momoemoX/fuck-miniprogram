/**
 * 原生组件
 *
 * 用自定义元素实现：属性变化由浏览器回调，组件内部拿原生 DOM 元素承接，
 * 和业务代码之间只隔一层事件转发。没有用到的组件不注册，也就没有成本。
 */

import { showPicker } from './overlay';
import { REGIONS } from './region';
import { WxText } from './text';
import { WxEditor, WxEditorPortal, EDITOR_CSS } from './editor';
import { WxSelection, SELECTION_CSS } from './selection';
import { eventResult } from './events';
import { booleanProperty, boundAttribute } from './attributes';

const elementStates = {
  audioReady: new WeakSet<Element>(),
  bound: new WeakSet<Element>(),
  cameraReady: new WeakSet<Element>(),
  moveReady: new WeakSet<Element>(),
  pickerReady: new WeakSet<Element>(),
  ready: new WeakSet<Element>(),
  swiperReady: new WeakSet<Element>(),
  videoReady: new WeakSet<Element>(),
  viewReady: new WeakSet<Element>()
};

let navigate: (url: string, openType: string) => void = () => {};

export function setNavigator(fn: (url: string, openType: string) => void) {
  navigate = fn;
}

const IMAGE_FIT: Record<string, string> = {
  scaleToFill: 'fill',
  aspectFit: 'contain',
  aspectFill: 'cover',
  widthFix: 'contain',
  heightFix: 'contain'
};

function maxLength(input: HTMLInputElement | HTMLTextAreaElement, value: string | null) {
  const length = value === null ? 140 : Number(value);
  if (length < 0) input.removeAttribute('maxlength');
  else input.maxLength = Number.isFinite(length) ? Math.floor(length) : 140;
}

class WxImage extends HTMLElement {
  static observedAttributes = ['src', 'mode', 'lazy-load'];
  private img = document.createElement('img');
  private bound = false;

  connectedCallback() {
    if (!this.img.parentNode) {
      this.img.setAttribute('data-fmp', 'image');
      this.appendChild(this.img);
    }
    if (!this.bound) {
      this.bound = true;
      // 官方 image 的 load / error 事件带图片尺寸或 errMsg
      this.img.addEventListener('load', () => {
        this.dispatchEvent(
          new CustomEvent('load', {
            bubbles: true,
            composed: true,
            detail: { width: this.img.naturalWidth, height: this.img.naturalHeight }
          })
        );
      });
      this.img.addEventListener('error', () => {
        this.dispatchEvent(
          new CustomEvent('error', {
            bubbles: true,
            composed: true,
            detail: { errMsg: `GET ${this.getAttribute('src') ?? ''} 404 (Not Found)` }
          })
        );
      });
    }
    this.apply();
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    const src = this.getAttribute('src') ?? '';
    if (src && this.img.getAttribute('src') !== src) this.img.src = src;
    const mode = this.getAttribute('mode') ?? 'scaleToFill';
    this.img.loading = this.hasAttribute('lazy-load') ? 'lazy' : 'eager';
    this.img.style.objectFit = IMAGE_FIT[mode] ?? 'fill';
    if (mode === 'widthFix') {
      this.img.style.width = '100%';
      this.img.style.height = 'auto';
    }
  }
}

class WxInput extends HTMLElement {
  static observedAttributes = ['value', 'placeholder', 'password', 'type', 'disabled', 'maxlength', 'focus'];
  private input = document.createElement('input');

  connectedCallback() {
    const initial = !this.input.parentNode;
    if (initial) {
      this.input.style.width = '100%';
      this.input.style.height = '100%';
      this.input.style.border = '0';
      this.input.style.outline = 'none';
      this.input.style.background = 'transparent';
      this.input.style.font = 'inherit';
      this.input.style.color = 'inherit';
      // 原生事件不再冒泡出去，统一换成小程序语义的 CustomEvent（带 detail.value）
      this.input.addEventListener('input', event => {
        event.stopPropagation();
        const value = this.emit('input', { value: this.input.value, cursor: this.input.selectionStart ?? this.input.value.length });
        if (typeof value === 'string') this.input.value = value;
      });
      this.input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        this.emit('confirm', { value: this.input.value });
      });
      this.input.addEventListener('focus', () => this.emit('focus', { value: this.input.value, height: 0 }));
      this.input.addEventListener('blur', () => this.emit('blur', { value: this.input.value, height: 0 }));
      this.appendChild(this.input);
    }
    this.apply(initial, initial);
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    if (previous !== value || name === 'value') this.apply(name === 'value', name === 'focus');
  }

  __reset() {
    this.setAttribute('value', '');
    this.input.value = '';
  }

  get value() {
    return this.input.value;
  }

  private emit(type: string, detail: Record<string, unknown>) {
    const event = new CustomEvent(type, { detail });
    this.dispatchEvent(event);
    return eventResult(event);
  }

  private apply(valueChanged = false, focusChanged = false) {
    if (!this.input) return;
    const value = this.getAttribute('value') ?? '';
    if (valueChanged && this.input.value !== value) this.input.value = value;
    this.input.placeholder = this.getAttribute('placeholder') ?? '';
    this.input.type = this.getAttribute('password') !== null ? 'password' : this.getAttribute('type') || 'text';
    this.input.disabled = this.getAttribute('disabled') !== null;
    maxLength(this.input, this.getAttribute('maxlength'));
    if (focusChanged && this.getAttribute('focus') !== null) this.input.focus();
  }
}

class WxTextarea extends HTMLElement {
  static observedAttributes = ['value', 'placeholder', 'disabled', 'maxlength', 'auto-height'];
  private area = document.createElement('textarea');

  get value() {
    return this.area.value;
  }

  connectedCallback() {
    const initial = !this.area.parentNode;
    if (initial) {
      this.area.style.cssText =
        'width:100%;height:100%;border:0;outline:none;background:transparent;font:inherit;color:inherit;resize:none';
      this.area.addEventListener('input', event => {
        event.stopPropagation();
        const value = this.emit('input', { value: this.area.value, cursor: this.area.selectionStart ?? this.area.value.length });
        if (typeof value === 'string') this.area.value = value;
        this.resize();
      });
      this.area.addEventListener('focus', () => this.emit('focus', { value: this.area.value, height: 0 }));
      this.area.addEventListener('blur', () => this.emit('blur', { value: this.area.value, height: 0 }));
      this.appendChild(this.area);
    }
    this.apply(initial);
  }

  private emit(type: string, detail: Record<string, unknown>) {
    const event = new CustomEvent(type, { detail });
    this.dispatchEvent(event);
    return eventResult(event);
  }

  /** auto-height：输入时按内容撑高 */
  private resize() {
    if (!this.hasAttribute('auto-height')) return;
    this.area.style.height = 'auto';
    this.area.style.height = `${this.area.scrollHeight}px`;
    this.style.height = `${this.area.scrollHeight}px`;
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    if (previous !== value || name === 'value') this.apply(name === 'value');
  }

  __reset() {
    this.setAttribute('value', '');
    this.area.value = '';
    this.resize();
  }

  private apply(valueChanged = false) {
    if (!this.area) return;
    const value = this.getAttribute('value') ?? '';
    if (valueChanged && this.area.value !== value) this.area.value = value;
    this.area.placeholder = this.getAttribute('placeholder') ?? '';
    this.area.disabled = this.getAttribute('disabled') !== null;
    maxLength(this.area, this.getAttribute('maxlength'));
    this.resize();
  }
}

class WxSwitch extends HTMLElement {
  static observedAttributes = ['checked', 'disabled', 'color'];
  private box = document.createElement('input');

  connectedCallback() {
    if (!this.box.parentNode) {
      this.box.type = 'checkbox';
      this.box.style.cssText = 'width:44px;height:26px;accent-color:var(--wx-switch-color, #07c160)';
      this.box.addEventListener('change', event => {
        event.stopPropagation();
        this.toggleAttribute('checked', this.box.checked);
        this.dispatchEvent(new CustomEvent('change', { detail: { value: this.box.checked }, bubbles: true }));
      });
      this.appendChild(this.box);
    }
    this.apply();
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    if (!this.box) return;
    this.box.checked = this.getAttribute('checked') !== null;
    this.box.disabled = this.getAttribute('disabled') !== null;
    const color = this.getAttribute('color');
    if (color) this.style.setProperty('--wx-switch-color', color);
  }
}

class WxSlider extends HTMLElement {
  static observedAttributes = ['value', 'min', 'max', 'step', 'disabled', 'activecolor'];
  private range = document.createElement('input');

  connectedCallback() {
    if (!this.range.parentNode) {
      this.range.type = 'range';
      this.range.style.width = '100%';
      this.range.addEventListener('change', event => {
        event.stopPropagation();
        this.setAttribute('value', this.range.value);
        this.dispatchEvent(new CustomEvent('change', { detail: { value: Number(this.range.value) } }));
      });
      this.appendChild(this.range);
    }
    this.apply();
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    if (!this.range) return;
    this.range.min = this.getAttribute('min') ?? '0';
    this.range.max = this.getAttribute('max') ?? '100';
    this.range.step = this.getAttribute('step') ?? '1';
    const value = this.getAttribute('value');
    if (value !== null && this.range.value !== value) this.range.value = value;
    this.range.disabled = this.getAttribute('disabled') !== null;
  }
}

/** devtools 无摄像头：灰底占位 + 「未找到摄像头」，并让页面收到 error，与官方基础库一致 */
class WxCamera extends HTMLElement {
  connectedCallback() {
    if (elementStates.cameraReady.has(this)) return;
    elementStates.cameraReady.add(this);
    const view = document.createElement('div');
    view.className = 'wx-camera-placeholder';
    view.textContent = '未找到摄像头';
    this.appendChild(view);
    setTimeout(() => {
      this.dispatchEvent(new CustomEvent('error', { detail: { errMsg: '未找到摄像头' } }));
    }, 0);
  }
}

/** 属性里存的 JSON（picker 的 range / value 可能是数组） */
function jsonAttr(el: Element, name: string, fallback: any) {
  const raw = el.getAttribute(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

/** picker：点击弹出滚轮选择器，change 事件的 detail.value 按模式给出索引或字符串 */
class WxPicker extends HTMLElement {
  static observedAttributes = ['mode', 'range', 'range-key', 'value', 'start', 'end', 'fields', 'level', 'custom-item'];
  private selectedValue?: { value: unknown };

  connectedCallback() {
    if (elementStates.pickerReady.has(this)) return;
    elementStates.pickerReady.add(this);
    this.addEventListener('click', () => {
      if (this.getAttribute('disabled') !== null) return;
      this.open();
    });
  }

  __value() {
    if (this.selectedValue) return this.selectedValue.value;
    const mode = this.getAttribute('mode') ?? 'selector';
    return mode === 'multiSelector' || mode === 'region' ? jsonAttr(this, 'value', []) : (this.getAttribute('value') ?? '');
  }

  __reset() {
    const mode = this.getAttribute('mode') ?? 'selector';
    this.setValue(mode === 'selector' ? -1 : mode === 'multiSelector' || mode === 'region' ? [] : '');
  }

  attributeChangedCallback(name: string) {
    if (name === 'value') this.selectedValue = undefined;
  }

  private setValue(value: unknown) {
    this.setAttribute('value', typeof value === 'string' ? value : JSON.stringify(value));
    this.selectedValue = { value };
  }

  private emit(type: string, detail: Record<string, unknown>) {
    if (type === 'change') this.setValue(detail.value);
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private overlay(): HTMLElement | null {
    return document.querySelector('.fmp-overlay');
  }

  private open() {
    const overlay = this.overlay();
    if (!overlay) return;
    const mode = this.getAttribute('mode') ?? 'selector';
    const headerText = this.getAttribute('header-text') ?? '';

    if (mode === 'time') {
      this.openTime(overlay, headerText);
      return;
    }
    if (mode === 'date') {
      this.openDate(overlay, headerText);
      return;
    }
    if (mode === 'region') {
      this.openRegion(overlay, headerText);
      return;
    }

    const range = jsonAttr(this, 'range', []) as any[];
    const rangeKey = this.getAttribute('range-key');
    const label = (item: any) => (item && typeof item === 'object' && rangeKey ? String(item[rangeKey] ?? '') : String(item ?? ''));

    if (mode === 'multiSelector') {
      const columns = (range as any[][]).map(column => ({ values: (column ?? []).map(label) }));
      const current = (jsonAttr(this, 'value', []) as number[]) ?? [];
      const session = showPicker(overlay, {
        title: headerText,
        columns: columns.map((column, index) => ({ ...column, defaultIndex: current[index] ?? 0 })),
        onColumnChange: (columnIndex, valueIndex) => {
          this.emit('columnchange', { column: columnIndex, value: valueIndex });
          // 父级 setData 更新 range 后再刷新后续列
          setTimeout(() => {
            const next = jsonAttr(this, 'range', []) as any[][];
            const selected = jsonAttr(this, 'value', []) as number[];
            session.update(
              next.map(column => ({ values: (column ?? []).map(label) })),
              selected
            );
          }, 30);
        },
        onConfirm: indexes => this.emit('change', { value: indexes }),
        onCancel: () => this.emit('cancel', {})
      });
      return;
    }

    const values = (range as any[]).map(label);
    const index = Number(jsonAttr(this, 'value', 0)) || 0;
    showPicker(overlay, {
      title: headerText,
      columns: [{ values, defaultIndex: index }],
      onConfirm: ([selected]) => this.emit('change', { value: selected }),
      onCancel: () => this.emit('cancel', {})
    });
  }

  private openTime(overlay: HTMLElement, title: string) {
    const current = (this.getAttribute('value') || '00:00').split(':').map(Number);
    const parse = (text: string | null, fallback: number) => {
      const [hour, minute] = (text ?? '').split(':').map(Number);
      return { hour: Number.isFinite(hour) ? hour : fallback, minute: Number.isFinite(minute) ? minute : 0 };
    };
    const start = parse(this.getAttribute('start'), 0);
    const end = parse(this.getAttribute('end'), 23);

    const hours: string[] = [];
    for (let hour = start.hour; hour <= end.hour; hour++) hours.push(pad2(hour));

    showPicker(overlay, {
      title,
      columns: [
        { values: hours, defaultIndex: Math.max(0, hours.indexOf(pad2(current[0] || 0))) },
        {
          values: Array.from({ length: 60 }, (_, minute) => pad2(minute)),
          defaultIndex: Number.isFinite(current[1]) ? current[1] : 0
        }
      ],
      onConfirm: ([hourIndex, minuteIndex]) => {
        this.emit('change', { value: `${hours[hourIndex] ?? '00'}:${pad2(minuteIndex ?? 0)}` });
      },
      onCancel: () => this.emit('cancel', {})
    });
  }

  private openDate(overlay: HTMLElement, title: string) {
    const fields = this.getAttribute('fields') ?? 'day';
    const value = this.getAttribute('value') || '2026-01-01';
    const [year, month, day] = value.split('-').map(Number);
    const start = (this.getAttribute('start') || '1900-01-01').split('-').map(Number);
    const end = (this.getAttribute('end') || '2100-12-31').split('-').map(Number);

    const years: string[] = [];
    for (let y = start[0]; y <= end[0]; y++) years.push(String(y));
    const months = Array.from({ length: 12 }, (_, index) => pad2(index + 1));
    const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();
    const days = Array.from({ length: daysInMonth(year, month) }, (_, index) => pad2(index + 1));

    const columns =
      fields === 'year'
        ? [{ values: years, defaultIndex: Math.max(0, years.indexOf(String(year))) }]
        : fields === 'month'
          ? [
              { values: years, defaultIndex: Math.max(0, years.indexOf(String(year))) },
              { values: months, defaultIndex: month - 1 }
            ]
          : [
              { values: years, defaultIndex: Math.max(0, years.indexOf(String(year))) },
              { values: months, defaultIndex: month - 1 },
              { values: days, defaultIndex: day - 1 }
            ];

    const session = showPicker(overlay, {
      title,
      columns,
      onColumnChange: (columnIndex, valueIndex) => {
        if (fields !== 'day' || columnIndex > 1) return;
        const nextYear = Number(years[valueIndex] ?? year);
        const nextMonth = columnIndex === 1 ? valueIndex + 1 : month;
        const nextDays = Array.from({ length: daysInMonth(nextYear, nextMonth) }, (_, index) => pad2(index + 1));
        setTimeout(() => {
          session.update(
            [
              { values: years, defaultIndex: Math.max(0, years.indexOf(String(nextYear))) },
              { values: months, defaultIndex: nextMonth - 1 },
              { values: nextDays, defaultIndex: 0 }
            ],
            [Math.max(0, years.indexOf(String(nextYear))), nextMonth - 1, 0]
          );
        }, 30);
      },
      onConfirm: indexes => {
        const y = years[indexes[0]] ?? String(year);
        const m = months[indexes[1] ?? 0] ?? pad2(month);
        const d = days[indexes[2] ?? 0] ?? pad2(day);
        this.emit('change', { value: fields === 'year' ? y : fields === 'month' ? `${y}-${m}` : `${y}-${m}-${d}` });
      },
      onCancel: () => this.emit('cancel', {})
    });
  }

  private openRegion(overlay: HTMLElement, title: string) {
    const level = this.getAttribute('level') ?? 'region';
    const custom = this.getAttribute('custom-item');
    const current = (jsonAttr(this, 'value', []) as string[]) ?? [];

    const provinces = REGIONS;
    const provinceIndex = Math.max(
      0,
      provinces.findIndex(province => province.name === current[0])
    );
    const cities = provinces[provinceIndex]?.children ?? [];
    const cityIndex = Math.max(
      0,
      cities.findIndex(city => city.name === current[1])
    );
    const districts = cities[cityIndex]?.children ?? [];
    const districtIndex = Math.max(
      0,
      districts.findIndex(district => district.name === current[2])
    );

    const names = (nodes: { name: string }[]) => nodes.map(node => node.name);
    const withCustom = (list: string[]) => (custom ? [custom, ...list] : list);

    const columns =
      level === 'city'
        ? [
            { values: names(provinces), defaultIndex: provinceIndex },
            { values: names(cities), defaultIndex: cityIndex }
          ]
        : level === 'sub-district'
          ? [
              { values: names(provinces), defaultIndex: provinceIndex },
              { values: names(cities), defaultIndex: cityIndex },
              { values: names(districts), defaultIndex: districtIndex },
              { values: withCustom(['全部街道']), defaultIndex: 0 }
            ]
          : [
              { values: names(provinces), defaultIndex: provinceIndex },
              { values: names(cities), defaultIndex: cityIndex },
              { values: names(districts), defaultIndex: districtIndex }
            ];

    const session = showPicker(overlay, {
      title,
      columns,
      onColumnChange: (columnIndex, valueIndex) => {
        const nextProvince = columnIndex === 0 ? provinces[valueIndex] : provinces[provinceIndex];
        const nextCities = nextProvince?.children ?? [];
        const nextCity = columnIndex === 1 ? nextCities[valueIndex] : nextCities[0];
        const nextDistricts = nextCity?.children ?? [];
        setTimeout(() => {
          session.update(
            level === 'city'
              ? [
                  { values: names(provinces), defaultIndex: columnIndex === 0 ? valueIndex : provinceIndex },
                  { values: names(nextCities), defaultIndex: columnIndex === 1 ? valueIndex : 0 }
                ]
              : [
                  { values: names(provinces), defaultIndex: columnIndex === 0 ? valueIndex : provinceIndex },
                  { values: names(nextCities), defaultIndex: columnIndex === 1 ? valueIndex : 0 },
                  { values: names(nextDistricts), defaultIndex: 0 }
                ],
            [columnIndex === 0 ? valueIndex : provinceIndex, columnIndex === 1 ? valueIndex : 0, 0]
          );
        }, 30);
      },
      onConfirm: indexes => {
        const province = provinces[indexes[0]];
        const city = province?.children?.[indexes[1] ?? 0];
        const district = city?.children?.[indexes[2] ?? 0];
        const value =
          level === 'city'
            ? [province?.name, city?.name]
            : level === 'sub-district'
              ? [province?.name, city?.name, district?.name, '全部街道']
              : [province?.name, city?.name, district?.name];
        this.emit('change', { value });
      },
      onCancel: () => this.emit('cancel', {})
    });
  }
}

/** picker-view：内嵌的多列滚轮，滚动停下后触发 change */
class WxPickerView extends HTMLElement {
  static observedAttributes = ['value', 'indicator-style'];

  private timer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback() {
    if (!elementStates.viewReady.has(this)) {
      elementStates.viewReady.add(this);
      this.addEventListener('scroll', () => this.scheduleChange(), true);
      requestAnimationFrame(() => this.syncScroll());
    }
  }

  attributeChangedCallback() {
    requestAnimationFrame(() => this.syncScroll());
  }

  private itemHeight(): number {
    const style = this.getAttribute('indicator-style') ?? '';
    const match = /height:\s*([\d.]+)(rpx|px)/.exec(style);
    if (!match) return 34;
    const size = Number(match[1]);
    return match[2] === 'rpx' ? size * parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fmp-rpx') || '0.5') : size;
  }

  private columns(): HTMLElement[] {
    return Array.from(this.querySelectorAll('wx-picker-view-column')) as HTMLElement[];
  }

  private syncScroll() {
    const height = this.itemHeight();
    const values = (jsonAttr(this, 'value', []) as number[]) ?? [];
    this.columns().forEach((column, index) => {
      column.style.height = '100%';
      column.style.overflowY = 'auto';
      column.style.scrollSnapType = 'y mandatory';
      column.style.padding = `${height * 2}px 0`;
      column.style.boxSizing = 'border-box';
      column.style.scrollbarWidth = 'none';
      const target = (values[index] ?? 0) * height;
      if (Math.abs(column.scrollTop - target) > 1) column.scrollTop = target;
    });
    this.style.overflow = 'hidden';
    this.style.position = 'relative';
  }

  private scheduleChange() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const height = this.itemHeight();
      const value = this.columns().map(column => Math.round(column.scrollTop / height));
      this.dispatchEvent(new CustomEvent('change', { detail: { value } }));
    }, 120);
  }
}

/** 音频组件：默认播放器外观（封面 + 播放键 + 名称/作者/时长）对齐官方 .wx-audio-default */
class WxAudio extends HTMLElement {
  static observedAttributes = ['src', 'name', 'author', 'poster', 'loop', 'controls'];

  private audio = document.createElement('audio');
  private button = document.createElement('div');
  private nameEl = document.createElement('div');
  private authorEl = document.createElement('div');
  private timeEl = document.createElement('div');
  private left = document.createElement('div');
  private card = document.createElement('div');
  private pendingSeek: number | null = null;
  private lastPublishedTime = 0;

  connectedCallback() {
    if (elementStates.audioReady.has(this)) { this.apply('reconnect'); return; }
    elementStates.audioReady.add(this);

    this.audio.style.display = 'none';
    this.audio.preload = 'metadata';

    const card = this.card;
    card.className = 'wx-audio-default';
    card.setAttribute('role', 'application');
    card.setAttribute('aria-label', '音频播放器');
    this.left.className = 'wx-audio-left';
    this.button.className = 'wx-audio-button play';
    this.button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><path d="M7 4.5v15l13-7.5z"/></svg>';
    this.left.appendChild(this.button);

    const right = document.createElement('div');
    right.className = 'wx-audio-right';
    this.timeEl.className = 'wx-audio-time';
    this.timeEl.textContent = '00:00';
    const info = document.createElement('div');
    info.className = 'wx-audio-info';
    this.nameEl.className = 'wx-audio-name';
    this.authorEl.className = 'wx-audio-author';
    info.append(this.nameEl, this.authorEl);
    right.append(this.timeEl, info);

    card.append(this.left, right);
    this.append(this.audio, card);

    this.button.addEventListener('click', event => {
      event.stopPropagation();
      if (this.audio.paused) void this.audio.play().catch(() => undefined);
      else this.audio.pause();
    });
    this.audio.addEventListener('play', () => {
      this.button.classList.remove('play');
      this.button.classList.add('pause');
      this.button.innerHTML =
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
      this.emit('play');
    });
    this.audio.addEventListener('pause', () => {
      this.button.classList.add('play');
      this.button.classList.remove('pause');
      this.button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="#fff"><path d="M7 4.5v15l13-7.5z"/></svg>';
      this.emit('pause');
    });
    this.audio.addEventListener('timeupdate', () => {
      this.syncTime();
      if (Math.abs(this.audio.currentTime - this.lastPublishedTime) % this.audio.duration >= 1) {
        this.emit('timeupdate', { currentTime: this.audio.currentTime, duration: this.audio.duration });
        // 3.7.0 的组件以毫秒保存上次值，却以秒比较；差分保留这一历史行为。
        this.lastPublishedTime = this.audio.currentTime * 1000;
      }
    });
    this.audio.addEventListener('loadedmetadata', () => this.syncTime());
    this.audio.addEventListener('ended', () => this.emit('ended'));
    this.audio.addEventListener('waiting', () => this.emit('waiting'));
    this.audio.addEventListener('progress', () => this.emit('progress', { buffered: this.audio.currentTime / this.audio.duration * 100 }));
    this.audio.addEventListener('ratechange', () => this.emit('ratechange', { playbackRate: this.audio.playbackRate }));
    this.audio.addEventListener('error', () => {
      const messages: Record<number, string> = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
      if (this.audio.error) this.emit('error', { errMsg: messages[this.audio.error.code] });
    });
    this.audio.addEventListener('canplay', () => {
      if (this.pendingSeek !== null) { this.audio.currentTime = this.pendingSeek; this.pendingSeek = null; }
    });

    this.apply();
  }

  disconnectedCallback() {
    queueMicrotask(() => {
      if (this.isConnected) return;
      this.pendingSeek = null;
      this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    });
  }

  attributeChangedCallback(name: string) {
    this.apply(name);
  }

  private emit(name: string, detail: Record<string, unknown> = {}) {
    if (this.isConnected) this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  private apply(attribute?: string) {
    if (!elementStates.audioReady.has(this)) return;
    const name = this.getAttribute('name') ?? '未知歌曲';
    const author = this.getAttribute('author') ?? '未知作者';
    this.nameEl.textContent = name;
    this.authorEl.textContent = author;
    this.nameEl.style.display = name ? '' : 'none';
    this.authorEl.style.display = author ? '' : 'none';
    const poster = this.getAttribute('poster');
    this.left.style.backgroundImage = poster ? `url("${poster}")` : '';
    this.audio.loop = booleanProperty(this, 'loop') ?? false;
    this.card.style.display = (booleanProperty(this, 'controls') ?? false) ? '' : 'none';
    const src = this.getAttribute('src');
    if (!attribute || attribute === 'src' || (attribute === 'reconnect' && !this.audio.getAttribute('src'))) this.setSource(src ?? '');
  }

  play() {
    return this.audio.play().catch(() => undefined);
  }

  pause() {
    this.audio.pause();
  }

  seek(time: number) {
    time = parseFloat(String(time));
    if (Number.isNaN(time)) return;
    if (this.audio.readyState < 2) this.pendingSeek = time;
    else this.audio.currentTime = time;
  }

  setSource(source: string) {
    if (typeof source !== 'string' || !source || this.audio.getAttribute('src') === source) return;
    this.pendingSeek = null;
    this.audio.src = source;
    this.syncTime();
  }

  private syncTime() {
    this.timeEl.textContent = formatTime(this.audio.currentTime);
    this.audio.dataset.time = String(this.audio.currentTime);
  }
}

interface TimedDanmu { text: string; color: string; sent: boolean }

/** 视频播放器：结构与控制条对齐官方基础库（.wx-video-* 类来自它） */
class WxVideo extends HTMLElement {
  static observedAttributes = [
    'src', 'poster', 'controls', 'autoplay', 'loop', 'muted', 'object-fit', 'initial-time', 'enable-danmu', 'danmu-list', 'danmu-btn',
    'show-progress', 'show-fullscreen-btn', 'show-play-btn', 'show-center-play-btn', 'show-mute-btn'
  ];

  private video = document.createElement('video');
  private container = document.createElement('div');
  private overlayEl = document.createElement('div');
  private currentTimeEl = document.createElement('div');
  private durationEl = document.createElement('div');
  private progressEl = document.createElement('div');
  private bar = document.createElement('div');
  private playButton = document.createElement('button');
  private centerPlayButton = document.createElement('button');
  private muteButton = document.createElement('button');
  private danmuButton = document.createElement('button');
  private fullscreenButton = document.createElement('button');
  private progressWrapper = document.createElement('div');
  private progressContainer = document.createElement('div');
  private readonly sizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.syncControls());
  private childObserver = new MutationObserver(() => this.collectChildren());
  private loaded = false;
  private pendingSeek: number | null = null;
  private danmuLayer = document.createElement('div');
  private danmuLanes: Array<{ width: number; started: number }> | null = null;
  private readonly danmuAnimations = new Map<HTMLElement, Animation>();
  private readonly danmuTimeline = new Map<number, TimedDanmu[]>();
  private lastDanmuPosition = -1;
  private danmuVisible = false;
  private fullscreen = false;
  private fullscreenDirection: 'vertical' | 'horizontal' = 'vertical';
  private readonly onFullscreenChange = () => {
    const fullScreen = document.fullscreenElement === this.container;
    if (this.fullscreen === fullScreen) return;
    this.fullscreen = fullScreen;
    this.syncControls();
    this.emit('fullscreenchange', { fullScreen, direction: this.fullscreenDirection });
  };

  connectedCallback() {
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.sizeObserver?.observe(this);
    if (elementStates.videoReady.has(this)) {
      this.childObserver.observe(this, { childList: true });
      this.collectChildren();
      this.apply('reconnect');
      return;
    }
    elementStates.videoReady.add(this);

    this.container.className = 'wx-video-container';
    this.container.addEventListener('fullscreenchange', event => {
      event.stopPropagation();
      this.onFullscreenChange();
    });
    this.video.setAttribute('playsinline', '');
    this.video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000';

    const bar = this.bar;
    bar.className = 'wx-video-bar';
    const controls = document.createElement('div');
    controls.className = 'wx-video-controls';
    const wrapper = this.progressWrapper;
    wrapper.className = 'wx-video-progress-wrapper';
    this.currentTimeEl.className = 'wx-video-current-time';
    this.currentTimeEl.textContent = '00:00';
    const progressContainer = this.progressContainer;
    progressContainer.className = 'wx-video-progress-container';
    progressContainer.setAttribute('role', 'slider');
    progressContainer.setAttribute('aria-label', '播放进度');
    progressContainer.setAttribute('aria-valuemin', '0');
    progressContainer.tabIndex = 0;
    progressContainer.addEventListener('click', event => {
      event.stopPropagation();
      const rect = progressContainer.getBoundingClientRect();
      if (this.duration && rect.width) this.seek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * this.duration);
    });
    progressContainer.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      this.seek(Math.max(0, Math.min(this.duration, this.video.currentTime + (event.key === 'ArrowLeft' ? -5 : 5))));
    });
    this.progressEl.className = 'wx-video-progress';
    progressContainer.appendChild(this.progressEl);
    this.durationEl.className = 'wx-video-duration';
    this.durationEl.textContent = '00:00';
    wrapper.append(this.currentTimeEl, progressContainer, this.durationEl);

    const fullscreen = this.fullscreenButton;
    fullscreen.type = 'button';
    fullscreen.className = 'wx-video-control-button wx-video-fullscreen';
    fullscreen.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.4"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg>';
    fullscreen.addEventListener('click', event => {
      event.stopPropagation();
      if (this.fullscreen) this.exitFullScreen();
      else this.requestFullScreen();
    });

    const togglePlayback = (event: Event) => {
      event.stopPropagation();
      if (this.video.paused) void this.play();
      else this.pause();
    };
    for (const button of [this.playButton, this.centerPlayButton]) {
      button.type = 'button';
      button.className = 'wx-video-control-button wx-video-play';
      button.addEventListener('click', togglePlayback);
    }
    this.centerPlayButton.classList.add('wx-video-center-play');
    this.muteButton.type = 'button';
    this.muteButton.className = 'wx-video-control-button wx-video-mute';
    this.muteButton.addEventListener('click', event => {
      event.stopPropagation();
      this.video.muted = !this.video.muted;
      this.syncControls();
    });
    this.danmuButton.type = 'button';
    this.danmuButton.className = 'wx-video-control-button wx-video-danmu-btn-on';
    this.danmuButton.textContent = '弹';
    this.danmuButton.addEventListener('click', event => {
      event.stopPropagation();
      this.danmuVisible = !this.danmuVisible;
      this.syncDanmuVisibility();
    });
    controls.append(this.playButton, wrapper, this.muteButton, fullscreen);
    bar.appendChild(controls);

    this.overlayEl.className = 'wx-video-slot';

    // slot 放在 container 内部、video 之后：与官方层级一致，cover-view 一定盖在画面上
    this.danmuLayer.className = 'wx-video-danmu-layer';
    this.container.append(this.video, this.danmuLayer, this.centerPlayButton, bar, this.overlayEl);
    this.appendChild(this.container);

    this.collectChildren();
    this.childObserver.observe(this, { childList: true });

    this.video.addEventListener('timeupdate', () => {
      this.syncProgress();
      this.syncDanmu();
      this.emit('timeupdate', { currentTime: this.video.currentTime, duration: this.duration });
    });
    this.video.addEventListener('loadedmetadata', () => {
      if (!this.isConnected) return;
      if (this.pendingSeek !== null) {
        this.video.currentTime = this.pendingSeek;
        this.pendingSeek = null;
      }
      this.durationEl.textContent = formatTime(this.video.duration);
      this.syncProgress();
      this.emit('loadedmetadata', { width: this.video.videoWidth, height: this.video.videoHeight, duration: this.duration });
    });
    this.video.addEventListener('play', () => { this.syncControls(); this.emit('play'); });
    this.video.addEventListener('pause', () => { this.syncControls(); this.emit('pause'); });
    this.video.addEventListener('ended', () => this.emit('ended'));
    this.video.addEventListener('waiting', () => this.emit('waiting'));
    for (const type of ['enterpictureinpicture', 'leavepictureinpicture']) this.video.addEventListener(type, event => {
      event.stopPropagation();
      this.emit(type);
    });
    this.video.addEventListener('progress', () => {
      const buffered = this.video.buffered;
      const percent = this.duration && buffered.length ? (buffered.end(buffered.length - 1) / this.duration) * 100 : 0;
      this.emit('progress', { buffered: Math.min(100, Math.max(0, percent)) });
    });
    this.video.addEventListener('error', () => this.emit('error', { errMsg: 'MEDIA_ERR_SRC_NOT_SUPPORTED' }));

    this.apply();
  }

  disconnectedCallback() {
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.sizeObserver?.disconnect();
    this.fullscreen = false;
    this.childObserver.disconnect();
    queueMicrotask(() => {
      if (this.isConnected) return;
      if (document.pictureInPictureElement === this.video) void document.exitPictureInPicture().catch(() => undefined);
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.loaded = false;
      this.pendingSeek = null;
      this.resetDanmu();
    });
  }

  private collectChildren() {
    for (const node of Array.from(this.childNodes)) {
      if (node !== this.container) this.overlayEl.appendChild(node);
    }
  }

  attributeChangedCallback(name: string) {
    if (name === 'danmu-list') this.readDanmuList();
    if (name === 'src') this.resetDanmu();
    const reload = name === 'src' && this.loaded;
    if (reload) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      this.loaded = false;
      this.pendingSeek = null;
    }
    this.apply(name);
    if (reload) this.ensureLoaded();
  }

  private emit(type: string, detail?: Record<string, unknown>) {
    if (!this.isConnected) return;
    this.dispatchEvent(
      new CustomEvent(type, {
        detail: detail ?? {}
      })
    );
  }

  private apply(name?: string) {
    if (!elementStates.videoReady.has(this)) return;
    const controls = booleanProperty(this, 'controls') ?? true;
    const poster = this.getAttribute('poster');
    if (poster && controls) this.video.poster = poster;
    else this.video.removeAttribute('poster');
    this.bar.style.display = controls ? '' : 'none';
    const fit = this.getAttribute('object-fit') ?? 'contain';
    this.video.style.objectFit = ['contain', 'cover', 'fill'].includes(fit) ? fit : 'contain';
    this.video.controls = false;
    this.video.loop = booleanProperty(this, 'loop') ?? false;
    if (!name || name === 'muted') this.video.muted = booleanProperty(this, 'muted') ?? false;
    this.video.autoplay = booleanProperty(this, 'autoplay') ?? false;
    if (!name || name === 'enable-danmu') this.danmuVisible = booleanProperty(this, 'enable-danmu') ?? false;
    this.syncDanmuVisibility();
    if (this.video.autoplay && this.isConnected) this.ensureLoaded();
    this.container.style.display = '';
    this.syncControls();
  }

  /** 首次播放才真正加载 src：官方初始也是黑屏 + 00:00 控制条 */
  private ensureLoaded() {
    if (this.loaded) return;
    const src = this.getAttribute('src');
    if (!src) return;
    const initialTime = Number(this.getAttribute('initial-time'));
    this.pendingSeek = Number.isFinite(initialTime) ? Math.max(0, initialTime) : 0;
    this.video.src = src;
    this.loaded = true;
  }

  play() {
    this.ensureLoaded();
    return this.video.play().catch(() => undefined);
  }

  pause() {
    this.video.pause();
  }

  stop() {
    this.video.pause();
    this.video.currentTime = 0;
    this.pendingSeek = this.video.readyState < HTMLMediaElement.HAVE_METADATA ? 0 : null;
  }

  seek(time: number) {
    this.ensureLoaded();
    this.video.currentTime = time;
    this.pendingSeek = this.video.readyState < HTMLMediaElement.HAVE_METADATA ? time : null;
  }

  get duration() {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get enableDanmu() {
    return this.danmuVisible;
  }

  private syncDanmuVisibility() {
    this.danmuLayer.style.opacity = this.danmuVisible ? '1' : '0';
    this.danmuButton.classList.toggle('wx-video-danmu-btn-off', !this.danmuVisible);
    this.danmuButton.setAttribute('aria-label', this.danmuVisible ? '关闭弹幕' : '打开弹幕');
  }

  set playbackRate(rate: number) {
    this.video.playbackRate = rate;
  }

  sendDanmu(data: { text: string; color?: string }) {
    if (!this.isConnected || typeof data?.text !== 'string' || !data.text) return;
    const time = Math.trunc(this.lastDanmuPosition);
    let bucket = this.danmuTimeline.get(time);
    if (!bucket) this.danmuTimeline.set(time, bucket = []);
    bucket.push({ text: data.text, color: data.color || '#ffffff', sent: false });
  }

  private renderDanmu(data: { text: string; color?: string }) {
    const node = document.createElement('span');
    node.className = 'wx-video-danmu-item';
    node.textContent = data.text;
    node.style.cssText = 'position:absolute;left:0;white-space:pre;font-size:16px;line-height:20px;color:white';
    if (data.color) node.style.color = data.color;
    this.danmuLayer.appendChild(node);
    this.danmuLanes ??= Array.from({ length: Math.floor(this.danmuLayer.clientHeight / 20) }, () => ({ width: 0, started: 0 }));
    const width = node.offsetWidth;
    const now = Date.now();
    const lane = this.danmuLanes.findIndex(previous => (previous.width + this.clientWidth) / 3000 * (now - previous.started) > width);
    if (lane < 0) {
      node.remove();
      return;
    }
    this.danmuLanes[lane] = { width, started: now };
    node.style.top = `${lane * 20}px`;
    const animation = node.animate([
      { transform: `translateX(${this.clientWidth}px)` },
      { transform: `translateX(${-width}px)` }
    ], { duration: 3000, easing: 'linear' });
    this.danmuAnimations.set(node, animation);
    animation.onfinish = () => {
      node.remove();
      this.danmuAnimations.delete(node);
    };
  }

  private readDanmuList() {
    this.danmuTimeline.clear();
    const list = boundAttribute(this, 'danmu-list');
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item.time !== 'number' || item.time < 0 || typeof item.text !== 'string' || !item.text) continue;
      let bucket = this.danmuTimeline.get(item.time);
      if (!bucket) this.danmuTimeline.set(item.time, bucket = []);
      bucket.push({ text: item.text, color: item.color || '#ffffff', sent: false });
    }
  }

  private syncDanmu() {
    if (!this.duration) return;
    const position = this.video.currentTime;
    const previous = this.lastDanmuPosition;
    this.lastDanmuPosition = position;
    if (this.video.paused || position <= previous) return;
    for (const item of this.danmuTimeline.get(Math.trunc(position)) ?? []) {
      if (item.sent) continue;
      item.sent = true;
      this.renderDanmu(item);
    }
  }

  private resetDanmu() {
    for (const [node, animation] of this.danmuAnimations) {
      animation.cancel();
      node.remove();
    }
    this.danmuAnimations.clear();
    this.lastDanmuPosition = -1;
    for (const bucket of this.danmuTimeline.values()) for (const item of bucket) item.sent = false;
  }

  requestFullScreen(options?: { direction?: number }) {
    const direction = options?.direction ?? (this.hasAttribute('direction') ? Number(this.getAttribute('direction')) : undefined);
    this.fullscreenDirection = direction === 0 ? 'vertical' : direction === 90 || direction === -90
      ? 'horizontal' : this.video.videoWidth > this.video.videoHeight ? 'horizontal' : 'vertical';
    void this.container.requestFullscreen?.().catch(() => undefined);
  }

  exitFullScreen() {
    if (document.fullscreenElement === this.container) void document.exitFullscreen().catch(() => undefined);
  }

  private syncControls() {
    const controls = booleanProperty(this, 'controls') ?? true;
    const paused = this.video.paused;
    const icon = paused ? '<path d="M5 3v18l15-9z"/>' : '<path d="M5 3h5v18H5zM14 3h5v18h-5z"/>';
    for (const button of [this.playButton, this.centerPlayButton]) {
      const label = paused ? '播放' : '暂停';
      if (button.getAttribute('aria-label') !== label) {
        button.setAttribute('aria-label', label);
        button.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">${icon}</svg>`;
      }
    }
    this.playButton.style.display = (booleanProperty(this, 'show-play-btn') ?? true) ? '' : 'none';
    this.centerPlayButton.style.display = controls && paused && (booleanProperty(this, 'show-center-play-btn') ?? true) ? '' : 'none';
    this.fullscreenButton.style.display = (booleanProperty(this, 'show-fullscreen-btn') ?? true) ? '' : 'none';
    this.fullscreenButton.setAttribute('aria-label', this.fullscreen ? '退出全屏' : '进入全屏');
    this.muteButton.style.display = booleanProperty(this, 'show-mute-btn') ? '' : 'none';
    this.muteButton.setAttribute('aria-label', this.video.muted ? '取消静音' : '静音');
    if (booleanProperty(this, 'danmu-btn')) this.fullscreenButton.before(this.danmuButton);
    else this.danmuButton.remove();
    const sound = this.video.muted ? '<path d="m17 9 6 6m0-6-6 6"/>' : '<path d="M16 8a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14"/>';
    this.muteButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 9h4l6-5v16l-6-5H2z"/>${sound}</svg>`;
    const progress = this.hasAttribute('show-progress') ? booleanProperty(this, 'show-progress') : this.clientWidth > 240;
    this.progressWrapper.style.display = progress ? '' : 'none';
  }

  private syncProgress() {
    const duration = this.duration;
    const ratio = duration ? Math.min(this.video.currentTime / duration, 1) : 0;
    this.progressEl.style.setProperty('--fmp-video-progress', String(ratio));
    this.progressEl.style.background =
      ratio > 0 ? `linear-gradient(to right, #fff ${ratio * 100}%, rgba(217,217,217,.1) ${ratio * 100}%)` : '';
    this.currentTimeEl.textContent = formatTime(this.video.currentTime);
    this.progressContainer.setAttribute('aria-valuemax', String(duration));
    this.progressContainer.setAttribute('aria-valuenow', String(this.video.currentTime));
    if (duration) this.durationEl.textContent = formatTime(duration);
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 可拖拽视图：拖动、边界回弹，change 事件给出相对 area 的位置 */
class WxMovableView extends HTMLElement {
  static observedAttributes = ['x', 'y', 'direction', 'disabled'];

  private start: { x: number; y: number; left: number; top: number; pointerId: number } | null = null;

  connectedCallback() {
    if (elementStates.moveReady.has(this)) return;
    elementStates.moveReady.add(this);
    this.style.position = 'absolute';
    this.style.touchAction = 'none';
    this.addEventListener('pointerdown', event => this.down(event));
    this.addEventListener('pointermove', event => this.move(event));
    this.addEventListener('pointerup', event => this.up(event));
    this.addEventListener('pointercancel', event => this.up(event));
    requestAnimationFrame(() => this.applyPosition());
  }

  attributeChangedCallback() {
    requestAnimationFrame(() => this.applyPosition());
  }

  private area(): HTMLElement | null {
    return this.parentElement as HTMLElement | null;
  }

  private applyPosition() {
    if (this.start) return;
    const x = Number(this.getAttribute('x') ?? 0) || 0;
    const y = Number(this.getAttribute('y') ?? 0) || 0;
    this.style.left = `${x}px`;
    this.style.top = `${y}px`;
  }

  private down(event: PointerEvent) {
    if (this.getAttribute('disabled') !== null) return;
    const area = this.area();
    if (!area) return;
    const areaBox = area.getBoundingClientRect();
    const box = this.getBoundingClientRect();
    this.start = {
      x: event.clientX,
      y: event.clientY,
      left: box.left - areaBox.left,
      top: box.top - areaBox.top,
      pointerId: event.pointerId
    };
    this.setPointerCapture(event.pointerId);
    this.style.transition = '';
  }

  private move(event: PointerEvent) {
    if (!this.start || event.pointerId !== this.start.pointerId) return;
    const direction = this.getAttribute('direction') ?? 'none';
    const area = this.area();
    if (!area) return;
    const bounds = area.getBoundingClientRect();
    const box = this.getBoundingClientRect();
    let left = this.start.left;
    let top = this.start.top;
    if (direction === 'all' || direction === 'horizontal') left += event.clientX - this.start.x;
    if (direction === 'all' || direction === 'vertical') top += event.clientY - this.start.y;

    const outOfBounds = this.getAttribute('out-of-bounds') !== null;
    const maxLeft = bounds.width - box.width;
    const maxTop = bounds.height - box.height;
    if (!outOfBounds) {
      left = Math.min(Math.max(left, 0), Math.max(maxLeft, 0));
      top = Math.min(Math.max(top, 0), Math.max(maxTop, 0));
    }

    this.style.left = `${left}px`;
    this.style.top = `${top}px`;
    this.emitChange(left, top, 'touch');
  }

  private up(event: PointerEvent) {
    if (!this.start || event.pointerId !== this.start.pointerId) return;
    this.start = null;
    const area = this.area();
    if (!area) return;
    const bounds = area.getBoundingClientRect();
    const box = this.getBoundingClientRect();
    const left = box.left - bounds.left;
    const top = box.top - bounds.top;
    const maxLeft = Math.max(bounds.width - box.width, 0);
    const maxTop = Math.max(bounds.height - box.height, 0);
    // out-of-bounds：松手弹回边界内
    const nextLeft = Math.min(Math.max(left, 0), maxLeft);
    const nextTop = Math.min(Math.max(top, 0), maxTop);
    if (nextLeft !== left || nextTop !== top) {
      this.style.transition = 'left .2s ease, top .2s ease';
      this.style.left = `${nextLeft}px`;
      this.style.top = `${nextTop}px`;
      this.emitChange(nextLeft, nextTop, 'touch');
    }
  }

  private emitChange(x: number, y: number, source: string) {
    this.dispatchEvent(new CustomEvent('change', { detail: { x, y, source } }));
  }
}

/** 轮播：横向 scroll-snap，滚动停下后按页触发 change */
class WxSwiper extends HTMLElement {
  static observedAttributes = ['current', 'autoplay', 'interval', 'circular', 'vertical', 'indicator-dots'];

  private timer: ReturnType<typeof setInterval> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private dots: HTMLElement | null = null;

  connectedCallback() {
    if (!elementStates.swiperReady.has(this)) {
      elementStates.swiperReady.add(this);
      this.addEventListener('scroll', () => {
        if (this.scrollTimer) clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => this.settle(), 120);
      });
      this.syncStyle();
      this.syncDots();
      requestAnimationFrame(() => this.applyCurrent(false));
    }
    this.syncAutoplay();
  }

  disconnectedCallback() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  attributeChangedCallback() {
    this.syncStyle();
    if (elementStates.swiperReady.has(this)) this.applyCurrent(false);
    this.syncDots();
    this.syncAutoplay();
  }

  /** indicator-dots：与官方一样浮在底部（竖滑时在右侧） */
  private syncDots() {
    if (!this.hasAttribute('indicator-dots')) {
      this.dots?.remove();
      this.dots = null;
      return;
    }
    if (!this.dots) {
      this.dots = document.createElement('div');
      this.dots.className = 'wx-swiper-dots';
      this.appendChild(this.dots);
    }
    this.dots.classList.toggle('is-vertical', this.hasAttribute('vertical'));
    const current = Number(this.getAttribute('current') ?? 0) || 0;
    const color = this.getAttribute('indicator-color') ?? 'rgba(0,0,0,.3)';
    const activeColor = this.getAttribute('indicator-active-color') ?? '#000';
    this.dots.replaceChildren(
      ...this.items().map((_, index) => {
        const dot = document.createElement('span');
        dot.className = 'wx-swiper-dot' + (index === current ? ' is-active' : '');
        dot.style.background = index === current ? activeColor : color;
        return dot;
      })
    );
  }

  private items(): HTMLElement[] {
    return Array.from(this.querySelectorAll('wx-swiper-item')) as HTMLElement[];
  }

  private syncStyle() {
    const vertical = this.hasAttribute('vertical');
    this.style.display = 'flex';
    this.style.overflow = vertical ? 'auto hidden' : 'hidden auto';
    this.style.overflowY = vertical ? 'auto' : 'hidden';
    this.style.overflowX = vertical ? 'hidden' : 'auto';
    this.style.scrollSnapType = vertical ? 'y mandatory' : 'x mandatory';
    this.style.flexDirection = vertical ? 'column' : 'row';
    for (const item of this.items()) {
      item.style.flex = '0 0 100%';
      item.style.width = '100%';
      item.style.height = '100%';
      item.style.scrollSnapAlign = 'start';
    }
  }

  private applyCurrent(smooth = true) {
    const index = Number(this.getAttribute('current') ?? 0) || 0;
    const target = this.items()[index];
    if (!target) return;
    const vertical = this.hasAttribute('vertical');
    this.scrollTo({ [vertical ? 'top' : 'left']: vertical ? target.offsetTop : target.offsetLeft, behavior: smooth ? 'smooth' : 'auto' });
  }

  private settle() {
    const vertical = this.hasAttribute('vertical');
    const size = vertical ? this.clientHeight : this.clientWidth;
    if (!size) return;
    const index = Math.round((vertical ? this.scrollTop : this.scrollLeft) / size);
    if (String(index) === this.getAttribute('current')) return;
    this.setAttribute('current', String(index));
    this.dispatchEvent(new CustomEvent('change', { detail: { current: index, source: 'touch' } }));
    this.syncDots();
    this.dispatchEvent(new CustomEvent('animationfinish', { detail: { current: index, source: 'touch' } }));
  }

  private syncAutoplay() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.getAttribute('autoplay') === null) return;
    const interval = Number(this.getAttribute('interval') ?? 5000) || 5000;
    this.timer = setInterval(() => {
      const total = this.items().length;
      if (!total) return;
      const current = Number(this.getAttribute('current') ?? 0) || 0;
      const next = current + 1 >= total ? (this.hasAttribute('circular') ? 0 : current) : current + 1;
      if (next === current) return;
      this.setAttribute('current', String(next));
      this.applyCurrent(true);
      this.syncDots();
      this.dispatchEvent(new CustomEvent('change', { detail: { current: next, source: 'autoplay' } }));
      this.dispatchEvent(new CustomEvent('animationfinish', { detail: { current: next, source: 'autoplay' } }));
    }, interval);
  }
}

/** 地图：占位底图 + 版权条；真实瓦片需要地图服务，这里只还原外观骨架 */
class WxCanvas extends HTMLElement {
  private canvas = document.createElement('canvas');

  connectedCallback() {
    if (!this.canvas.parentNode) {
      this.canvas.style.cssText = 'width:100%;height:100%;display:block';
      this.appendChild(this.canvas);
    }
    this.sync();
  }

  attributeChangedCallback() {
    this.sync();
  }

  private sync() {
    const rect = this.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (rect.width) {
      this.canvas.width = Math.round(rect.width * ratio);
      this.canvas.height = Math.round(rect.height * ratio);
      // type="webgl" 的画布留给业务侧获取 webgl 上下文（createMediaRecorder 也依赖），
      // 只有默认与 2d 类型绑定 2d 上下文
      if (this.getAttribute('type') !== 'webgl') {
        const ctx = this.canvas.getContext('2d');
        ctx?.scale(ratio, ratio);
      }
    }
  }
}

class WxNavigator extends HTMLElement {
  connectedCallback() {
    this.style.cursor = 'pointer';
    if (elementStates.bound.has(this)) return;
    elementStates.bound.add(this);
    this.addEventListener('click', () => {
      const url = this.getAttribute('url') ?? '';
      if (url) navigate(url, this.getAttribute('open-type') ?? 'navigate');
    });
  }
}

class WxWebView extends HTMLElement {
  static observedAttributes = ['src'];
  private frame = document.createElement('iframe');

  connectedCallback() {
    if (!this.frame.parentNode) {
      this.frame.style.cssText = 'width:100%;height:100%;border:0';
      this.appendChild(this.frame);
    }
    this.apply();
  }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    const src = this.getAttribute('src');
    if (src && this.frame.getAttribute('src') !== src) this.frame.src = src;
  }
}

const ELEMENTS: Record<string, CustomElementConstructor> = {
  'wx-text': WxText,
  'wx-image': WxImage,
  'wx-input': WxInput,
  'wx-textarea': WxTextarea,
  'wx-switch': WxSwitch,
  'wx-slider': WxSlider,
  'wx-video': WxVideo,
  'wx-canvas': WxCanvas,
  'wx-navigator': WxNavigator,
  'wx-web-view': WxWebView,
  'wx-map': WxMap,
  'wx-camera': WxCamera,
  'wx-audio': WxAudio,
  'wx-editor': WxEditor,
  'wx-editor-portal': WxEditorPortal,
  'wx-selection': WxSelection,
  'wx-picker-view': WxPickerView,
  'wx-picker': WxPicker,
  'wx-movable-view': WxMovableView,
  'wx-swiper': WxSwiper
};

let defined = false;

import { CONTROL_CSS, CONTROL_ELEMENTS } from './controls';
import { WxMap } from './map-view';

export function defineNativeElements() {
  if (defined) return;
  defined = true;
  for (const [tag, ctor] of Object.entries({ ...ELEMENTS, ...CONTROL_ELEMENTS })) {
    if (!customElements.get(tag)) customElements.define(tag, ctor);
  }
}

export const NATIVE_CSS =
  SELECTION_CSS +
  EDITOR_CSS +
  `
wx-audio { display: block; }
.wx-audio-default { display: flex; width: 100%; height: 67px; border: 1px solid #e0e0e0; border-radius: 2.5px; background: #fcfcfc; box-sizing: border-box; overflow: hidden; }
.wx-audio-left { position: relative; flex: none; width: 65px; height: 65px; background: #e6e6e6 center / 100% 100% no-repeat; }
.wx-audio-button { position: absolute; left: 50%; top: 50%; width: 24px; height: 24px; margin: -12px 0 0 -12px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.wx-audio-right { position: relative; flex: 1; min-width: 0; padding: 11px 16.5px 13.5px 15px; box-sizing: border-box; }
.wx-audio-time { position: absolute; right: 16.5px; top: 11px; font-size: 12px; color: #888; }
.wx-audio-info { padding-top: 11px; }
.wx-audio-name { font-size: 14px; color: #353535; line-height: 23px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wx-audio-author { font-size: 12px; color: #888; line-height: 15px; }
/* 官方 wx-video 是 inline-block，底部因此有一点点基线间隙，块级化会改变后续元素位置 */
wx-video { display: inline-block; position: relative; overflow: hidden; width: 300px; height: 225px; }
.wx-video-container { position: absolute; inset: 0; background: #000; overflow: hidden; }
.wx-video-slot { position: absolute; inset: 0; pointer-events: none; }
.wx-video-slot > * { pointer-events: auto; }
.wx-video-danmu-layer { position: absolute; inset: 0; margin-bottom: 60px; overflow: hidden; pointer-events: none; }
.wx-video-bar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; display: flex; height: 48px; padding: 0 16px; box-sizing: border-box; }
.wx-video-controls { display: flex; align-items: center; justify-content: space-between; flex: 1; height: 38px; min-width: 0; }
.wx-video-progress-wrapper { flex: 1; display: flex; align-items: center; height: 38px; min-width: 0; }
.wx-video-current-time, .wx-video-duration { font-size: 14px; line-height: 24px; color: rgba(255,255,255,.5); white-space: nowrap; }
.wx-video-progress-container { flex: 1; display: flex; align-items: center; height: 38px; margin: 0 8px; min-width: 0; cursor: pointer; }
.wx-video-progress { width: 100%; height: 4px; border-radius: 20px; background: rgba(217,217,217,.1); }
.wx-video-control-button { display: flex; flex: none; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 0; color: #fff; background: rgba(255,255,255,.5); cursor: pointer; }
.wx-video-center-play { position: absolute; left: 50%; top: 50%; z-index: 1; transform: translate(-50%, -50%); border-radius: 50%; width: 48px; height: 48px; background: rgba(0,0,0,.5); }
wx-movable-area { position: relative; display: block; overflow: hidden; }
wx-movable-view { position: absolute; display: block; }
wx-swiper { position: relative; display: flex; }
wx-swiper-item { display: block; position: relative; overflow: hidden; }
.wx-swiper-dots { position: absolute; left: 0; right: 0; bottom: 8px; display: flex; align-items: center; justify-content: center; gap: 4px; pointer-events: none; z-index: 2; }
.wx-swiper-dots.is-vertical { left: auto; right: 8px; top: 0; bottom: 0; flex-direction: column; }
.wx-swiper-dot { width: 6px; height: 6px; border-radius: 3px; background: rgba(0,0,0,.3); transition: width .2s; }
.wx-swiper-dot.is-active { width: 12px; }
wx-map { position: relative; overflow: hidden; width: 300px; height: 150px; background: #f5f5f5; }
.wx-map-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.wx-map-attr { position: absolute; left: 8px; bottom: 6px; z-index: 1; pointer-events: none; display: flex; align-items: center; gap: 4px; font-size: 10px; color: #8a8a8a; }
.wx-map-logo { padding: 1px 4px; border-radius: 2px; background: #1a8cff; color: #fff; font-size: 10px; }
wx-camera { position: relative; overflow: hidden; background: #808080; }
.wx-camera-placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,.85); font-size: 14px; }
wx-page { display: block; position: absolute; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; font-family: initial; font-size: 16px; }
wx-custom-tab-bar { font-family: initial; font-size: 16px; }
wx-view, wx-form, wx-picker, wx-picker-view, wx-picker-view-column, wx-radio-group, wx-checkbox-group,
wx-custom-tab-bar, wx-movable-area, wx-movable-view, wx-map, wx-camera, wx-audio,
wx-canvas, wx-web-view, wx-editor, wx-cover-view, wx-scroll-view { display: block; }
wx-text, wx-label { display: inline; }
wx-scroll-view { overflow: hidden; -webkit-overflow-scrolling: touch; }
wx-scroll-view[scroll-y] { overflow-y: auto; }
wx-scroll-view[scroll-x] { overflow-x: auto; }
wx-scroll-view[scroll-y][scroll-x] { overflow: auto; }
wx-image { display: inline-block; overflow: hidden; }
wx-image > img { width: 100%; height: 100%; display: block; }
wx-input, wx-textarea { display: block; }
wx-navigator { display: inline-block; }
wx-web-view { height: 100%; }
wx-button {
  display: block; position: relative; box-sizing: border-box; margin: 0 auto;
  width: 184px; padding: 8px 24px; min-height: 40px; line-height: 24px;
  font-size: 17px; font-weight: 400;
  text-align: center; text-decoration: none; border-radius: 4px; overflow: hidden;
  color: #000; background: #f8f8f8; border: 0;
  -webkit-tap-highlight-color: transparent; cursor: pointer;
}
wx-button::after { content: ''; position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity .15s; pointer-events: none; }
wx-button:active::after { opacity: .1; }
/* size=mini 不再固定宽度，宽度由内容决定（在 flex 容器里就是 flex item 的内容宽） */
/* margin 不在这里写死：页面里的 .btns button 规则要能覆盖它 */
wx-button[size="mini"] { width: auto; min-height: 32px; padding: 0 14px; line-height: 32px; font-size: 16px; }
wx-button[type="primary"] { background: #07c160; color: #fff; }
wx-button[type="warn"] { background: #f2f2f2; color: #fa5151; }
wx-button[type="primary"][disabled], wx-button[type="warn"][disabled] { background: #fafafa; color: rgba(0,0,0,.18); }
wx-button[disabled] { background: #fafafa; color: rgba(0,0,0,.18); cursor: default; }
${CONTROL_CSS}
`;
