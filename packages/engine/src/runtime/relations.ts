import { normalize } from './modules';
import { resolveBehavior } from './behaviors';
import { anchorOf, logicalParent, virtualHosts } from './hosts';

interface RelationNode {
  instance: any;
  host: Element;
  id: string;
  specs: Record<string, any>;
  owner: any;
  attached: boolean;
}

const nodes = new Map<any, RelationNode>();
const counterparts: Record<string, string> = { parent: 'child', child: 'parent', ancestor: 'descendant', descendant: 'ancestor' };

function ancestors(node: RelationNode): RelationNode[] {
  const result: RelationNode[] = [];
  let host = logicalParent(node.host);
  while (host) {
    const parent = nodes.get((host as any).__wxComponent);
    if (parent?.instance === node.owner) break;
    if (parent) result.push(parent);
    host = logicalParent(host);
  }
  return result;
}

function matches(owner: RelationNode, name: string, spec: any, target: RelationNode) {
  if (spec.target && (typeof spec.target !== 'string' || resolveBehavior(spec.target))) return target.instance.hasBehavior(spec.target);
  const path = spec.target ?? name;
  const id = normalize(path.startsWith('/') ? path : `${owner.id.slice(0, owner.id.lastIndexOf('/'))}/${path}`);
  return target.id === id;
}

export function reconcileRelations() {
  const callbacks: Array<() => void> = [];
  const parentsByNode = new Map(Array.from(nodes.values(), node => [node, ancestors(node)]));
  for (const node of nodes.values()) {
    const parents = parentsByNode.get(node)!;
    for (const [name, spec] of Object.entries<any>(node.specs)) {
      const possible = spec.type === 'parent' ? parents.slice(0, 1) : spec.type === 'ancestor' ? parents : Array.from(nodes.values());
      const candidates = !node.attached
        ? []
        : possible.filter(target => {
            if (!target.attached || target === node || !matches(node, name, spec, target)) return false;
            const targetParents = parentsByNode.get(target)!;
            const related =
              spec.type === 'parent'
                ? parents[0] === target
                : spec.type === 'ancestor'
                  ? parents.includes(target)
                  : spec.type === 'child'
                    ? targetParents[0] === node
                    : spec.type === 'descendant' && targetParents.includes(node);
            return (
              related &&
              Object.entries<any>(target.specs).some(
                ([otherName, other]) => other.type === counterparts[spec.type] && matches(target, otherName, other, node)
              )
            );
          });
      candidates.sort((a, b) => (anchorOf(a.host).compareDocumentPosition(anchorOf(b.host)) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      const next = candidates.map(target => target.instance);
      const previous: any[] = node.instance.__relations.get(name) ?? [];
      node.instance.__relations.set(name, next);
      for (const target of previous) if (!next.includes(target)) callbacks.push(() => spec.unlinked?.call(node.instance, target));
      for (const target of next) if (!previous.includes(target)) callbacks.push(() => spec.linked?.call(node.instance, target));
      for (const target of next) {
        if (previous.includes(target) && previous.indexOf(target) !== next.indexOf(target))
          callbacks.push(() => spec.linkChanged?.call(node.instance, target));
      }
    }
  }
  for (const callback of callbacks) callback();
}

export function registerRelations(instance: any, host: Element, id: string, specs: Record<string, any>, owner: any) {
  nodes.set(instance, { instance, host, id, specs, owner, attached: false });
}

export function attachRelations(instance: any) {
  const node = nodes.get(instance);
  if (node) node.attached = true;
}

export function detachRelations(instance: any) {
  const node = nodes.get(instance);
  if (!node) return;
  nodes.delete(instance);
  for (const owner of [node, ...nodes.values()]) {
    for (const [name, spec] of Object.entries<any>(owner.specs)) {
      const previous: any[] = owner.instance.__relations.get(name) ?? [];
      const removed = owner === node ? previous : previous.filter(target => target === instance);
      owner.instance.__relations.set(name, owner === node ? [] : previous.filter(target => target !== instance));
      for (const target of removed) spec.unlinked?.call(owner.instance, target);
    }
  }
}

export function notifyComponentMoves(roots: Element[]) {
  for (const node of nodes.values()) {
    const positions = virtualHosts.get(node.host)?.elements() ?? [node.host];
    if (node.attached && positions.some(position => roots.some(root => root === position || root.contains(position))))
      node.instance.__onMoved?.();
  }
  if (roots.length) reconcileRelations();
}
