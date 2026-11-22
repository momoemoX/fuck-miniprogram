import type { ScopeMark } from './builder';

export function pageStyles(instance: any, el: Element, scope?: ScopeMark, independent = false) {
  instance.__styleRoot = el;
  instance.__pageStyles = [...(independent ? [] : ['global']), 'shared', ...(scope ? [`p${scope.value}`] : [])];
  instance.__styleScopes = instance.__pageStyles;
  el.setAttribute('fmp-style', instance.__styleScopes.join(' '));
}

const sharedStyles = new WeakMap<Element, Map<string, number>>();

export function componentStyles(
  instance: any,
  el: Element,
  scope: ScopeMark | undefined,
  mode: string,
  parent: any,
  externalClasses: string[],
  external: () => Record<string, any>
) {
  const isPage = scope?.attr === 'fmp-page';
  if (isPage) pageStyles(instance, el, scope);
  else {
    instance.__styleRoot = parent?.__styleRoot;
    instance.__pageStyles = parent?.__pageStyles ?? ['global'];
  }
  const own = scope ? `${isPage ? 'p' : 'c'}${scope.value}` : '';
  const isolated = mode === 'isolated' || mode === 'page-isolated';
  if (isPage) {
    instance.__pageStyles = [...(mode.startsWith('page-') ? [] : ['global']), 'shared', ...(own ? [own] : [])];
    instance.__styleScopes = isolated ? [] : instance.__pageStyles;
    el.setAttribute('fmp-style', instance.__styleScopes.join(' '));
  } else instance.__styleScopes = Array.from(new Set([...(isolated ? [] : instance.__pageStyles), ...(own ? [own] : [])]));
  if (own && !instance.__virtualHost) el.setAttribute('fmp-host', own);
  instance.__styleParent = parent;
  instance.__ownStyleScope = own;
  instance.__externalClasses = externalClasses;
  instance.__externalValues = external;
  const nodes = new Map<Element, string>();
  const resolveToken = (
    owner: any,
    token: string,
    classes: string[],
    scopes: Set<string>,
    visited: Set<string>
  ) => {
    if (token.startsWith('~')) {
      const name = token.slice(1);
      if (name) {
        classes.push(name);
        for (const s of owner?.__pageStyles ?? []) scopes.add(s);
      }
      return;
    }
    if (token.startsWith('^')) {
      let depth = 0;
      while (token[depth] === '^') depth += 1;
      const name = token.slice(depth);
      if (name) {
        classes.push(name);
        let ancestor = owner;
        for (let i = 0; i < depth && ancestor; i += 1) ancestor = ancestor.__styleParent;
        if (ancestor?.__ownStyleScope) scopes.add(ancestor.__ownStyleScope);
        else for (const s of ancestor?.__styleScopes ?? []) scopes.add(s);
      }
      return;
    }
    const ownerExternals: string[] = owner?.__externalClasses ?? [];
    if (!ownerExternals.includes(token)) {
      classes.push(token);
      return;
    }
    const key = `${owner.__ownStyleScope ?? ''}:${token}`;
    if (visited.has(key)) return;
    visited.add(key);
    const passed = String(owner.__externalValues?.()[token] ?? '')
      .split(/\s+/)
      .filter(Boolean);
    const nextParent = owner.__styleParent;
    for (const item of passed) {
      if (nextParent && (nextParent.__externalClasses?.includes(item) || item.startsWith('~') || item.startsWith('^'))) {
        resolveToken(nextParent, item, classes, scopes, visited);
      } else {
        classes.push(item);
        for (const s of nextParent?.__styleScopes ?? []) scopes.add(s);
      }
    }
  };
  const apply = (node: Element, value: string) => {
    nodes.set(node, value);
    const classes: string[] = [];
    const scopes = new Set<string>(instance.__styleScopes);
    for (const token of value.split(/\s+/).filter(Boolean)) {
      resolveToken(instance, token, classes, scopes, new Set());
    }
    node.setAttribute('class', classes.join(' '));
    node.setAttribute('fmp-style', Array.from(scopes).join(' '));
  };
  instance.__applyClasses = apply;
  instance.__forgetClasses = (node: Element) => nodes.delete(node);
  instance.__refreshClasses = () => {
    for (const [node, value] of nodes) apply(node, value);
  };
  const root = instance.__styleRoot as Element | undefined;
  let shared: Map<string, number> | undefined;
  if ((mode === 'shared' || mode === 'page-shared') && root && own) {
    shared = sharedStyles.get(root);
    if (!shared) sharedStyles.set(root, (shared = new Map()));
    shared.set(own, (shared.get(own) ?? 0) + 1);
    root.setAttribute('fmp-shared', Array.from(shared.keys()).join(' '));
  }
  return () => {
    nodes.clear();
    if (!shared || !root) return;
    const count = shared.get(own)! - 1;
    if (count) shared.set(own, count);
    else shared.delete(own);
    root.setAttribute('fmp-shared', Array.from(shared.keys()).join(' '));
  };
}
