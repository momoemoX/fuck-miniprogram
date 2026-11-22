const constructors = new Map<Function, string>([
  [Array, 'Array'],
  [Object, 'Object'],
  [Number, 'Number'],
  [String, 'String'],
  [Boolean, 'Boolean'],
  [Date, 'Date'],
  [RegExp, 'RegExp'],
  [Function, 'Function']
]);

const exposed = new WeakMap<object, any>();
const originals = new WeakMap<object, any>();

function copy(value: any): any {
  if (Array.isArray(value)) return value.map(copy);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, value]) => [name, copy(value)]));
  return value;
}

export function exposeWxs<T>(value: T): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const source = value as object;
  if (exposed.has(source)) return exposed.get(source);
  const proxy = new Proxy(source, {
    get: (target, key) => exposeWxs(wxsProperty(target, key)),
    apply: (target: any, receiver, args) => copy(target.apply(originals.get(receiver) ?? receiver, args.map(copy)))
  });
  exposed.set(source, proxy);
  originals.set(proxy, source);
  return proxy as T;
}

export function wxsProperty(value: any, key: PropertyKey): any {
  const property = value[key];
  return key === 'constructor' && !Object.prototype.hasOwnProperty.call(value, key) ? (constructors.get(property) ?? property) : property;
}
export function wxsCall(value: any, key: PropertyKey): (...args: any[]) => any {
  const method = wxsProperty(value, key);
  return (...args: any[]) => method.apply(value, args);
}
