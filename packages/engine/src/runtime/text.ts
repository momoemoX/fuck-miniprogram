const rawText = new WeakMap<Text, string>();
const rendered = new WeakMap<Text, { owner: Element; span: HTMLSpanElement; value: string }>();
const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003'
};

function paint(node: Text) {
  if (!rawText.has(node)) return;
  const raw = rawText.get(node)!;
  const text = node.parentElement?.closest('wx-text');
  let state = rendered.get(node);
  if (!text) {
    if (state) {
      state.span.replaceWith(node);
      rendered.delete(node);
    }
    if (node.data !== raw) node.data = raw;
    return;
  }
  const decoded = text?.hasAttribute('decode') && text.getAttribute('decode') !== 'false';
  let value = decoded ? raw.replace(/&(amp|lt|gt|quot|apos|nbsp|ensp|emsp);/g, (_match, name: string) => entities[name]) : raw;
  const space = text.getAttribute('space');
  if (space && ['nbsp', 'ensp', 'emsp'].includes(space)) value = value.replace(/ /g, entities[space]);
  if (!state) {
    const span = document.createElement('span');
    node.replaceWith(span);
    span.appendChild(node);
    state = { owner: text, span, value: '' };
    rendered.set(node, state);
  } else if (state.owner === text && state.value === value) return;
  state.owner = text;
  state.value = value;
  const parts = value.split(/\r\n?|\n/);
  node.data = parts[0];
  state.span.replaceChildren(node, ...parts.slice(1).flatMap(part => [document.createElement('br'), document.createTextNode(part)]));
}

export function writeText(node: Text, value: string) {
  rawText.set(node, value);
  paint(node);
}

export class WxText extends HTMLElement {
  static observedAttributes = ['decode', 'space', 'selectable', 'user-select'];
  private observer = new MutationObserver(() => this.paint());

  connectedCallback() {
    this.observer.observe(this, { childList: true, subtree: true });
    this.paint();
  }

  disconnectedCallback() {
    this.observer.disconnect();
  }

  attributeChangedCallback() {
    this.paint();
  }

  private paint() {
    const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) paint(node);
  }
}
