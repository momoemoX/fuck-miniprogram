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
import { normalizeSize } from './geometry';
import { getTempFile } from './api/temp-files';
import BUILTIN_HOST_CSS from './builtin-hosts.css';

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
  private resize = new ResizeObserver(() => this.fitHost());
  private fittedDimension?: { axis: 'width' | 'height'; original: string; applied: string };

  connectedCallback() {
    if (!this.img.parentNode) {
      this.img.setAttribute('data-fmp', 'image');
      this.appendChild(this.img);
    }
    if (!this.bound) {
      this.bound = true;
      this.img.addEventListener('load', () => {
        this.fitHost();
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
    this.resize.observe(this);
    this.apply();
  }

  disconnectedCallback() { this.resize.disconnect(); }

  attributeChangedCallback() {
    this.apply();
  }

  private apply() {
    const mode = this.getAttribute('mode') ?? 'scaleToFill';
    const axis = mode === 'widthFix' ? 'height' : mode === 'heightFix' ? 'width' : undefined;
    if (this.fittedDimension && this.fittedDimension.axis !== axis) {
      const fitted = this.fittedDimension;
      if (this.style[fitted.axis] === fitted.applied) this.style[fitted.axis] = fitted.original;
      this.fittedDimension = undefined;
    }
    const src = this.getAttribute('src') ?? '';
    if (src && this.img.getAttribute('src') !== src) this.img.src = getTempFile(src)?.url ?? src;
    this.img.loading = this.hasAttribute('lazy-load') ? 'lazy' : 'eager';
    const CROP_MODES = new Set([
      'top', 'bottom', 'center', 'left', 'right',
      'top left', 'top right', 'bottom left', 'bottom right'
    ]);
    this.img.style.width = '100%';
    this.img.style.height = '100%';
    this.img.style.objectPosition = 'center';
    if (CROP_MODES.has(mode)) {
      this.img.style.objectFit = 'none';
      this.img.style.objectPosition = mode;
    } else if (mode === 'widthFix') {
      this.img.style.objectFit = 'fill';
      this.img.style.width = '100%';
      this.img.style.height = 'auto';
    } else if (mode === 'heightFix') {
      this.img.style.objectFit = 'fill';
      this.img.style.width = 'auto';
      this.img.style.height = '100%';
    } else {
      this.img.style.objectFit = IMAGE_FIT[mode] ?? 'fill';
    }
    this.fitHost();
  }

  private fitHost() {
    if (!this.isConnected || !this.img.complete || !this.img.naturalWidth || !this.img.naturalHeight) return;
    const mode = this.getAttribute('mode');
    if (mode !== 'widthFix' && mode !== 'heightFix') return;
    const axis = mode === 'widthFix' ? 'height' : 'width';
    const layout = getComputedStyle(this);
    const size = axis === 'height'
      ? parseFloat(layout.width) * this.img.naturalHeight / this.img.naturalWidth
      : parseFloat(layout.height) * this.img.naturalWidth / this.img.naturalHeight;
    const applied = `${size}px`;
    if (!this.fittedDimension) this.fittedDimension = { axis, original: this.style[axis], applied };
    else if (this.style[axis] !== this.fittedDimension.applied) this.fittedDimension.original = this.style[axis];
    this.fittedDimension.applied = applied;
    if (this.style[axis] !== applied) this.style[axis] = applied;
  }
}

function applySelection(host: HTMLElement, field: HTMLInputElement | HTMLTextAreaElement) {
  const cursor = Number(host.getAttribute('cursor') ?? -1);
  const start = Number(host.getAttribute('selection-start') ?? -1);
  const end = Number(host.getAttribute('selection-end') ?? -1);
  try {
    if (start >= 0 && end >= 0) field.setSelectionRange(start, end);
    else if (cursor >= 0) field.setSelectionRange(cursor, cursor);
  } catch {
    /* Native number/password controls may not expose selection. */
  }
}

class WxInput extends HTMLElement {
  static observedAttributes = [
    'value',
    'placeholder',
    'password',
    'type',
    'disabled',
    'maxlength',
    'focus',
    'auto-focus',
    'cursor',
    'selection-start',
    'selection-end'
  ];
  private input = document.createElement('input');

  connectedCallback() {
    const initial = !this.input.parentNode;
    if (initial) {
      this.input.style.width = '100%';
      this.input.style.height = '100%';
      this.input.style.border = '0';
      this.input.style.padding = '0';
      this.input.style.margin = '0';
      this.input.style.boxSizing = 'border-box';
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
    if (focusChanged) {
      if (this.hasAttribute('focus') || this.hasAttribute('auto-focus')) this.input.focus();
      else this.input.blur();
    }
    applySelection(this, this.input);
  }
}

class WxTextarea extends HTMLElement {
  static observedAttributes = [
    'value',
    'placeholder',
    'disabled',
    'maxlength',
    'auto-height',
    'focus',
    'auto-focus',
    'cursor',
    'selection-start',
    'selection-end'
  ];
  private area = document.createElement('textarea');

  get value() {
    return this.area.value;
  }

  connectedCallback() {
    const initial = !this.area.parentNode;
    if (initial) {
      this.area.style.cssText =
        'position:absolute;width:100%;height:100%;padding:0;border:0;outline:none;background:transparent;font:inherit;line-height:1.2;color:inherit;resize:none';
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
    if (this.hasAttribute('focus') || this.hasAttribute('auto-focus')) this.area.focus();
    else if (document.activeElement === this.area) this.area.blur();
    applySelection(this, this.area);
  }
}

class WxSwitch extends HTMLElement {
  static observedAttributes = ['checked', 'disabled', 'color', 'type'];
  private box = document.createElement('input');

  connectedCallback() {
    if (!this.box.parentNode) {
      this.box.type = 'checkbox';
      this.box.className = 'fmp-switch-control';
      this.box.addEventListener('change', event => {
        event.stopPropagation();
        this.toggleAttribute('checked', this.box.checked);
        this.dispatchEvent(new CustomEvent('change', { detail: { value: this.box.checked }, bubbles: true }));
      });
      this.appendChild(this.box);
    }
    this.apply();
  }

  attributeChangedCallback() { this.apply(); }

  private apply() {
    this.box.checked = booleanProperty(this, 'checked') ?? false;
    this.box.disabled = booleanProperty(this, 'disabled') ?? false;
    const checkbox = this.getAttribute('type') === 'checkbox';
    this.box.setAttribute('role', checkbox ? 'checkbox' : 'switch');
    this.box.setAttribute('aria-label', this.getAttribute('aria-label') ?? '');
    this.style.setProperty('--fmp-switch-color', this.getAttribute('color') || (checkbox ? '#09bb07' : '#07c160'));
  }
}

class WxSlider extends HTMLElement {
  static observedAttributes = ['value', 'min', 'max', 'step', 'disabled', 'activecolor', 'active-color', 'selected-color', 'color', 'background-color', 'show-value', 'block-size', 'block-color'];
  private range = document.createElement('input');
  private layout = document.createElement('div');
  private track = document.createElement('div');
  private fill = document.createElement('div');
  private output = document.createElement('output');

  connectedCallback() {
    if (!this.range.parentNode) {
      const row = document.createElement('div');
      row.className = 'fmp-slider-row';
      this.layout.className = 'fmp-slider-control';
      this.track.className = 'fmp-slider-track';
      this.fill.className = 'fmp-slider-fill';
      this.track.setAttribute('aria-hidden', 'true');
      this.track.appendChild(this.fill);
      this.range.type = 'range';
      this.range.className = 'fmp-slider-input';
      this.output.className = 'fmp-slider-value';
      this.output.setAttribute('aria-live', 'off');
      for (const [native, type] of [['input', 'changing'], ['change', 'change']]) {
        this.range.addEventListener(native, event => {
          event.stopPropagation();
          this.setAttribute('value', this.range.value);
          this.dispatchEvent(new CustomEvent(type, { detail: { value: Number(this.range.value) } }));
        });
      }
      this.layout.append(this.track, this.range);
      row.append(this.layout, this.output);
      this.appendChild(row);
    }
    this.apply();
  }

  attributeChangedCallback() { this.apply(); }

  private apply() {
    this.range.min = this.getAttribute('min') ?? '0';
    this.range.max = this.getAttribute('max') ?? '100';
    this.range.step = this.getAttribute('step') ?? '1';
    const value = this.getAttribute('value') ?? this.range.min;
    if (this.range.value !== value) this.range.value = value;
    const disabled = booleanProperty(this, 'disabled') ?? false;
    this.range.disabled = disabled;
    const size = Math.max(12, Math.min(28, Number(this.getAttribute('block-size') ?? 28) || 28));
    this.layout.style.setProperty('--fmp-slider-size', `${size}px`);
    this.layout.style.setProperty('--fmp-slider-block-color', this.getAttribute('block-color') || '#fff');
    const active = this.getAttribute('active-color') || this.getAttribute('activecolor');
    this.fill.style.backgroundColor = disabled ? '#ccc' : active && active.toLowerCase() !== '#1aad19' ? active : this.getAttribute('selected-color') || active || '#1aad19';
    this.track.style.backgroundColor = this.getAttribute('background-color') || this.getAttribute('color') || '#e9e9e9';
    const span = Number(this.range.max) - Number(this.range.min);
    const progress = span > 0 ? (Number(this.range.value) - Number(this.range.min)) / span : 0;
    this.fill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    this.output.textContent = this.range.value;
    this.output.hidden = !(booleanProperty(this, 'showValue') ?? false);
  }
}


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
          const previous = this.getAttribute('value');
          this.emit('columnchange', { column: columnIndex, value: valueIndex });
          // 父级 setData 更新 range 后再刷新后续列
          setTimeout(() => {
            const next = jsonAttr(this, 'range', []) as any[][];
            const selected = jsonAttr(this, 'value', []) as number[];
            session.update(
              next.map(column => ({ values: (column ?? []).map(label) })),
              previous === this.getAttribute('value') ? undefined : selected
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
      const [hour, minute] = text ? text.split(':').map(Number) : [fallback, 0];
      return { hour: Number.isFinite(hour) ? hour : fallback, minute: Number.isFinite(minute) ? minute : 0 };
    };
    const start = parse(this.getAttribute('start'), 0);
    const end = parse(this.getAttribute('end'), 23);

    const hours: string[] = [];
    for (let hour = start.hour; hour <= end.hour; hour++) hours.push(pad2(hour));

    showPicker(overlay, {
      title,
      columns: [
        { values: hours, label: '时', defaultIndex: Math.max(0, hours.indexOf(pad2(current[0] || 0))) },
        {
          label: '分',
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
    let days = Array.from({ length: daysInMonth(year, month) }, (_, index) => pad2(index + 1));

    const columns =
      fields === 'year'
        ? [{ values: years, label: '年', defaultIndex: Math.max(0, years.indexOf(String(year))) }]
        : fields === 'month'
          ? [
              { values: years, label: '年', defaultIndex: Math.max(0, years.indexOf(String(year))) },
              { values: months, label: '月', defaultIndex: month - 1 }
            ]
          : [
              { values: years, label: '年', defaultIndex: Math.max(0, years.indexOf(String(year))) },
              { values: months, label: '月', defaultIndex: month - 1 },
              { values: days, label: '日', defaultIndex: day - 1 }
            ];

    let selectedYear = year, selectedMonth = month;
    const session = showPicker(overlay, {
      title,
      columns,
      onColumnChange: (columnIndex, valueIndex) => {
        if (fields !== 'day' || columnIndex > 1) return;
        if (columnIndex === 0) selectedYear = Number(years[valueIndex]);
        if (columnIndex === 1) selectedMonth = valueIndex + 1;
        const nextYear = selectedYear, nextMonth = selectedMonth;
        const nextDays = Array.from({ length: daysInMonth(nextYear, nextMonth) }, (_, index) => pad2(index + 1));
        setTimeout(() => {
          days = nextDays;
          session.update(
            [
              { values: years, label: '年', defaultIndex: Math.max(0, years.indexOf(String(nextYear))) },
              { values: months, label: '月', defaultIndex: nextMonth - 1 },
              { values: nextDays, label: '日', defaultIndex: 0 }
            ],
            [Math.max(0, years.indexOf(String(nextYear))), nextMonth - 1, Math.min(session.selectedIndexes()[2] ?? 0, nextDays.length - 1)]
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
        if (columnIndex >= 2) return;
        const selection = session.selectedIndexes();
        const selectedProvince = columnIndex === 0 ? valueIndex : selection[0];
        const nextProvince = provinces[selectedProvince];
        const nextCities = nextProvince?.children ?? [];
        const nextCity = columnIndex === 1 ? nextCities[valueIndex] : nextCities[0];
        const nextDistricts = nextCity?.children ?? [];
        session.update(
            level === 'city'
              ? [
                  { values: names(provinces), defaultIndex: selectedProvince },
                  { values: names(nextCities), defaultIndex: columnIndex === 1 ? valueIndex : 0 }
                ]
              : [
                  { values: names(provinces), defaultIndex: selectedProvince },
                  { values: names(nextCities), defaultIndex: columnIndex === 1 ? valueIndex : 0 },
                  { values: names(nextDistricts), defaultIndex: 0 }
                ],
            [selectedProvince, columnIndex === 1 ? valueIndex : 0, 0]
          );
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
  static observedAttributes = ['value', 'indicator-style', 'indicator-class', 'mask-style', 'mask-class'];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private columnViews = new Map<HTMLElement, { viewport: HTMLDivElement; indicator: HTMLDivElement; fade: HTMLDivElement }>();
  private resize = new ResizeObserver(() => this.syncScroll());

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.layout{display:flex;position:relative;overflow:hidden;height:100%;width:100%;contain:size}slot{display:contents}';
    const layout = document.createElement('div');
    layout.className = 'layout';
    const slot = document.createElement('slot');
    slot.addEventListener('slotchange', () => this.syncScroll());
    layout.appendChild(slot);
    shadow.append(style, layout);
  }

  connectedCallback() { this.resize.observe(this); requestAnimationFrame(() => this.syncScroll()); }
  disconnectedCallback() { this.resize.disconnect(); if (this.timer) clearTimeout(this.timer); }
  attributeChangedCallback() { if (this.isConnected) this.syncScroll(); }

  private itemHeight(): number {
    const indicator = this.columnViews.values().next().value?.indicator;
    return indicator ? parseFloat(getComputedStyle(indicator).height) || 34 : 34;
  }

  private decorationStyle(value: string | null) {
    return (value ?? '').replace(/-?\d+(?:\.\d+)?rpx/g, value => `${normalizeSize(value)}px`);
  }

  private columns(): HTMLElement[] { return Array.from(this.children).filter(node => node.tagName === 'WX-PICKER-VIEW-COLUMN') as HTMLElement[]; }

  private viewFor(column: HTMLElement) {
    const previous = this.columnViews.get(column);
    if (previous) return previous;
    const shadow = column.shadowRoot ?? column.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.viewport{height:100%;overflow-y:auto;scroll-snap-type:y mandatory;scrollbar-width:none;box-sizing:border-box;position:relative}.viewport::-webkit-scrollbar{display:none}slot{display:contents}.rows::slotted(*){height:var(--row-height,34px);scroll-snap-align:center}';
    const viewport = document.createElement('div');
    viewport.className = 'viewport';
    const rows = document.createElement('slot');
    rows.className = 'rows';
    viewport.appendChild(rows);
    viewport.addEventListener('scroll', () => this.scheduleChange());
    const fade = document.createElement('div');
    fade.slot = 'fmp-wheel-overlay';
    const indicator = document.createElement('div');
    indicator.slot = 'fmp-wheel-overlay';
    const decorations = document.createElement('slot');
    decorations.name = 'fmp-wheel-overlay';
    column.append(fade, indicator);
    shadow.append(style, viewport, decorations);
    const view = { viewport, indicator, fade };
    this.columnViews.set(column, view);
    return view;
  }

  private syncScroll() {
    if (!this.isConnected) return;
    const values = jsonAttr(this, 'value', []) as number[];
    const columns = this.columns();
    for (const [column, view] of this.columnViews) if (!columns.includes(column)) {
      view.fade.remove();
      view.indicator.remove();
      this.columnViews.delete(column);
    }
    columns.forEach(column => {
      const { indicator, fade } = this.viewFor(column);
      indicator.className = `fmp-wheel-indicator ${this.getAttribute('indicator-class') ?? ''}`;
      fade.className = `fmp-wheel-fade ${this.getAttribute('mask-class') ?? ''}`;
      indicator.style.cssText = this.decorationStyle(this.getAttribute('indicator-style'));
      fade.style.cssText = this.decorationStyle(this.getAttribute('mask-style'));
    });
    const height = this.itemHeight();
    columns.forEach((column, index) => {
      const { viewport } = this.viewFor(column);
      column.style.setProperty('--row-height', `${height}px`);
      viewport.style.paddingBlock = `${Math.max(0, (column.clientHeight - height) / 2)}px`;
      const target = (values[index] ?? 0) * height;
      if (Math.abs(viewport.scrollTop - target) > 1) viewport.scrollTop = target;
    });
  }

  private scheduleChange() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.isConnected) return;
      const height = this.itemHeight();
      const value = this.columns().map(column => Math.round(this.viewFor(column).viewport.scrollTop / height));
      this.dispatchEvent(new CustomEvent('change', { detail: { value } }));
    }, 120);
  }
}


class FmpAudio extends HTMLElement {
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
    card.className = 'fmp-audio-default';
    card.setAttribute('role', 'application');
    card.setAttribute('aria-label', '音频播放器');
    this.left.className = 'fmp-audio-left';
    this.button.className = 'fmp-audio-button play';
    this.button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#b2b2b2" stroke="#fff" stroke-width="2"/><path d="m9 6 9 6-9 6z" fill="#fff"/></svg>';
    this.left.appendChild(this.button);

    const right = document.createElement('div');
    right.className = 'fmp-audio-right';
    this.timeEl.className = 'fmp-audio-time';
    this.timeEl.textContent = '00:00';
    const info = document.createElement('div');
    info.className = 'fmp-audio-info';
    this.nameEl.className = 'fmp-audio-name';
    this.authorEl.className = 'fmp-audio-author';
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
      this.button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#b2b2b2" stroke="#fff" stroke-width="2"/><path d="m9 6 9 6-9 6z" fill="#fff"/></svg>';
      this.emit('pause');
    });
    this.audio.addEventListener('timeupdate', () => {
      this.syncTime();
      if (Math.abs(this.audio.currentTime - this.lastPublishedTime) % this.audio.duration >= 1) {
        this.emit('timeupdate', { currentTime: this.audio.currentTime, duration: this.audio.duration });

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
    this.audio.src = getTempFile(source)?.url ?? source;
    this.syncTime();
  }

  private syncTime() {
    this.timeEl.textContent = formatTime(this.audio.currentTime);
    this.audio.dataset.time = String(this.audio.currentTime);
  }
}

interface TimedDanmu { text: string; color: string; sent: boolean }


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

    this.container.className = 'fmp-video-container';
    this.container.addEventListener('fullscreenchange', event => {
      event.stopPropagation();
      this.onFullscreenChange();
    });
    this.video.setAttribute('playsinline', '');
    this.video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000';

    const bar = this.bar;
    bar.className = 'fmp-video-bar';
    const controls = document.createElement('div');
    controls.className = 'fmp-video-controls';
    const wrapper = this.progressWrapper;
    wrapper.className = 'fmp-video-progress-wrapper';
    this.currentTimeEl.className = 'fmp-video-current-time';
    this.currentTimeEl.textContent = '00:00';
    const progressContainer = this.progressContainer;
    progressContainer.className = 'fmp-video-progress-container';
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
    this.progressEl.className = 'fmp-video-progress';
    progressContainer.appendChild(this.progressEl);
    this.durationEl.className = 'fmp-video-duration';
    this.durationEl.textContent = '00:00';
    wrapper.append(this.currentTimeEl, progressContainer, this.durationEl);

    const fullscreen = this.fullscreenButton;
    fullscreen.type = 'button';
    fullscreen.className = 'fmp-video-control-button fmp-video-fullscreen';
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
      button.className = 'fmp-video-control-button fmp-video-play';
      button.addEventListener('click', togglePlayback);
    }
    this.centerPlayButton.classList.add('fmp-video-center-play');
    this.muteButton.type = 'button';
    this.muteButton.className = 'fmp-video-control-button fmp-video-mute';
    this.muteButton.addEventListener('click', event => {
      event.stopPropagation();
      this.video.muted = !this.video.muted;
      this.syncControls();
    });
    this.danmuButton.type = 'button';
    this.danmuButton.className = 'fmp-video-control-button fmp-video-danmu-btn-on';
    this.danmuButton.textContent = '弹';
    this.danmuButton.addEventListener('click', event => {
      event.stopPropagation();
      this.danmuVisible = !this.danmuVisible;
      this.syncDanmuVisibility();
    });
    controls.append(this.playButton, wrapper, this.muteButton, fullscreen);
    bar.appendChild(controls);

    this.overlayEl.className = 'fmp-video-slot';

    this.danmuLayer.className = 'fmp-video-danmu-layer';
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


  private ensureLoaded() {
    if (this.loaded) return;
    const src = this.getAttribute('src');
    if (!src) return;
    const initialTime = Number(this.getAttribute('initial-time'));
    this.pendingSeek = Number.isFinite(initialTime) ? Math.max(0, initialTime) : 0;
    this.video.src = getTempFile(src)?.url ?? src;
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
    this.danmuButton.classList.toggle('fmp-video-danmu-btn-off', !this.danmuVisible);
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
    node.className = 'fmp-video-danmu-item';
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
    const playable = !!this.getAttribute('src');
    this.playButton.style.display = playable && (booleanProperty(this, 'show-play-btn') ?? true) ? '' : 'none';
    this.centerPlayButton.style.display = playable && controls && paused && (booleanProperty(this, 'show-center-play-btn') ?? true) ? '' : 'none';
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
  static observedAttributes = [
    'current',
    'autoplay',
    'interval',
    'circular',
    'vertical',
    'indicator-dots',
    'duration',
    'display-multiple-items',
    'previous-margin',
    'next-margin',
    'indicator-color',
    'indicator-active-color'
  ];

  private viewport = document.createElement('div');
  private surface = document.createElement('div');
  private extentMarker = document.createElement('div');
  private resize = new ResizeObserver(() => { this.syncStyle(); this.applyCurrent(false); });
  private internalCurrent = false;
  private transitionEpoch = 0;
  private controlledIndex: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private dots: HTMLElement | null = null;
  private drag?: { id: number; start: number; offset: number };

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = '.surface{position:relative;width:100%;height:100%}.viewport{position:relative;width:100%;height:100%;overflow:auto;scrollbar-width:none}.viewport::-webkit-scrollbar{display:none}slot{display:contents}.dots{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:flex;gap:8px;font-size:0;pointer-events:none}.dots.vertical{left:auto;bottom:auto;right:10px;top:50%;transform:translateY(-50%);flex-direction:column;gap:9px}.dot{width:8px;height:8px;border-radius:50%;background:rgba(0,0,0,.3)}';
    this.surface.className = 'surface';
    this.viewport.className = 'viewport';
    this.viewport.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      const vertical = this.hasAttribute('vertical');
      this.drag = { id: event.pointerId, start: vertical ? event.clientY : event.clientX, offset: vertical ? this.viewport.scrollTop : this.viewport.scrollLeft };
      this.viewport.style.scrollSnapType = 'none';
      this.viewport.setPointerCapture(event.pointerId);
    });
    this.viewport.addEventListener('pointermove', event => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      const vertical = this.hasAttribute('vertical');
      this.viewport[vertical ? 'scrollTop' : 'scrollLeft'] = this.drag.offset + this.drag.start - (vertical ? event.clientY : event.clientX);
      event.preventDefault();
    });
    const endDrag = (event: PointerEvent) => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      this.drag = undefined;
      const vertical = this.hasAttribute('vertical');
      const size = this.itemExtent();
      const offset = vertical ? this.viewport.scrollTop : this.viewport.scrollLeft;
      this.viewport.style.scrollSnapType = vertical ? 'y mandatory' : 'x mandatory';
      this.viewport.scrollTo({ [vertical ? 'top' : 'left']: Math.round(offset / size) * size, behavior: 'smooth' });
      this.syncAutoplay();
    };
    this.viewport.addEventListener('pointerup', endDrag);
    this.viewport.addEventListener('pointercancel', endDrag);
    const slot = document.createElement('slot');
    slot.addEventListener('slotchange', () => { this.syncStyle(); this.syncDots(); this.applyCurrent(false); });
    this.extentMarker.style.cssText = 'position:absolute;width:1px;height:1px;pointer-events:none';
    this.viewport.append(slot, this.extentMarker);
    this.surface.appendChild(this.viewport);
    shadow.append(style, this.surface);
  }

  connectedCallback() {
    if (!elementStates.swiperReady.has(this)) {
      elementStates.swiperReady.add(this);
      this.viewport.addEventListener('scroll', () => {
        if (this.scrollTimer) clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => this.settle(), 120);
      });
      this.syncStyle();
      this.syncDots();
      requestAnimationFrame(() => this.applyCurrent(false));
    }
    this.resize.observe(this);
    this.syncAutoplay();
  }

  disconnectedCallback() {
    this.resize.disconnect();
    this.drag = undefined;
    this.transitionEpoch++;
    this.controlledIndex = null;
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null) {
    this.syncStyle();
    if (elementStates.swiperReady.has(this)) {
      const index = Number(value) || 0;
      if (name === 'current' && previous !== value && !this.internalCurrent && this.items()[index]) {
        const epoch = ++this.transitionEpoch;
        this.controlledIndex = index;
        this.dispatchEvent(new CustomEvent('change', { detail: { current: index, source: '' } }));
        this.applyCurrent(true);
        const finish = () => {
          if (!this.isConnected || epoch !== this.transitionEpoch) return;
          const target = this.items()[index];
          if (!target) return;
          const vertical = this.hasAttribute('vertical');
          const offset = index * this.itemExtent();
          const position = vertical ? this.viewport.scrollTop : this.viewport.scrollLeft;
          if (Math.abs(position - offset) > 1) {
            requestAnimationFrame(finish);
            return;
          }
          this.controlledIndex = null;
          this.dispatchEvent(new CustomEvent('animationfinish', { detail: { current: index, source: '' } }));
        };
        requestAnimationFrame(finish);
      } else this.applyCurrent(false);
    }
    this.syncDots();
    this.syncAutoplay();
  }

  private syncDots() {
    if (!this.hasAttribute('indicator-dots')) {
      this.dots?.remove();
      this.dots = null;
      return;
    }
    if (!this.dots) {
      this.dots = document.createElement('div');
      this.dots.className = 'dots';
      this.surface.appendChild(this.dots);
    }
    this.dots.classList.toggle('vertical', this.hasAttribute('vertical'));
    const current = Number(this.getAttribute('current') ?? 0) || 0;
    const color = this.getAttribute('indicator-color') ?? 'rgba(0,0,0,.3)';
    const activeColor = this.getAttribute('indicator-active-color') ?? '#000';
    this.dots.replaceChildren(
      ...this.items().map((_, index) => {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = index === current ? activeColor : color;
        return dot;
      })
    );
  }

  private items(): HTMLElement[] {
    return Array.from(this.children).filter(node => node.tagName === 'WX-SWIPER-ITEM') as HTMLElement[];
  }

  private visibleCount() { return Math.max(1, Number(this.getAttribute('display-multiple-items') ?? 1) || 1); }

  private itemExtent() {
    const length = this.hasAttribute('vertical') ? this.viewport.clientHeight : this.viewport.clientWidth;
    return Math.max(1, (length - normalizeSize(this.getAttribute('previous-margin') ?? 0) - normalizeSize(this.getAttribute('next-margin') ?? 0)) / this.visibleCount());
  }

  private syncStyle() {
    const vertical = this.hasAttribute('vertical');
    this.viewport.style.overflowY = vertical ? 'auto' : 'hidden';
    this.viewport.style.overflowX = vertical ? 'hidden' : 'auto';
    this.viewport.style.scrollSnapType = this.drag ? 'none' : vertical ? 'y mandatory' : 'x mandatory';
    const size = this.itemExtent();
    const previous = normalizeSize(this.getAttribute('previous-margin') ?? 0);
    const next = normalizeSize(this.getAttribute('next-margin') ?? 0);
    this.items().forEach((item, index) => {
      item.style.width = vertical ? '100%' : `${size}px`;
      item.style.height = vertical ? `${size}px` : '100%';
      item.style.left = vertical ? '0' : `${previous + index * size}px`;
      item.style.top = vertical ? `${previous + index * size}px` : '0';
      item.style.scrollSnapAlign = 'start';
      item.style.scrollMarginLeft = vertical ? '0' : `${previous}px`;
      item.style.scrollMarginTop = vertical ? `${previous}px` : '0';
    });
    const end = Math.max(0, previous + this.items().length * size + next - 1);
    this.extentMarker.style.left = vertical ? '0' : `${end}px`;
    this.extentMarker.style.top = vertical ? `${end}px` : '0';
  }

  private applyCurrent(smooth = true) {
    const index = Number(this.getAttribute('current') ?? 0) || 0;
    const target = this.items()[index];
    if (!target) return;
    const vertical = this.hasAttribute('vertical');
    this.viewport.scrollTo({ [vertical ? 'top' : 'left']: index * this.itemExtent(), behavior: smooth ? 'smooth' : 'auto' });
  }

  private settle() {
    const vertical = this.hasAttribute('vertical');
    const size = this.itemExtent();
    if (!size) return;
    const index = Math.round((vertical ? this.viewport.scrollTop : this.viewport.scrollLeft) / size);
    if (this.controlledIndex !== null) return;
    if (String(index) === this.getAttribute('current')) return;
    this.internalCurrent = true;
    this.setAttribute('current', String(index));
    this.internalCurrent = false;
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
      this.internalCurrent = true;
      this.setAttribute('current', String(next));
      this.internalCurrent = false;
      this.applyCurrent(true);
      this.syncDots();
      this.dispatchEvent(new CustomEvent('change', { detail: { current: next, source: 'autoplay' } }));
      this.dispatchEvent(new CustomEvent('animationfinish', { detail: { current: next, source: 'autoplay' } }));
    }, interval);
  }
}


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
  'wx-audio': FmpAudio,
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
wx-audio { display: inline-block; line-height: 0; }
.fmp-audio-default { display: flex; width: 304px; height: 67px; border: 1px solid #e0e0e0; border-radius: 2.5px; background: #fcfcfc; box-sizing: border-box; overflow: hidden; line-height: normal; }
.fmp-audio-left { position: relative; flex: none; width: 65px; height: 65px; background: #e6e6e6 center / 100% 100% no-repeat; }
.fmp-audio-button { position: absolute; left: 50%; top: 50%; width: 24px; height: 24px; margin: -12px 0 0 -12px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
.fmp-audio-right { position: relative; flex: 1; min-width: 0; padding: 11px 16.5px 13.5px 15px; box-sizing: border-box; }
.fmp-audio-time { position: absolute; right: 16.5px; top: 11px; font-size: 12px; color: #888; }
.fmp-audio-info { padding-top: 0; }
.fmp-audio-name { font-size: 14px; color: #353535; line-height: 23px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fmp-audio-author { font-size: 12px; color: #888; line-height: 15px; }
wx-video { display: inline-block; position: relative; overflow: hidden; width: 300px; height: 225px; line-height: 0; }
.fmp-video-container { position: absolute; inset: 0; background: #000; overflow: hidden; }
.fmp-video-slot { position: absolute; inset: 0; pointer-events: none; }
.fmp-video-slot > * { pointer-events: auto; }
.fmp-video-danmu-layer { position: absolute; inset: 0; margin-bottom: 60px; overflow: hidden; pointer-events: none; }
.fmp-video-bar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; display: flex; height: 48px; padding: 0 16px; box-sizing: border-box; }
.fmp-video-controls { display: flex; align-items: center; justify-content: space-between; flex: 1; height: 38px; min-width: 0; }
.fmp-video-progress-wrapper { flex: 1; display: flex; align-items: center; height: 38px; min-width: 0; }
.fmp-video-current-time, .fmp-video-duration { font-size: 14px; line-height: 24px; color: rgba(255,255,255,.5); white-space: nowrap; }
.fmp-video-progress-container { flex: 1; display: flex; align-items: center; height: 38px; margin: 0 8px; min-width: 0; cursor: pointer; }
.fmp-video-progress { position: relative; width: 100%; height: 4px; border-radius: 20px; background: rgba(217,217,217,.1); }
.fmp-video-progress::after { content: ''; position: absolute; left: calc(var(--fmp-video-progress, 0) * 100%); top: 50%; width: 8px; height: 8px; border-radius: 50%; background: #fff; transform: translate(-50%, -50%); }
.fmp-video-control-button { display: flex; flex: none; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 0; color: rgba(255,255,255,.5); background: transparent; cursor: pointer; }
.fmp-video-center-play { position: absolute; left: 50%; top: 50%; z-index: 1; transform: translate(-50%, -50%); border-radius: 50%; width: 48px; height: 48px; background: rgba(0,0,0,.5); }
wx-movable-area { position: relative; display: block; width: 10px; height: 10px; overflow: visible; }
wx-movable-view { position: absolute; display: block; width: 10px; height: 10px; }
wx-swiper { display: block; height: 150px; }
wx-swiper-item { display: block; position: absolute; width: 100%; height: 100%; overflow: hidden; }
wx-map { position: relative; overflow: visible; width: 300px; height: 150px; background: transparent; }
.wx-map-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.wx-map-attr { position: absolute; left: 8px; bottom: 6px; z-index: 1; pointer-events: none; display: flex; align-items: center; gap: 4px; font-size: 10px; color: #8a8a8a; }
.wx-map-logo { padding: 1px 4px; border-radius: 2px; background: #1a8cff; color: #fff; font-size: 10px; }
wx-camera { position: relative; overflow: hidden; background: #808080; }
.wx-camera-placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,.85); font-size: 14px; }
wx-page { display: block; position: absolute; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; font-family: initial; font-size: 16px; }
wx-custom-tab-bar { font-family: initial; font-size: 16px; }
wx-view, wx-picker, wx-picker-view, wx-picker-view-column, wx-radio-group, wx-checkbox-group,
wx-custom-tab-bar, wx-movable-area, wx-movable-view, wx-map, wx-camera,
wx-web-view, wx-editor, wx-cover-view, wx-scroll-view { display: block; }
wx-picker-view-column { position: relative; overflow: hidden; height: 100%; flex: 1; z-index: 0; min-width: 0; contain: size; }
.fmp-wheel-indicator { position: absolute; height: 34px; top: 50%; left: 0; right: 0; transform: translateY(-50%); pointer-events: none; box-sizing: border-box; border-block: 1px solid #e5e5e5; }
.fmp-wheel-fade { position: absolute; inset: 0; pointer-events: none; background: linear-gradient(#fff, transparent 45%, transparent 55%, #fff); }
wx-form { display: inline; }
wx-canvas { display: none; position: relative; }
wx-canvas[canvas-id], wx-canvas[type] { display: block; width: 300px; height: 150px; }
wx-text, wx-label { display: inline; }
wx-scroll-view { -webkit-overflow-scrolling: touch; }
wx-scroll-view[scroll-y] { overflow-y: auto; }
wx-scroll-view[scroll-x] { overflow-x: auto; }
wx-scroll-view[scroll-y][scroll-x] { overflow: auto; }
wx-image { display: inline-block; overflow: hidden; width: 320px; height: 240px; }
wx-image > img { width: 100%; height: 100%; display: block; }
wx-input { display: block; height: 22.4px; min-height: 22.4px; overflow: hidden; white-space: nowrap; }
wx-textarea { display: block; width: 300px; height: 150px; position: relative; overflow: hidden; }
wx-editor { display: block; position: relative; box-sizing: border-box; height: 200px; overflow: hidden; }
wx-slider { display: block; margin: 10px 18px; height: 18px; }
wx-switch { display: inline-block; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.fmp-switch-control { appearance: none; -webkit-appearance: none; display: inline-block; vertical-align: middle; width: 52px; height: 32px; margin: 0 5px 0 0; padding: 0; box-sizing: border-box; border: 2px solid transparent; border-radius: 16px; outline: 0; position: relative; background: rgba(0,0,0,.1); cursor: inherit; transition: background-color .1s,border-color .1s; }
.fmp-switch-control::after { content: ''; position: absolute; top: 0; left: 0; width: 28px; height: 28px; border-radius: 50%; background: #fff; box-shadow: 0 2px 3px rgba(0,0,0,.06); transition: transform .3s; }
.fmp-switch-control:checked { background: var(--fmp-switch-color); border-color: var(--fmp-switch-color); }
.fmp-switch-control:checked::after { transform: translateX(20px); }
.fmp-switch-control:disabled { opacity: .3; cursor: default; }
wx-switch[type="checkbox"] .fmp-switch-control { width: 24px; height: 24px; border: 1px solid #d1d1d1; border-radius: 3px; background: #fff; color: var(--fmp-switch-color); }
wx-switch[type="checkbox"] .fmp-switch-control::after { display: none; }
wx-switch[type="checkbox"] .fmp-switch-control:checked::after { display: block; width: 6px; height: 11px; top: 3px; left: 7px; border-radius: 0; border: solid currentColor; border-width: 0 2px 2px 0; background: transparent; box-shadow: none; transform: rotate(45deg); }
wx-switch[type="checkbox"] .fmp-switch-control:disabled { opacity: 1; background: #e1e1e1; color: #adadad; }
.fmp-switch-control:focus-visible { outline: 2px solid #576b95; outline-offset: 2px; }
.fmp-slider-row { display: flex; align-items: center; min-height: 16px; }
.fmp-slider-control { flex: 1; min-width: 0; height: 18px; position: relative; --fmp-slider-size: 28px; --fmp-slider-block-color: #fff; }
.fmp-slider-track { position: absolute; top: 8px; left: 0; right: 0; height: 2px; border-radius: 5px; background: #e9e9e9; }
.fmp-slider-fill { height: 100%; border-radius: 6px; background: #1aad19; }
.fmp-slider-input { appearance: none; -webkit-appearance: none; display: block; position: absolute; left: calc(var(--fmp-slider-size) * -.5); top: 0; width: calc(100% + var(--fmp-slider-size)); height: 18px; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; cursor: pointer; }
.fmp-slider-input::-webkit-slider-runnable-track { height: 2px; background: transparent; }
.fmp-slider-input::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: var(--fmp-slider-size); height: var(--fmp-slider-size); margin-top: calc((2px - var(--fmp-slider-size)) / 2); border: 0; border-radius: 50%; background: var(--fmp-slider-block-color); box-shadow: 0 0 4px rgba(0,0,0,.2); }
.fmp-slider-input::-moz-range-track { height: 2px; background: transparent; }
.fmp-slider-input::-moz-range-thumb { width: var(--fmp-slider-size); height: var(--fmp-slider-size); border: 0; border-radius: 50%; background: var(--fmp-slider-block-color); box-shadow: 0 0 4px rgba(0,0,0,.2); }
.fmp-slider-input:disabled { cursor: default; }
.fmp-slider-input:focus-visible { outline: 2px solid #576b95; outline-offset: 3px; }
.fmp-slider-value { flex: none; color: #888; font-size: 14px; margin-left: 1em; text-align: center; }
[hidden] { display: none !important; }
wx-navigator { display: block; }
wx-web-view { height: 100%; }
wx-button {
  display: block; position: relative; box-sizing: border-box; margin: 0 auto;
  width: 184px; padding: 8px 24px; min-height: 40px; line-height: 24px;
  font-size: 17px; font-weight: 700;
  text-align: center; text-decoration: none; border-radius: 4px; overflow: hidden;
  color: #000; background: #f8f8f8; border: 0;
  -webkit-tap-highlight-color: transparent; cursor: pointer;
}
wx-button::after { content: ''; position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity .15s; pointer-events: none; }
wx-button:active::after { opacity: .1; }
wx-button[size="mini"] { display: inline-block; width: auto; min-height: 32px; padding: 0 12px; line-height: 32px; font-size: 16px; }
wx-button[type="default"] { background: #f2f2f2; color: #06ae56; }
wx-button[type="primary"] { background: #07c160; color: #fff; }
wx-button[type="warn"] { background: #f2f2f2; color: #fa5151; }
wx-button[plain] { background: transparent; color: #353535; border: 1px solid #353535; }
wx-button[type="primary"][plain] { background: transparent; color: #07c160; border: 1px solid #07c160; }
wx-button[type="warn"][plain] { background: transparent; color: #fa5151; border: 1px solid #fa5151; }
wx-button[type="primary"][disabled], wx-button[type="warn"][disabled], wx-button[type="default"][disabled] { background: #fafafa; color: rgba(0,0,0,.18); }
wx-button[disabled] { background: #fafafa; color: rgba(0,0,0,.18); cursor: default; }
${CONTROL_CSS}
${BUILTIN_HOST_CSS}
`;
