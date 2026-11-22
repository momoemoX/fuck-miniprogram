import { eventOwner } from './events';
import { logicalElements, logicalParent } from './hosts';

export function ownedElements(root: Element, selector: string, normalize: (selector: string) => string = value => value): Element[] {
  const parts = selector.split(/\s*>>>\s*/);
  const owner = (root as any).__wxComponent ?? (root as any).__wxSelectorOwner;
  if (parts.length === 1) {
    return logicalElements(root).filter(node => node.matches(normalize(selector)) && (!owner || eventOwner(node) === owner));
  }
  let nodes = ownedElements(root, parts[0], normalize);
  for (const part of parts.slice(1)) {
    nodes = nodes.flatMap(node => logicalElements(node).filter(child => child.matches(normalize(part))));
  }
  return Array.from(new Set(nodes));
}

type SelectorStep = { parts: string[]; relation: ' ' | '>' | '>>>' };

function parseSelector(value: string): SelectorStep[] | null {
  const steps: SelectorStep[] = [];
  let remaining = value.trim();
  let relation: SelectorStep['relation'] = ' ';
  while (remaining) {
    const simple = /^(?:[.#][\w\-\u0080-\uFFFF]+)+/.exec(remaining)?.[0];
    if (!simple) return null;
    steps.push({ parts: simple.match(/[.#][\w\-\u0080-\uFFFF]+/g)!, relation });
    remaining = remaining.slice(simple.length);
    if (!remaining) break;
    const combinator = /^(\s*(>>>|>)\s*|\s+)/.exec(remaining);
    if (!combinator) return null;
    relation = (combinator[2] ?? ' ') as SelectorStep['relation'];
    remaining = remaining.slice(combinator[0].length);
  }
  return steps.length ? steps : null;
}

export function selectElements(root: Element, selector: string): Element[] {
  if (typeof selector !== 'string') return [];
  const elements = logicalElements(root);
  const owner = (root as any).__wxComponent ?? (root as any).__wxSelectorOwner;
  const selected = new Set<Element>();
  const matches = (node: Element, step: SelectorStep) =>
    step.parts.every(part => (part[0] === '#' ? node.id === part.slice(1) : node.classList.contains(part.slice(1))));
  const parentInOwnerTree = (node: Element): Element | null => {
    const owner = eventOwner(node);
    for (let parent = logicalParent(node); parent; parent = logicalParent(parent)) {
      if (eventOwner(parent) === owner || (parent as any).__wxComponent === owner) return parent;
    }
    return null;
  };
  for (const group of selector.split(',')) {
    const steps = parseSelector(group);
    if (!steps) continue;
    let candidates = elements.filter(node => (!owner || eventOwner(node) === owner) && matches(node, steps[0]));
    for (const step of steps.slice(1)) {
      const next = new Set<Element>();
      for (const parent of candidates) {
        for (const child of logicalElements(parent)) {
          if (step.relation !== '>>>' && eventOwner(child) !== eventOwner(parent)) continue;
          if (step.relation === '>' && parentInOwnerTree(child) !== parent) continue;
          if (matches(child, step)) next.add(child);
        }
      }
      candidates = Array.from(next);
    }
    for (const node of candidates) selected.add(node);
  }
  return elements.filter(node => selected.has(node));
}

export function selectedComponents(root: Element, selector: string): any[] {
  return selectElements(root, selector)
    .map(node => (node as any).__wxComponent)
    .filter(Boolean)
    .map(instance => (instance.__exportValue ? instance.__exportValue() : instance));
}
