import type { ScopeMark } from './builder';
import { refreshDescriptorAttributes } from './wxs-descriptor';

type ClassSource = { name: string; scopes: string[] };

export function classNames(instance: any, text: string): string[] {
  const sources: ClassSource[] =
    instance.__resolveClasses?.(text) ??
    text
      .split(/\s+/)
      .filter(Boolean)
      .map(name => ({ name, scopes: instance.__styleScopes ?? [] }));
  return [...new Set(sources.flatMap(({ name, scopes }) => [name, ...scopes.map(scope => `${name}--fmp-${scope}`)]))];
}

export function pageStyles(instance: any, el: Element, scope?: ScopeMark, independent = false) {
  if (independent) instance.__independent = true;
  instance.__styleRoot = el;
  instance.__ownStyle = scope ? `p${scope.value}` : '';
  instance.__pageStyles = [...(instance.__independent ? [] : ['global']), 'shared', ...(scope ? [`p${scope.value}`] : [])];
  instance.__styleScopes = instance.__pageStyles;
  instance.__allowSharedChildren = true;
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
  if (isPage) pageStyles(instance, el, scope, !!instance.__independent);
  else {
    instance.__styleRoot = parent?.__styleRoot;
    instance.__pageStyles = parent?.__pageStyles ?? ['global'];
    instance.__allowSharedChildren = parent?.__allowSharedChildren ?? true;
  }
  const own = scope ? `${isPage ? 'p' : 'c'}${scope.value}` : '';
  instance.__ownStyle = own;
  const isolated = mode === 'isolated' || mode === 'page-isolated';
  if (isPage) {
    const pageMode = mode.startsWith('page-');
    instance.__allowSharedChildren = !pageMode || mode === 'page-shared';
    instance.__pageStyles =
      mode === 'page-isolated'
        ? []
        : [
            ...(!pageMode && !instance.__independent ? ['global'] : []),
            ...(instance.__allowSharedChildren ? ['shared'] : []),
            ...(own ? [own] : [])
          ];
    instance.__styleScopes = [...new Set([...instance.__pageStyles, ...(own ? [own] : [])])];
    el.setAttribute('fmp-style', instance.__styleScopes.join(' '));
  } else {
    instance.__styleScopes = [...new Set([...(isolated ? [] : instance.__pageStyles), ...(own ? [own] : [])])];
  }
  if (own && !instance.__virtualHost) el.setAttribute('fmp-host', own);
  instance.__resolveClasses = (text: string): ClassSource[] =>
    text
      .split(/\s+/)
      .filter(Boolean)
      .flatMap(token => {
        if (externalClasses.includes(token)) {
          const value = String(external()[token] ?? '');
          return (
            parent?.__resolveClasses?.(value) ??
            value
              .split(/\s+/)
              .filter(Boolean)
              .map(name => ({ name, scopes: parent?.__styleScopes ?? [] }))
          );
        }
        if (token.startsWith('~')) return [{ name: token.slice(1), scopes: instance.__page?.__styleScopes ?? instance.__pageStyles }];
        if (token.startsWith('^')) {
          let source = parent;
          while (token.startsWith('^')) {
            token = token.slice(1);
            if (token.startsWith('^')) source = source?.__owner;
          }
          return [{ name: token, scopes: source?.__styleScopes ?? [] }];
        }
        return [{ name: token, scopes: instance.__styleScopes }];
      });
  const nodes = new Map<Element, string>();
  const apply = (node: Element, value: string) => {
    nodes.set(node, value);
    const sources: ClassSource[] = instance.__resolveClasses(value);
    node.setAttribute('class', classNames(instance, value).join(' '));
    node.setAttribute('fmp-style', [...new Set([...instance.__styleScopes, ...sources.flatMap(source => source.scopes)])].join(' '));
    refreshDescriptorAttributes(node);
  };
  instance.__applyClasses = apply;
  instance.__forgetClasses = (node: Element) => nodes.delete(node);
  instance.__refreshClasses = () => {
    for (const [node, value] of nodes) apply(node, value);
  };
  const root = instance.__styleRoot as Element | undefined;
  let shared: Map<string, number> | undefined;
  if ((mode === 'shared' || mode === 'page-shared') && root && own && instance.__allowSharedChildren) {
    shared = sharedStyles.get(root);
    if (!shared) sharedStyles.set(root, (shared = new Map()));
    shared.set(own, (shared.get(own) ?? 0) + 1);
    root.setAttribute('fmp-shared', [...shared.keys()].join(' '));
  }
  return () => {
    nodes.clear();
    if (!shared || !root) return;
    const count = shared.get(own)! - 1;
    if (count) shared.set(own, count);
    else shared.delete(own);
    root.setAttribute('fmp-shared', [...shared.keys()].join(' '));
  };
}
