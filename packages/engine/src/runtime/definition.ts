export function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneData) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, cloneData(value)])) as T;
  }
  return value;
}

function plain(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeData(target: Record<string, any>, source: any) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (plain(value) && Object.prototype.hasOwnProperty.call(target, key) && plain(target[key])) mergeData(target[key], value);
    else Object.defineProperty(target, key, { value: cloneData(value), writable: true, enumerable: true, configurable: true });
  }
}

export function definitionChain(definition: any): any[] {
  const chain: any[] = [];
  const seen = new Set<any>();
  const visit = (item: any) => {
    item = resolveBehavior(item);
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const behavior of item.behaviors ?? []) visit(behavior);
    chain.push(item);
  };
  visit(definition);
  return chain;
}

export function propertySpec(value: any): any {
  return typeof value === 'function' || value === null ? { type: value } : value;
}

export function propertyDefault(spec: any): any {
  if (spec.value !== undefined) return cloneData(spec.value);
  if (spec.type === String) return '';
  if (spec.type === Number) return 0;
  if (spec.type === Boolean) return false;
  if (spec.type === Array) return [];
  return null;
}

export function propertyValue(spec: any, value: any): any {
  const types = [spec.type, ...(spec.optionalTypes ?? [])];
  const accepts = (type: any) =>
    type === null ||
    (type === Array
      ? Array.isArray(value)
      : type === Object
        ? value !== null && typeof value === 'object'
        : type === Number
          ? typeof value === 'number'
          : type === Boolean
            ? typeof value === 'boolean'
            : type === String && typeof value === 'string');
  if (types.some(accepts)) return cloneData(value);
  if (spec.type === String) return value == null ? '' : String(value);
  if (spec.type === Number) return Number(value) || 0;
  if (spec.type === Boolean) return !!value;
  return propertyDefault({ type: spec.type });
}

export function equalData(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equalData(a[key], b[key]))
  );
}
import { resolveBehavior } from './behaviors';

