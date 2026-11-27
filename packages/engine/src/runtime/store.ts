/**
 * 响应式核心：路径依赖 + 失效传播
 *
 * 不用 Proxy、不做依赖收集：setData 本身就带着精确路径，直接按路径把
 * 命中的绑定标脏即可。依赖挂在按路径分段构建的 trie 上，
 * setData 一个叶子路径只需要走一遍树。
 */

export type Dep = string[];

function viewValue(value: any) {
  if (value instanceof Date) return {};
  const serialized = JSON.stringify(value, function (key, v) {
    return this && this[key] instanceof Date ? {} : v;
  });
  return serialized === undefined ? undefined : JSON.parse(serialized);
}

const pendingStores = new Set<Store>();
const renderCallbacks: Array<() => void> = [];
let renderScheduled = false;

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  queueMicrotask(() => {
    try {
      // 父绑定会继续更新子组件的 store，回调必须等整条渲染链清空。
      while (pendingStores.size) {
        const store = pendingStores.values().next().value!;
        pendingStores.delete(store);
        store.flushSync();
      }
      const count = renderCallbacks.length;
      for (let i = 0; i < count; i++) renderCallbacks.shift()!();
    } finally {
      renderScheduled = false;
      if (pendingStores.size || renderCallbacks.length) scheduleRender();
    }
  });
}

export function afterRender(callback: () => void) {
  renderCallbacks.push(callback);
  scheduleRender();
}

export interface Scope {
  readonly data: any;
  item?: any;
  index?: number | string;
  /** 模板里用到的 wxs 模块 */
  wxs?: Record<string, any>;
  /** wx:for-item / wx:for-index 自定义的变量名 */
  [key: string]: any;
}

export interface Effect {
  deps: Dep[];
  run: () => void;
  active: boolean;
  deep: boolean;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  effects: Set<Effect>;
}

function createNode(): TrieNode {
  return { children: new Map(), effects: new Set() };
}

export type KeyFn = (item: any, index: any) => unknown;

/** 列表项的依赖前缀用 `#key`，重排时不需要重新注册 */
export const KEY_MARK = '#';

export class Holder {
  effects: Effect[] = [];
  private children = new Set<Holder>();
  private cleanups = new Set<() => void>();
  private active = true;

  constructor(
    readonly scope: Scope,
    private readonly store: Store,
    private readonly owner?: Holder
  ) {
    owner?.children.add(this);
  }

  onDispose(cleanup: () => void) {
    this.cleanups.add(cleanup);
  }

  dispose() {
    if (!this.active) return;
    this.active = false;
    this.owner?.children.delete(this);
    for (const effect of this.effects) this.store.unregister(effect);
    this.effects = [];
    for (const child of this.children) child.dispose();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }

  refresh() {
    for (const effect of this.effects) {
      if (effect.active) effect.run();
    }
    for (const child of this.children) child.refresh();
  }
}

export class Store {
  data: any;
  private viewData: any;
  private root = createNode();
  private keyed = new Map<string, Set<KeyFn>>();
  private pending = new Set<Effect>();
  private postFlush: Array<() => void> = [];
  private commits = new Set<() => void>();
  private flushing = false;

  /** 统计：执行过的绑定次数，用来验证"只更新一个节点" */
  stats = { runs: 0, flushes: 0 };

  constructor(
    data: any,
    private readonly pure?: (name: string) => boolean
  ) {
    this.data = data;
    this.viewData = viewValue(pure ? Object.fromEntries(Object.entries(data).filter(([name]) => !pure(name))) : data);
  }

  rootScope(): Scope {
    return Object.defineProperty({}, 'data', { get: () => this.viewData }) as Scope;
  }

  holder(scope: Scope, owner?: Holder): Holder {
    return new Holder(scope, this, owner);
  }

  register(deps: Dep[], run: () => void, holder: Holder, deep = true): Effect {
    deps = Array.from(new Map(deps.map(dep => [JSON.stringify(dep), dep])).values());
    const effect: Effect = { deps, run, active: true, deep };
    for (const dep of deps) {
      let node = this.root;
      for (const segment of dep) {
        let child = node.children.get(segment);
        if (!child) {
          child = createNode();
          node.children.set(segment, child);
        }
        node = child;
      }
      node.effects.add(effect);
    }
    holder.effects.push(effect);
    return effect;
  }

  unregister(effect: Effect) {
    if (!effect.active) return;
    effect.active = false;
    this.pending.delete(effect);
    for (const dep of effect.deps) {
      let node = this.root;
      const parents: Array<[TrieNode, string]> = [];
      for (const segment of dep) {
        parents.push([node, segment]);
        node = node.children.get(segment)!;
      }
      node.effects.delete(effect);
      for (let i = parents.length - 1; i >= 0; i--) {
        if (node.effects.size || node.children.size) break;
        const [parent, segment] = parents[i];
        parent.children.delete(segment);
        node = parent;
      }
    }
  }

  /** 列表下标只在依赖路径中映射成 `#key`，业务数据保留原路径。 */
  setKeyed(path: string | Dep, keyFn: KeyFn) {
    const id = JSON.stringify(typeof path === 'string' ? parsePath(path) : path);
    let resolvers = this.keyed.get(id);
    if (!resolvers) this.keyed.set(id, (resolvers = new Set()));
    resolvers.add(keyFn);
    return () => {
      resolvers.delete(keyFn);
      if (!resolvers.size) this.keyed.delete(id);
    };
  }

  setData(patch: Record<string, any>, callback?: () => void) {
    for (const key of Object.keys(patch)) {
      const segments = parsePath(key);
      if (this.pure?.(segments[0])) {
        assign(this.data, segments, patch[key]);
        continue;
      }
      const previous = this.dependencyPaths(segments);
      assign(this.data, segments, patch[key]);
      const value = viewValue(patch[key]);
      if (value === undefined) continue;
      assign(this.viewData, segments, value);
      const next = this.dependencyPaths(segments);
      for (const dep of [...previous.paths, ...next.paths]) this.invalidate(dep);
      for (const [id, { path, keys }] of next.lists) {
        if (segments.length === path.length + 1 || keys !== previous.lists.get(id)?.keys) {
          this.invalidate(path);
        }
      }
    }
    for (const commit of Array.from(this.commits)) commit();
    this.schedule();
    if (callback) afterRender(callback);
  }

  onCommit(callback: () => void, holder: Holder) {
    this.commits.add(callback);
    holder.onDispose(() => this.commits.delete(callback));
  }

  /** 同步刷新，benchmark / 测试用 */
  flushSync() {
    pendingStores.delete(this);
    this.flush();
  }

  afterFlush(callback: () => void) {
    this.postFlush.push(callback);
    this.schedule();
  }

  /**
   * 按数据路径写入：`model:` 回写父级字段用。
   * 路径里的 `#key` 段（wx:for 里的项）在这里还原成当前下标，
   * 找不到对应项时放弃写入，避免写坏数据。
   */
  setByPath(segments: string[], value: unknown): boolean {
    const resolved = this.resolveKeyed(segments);
    if (!resolved?.length) return false;
    this.setData({ [pathToString(resolved)]: value });
    return true;
  }

  private resolveKeyed(segments: string[]): string[] | null {
    const resolved: string[] = [];
    for (const segment of segments) {
      if (!segment.startsWith(KEY_MARK)) {
        resolved.push(segment);
        continue;
      }
      const key = segment.slice(KEY_MARK.length);
      const list = getByPath(this.data, resolved);
      const resolvers = [...(this.keyed.get(JSON.stringify(resolved)) ?? [])];
      const entries: Array<[string | number, any]> = Array.isArray(list)
        ? list.map((item, index) => [index, item] as [number, any])
        : list && typeof list === 'object'
          ? (Object.entries(list) as Array<[string, any]>)
          : [];
      let found: string | null = null;
      for (const [index, item] of entries) {
        if (resolvers.some(resolve => String(resolve(item, index)) === key)) {
          found = String(index);
          break;
        }
      }
      if (found === null) return null;
      resolved.push(found);
    }
    return resolved;
  }

  private dependencyPaths(segments: string[]) {
    let paths: Dep[] = [[]];
    const lists = new Map<string, { path: Dep; keys: string }>();
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const list = getByPath(this.viewData, segments.slice(0, i));
      const next: Dep[] = [];
      for (const prefix of paths) {
        next.push([...prefix, segment]);
        const id = JSON.stringify(prefix);
        const resolvers = this.keyed.get(id);
        if (!resolvers) continue;
        const keys: string[] = [];
        if (list != null && Object.prototype.hasOwnProperty.call(list, segment)) {
          for (const resolve of resolvers) {
            const key = KEY_MARK + String(resolve(list[segment], Array.isArray(list) ? Number(segment) : segment));
            if (keys.includes(key)) continue;
            keys.push(key);
            next.push([...prefix, key]);
          }
        }
        lists.set(id, { path: prefix, keys: JSON.stringify(keys) });
      }
      paths = next;
    }
    return { paths, lists };
  }

  private invalidate(segments: string[]) {
    let node: TrieNode | undefined = this.root;
    for (const segment of segments) {
      for (const effect of node.effects) {
        if (effect.active && effect.deep) this.pending.add(effect);
      }
      node = node.children.get(segment);
      if (!node) return;
    }
    this.collect(node);
  }

  private collect(node: TrieNode) {
    for (const effect of node.effects) {
      if (effect.active) this.pending.add(effect);
    }
    for (const child of node.children.values()) this.collect(child);
  }

  private schedule() {
    pendingStores.add(this);
    scheduleRender();
  }

  private flush() {
    if (this.flushing || (!this.pending.size && !this.postFlush.length)) return;
    this.flushing = true;
    const effects = Array.from(this.pending);
    this.pending.clear();
    this.stats.flushes++;
    try {
      for (const effect of effects) {
        if (!effect.active) continue;
        this.stats.runs++;
        effect.run();
      }
      const callbacks = this.postFlush.splice(0);
      for (const callback of callbacks) callback();
    } finally {
      this.flushing = false;
    }
  }
}

/** `a.b[0].c` → ['a','b','0','c'] */
export function parsePath(key: string): string[] {  const segments: string[] = [];
  let i = 0;
  while (i < key.length) {
    if (key[i] === '.') {
      i++;
      continue;
    }
    if (key[i] !== '[') {
      const start = i;
      while (i < key.length && key[i] !== '.' && key[i] !== '[') i++;
      segments.push(key.slice(start, i));
      continue;
    }
    i++;
    while (/\s/.test(key[i] ?? '') && i < key.length) i++;
    const quote = key[i];
    if (quote === '"' || quote === "'") {
      const start = i++;
      let value = '';
      while (i < key.length && key[i] !== quote) {
        if (key[i] === '\\') {
          i++;
          value += key[i++] ?? '';
        } else value += key[i++];
      }
      i++;
      segments.push(quote === '"' ? JSON.parse(key.slice(start, i)) : value);
      while (i < key.length && key[i] !== ']') i++;
    } else {
      const start = i;
      while (i < key.length && key[i] !== ']') i++;
      segments.push(key.slice(start, i).trim());
    }
    if (key[i] === ']') i++;
  }
  return segments;
}

export function getByPath(data: any, segments: string[]): any {
  let value = data;
  for (const segment of segments) {
    if (value == null) return undefined;
    value = value[segment];
  }
  return value;
}

/** ['a','b','0','c'] → `a.b[0].c`，setData 认这种写法 */
export function pathToString(segments: string[]): string {
  let out = segments[0] ?? '';
  for (const segment of segments.slice(1)) {
    out += /^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`;
  }
  return out;
}

function assign(data: any, segments: string[], value: any) {
  let target = data;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const next = segments[i + 1];
    if (!Object.prototype.hasOwnProperty.call(target, segment) || target[segment] == null || typeof target[segment] !== 'object') {
      writeField(target, segment, /^\d+$/.test(next) ? [] : {});
    }
    target = target[segment];
  }
  writeField(target, segments[segments.length - 1], value);
}

function writeField(target: any, field: string, value: any) {
  if (field === '__proto__') Object.defineProperty(target, field, { value, writable: true, enumerable: true, configurable: true });
  else target[field] = value;
}
