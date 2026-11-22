import { describe, expect, it } from 'vitest';
import { mergeData } from '../../packages/engine/src/runtime/definition';

describe('组件初始数据合并', () => {
  it('组件把原型名称保留为独立数据字段', () => {
    const target: Record<string, any> = {};
    const source = JSON.parse('{"__proto__":{"marker":"own"},"constructor":{"label":"data"}}');
    try {
      mergeData(target, source);
      expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
      expect(target.__proto__).toEqual({ marker: 'own' });
      expect(({} as any).marker).toBeUndefined();
      expect(target.constructor).toEqual({ label: 'data' });
    } finally {
      delete (Object.prototype as any).marker;
    }
  });
  it('behavior 合并对象时保留嵌套字段且数组按后定义覆盖', () => {
    const target = { nested: { first: 1 }, list: [1, 2] };
    mergeData(target, { nested: { second: 2 }, list: [3] });
    expect(target).toEqual({ nested: { first: 1, second: 2 }, list: [3] });
  });
});
