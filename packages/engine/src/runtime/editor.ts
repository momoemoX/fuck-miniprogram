import Quill, { Delta } from 'quill';
import coreStyle from 'quill/dist/quill.core.css';
import { deliver } from './api/util';
import { prefixCss } from '../css';
import { pageRect } from './geometry';
import { createVirtualHost, disposeVirtualHost } from './hosts';
import { refreshVirtualEvents } from './events';
import type { RenderRange } from './range';
import { blobFromPath } from './api/temp-files';
import { fileData } from './api/file-codecs';
import { readImageMetadata } from './api/image-metadata';
import type { ContextShape } from './contexts';

const BlockEmbed = Quill.import('blots/block/embed') as any;
const Inline = Quill.import('blots/inline') as any;
class TaggedInline extends Inline {
  static formats(node: HTMLElement) {
    return node.tagName.toLowerCase();
  }
}
class Bold extends TaggedInline {
  static blotName = 'bold';
  static tagName = ['STRONG', 'B'];
}
class Italic extends TaggedInline {
  static blotName = 'italic';
  static tagName = ['EM', 'I'];
}
class Strike extends TaggedInline {
  static blotName = 'strike';
  static tagName = ['DEL', 'S', 'STRIKE'];
}
class Inserted extends Inline {
  static blotName = 'ins';
  static tagName = 'INS';
}
const Image = Quill.import('formats/image') as any;
class EditorImage extends Image {
  static sanitize(url: string) {
    return url.startsWith('blob:') ? url : super.sanitize(url);
  }
  static formats(node: HTMLElement) {
    const formats = super.formats(node);
    for (const name of ['class', 'data-local', 'data-custom']) if (node.hasAttribute(name)) formats[name] = node.getAttribute(name);
    return formats;
  }
  format(name: string, value: any) {
    if (name === 'class' || name === 'data-local' || name === 'data-custom') {
      if (value) this.domNode.setAttribute(name, value);
      else this.domNode.removeAttribute(name);
    } else super.format(name, value);
  }
}
class Divider extends BlockEmbed {
  static blotName = 'divider';
  static tagName = 'HR';
}
const customBlocks = new WeakMap<HTMLElement, { blockId: string; editorId: number }>();
const editorCounters = new WeakMap<Element, number>();
class CustomBlock extends BlockEmbed {
  static blotName = 'customBlock';
  static tagName = 'WX-EDITOR-CUSTOM-BLOCK';
  static create(value: { blockId: string; editorId: number }) {
    const node = super.create() as HTMLElement;
    node.className = value.blockId;
    node.contentEditable = 'false';
    node.style.display = 'block';
    customBlocks.set(node, { ...value });
    return node;
  }
  static value(node: HTMLElement) {
    return customBlocks.get(node) ?? { blockId: node.className, editorId: 0 };
  }
}
Quill.register(Divider);
Quill.register(CustomBlock);
Quill.register(
  { 'formats/bold': Bold, 'formats/italic': Italic, 'formats/strike': Strike, 'formats/ins': Inserted, 'formats/image': EditorImage },
  true
);
const { StyleAttributor, Scope } = Quill.import('parchment') as any;
const ColorStyle = Quill.import('attributors/style/color') as any;
const inlineStyles = ['font', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontFamily', 'letterSpacing', 'textDecoration'];
const blockStyles = [
  'align',
  'direction',
  'margin',
  'marginTop',
  'marginBottom',
  'marginLeft',
  'marginRight',
  'padding',
  'paddingTop',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'lineHeight',
  'textIndent',
  'wordWrap',
  'wordBreak',
  'whiteSpace'
];
for (const name of [...inlineStyles, ...blockStyles]) {
  const cssName = name === 'align' ? 'text-align' : name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
  Quill.register(new StyleAttributor(name, cssName, { scope: blockStyles.includes(name) ? Scope.BLOCK : Scope.INLINE }), true);
}
Quill.register(new ColorStyle.constructor('backgroundColor', 'background-color', { scope: Scope.INLINE }), true);
const formats = [
  'bold',
  'italic',
  'underline',
  'strike',
  'ins',
  'script',
  'header',
  'indent',
  'list',
  'color',
  'backgroundColor',
  'link',
  'image',
  'divider',
  'customBlock',
  ...inlineStyles,
  ...blockStyles
];

export const EDITOR_CSS =
  prefixCss(coreStyle, 'wx-editor ') +
  `
wx-editor { display:block; height:300px; }
wx-editor .ql-container { font:inherit; }
wx-editor .ql-editor { padding:0; min-height:200px; line-height:normal; }
wx-editor .ql-editor.ql-blank::before { left:0; right:0; font-style:normal; }
wx-editor-portal { display:none; }
`;

export class WxEditor extends HTMLElement {
  static observedAttributes = ['read-only', 'placeholder'];
  private editor: Quill | null = null;
  private context: any;
  private ready: ReturnType<typeof setTimeout> | null = null;
  private readySent = false;
  private suppressInput = 0;
  private portals = new Set<WxEditorPortal>();
  private status = '{}';
  private activation = 0;
  private resources = new AbortController();
  private editorId = -1;

  connectedCallback() {
    if (this.editorId < 0) {
      const page = this.closest('wx-page') ?? document.documentElement;
      this.editorId = editorCounters.get(page) ?? 0;
      editorCounters.set(page, this.editorId + 1);
    }
    if (this.resources.signal.aborted) this.resources = new AbortController();
    if (this.editor) {
      this.editor.scroll.observer.observe(this.editor.root, {
        attributes: true,
        characterData: true,
        characterDataOldValue: true,
        childList: true,
        subtree: true
      });
      this.scheduleReady();
      return;
    }
    const container = document.createElement('div');
    this.appendChild(container);
    const editor = new Quill(container, {
      placeholder: this.getAttribute('placeholder') ?? '',
      readOnly: this.hasAttribute('read-only'),
      formats,
      modules: { toolbar: false, history: { delay: 1000 } }
    });
    this.editor = editor;
    editor.clipboard.addMatcher(Node.TEXT_NODE, (node, delta) =>
      node.textContent?.includes('\u00a0')
        ? new Delta(
            delta.ops.map(operation =>
              typeof operation.insert === 'string' ? { ...operation, insert: operation.insert.replace(/ /g, '\u00a0') } : operation
            )
          )
        : delta
    );
    editor.root.addEventListener('input', event => event.stopPropagation());
    editor.root.addEventListener('focus', () => this.emit('focus', this.contents()));
    editor.root.addEventListener('blur', () => this.emit('blur', this.contents()));
    editor.on('text-change', () => {
      for (const portal of this.portals) portal.project(editor.root);
      if (!this.suppressInput) this.emit('input', this.contents());
    });
    editor.on('selection-change', range => {
      if (range) this.updateStatus();
    });
    this.scheduleReady();
  }

  private scheduleReady() {
    if (this.readySent || this.ready !== null) return;
    this.ready = setTimeout(() => {
      this.ready = null;
      if (this.isConnected) {
        this.readySent = true;
        this.emit('ready', {});
      }
    }, 0);
  }

  disconnectedCallback() {
    this.activation++;
    this.resources.abort();
    if (this.ready) clearTimeout(this.ready);
    this.ready = null;
    this.editor?.scroll.observer.disconnect();
  }

  attributeChangedCallback(name: string) {
    if (!this.editor) return;
    if (name === 'read-only') {
      this.editor.enable(!this.hasAttribute('read-only'));
      if (this.hasAttribute('read-only')) {
        this.editor.blur();
        this.editor.selection.savedRange = { index: 0, length: 0 };
      }
    }
    if (name === 'placeholder') this.editor.root.dataset.placeholder = this.getAttribute('placeholder') ?? '';
  }

  private emit(type: string, detail: any) {
    if (this.isConnected) this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private updateStatus() {
    const range = this.editor?.getSelection();
    if (!range) return;
    const formats = this.editor!.getFormat(range);
    const status = JSON.stringify(formats, Object.keys(formats).sort());
    if (status === this.status) return;
    this.status = status;
    this.emit('statuschange', formats);
  }

  private contents() {
    const editor = this.editor!;
    const delta = JSON.parse(JSON.stringify(editor.getContents()));
    const root = editor.root.cloneNode(true) as HTMLElement;
    root.querySelectorAll('.ql-ui').forEach(node => node.remove());
    for (const content of Array.from(root.querySelectorAll('wx-portal-content'))) {
      for (const node of Array.from(content.querySelectorAll('*')))
        for (const name of ['fmp-page', 'fmp-component', 'fmp-host', 'fmp-style']) node.removeAttribute(name);
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_COMMENT);
      const comments: Node[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
      for (const node of comments) node.parentNode?.removeChild(node);
    }
    for (const list of Array.from(root.querySelectorAll('ol'))) {
      let group: HTMLElement | null = null;
      for (const item of Array.from(list.children)) {
        const tag = item.getAttribute('data-list') === 'bullet' ? 'UL' : 'OL';
        item.removeAttribute('data-list');
        if (!group || group.tagName !== tag) {
          group = document.createElement(tag);
          list.before(group);
        }
        group.appendChild(item);
      }
      list.remove();
    }
    return { html: root.innerHTML, text: editor.getText(), delta };
  }

  projectPortal(portal: WxEditorPortal) {
    this.portals.add(portal);
    if (this.editor) portal.project(this.editor.root);
  }

  removePortal(portal: WxEditorPortal) {
    this.portals.delete(portal);
  }

  private bounds(index: number, length = 0) {
    const bounds = this.editor!.selection.getBounds(index, length);
    if (!bounds) throw new Error('invalid range');
    const { left, top, width, height } = pageRect(bounds, this.closest('wx-page'));
    return { left, top, width, height };
  }

  private withoutInput(run: () => void) {
    this.suppressInput++;
    try {
      run();
    } finally {
      this.suppressInput--;
    }
  }

  private call(options: any, run: () => any) {
    if (!this.isConnected || !this.editor) return;
    const activation = this.activation;
    let result: any;
    try {
      result = run();
    } catch (error) {
      result = Promise.reject(error);
    }
    void Promise.resolve(result).then(
      value => {
        if (!this.isConnected || activation !== this.activation) return;
        const result = { errMsg: 'ok', ...value };
        deliver(options?.success, result);
        if (this.isConnected && activation === this.activation) deliver(options?.complete, result);
      },
      error => {
        if (!this.isConnected || activation !== this.activation) return;
        const result = { errMsg: `fail ${error?.message ?? error}` };
        deliver(options?.fail, result);
        if (this.isConnected && activation === this.activation) deliver(options?.complete, result);
      }
    );
  }

  getContext() {
    if (this.context) return this.context;
    const editor = this.editor!;
    const selection = () => editor.getSelection() ?? editor.selection.savedRange ?? { index: 0, length: 0 };
    const replace = (text: string) => {
      const range = selection();
      editor.updateContents(new Delta().retain(range.index).delete(range.length).insert(text), 'api');
      editor.setSelection(range.index + text.length, 0, 'silent');
    };
    this.context = {
      getContents: (options: any = {}) => this.call(options, () => this.contents()),
      setContents: (options: any) =>
        this.call(options, () =>
          this.withoutInput(() => {
            if (options.delta) editor.setContents(options.delta);
            else {
              const document = new DOMParser().parseFromString(String(options.html ?? ''), 'text/html');
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode())
                node.textContent = node.textContent?.replace(/ /g, '\u00a0') ?? '';
              editor.setContents(editor.clipboard.convert({ html: document.body.innerHTML }));
            }
          })
        ),
      insertText: (options: any) => this.call(options, () => replace(String(options.text ?? ''))),
      clear: (options: any = {}) =>
        this.call(options, () => {
          editor.setText('');
        }),
      undo: (options: any = {}) =>
        this.call(options, () => {
          editor.history.undo();
        }),
      redo: (options: any = {}) =>
        this.call(options, () => {
          editor.history.redo();
        }),
      format: (name: string, value?: any) => {
        if (!this.isConnected) return;
        const range = selection();
        const current = editor.getFormat(range)[name];
        const normalized = name === 'header' && /^h[1-6]$/i.test(String(value)) ? Number(String(value).slice(1)) : value;
        const next = normalized === undefined ? !current : current === value ? false : normalized;
        editor.format(name, next);
        this.updateStatus();
      },
      removeFormat: (options: any = {}) =>
        this.call(options, () => {
          const range = selection();
          editor.removeFormat(range.index, range.length);
        }),
      getSelectionText: (options: any = {}) =>
        this.call(options, () => {
          const range = editor.getSelection();
          return { text: range ? editor.getText(range.index, range.length) : '' };
        }),
      insertDivider: (options: any = {}) =>
        this.call(options, () => {
          const range = selection();
          editor.updateContents(new Delta().retain(range.index).delete(range.length).insert('\n').insert({ divider: true }));
          editor.setSelection(range.index + 2, 0, 'silent');
        }),
      insertCustomBlock: (options: any = {}) =>
        this.call(options, () => {
          const range = selection();
          const blockId = `ecb_${crypto.randomUUID().slice(0, 6)}`;
          const change = new Delta().retain(range.index).delete(range.length);
          if (!options.nowrap) change.insert('\n');
          change.insert({ customBlock: { blockId, editorId: this.editorId } });
          editor.updateContents(change);
          editor.setSelection(range.index + (options.nowrap ? 1 : 2), 0, 'silent');
          return { blockId, type: 'block' };
        }),
      insertImage: (options: any) =>
        this.call(options, async () => {
          if (!options.src) throw new Error('src is required');
          let source = String(options.src);
          const local = /^(blob:|wxfile:)/.test(source);
          const signal = this.resources.signal;
          if (source.startsWith('wxfile:')) {
            const blob = await blobFromPath(source, signal);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const type = readImageMetadata(bytes).type;
            source = `data:${type === 'unknown' ? blob.type : `image/${type}`};base64,${fileData(bytes, 'base64')}`;
          }
          if (signal.aborted || !this.isConnected) return;
          const range = selection();
          editor.deleteText(range.index, range.length);
          editor.insertEmbed(range.index, 'image', source);
          for (const key of ['alt', 'width', 'height'])
            if (options[key] !== undefined) editor.formatText(range.index, 1, key, options[key]);
          if (options.extClass) editor.formatText(range.index, 1, 'class', options.extClass);
          if (local) editor.formatText(range.index, 1, 'data-local', options.src);
          if (options.data)
            editor.formatText(
              range.index,
              1,
              'data-custom',
              Object.entries(options.data)
                .map(([key, value]) => `${key}=${value}`)
                .join('&')
            );
          if (!options.nowrap) editor.insertText(range.index + 1, '\n');
          editor.setSelection(range.index + 1, 0, 'silent');
        }),
      blur: (options: any = {}) =>
        this.call(options, () => {
          editor.blur();
        }),
      scrollIntoView: () => {
        if (this.isConnected) editor.scrollSelectionIntoView();
      },
      getSelection: (options: any = {}) =>
        this.call(options, () => {
          const range = editor.getSelection();
          if (!range) throw new Error('unfocused');
          return { range, bounds: this.bounds(range.index, range.length) };
        }),
      setSelection: (options: any) =>
        this.call(options, () => {
          editor.setSelection(Number(options.index ?? 0), Number(options.length ?? 0));
        }),
      deleteText: (options: any) =>
        this.call(options, () => {
          editor.deleteText(Number(options.index ?? 0), Number(options.length ?? 0));
        }),
      getBounds: (options: any) =>
        this.call(options, () => ({ bounds: this.bounds(Number(options.index ?? 0), Number(options.length ?? 0)) })),
      getHistoryState: (options: any = {}) =>
        this.call(options, () => ({ undo: editor.history.stack.undo.length, redo: editor.history.stack.redo.length }))
    } satisfies ContextShape<'EditorContext'>;
    return this.context;
  }
}

export class WxEditorPortal extends HTMLElement {
  static observedAttributes = ['key'];
  private range: RenderRange | null = null;
  private owner: WxEditor | null = null;
  private content = document.createElement('wx-portal-content');
  private observer = new MutationObserver(() => this.adoptChildren());

  connectedCallback() {
    this.range = createVirtualHost(this, false);
    this.owner = this.closest('wx-editor');
    this.adoptChildren();
    this.observer.observe(this, { childList: true });
    this.owner?.projectPortal(this);
  }

  disconnectedCallback() {
    this.observer.disconnect();
    this.owner?.removePortal(this);
    this.owner = null;
    if (this.range) {
      while (this.range.start.nextSibling && this.range.start.nextSibling !== this.range.end)
        this.appendChild(this.range.start.nextSibling);
      disposeVirtualHost(this);
      this.range = null;
      this.content.remove();
      refreshVirtualEvents();
    }
  }

  attributeChangedCallback() {
    this.owner?.projectPortal(this);
  }

  private adoptChildren() {
    if (!this.range) return;
    for (const node of Array.from(this.childNodes)) this.range.appendChild(node);
    refreshVirtualEvents();
  }

  project(root: HTMLElement) {
    if (!this.range) return;
    const key = this.getAttribute('key');
    const target = Array.from(root.querySelectorAll('wx-editor-custom-block')).find(node => node.className === key);
    this.range.move(this.content);
    if (target) {
      if (this.content.parentNode !== target) target.appendChild(this.content);
    } else this.content.remove();
    refreshVirtualEvents();
  }
}
