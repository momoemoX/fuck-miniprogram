import { RenderRange, type RenderParent } from './range';

export const virtualHosts = new Map<Element, RenderRange>();
export const virtualEventHosts = new Set<Element>();
const markers = new WeakMap<Node, { host: Element; end: boolean }>();

export function createVirtualHost(host: Element, forwardEvents = true) {
  const range = new RenderRange();
  virtualHosts.set(host, range);
  if (forwardEvents) virtualEventHosts.add(host);
  markers.set(range.start, { host, end: false });
  markers.set(range.end, { host, end: true });
  return range;
}

export function disposeVirtualHost(host: Element) {
  const range = virtualHosts.get(host);
  if (!range) return;
  range.remove();
  markers.delete(range.start);
  markers.delete(range.end);
  virtualHosts.delete(host);
  virtualEventHosts.delete(host);
}

export function anchorOf(node: Element): Node {
  return virtualHosts.get(node)?.start ?? node;
}

export function logicalParent(node: Node): Element | null {
  const anchor = node instanceof Element ? anchorOf(node) : node;
  const closed = new Set<Element>();
  for (let sibling = anchor.previousSibling; sibling; sibling = sibling.previousSibling) {
    const marker = markers.get(sibling);
    if (!marker) continue;
    if (marker.end) closed.add(marker.host);
    else if (closed.has(marker.host)) closed.delete(marker.host);
    else return marker.host;
  }
  return anchor.parentElement;
}

export function logicalContains(root: Element, node: Node): boolean {
  for (let parent = logicalParent(node); parent; parent = logicalParent(parent)) if (parent === root) return true;
  return false;
}

export function logicalElements(root: Element): Element[] {
  const range = virtualHosts.get(root);
  const elements = range
    ? range.elements().flatMap(element => [element, ...Array.from(element.querySelectorAll('*'))])
    : Array.from(root.querySelectorAll('*'));
  for (const host of virtualHosts.keys()) if (host !== root && logicalContains(root, host)) elements.push(host);
  return Array.from(new Set(elements)).sort((a, b) => {
    const position = anchorOf(a).compareDocumentPosition(anchorOf(b));
    return position & Node.DOCUMENT_POSITION_DISCONNECTED
      ? 0
      : position & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : position & Node.DOCUMENT_POSITION_PRECEDING
          ? 1
          : 0;
  });
}

export function appendComponent(parent: RenderParent, host: Element) {
  const range = virtualHosts.get(host);
  if (range) range.move(parent);
  else parent.appendChild(host);
}
