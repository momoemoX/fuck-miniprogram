import { describe, expect, it } from 'vitest';
import { Store } from '../../packages/engine/src/runtime/store';

describe('引擎数据更新', () => {
  it('渲染数据保留提交时的快照，逻辑数据保持传入对象引用', () => {
    const store = new Store({ value: { count: 1 } });
    const scope = store.rootScope();
    store.data.value.count = 88;
    expect(scope.data.value.count).toBe(1);
    const value = { count: 5 };
    store.setData({ value });
    value.count = 99;
    expect(store.data.value).toBe(value);
    expect(scope.data.value.count).toBe(5);
  });

  it('逻辑字段可变成 undefined，渲染数据保留原值并将非有限数值转成 null', () => {
    const store = new Store({ value: 'old', number: 1 });
    store.setData({ value: undefined, number: NaN });
    expect(store.data.value).toBeUndefined();
    expect(Number.isNaN(store.data.number)).toBe(true);
    expect(store.rootScope().data).toEqual({ value: 'old', number: null });
  });
  it('列表局部更新保留真实下标，并刷新固定下标和按 key 绑定的内容', () => {
    // Given 同一列表同时被固定下标和 wx:for 引用
    const store = new Store({ list: [{ id: 'a', name: 'A' }] });
    const holder = store.holder(store.rootScope());
    const visible: string[] = [];
    store.setKeyed('list', item => item.id);
    store.register([['list', '0', 'name']], () => visible.push(store.data.list[0].name), holder);
    store.register([['list', '#a', 'name']], () => visible.push(store.data.list[0].name), holder);

    // When 通过真实下标修改一项
    store.setData({ 'list[0].name': 'B' });
    store.flushSync();

    // Then 数据中不出现依赖系统的 key，两个引用都能读到新值
    expect(store.data.list).toEqual([{ id: 'a', name: 'B' }]);
    expect(Object.keys(store.data.list)).toEqual(['0']);
    expect(visible).toEqual(['B', 'B']);
  });

  it('嵌套列表局部更新写入正确的父项', () => {
    const store = new Store({ groups: [{ id: 'g', rows: [{ id: 'r', name: 'A' }] }] });
    const holder = store.holder(store.rootScope());
    let visible = '';
    store.setKeyed('groups', item => item.id);
    store.setKeyed('groups.#g.rows', item => item.id);
    store.register(
      [['groups', '#g', 'rows', '#r', 'name']],
      () => {
        visible = store.data.groups[0].rows[0].name;
      },
      holder
    );

    store.setData({ 'groups[0].rows[0].name': 'B' });
    store.flushSync();

    expect(visible).toBe('B');
    expect(store.data.groups).toEqual([{ id: 'g', rows: [{ id: 'r', name: 'B' }] }]);
  });

  it('对象的派生内容在子字段更新后刷新', () => {
    const store = new Store({ profile: { name: 'A' } });
    const holder = store.holder(store.rootScope());
    let visible = '';
    store.register(
      [['profile']],
      () => {
        visible = JSON.stringify(store.data.profile);
      },
      holder
    );

    store.setData({ 'profile.name': 'B' });
    store.flushSync();

    expect(visible).toBe('{"name":"B"}');
  });

  it('绑定刷新抛错后仍能处理下一次数据更新', () => {
    const store = new Store({ value: 0 });
    const holder = store.holder(store.rootScope());
    let visible = 0;
    store.register(
      [['value']],
      () => {
        if (store.data.value === 1) throw new Error('render failed');
        visible = store.data.value;
      },
      holder
    );

    store.setData({ value: 1 });
    expect(() => store.flushSync()).toThrow('render failed');
    store.setData({ value: 2 });
    store.flushSync();

    expect(visible).toBe(2);
  });
});
