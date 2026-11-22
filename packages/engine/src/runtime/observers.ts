import { getByPath, parsePath, type Dep } from './store';
import { invoke } from './callbacks';

export type Observer = string | ((...args: any[]) => void);
export interface DataObserver {
  paths: Array<{ path: Dep; deep: boolean }>;
  callback: Observer;
}

export function dataObserver(pattern: string, callback: Observer): DataObserver {
  return {
    paths: pattern.split(',').map(field => {
      const path = parsePath(field.trim());
      const deep = path[path.length - 1] === '**';
      if (deep) path.pop();
      return { path, deep };
    }),
    callback
  };
}

function prefix(a: Dep, b: Dep) {
  return a.length <= b.length && a.every((part, index) => part === b[index]);
}

export function callObserver(instance: any, callback: Observer, args: any[]) {
  const fn = typeof callback === 'string' ? instance[callback] : callback;
  invoke(instance, fn, args);
}

export function notifyObservers(instance: any, observers: DataObserver[], changes: Dep[]) {
  for (const observer of observers) {
    const matches = observer.paths.some(({ path, deep }) => changes.some(change => prefix(change, path) || (deep && prefix(path, change))));
    if (matches)
      callObserver(
        instance,
        observer.callback,
        observer.paths.map(({ path }) => getByPath(instance.data, path))
      );
  }
}
