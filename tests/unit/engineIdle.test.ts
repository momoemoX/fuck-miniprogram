import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemApi } from '../../packages/engine/src/runtime/api/system';

let system: SystemApi;
let api: any;
let callbacks: Map<number, IdleRequestCallback>;
let cancelled: number[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', {});
  callbacks = new Map();
  cancelled = [];
  let sequence = 0;
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => cancelled.push(id));
  system = new SystemApi({ deviceInfo: () => ({ screenWidth: 375, screenHeight: 812 }) } as any);
  api = system.api();
});
afterEach(() => {
  system.dispose();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('空闲回调生命周期', () => {
  const deadline = { didTimeout: false, timeRemaining: () => 10 };
  it('取消任务后忽略已经排队的迟到回调', () => {
    const callback = vi.fn();
    const id = api.requestIdleCallback(callback, { timeout: 5 });
    expect(callback).not.toHaveBeenCalled();
    api.cancelIdleCallback(id);
    callbacks.get(1)!(deadline);
    expect(callback).not.toHaveBeenCalled();
    expect(cancelled).toEqual([1]);
  });
  it('完成的回调可继续调度，取消旧标识不会影响新任务', () => {
    const events: string[] = [];
    const first = api.requestIdleCallback(() => {
      events.push('first');
      api.requestIdleCallback(() => events.push('second'));
    });
    callbacks.get(1)!(deadline);
    api.cancelIdleCallback(first);
    callbacks.get(2)!(deadline);
    expect(events).toEqual(['first', 'second']);
  });
  it('应用销毁取消所有待执行回调并拒绝旧实例的新调度', () => {
    const callback = vi.fn();
    api.requestIdleCallback(callback);
    api.requestIdleCallback(callback);
    system.dispose();
    for (const run of callbacks.values()) run(deadline);
    api.requestIdleCallback(callback);
    expect(callback).not.toHaveBeenCalled();
    expect(cancelled).toEqual([1, 2]);
    expect(callbacks.size).toBe(2);
  });
  it('缺少原生调度时仍异步执行且支持取消和期限对象', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('cancelIdleCallback', undefined);
    const results: any[] = [];
    const cancelledTask = api.requestIdleCallback(() => results.push('cancelled'));
    api.cancelIdleCallback(cancelledTask);
    api.requestIdleCallback(
      (value: IdleDeadline) => results.push({ keys: Object.keys(value), didTimeout: value.didTimeout, remaining: value.timeRemaining() }),
      { timeout: 0 }
    );
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toEqual([{ keys: [], didTimeout: true, remaining: 0 }]);
  });
});
