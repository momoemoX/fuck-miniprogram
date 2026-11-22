import { deliver } from './util';

export class IdleCallbacks {
  private tasks = new Map<number, () => void>();
  private sequence = 0;
  private disposed = false;

  request(callback: IdleRequestCallback, options?: IdleRequestOptions) {
    if (this.disposed || typeof callback !== 'function') return;
    const id = ++this.sequence;
    this.tasks.set(id, () => undefined);
    const run = (deadline: IdleDeadline) => {
      if (!this.tasks.has(id) || this.disposed) return;
      this.tasks.delete(id);
      deliver(callback, deadline);
    };
    if (typeof globalThis.requestIdleCallback === 'function') {
      const nativeId = globalThis.requestIdleCallback(run, options);
      const cancel = globalThis.cancelIdleCallback;
      if (this.tasks.has(id)) this.tasks.set(id, () => cancel?.call(globalThis, nativeId));
    } else {
      const requested = performance.now();
      const value = Number(options?.timeout);
      const timeout = Number.isFinite(value) ? Math.max(0, value) : Infinity;
      const timer = setTimeout(() => {
        const expired = performance.now() - requested >= timeout;
        const end = performance.now() + 50;
        run(
          Object.create({
            get didTimeout() {
              return expired;
            },
            timeRemaining() {
              return expired ? 0 : Math.max(0, end - performance.now());
            }
          })
        );
      }, 0);
      this.tasks.set(id, () => clearTimeout(timer));
    }
    return id;
  }

  cancel(id: number) {
    const cancel = this.tasks.get(id);
    this.tasks.delete(id);
    cancel?.();
  }

  dispose() {
    this.disposed = true;
    const pending = Array.from(this.tasks.values());
    this.tasks.clear();
    for (const cancel of pending) cancel();
  }
}
