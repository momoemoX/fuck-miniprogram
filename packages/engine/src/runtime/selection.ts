import { pageRect } from './geometry';
import type { ContextShape } from './contexts';

type Point = { node: Node; offset: number };

export class WxSelection extends HTMLElement {
  static observedAttributes = ['disable-context-menu'];
  private context: any;
  private active = false;
  private changed = () => this.report();
  private menu = (event: Event) => {
    if (this.hasAttribute('disable-context-menu') && this.getAttribute('disable-context-menu') !== 'false') event.preventDefault();
  };

  connectedCallback() {
    document.addEventListener('selectionchange', this.changed);
    this.addEventListener('contextmenu', this.menu);
  }

  disconnectedCallback() {
    document.removeEventListener('selectionchange', this.changed);
    this.removeEventListener('contextmenu', this.menu);
  }

  private owner(node: Node | null): Element | null {
    const element = node instanceof Element ? node : node?.parentElement;
    const unit = element?.closest('wx-text, wx-rich-text') ?? null;
    if (unit?.closest('wx-selection') !== this) return null;
    for (let parent: Element | null = unit; parent && parent !== this; parent = parent.parentElement)
      if (
        parent.matches('wx-text, wx-rich-text') &&
        ['user-select', 'selectable'].some(name => parent!.hasAttribute(name) && parent!.getAttribute(name) !== 'false')
      )
        return unit;
    return null;
  }

  private texts(root: Node = this): Text[] {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (this.owner(node)) nodes.push(node as Text);
    return nodes;
  }

  private contextTexts() {
    return this.texts().filter(node => {
      const text = node.parentElement?.closest('wx-text');
      return text && this.owner(text);
    });
  }

  private point(offset: number): Point | null {
    const nodes = this.contextTexts();
    let remaining = Math.max(0, Math.trunc(Number(offset) || 0));
    for (const node of nodes) {
      if (remaining <= node.length) return { node, offset: remaining };
      remaining -= node.length;
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last, offset: last.length } : null;
  }

  private select(anchor: Point | null, focus: Point | null) {
    if (!this.isConnected || !anchor || !focus) return;
    window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }

  private report() {
    const selection = window.getSelection();
    if (!this.isConnected || !selection) return;
    if (!selection.rangeCount || selection.isCollapsed) {
      if (this.active || (selection.anchorNode && this.contains(selection.anchorNode)))
        this.dispatchEvent(new CustomEvent('selectionchange', { detail: { isCollapsed: true, selectedString: '' } }));
      this.active = false;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(this)) return;
    this.active = true;
    let selectedString = '';
    let firstId: string | undefined, lastId: string | undefined;
    let firstFallback: string | undefined, lastFallback: string | undefined;
    for (const unit of Array.from(this.querySelectorAll('wx-text, wx-rich-text')).filter(unit => this.owner(unit))) {
      if (firstId !== undefined && lastId !== undefined) break;
      if (unit.id) lastFallback = unit.id;
      for (const node of this.texts(unit)) {
        if (node === selection.anchorNode) firstId = unit.id;
        if (node === selection.focusNode) lastId = unit.id;
        if (!range.intersectsNode(node)) continue;
        if (firstFallback === undefined && unit.id) firstFallback = unit.id;
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : node.length;
        selectedString += node.data.slice(start, end);
      }
    }
    const rect = pageRect(range.getBoundingClientRect(), this.closest('wx-page'));
    const detail: any = {
      isCollapsed: selection.isCollapsed,
      selectedString,
      firstRangeRect: { x: rect.left, y: rect.top, ...rect },
      firstNodeId: firstId ?? firstFallback,
      lastNodeId: lastId ?? lastFallback,
      ...(firstId !== undefined ? { firstOffset: selection.anchorOffset } : {}),
      ...(lastId !== undefined ? { lastOffset: selection.focusOffset } : {})
    };
    if (selection.anchorNode?.compareDocumentPosition(selection.focusNode!) === Node.DOCUMENT_POSITION_PRECEDING)
      [detail.firstNodeId, detail.lastNodeId] = [detail.lastNodeId, detail.firstNodeId];
    this.dispatchEvent(new CustomEvent('selectionchange', { detail }));
  }

  getContext() {
    return (this.context ??= {
      selectRange: (start: number, end: number) => {
        const total = this.contextTexts().reduce((length, node) => length + node.length, 0);
        const values = [Number(start), Number(end)];
        if (!values.every(Number.isFinite)) return;
        const [from, to] = values.map(value => Math.max(0, Math.min(total, Math.trunc(value)))).sort((a, b) => a - b);
        if (from === to) return;
        this.select(this.point(from), this.point(to));
      },
      setBaseAndExtent: (anchorId: string, anchorOffset: number, focusId: string, focusOffset: number) => {
        const anchor = this.querySelector(`#${CSS.escape(anchorId)}`),
          focus = this.querySelector(`#${CSS.escape(focusId)}`);
        if (
          !anchor ||
          !focus ||
          !Number.isInteger(anchorOffset) ||
          !Number.isInteger(focusOffset) ||
          anchorOffset < 0 ||
          focusOffset < 0 ||
          anchorOffset > anchor.childNodes.length ||
          focusOffset > focus.childNodes.length
        )
          return;
        this.select({ node: anchor, offset: anchorOffset }, { node: focus, offset: focusOffset });
      },
      removeSelection: () => {
        const selection = window.getSelection();
        if (this.isConnected && selection?.rangeCount && selection.getRangeAt(0).intersectsNode(this)) selection.removeAllRanges();
      }
    } satisfies ContextShape<'SelectionContext'>);
  }
}

export const SELECTION_CSS = `
wx-selection { display:block; user-select:none; }
wx-selection wx-text[user-select], wx-selection wx-text[selectable], wx-selection wx-rich-text[user-select] { user-select:text; }
`;
