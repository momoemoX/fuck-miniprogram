/**
 * 系统弹层：toast / modal / actionSheet / picker
 *
 * DOM 结构与类名和 packages/core/src/runtime/host/ui/PhoneShell.ts 一致，
 * 这样自研引擎和官方基础库链路的弹层看起来、量起来都一样。
 */

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
    const dim = mask(true);
    const sheet = element('div', 'fmp-actionsheet');
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
  /** 列定义变化后（联动）刷新后续列 */
  update: (columns: PickerColumn[], indexes?: number[]) => void;
}

/**
 * 滚轮选择器：列可以联动（某一列滚动后返回新的列定义）。
 * DOM 结构与类名对齐官方内部实现，弹层外观才一致。
 */
export function showPicker(overlay: HTMLElement, options: PickerOptions): PickerSession {
  const wrapper = document.createElement('div');
  wrapper.className = 'fmp-picker-layer';

  const dim = mask(true);
  const panel = element('div', 'fmp-picker');

  const header = element('div', 'fmp-picker-header');
  const cancel = element('button', 'fmp-picker-cancel', options.cancelText || '取消');
  const confirm = element('button', 'fmp-picker-confirm', options.confirmText || '确定');
  header.append(cancel, confirm);

  const body = element('div', 'fmp-picker-body');
  body.append(element('div', 'fmp-picker-mask'), element('div', 'fmp-picker-indicator'));

  let columns = options.columns.map(column => ({ ...column }));
  let indexes = columns.map(column => Math.min(Math.max(column.defaultIndex ?? 0, 0), Math.max(column.values.length - 1, 0)));
  let timer: ReturnType<typeof setTimeout> | null = null;

  const build = (from = 0) => {
    for (const node of Array.from(body.querySelectorAll('.fmp-picker-column'))) node.remove();

    columns.forEach((column, index) => {
      if (index < from) return;
      const list = element('div', 'fmp-picker-column');
      column.values.forEach((value, valueIndex) => {
        const item = element('div', 'fmp-picker-item', value);
        item.dataset.index = String(valueIndex);
        item.addEventListener('click', () => {
          list.scrollTo({ top: valueIndex * PICKER_ITEM_HEIGHT, behavior: 'smooth' });
        });
        list.appendChild(item);
      });
      list.dataset.index = String(index);
      list.addEventListener('scroll', () => {
        const at = Math.round(list.scrollTop / PICKER_ITEM_HEIGHT);
        const next = Math.min(Math.max(at, 0), Math.max(column.values.length - 1, 0));
        if (next === indexes[index]) return;
        indexes[index] = next;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const updated = options.onColumnChange?.(index, next);
          if (updated) {
            const keep = indexes.slice(0, index + 1);
            columns = updated.map(col => ({ ...col }));
            indexes = columns.map((col, i) => (i < keep.length ? Math.min(keep[i], Math.max(col.values.length - 1, 0)) : Math.min(col.defaultIndex ?? 0, Math.max(col.values.length - 1, 0))));
            build(index + 1);
          }
        }, 80);
      });
      columns[index] = column;
      body.appendChild(list);
      requestAnimationFrame(() => {
        list.scrollTop = indexes[index] * PICKER_ITEM_HEIGHT;
      });
    });
  };

  build();
  panel.append(header, body);
  wrapper.append(dim, panel);
  overlay.appendChild(wrapper);

  const close = () => wrapper.remove();
  dim.addEventListener('click', () => {
    close();
    options.onCancel?.();
  });
  cancel.addEventListener('click', () => {
    close();
    options.onCancel?.();
  });
  confirm.addEventListener('click', () => {
    const result = indexes.slice();
    close();
    options.onConfirm(result);
  });

  return {
    close,
    update: (next, nextIndexes) => {
      columns = next.map(column => ({ ...column }));
      indexes = columns.map((column, index) => {
        const wanted = nextIndexes?.[index] ?? (index === 0 ? indexes[index] : column.defaultIndex ?? 0);
        return Math.min(Math.max(wanted ?? 0, 0), Math.max(column.values.length - 1, 0));
      });
      build(0);
    }
  };
}

export { PICKER_ITEM_HEIGHT };
