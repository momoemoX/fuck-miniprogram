export interface ToastOptions {
  title?: string;
  icon?: 'success' | 'error' | 'loading' | 'none';
  image?: string;
  duration?: number;
  mask?: boolean;
}

export interface ModalOptions {
  title?: string;
  content?: string;
  showCancel?: boolean;
  cancelText?: string;
  cancelColor?: string;
  confirmText?: string;
  confirmColor?: string;
  editable?: boolean;
  placeholderText?: string;
}

export interface ActionSheetOptions {
  alertText?: string;
  itemList: string[];
  itemColor?: string;
}

export interface PickerColumn {
  values: string[];
  defaultIndex?: number;
  label?: string;
}

export interface PickerOptions {
  title?: string;
  columns: PickerColumn[];
  confirmText?: string;
  cancelText?: string;
  /** 某列滚动后回调，返回新的列定义表示需要联动 */
  onColumnChange?: (columnIndex: number, valueIndex: number) => PickerColumn[] | void;
  onConfirm: (indexes: number[]) => void;
  onCancel?: () => void;
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function mask(dim: boolean): HTMLElement {
  return element('div', 'fmp-mask' + (dim ? ' is-dim' : ''));
}

/* ------------------------------------------------------------------ toast */

export interface ToastHandle {
  hide: () => void;
}

export function showToast(overlay: HTMLElement, options: ToastOptions): ToastHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const wrapper = document.createElement('div');
  wrapper.className = 'fmp-toast-wrapper';
  if (options.mask) wrapper.appendChild(mask(false));

  const icon = options.image ? 'image' : options.icon || 'success';
  const toast = element('div', 'fmp-toast' + (icon === 'none' ? '' : ' has-icon'));
  toast.setAttribute('role', 'alert');
  if (icon === 'loading') {
    toast.appendChild(element('div', 'fmp-toast-spinner'));
  } else if (icon === 'image') {
    const img = document.createElement('img');
    img.src = options.image!;
    img.width = img.height = 40;
    toast.appendChild(img);
  } else if (icon !== 'none') {
    toast.appendChild(element('div', 'fmp-toast-icon', icon === 'error' ? '✕' : '✓'));
  }
  toast.appendChild(element('div', 'fmp-toast-title', options.title || ''));
  wrapper.appendChild(toast);
  overlay.appendChild(wrapper);

  const hide = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    wrapper.remove();
  };

  if (icon !== 'loading' || options.duration) {
    timer = setTimeout(hide, options.duration ?? 1500);
  }
  return { hide };
}

/* ------------------------------------------------------------------ modal */

export function showModal(
  overlay: HTMLElement,
  options: ModalOptions
): Promise<{ confirm: boolean; cancel: boolean; content?: string }> {
  return new Promise(resolve => {
    const wrapper = document.createElement('div');
    wrapper.appendChild(mask(true));
    const modal = element('div', 'fmp-modal');
    modal.setAttribute('role', 'dialog');
    if (options.title) modal.appendChild(element('div', 'fmp-modal-title', options.title));
    if (options.content && !options.editable) modal.appendChild(element('div', 'fmp-modal-content', options.content));

    let input: HTMLInputElement | null = null;
    if (options.editable) {
      input = document.createElement('input');
      input.className = 'fmp-modal-input';
      input.value = options.content || '';
      input.placeholder = options.placeholderText || '';
      modal.appendChild(input);
    }

    const actions = element('div', 'fmp-modal-actions');
    const close = (confirm: boolean) => {
      wrapper.remove();
      resolve({ confirm, cancel: !confirm, ...(options.editable ? { content: input!.value } : {}) });
    };
    if (options.showCancel !== false) {
      const cancel = element('button', 'fmp-modal-cancel', options.cancelText || '取消');
      cancel.style.color = options.cancelColor || '#000';
      cancel.addEventListener('click', () => close(false));
      actions.appendChild(cancel);
    }
    const confirm = element('button', 'fmp-modal-confirm', options.confirmText || '确定');
    confirm.style.color = options.confirmColor || '#576b95';
    confirm.addEventListener('click', () => close(true));
    actions.appendChild(confirm);
    modal.appendChild(actions);

    wrapper.appendChild(modal);
    overlay.appendChild(wrapper);
    input?.focus();
  });
}

/* ------------------------------------------------------------- actionSheet */

export function showActionSheet(overlay: HTMLElement, options: ActionSheetOptions): Promise<number | null> {
  return new Promise(resolve => {
    const wrapper = document.createElement('div');
    wrapper.className = 'fmp-dialog-layer';
    const dim = mask(true);
    const sheet = element('div', 'fmp-actionsheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', '操作菜单');
    const close = (index: number | null) => {
      wrapper.remove();
      resolve(index);
    };

    if (options.alertText) sheet.appendChild(element('div', 'fmp-actionsheet-alert', options.alertText));
    options.itemList.forEach((text, index) => {
      const button = element('button', 'fmp-actionsheet-item', text);
      button.style.color = options.itemColor || '#000';
      button.addEventListener('click', () => close(index));
      sheet.appendChild(button);
    });
    const cancel = element('button', 'fmp-actionsheet-cancel', '取消');
    cancel.addEventListener('click', () => close(null));
    sheet.appendChild(cancel);
    dim.addEventListener('click', () => close(null));

    wrapper.append(dim, sheet);
    overlay.appendChild(wrapper);
  });
}

/* ----------------------------------------------------------------- picker */

const PICKER_ITEM_HEIGHT = 48;

export interface PickerSession {
  close: () => void;
  selectedIndexes: () => number[];
  /** 列定义变化后（联动）刷新后续列 */
  update: (columns: PickerColumn[], indexes?: number[]) => void;
}

export function showPicker(overlay: HTMLElement, options: PickerOptions): PickerSession {
  const wrapper = element('div', 'fmp-picker-layer fmp-dialog-layer');
  const dim = mask(true);
  const panel = element('div', 'fmp-picker');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', options.title || '选择器');
  const header = element('div', 'fmp-picker-header');
  const cancel = element('button', 'fmp-picker-cancel', options.cancelText || '取消');
  const confirm = element('button', 'fmp-picker-confirm', options.confirmText || '确定');
  header.append(cancel, confirm);
  const body = element('div', 'fmp-picker-body');
  body.append(element('div', 'fmp-picker-mask'), element('div', 'fmp-picker-indicator'));
  let columns = options.columns.map(column => ({ ...column }));
  const clamp = (value: number, index: number) => Math.min(Math.max(value, 0), Math.max(columns[index].values.length - 1, 0));
  let indexes = columns.map((column, index) => clamp(column.defaultIndex ?? 0, index));
  let closed = false;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const notify = (index: number) => {
    if (closed) return;
    const updated = options.onColumnChange?.(index, indexes[index]);
    if (updated) {
      columns = updated.map(column => ({ ...column }));
      indexes = columns.map((column, i) => clamp(i <= index ? indexes[i] : column.defaultIndex ?? 0, i));
      build(index + 1);
    }
  };
  const build = (from = 0) => {
    for (const [index, timer] of timers) if (index >= from) { clearTimeout(timer); timers.delete(index); }
    for (const node of Array.from(body.querySelectorAll('.fmp-picker-column')).slice(from)) node.remove();
    columns.forEach((column, index) => {
      if (index < from) return;
      const list = element('div', 'fmp-picker-column');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', column.label || `第${index + 1}列`);
      const paint = () => {
        Array.from(list.children).forEach((item, i) => item.setAttribute('aria-selected', String(i === indexes[index])));
      };
      const select = (next: number) => {
        clearTimeout(timers.get(index));
        const changed = next !== indexes[index];
        indexes[index] = clamp(next, index);
        list.scrollTop = indexes[index] * PICKER_ITEM_HEIGHT;
        paint();
        if (changed) notify(index);
      };
      column.values.forEach((value, valueIndex) => {
        const item = element('div', 'fmp-picker-item', value);
        item.setAttribute('role', 'option');
        if (column.label) item.setAttribute('aria-label', `${value}${column.label}`);
        item.addEventListener('click', () => select(valueIndex));
        list.appendChild(item);
      });
      list.addEventListener('scroll', () => {
        if (closed || !list.isConnected) return;
        const next = clamp(Math.round(list.scrollTop / PICKER_ITEM_HEIGHT), index);
        if (next === indexes[index]) return;
        indexes[index] = next;
        paint();
        clearTimeout(timers.get(index));
        timers.set(index, setTimeout(() => notify(index), 80));
      });
      body.appendChild(list);
      paint();
      list.scrollTop = indexes[index] * PICKER_ITEM_HEIGHT;
    });
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    wrapper.remove();
  };
  dim.addEventListener('click', () => { close(); options.onCancel?.(); });
  cancel.addEventListener('click', () => { close(); options.onCancel?.(); });
  confirm.addEventListener('click', () => { const result = indexes.slice(); close(); options.onConfirm(result); });
  panel.append(header, body);
  wrapper.append(dim, panel);
  overlay.appendChild(wrapper);
  build();
  return {
    close,
    selectedIndexes: () => indexes.slice(),
    update: (next, nextIndexes) => {
      if (closed) return;
      const previous = columns;
      const previousIndexes = indexes;
      let from = 0;
      while (from < Math.min(previous.length, next.length) &&
        previous[from].label === next[from].label &&
        previous[from].values.length === next[from].values.length &&
        previous[from].values.every((value, index) => value === next[from].values[index])) from++;
      columns = next.map(column => ({ ...column }));
      indexes = columns.map((column, index) => clamp(nextIndexes?.[index] ?? indexes[index] ?? column.defaultIndex ?? 0, index));
      Array.from(body.querySelectorAll<HTMLElement>('.fmp-picker-column')).slice(0, from).forEach((list, index) => {
        Array.from(list.children).forEach((item, i) => item.setAttribute('aria-selected', String(i === indexes[index])));
        if (previousIndexes[index] !== indexes[index]) list.scrollTop = indexes[index] * PICKER_ITEM_HEIGHT;
      });
      build(from);
    }
  };
}

export { PICKER_ITEM_HEIGHT };
