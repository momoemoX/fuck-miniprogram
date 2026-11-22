export type RenderParent = Element | RenderRange;

/** 用注释锚点保留动态片段的位置，避免包装元素改变 CSS 的节点结构。 */
export class RenderRange {
  readonly start = document.createComment('range');
  readonly end = document.createComment('/range');
  private readonly parking = document.createDocumentFragment();

  constructor() {
    this.parking.append(this.start, this.end);
  }

  get parentNode(): Node | null {
    const parent = this.start.parentNode;
    return parent === this.parking ? null : parent;
  }

  get nextSibling(): Node | null {
    return this.end.nextSibling;
  }

  appendChild<T extends Node>(node: T): T {
    return this.insertBefore(node, null);
  }

  insertBefore<T extends Node>(node: T, before: Node | null): T {
    return this.end.parentNode!.insertBefore(node, before ?? this.end);
  }

  move(parent: RenderParent | DocumentFragment, before: Node | null = null) {
    const container = parent instanceof RenderRange ? parent.end.parentNode : parent;
    const reference = before ?? (parent instanceof RenderRange ? parent.end : null);
    if (this.start.parentNode === container && this.end.nextSibling === reference) return;
    const fragment = document.createDocumentFragment();
    let node: Node | null = this.start;
    while (node) {
      const next: Node | null = node.nextSibling;
      fragment.appendChild(node);
      if (node === this.end) break;
      node = next;
    }
    parent.insertBefore(fragment, before);
  }

  remove() {
    this.move(this.parking);
  }

  elements(): Element[] {
    const elements: Element[] = [];
    for (let node = this.start.nextSibling; node && node !== this.end; node = node.nextSibling) {
      if (node instanceof Element) elements.push(node);
    }
    return elements;
  }
}
