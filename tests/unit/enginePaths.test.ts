import { describe, expect, it } from 'vitest';
import { parsePath, Store } from '../../packages/engine/src/runtime/store';

describe('小程序数据路径', () => {
  it('引号内的点号和括号属于同一个数据字段', () => {
    expect(parsePath('root["a.b"]["x[y]"]')).toEqual(['root', 'a.b', 'x[y]']);
  });
  it('引号字段支持转义并可与数字下标混用', () => {
    expect(parsePath('root["a\\\"b"][0].value')).toEqual(['root', 'a"b', '0', 'value']);
  });
  it('按带点号的字段写入数据时不创建多余的层级', () => {
    const store = new Store({ root: { 'a.b': 1 } });
    store.setData({ 'root["a.b"]': 2 });
    expect(store.data).toEqual({ root: { 'a.b': 2 } });
  });
  it('特殊字段名只写入当前数据，不修改对象原型', () => {
    const store = new Store({});
    store.setData({ '__proto__.enginePathMarker': true });
    expect(Object.prototype).not.toHaveProperty('enginePathMarker');
    expect(Object.prototype.hasOwnProperty.call(store.data, '__proto__')).toBe(true);
  });
});
