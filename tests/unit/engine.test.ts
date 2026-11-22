/**
 * 自研引擎 spike：编译器与响应式核心的纯逻辑测试（不依赖 DOM）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileExpr, splitExpression } from '../../packages/engine/src/compiler/expr';
import { generate } from '../../packages/engine/src/compiler/codegen';
import { parse } from '../../packages/engine/src/compiler/parser';
import { bundleWorker, collectWorkerPaths } from '../../packages/engine/src/compiler/worker';
import { compileWxss, scopeWxss } from '../../packages/engine/src/compiler/wxss';
import { toKeyframes } from '../../packages/engine/src/runtime/animate';
import { getByPath, parsePath, Store } from '../../packages/engine/src/runtime/store';

describe('表达式编译', () => {
  it('把插值切成静态片段和表达式', () => {
    expect(splitExpression('共 {{count}} 项')).toEqual([
      { type: 'text', value: '共 ' },
      { type: 'expr', value: 'count' },
      { type: 'text', value: ' 项' }
    ]);
  });

  it('数据字段改写为 s.data，并记下完整依赖路径', () => {
    const result = compileExpr("title + ' / ' + list[0].name");
    expect(new Function('s', `return (${result.code})`)({ data: { title: 'Title', list: [{ name: 'Name' }] } })).toBe('Title / Name');
    expect(result.deps).toEqual([['title'], ['list', '0', 'name']]);
  });

  it('循环变量改写为 s.item，依赖带上循环变量前缀', () => {
    const result = compileExpr('item.name || index', new Set(['item', 'index']));
    expect(new Function('s', `return (${result.code})`)({ item: { name: 'row' }, index: 2 })).toBe('row');
    expect(result.deps).toEqual([['item', 'name'], ['index']]);
  });

  it('方法调用里的属性名不会被当成数据字段', () => {
    const result = compileExpr('list.slice(0, 2).join(",")');
    expect(new Function('s', `return (${result.code})`)({ data: { list: [1, 2, 3] } })).toBe('1,2');
    expect(result.deps).toEqual([['list']]);
  });

  it('动态下标只依赖到数组本身', () => {
    const result = compileExpr('list[i]', new Set(['i']));
    expect(result.deps).toEqual([['list'], ['i']]);
  });
});

describe('模板代码生成', () => {
  const code = generate(
    'pages/index/index',
    parse(`<view class="card">
      <text>{{title}}</text>
      <view wx:if="{{show}}">A</view>
      <view wx:else>B</view>
      <view wx:for="{{list}}" wx:key="id" bindtap="onTap" data-id="{{item.id}}">{{item.name}}</view>
    </view>`)
  );

  it('静态结构直写，动态文本走绑定', () => {
    expect(code).toMatch(/const n0 = \$\.el\("view"\);/);
    expect(code).toContain('$.classes(n0, "card");');
    expect(code).toMatch(/\$\.text\(t\d+, \[\["title"\]\]/);
  });

  it('条件分支合并成一个 cond，else 无条件', () => {
    expect(code).toMatch(/\$\.cond\(n\d+, \[/);
    expect(code).toContain('deps: [["show"]]');
    expect(code).toContain('test: function () { return true }');
  });

  it('列表带 key、事件和相对依赖', () => {
    expect(code).toContain('key: function (item) { return item["id"] }');
    expect(code).toMatch(/\$\.on\(n\d+, "tap", "onTap", false, false\);/);
    expect(code).toMatch(/\$\.text\(t\d+, \[\["item","name"\]\]/);
  });
});

describe('WXSS', () => {
  it('rpx 编译成 calc，尺寸变化不用重新编译', () => {
    expect(compileWxss('.a { padding: 40rpx 20rpx; }')).toContain('calc(40 * var(--fmp-rpx))');
  });

  it('page 选择器映射到页面容器', () => {
    expect(compileWxss('page { background: #fff; }')).toContain('wx-page { background: #fff; }');
  });

  it('标签选择器映射到 wx- 组件', () => {
    expect(compileWxss('.btns button { margin: 0; }')).toContain('.btns wx-button { margin: 0; }');
    expect(compileWxss('view > text { color: red; }')).toContain('wx-view > wx-text');
  });

  it('env(safe-area-inset-*) 换成运行时变量，括号不重复', () => {
    expect(compileWxss('.a { padding-bottom: env(safe-area-inset-bottom); }')).toContain('var(--fmp-safe-area-inset-bottom)');
  });

  it('页面 / 组件样式限定选择器的每一段作用域', () => {
    expect(scopeWxss('.card .item { color: red; }', 'data-p', '3')).toContain('.card[data-p="3"] .item[data-p="3"]');
    expect(scopeWxss('.item, .title { color: red; }', 'data-c', '0')).toContain('.item[data-c="0"], .title[data-c="0"]');
  });
});

describe('数据路径', () => {
  it('解析 setData 的 key', () => {
    expect(parsePath('a.b[0].c')).toEqual(['a', 'b', '0', 'c']);
    expect(parsePath("list['x'].y")).toEqual(['list', 'x', 'y']);
  });

  it('不存在的路径读到 undefined', () => {
    expect(getByPath({ a: 1 }, ['a', 'b'])).toBeUndefined();
  });
});

describe('失效传播', () => {
  const create = () => {
    const store = new Store({
      a: { b: 1 },
      list: [
        { id: 1, name: 'x' },
        { id: 2, name: 'y' }
      ]
    });
    const holder = store.holder(store.rootScope());
    const hits: string[] = [];
    store.register([['a', 'b']], () => hits.push('a.b'), holder);
    store.register([['list']], () => hits.push('list'), holder);
    store.register([['list', '#1', 'name']], () => hits.push('item1'), holder);
    store.register([['list', '#2', 'name']], () => hits.push('item2'), holder);
    return { store, holder, hits };
  };

  it('只跑命中路径的绑定', () => {
    const { store, hits } = create();
    store.setData({ 'a.b': 2 });
    store.flushSync();
    expect(hits).toEqual(['a.b']);
  });

  it('列表下标经 key 改写后命中对应项和列表派生内容', () => {
    const { store, hits } = create();
    store.setKeyed('list', item => item.id);
    store.setData({ 'list[0].name': 'x2' });
    store.flushSync();
    expect(hits).toEqual(['list', 'item1']);
  });

  it('整体替换列表时，列表本身和所有项都刷新', () => {
    const { store, hits } = create();
    store.setKeyed('list', item => item.id);
    store.setData({
      list: [
        { id: 1, name: 'x' },
        { id: 2, name: 'y' }
      ]
    });
    store.flushSync();
    expect(hits.sort()).toEqual(['item1', 'item2', 'list']);
  });

  it('销毁 holder 后不再执行', () => {
    const { store, holder, hits } = create();
    holder.dispose();
    store.setData({ 'a.b': 3 });
    store.flushSync();
    expect(hits).toEqual([]);
  });
});

describe('模板与组件语法', () => {
  it('template 的 data 按对象字面量编译', () => {
    const code = generate('t', parse('<template is="row" data="{{item: first, index: 0}}" />'), {
      templates: { row: parse('<view>{{index + 1}}. {{item.name}}</view>') }
    });
    expect(code).toContain('$.template(');
    expect(code).toContain('return ({item: s.data.first, index: 0});');
    expect(code).toContain('s.data.item?.name');
  });

  it('slot 生成分发调用并忽略出口内子节点', () => {
    const code = generate('c', parse('<slot name="header">默认标题</slot>'));
    expect(code).toContain('$.slot(');
    expect(code).toContain('"header"');
    expect(code).not.toContain('默认标题');
  });

  it('组件标签的子节点放进 slotBody', () => {
    const code = generate('p', parse('<card><view slot="header">H</view></card>'), {
      components: { card: 'components/card/card' }
    });
    expect(code).toContain('$.slotBody(');
    expect(code).toMatch(/\$\.attribute\(\w+, "slot", "header"\)/);
  });

  it('capture-bind / catch 解析成捕获与阻止冒泡', () => {
    const code = generate('p', parse('<view capture-bind:tap="onTap" catch:touchmove="onMove" />'));
    expect(code).toContain('"tap", "onTap", false, true');
    expect(code).toContain('"touchmove", "onMove", true, false');
  });

  it('对象 wx:for 生成 *this 的 key 函数', () => {
    const code = generate('p', parse('<view wx:for="{{obj}}" wx:key="*this">{{item}}</view>'));
    expect(code).toContain('function (item) { return item }');
  });
});

describe('表达式编译（补充）', () => {
  it('对象字面量的值会替换，键不会', () => {
    const result = compileExpr('({ a: first, b: second })');
    expect(result.code).toBe('({ a: s.data.first, b: s.data.second })');
    expect(result.deps).toEqual([['first'], ['second']]);
  });

  it('三元表达式的两个分支都被替换', () => {
    const result = compileExpr('flag ? yes : no');
    expect(result.code).toBe('s.data.flag ? s.data.yes : s.data.no');
    expect(result.deps).toEqual([['flag'], ['yes'], ['no']]);
  });

  it('wxs 模块调用改写成 s.wxs', () => {
    const result = compileExpr('fmt.upper(title)', new Set(), new Set(['fmt']));
    expect(
      new Function('s', `return (${result.code})`)({
        data: { title: 'hello' },
        wxs: { fmt: { upper: (value: string) => value.toUpperCase() } }
      })
    ).toBe('HELLO');
    expect(result.deps).toEqual([['title']]);
  });
});

describe('Worker 打包', () => {
  const makeProject = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmp-worker-'));
    fs.mkdirSync(path.join(dir, 'workers'));
    fs.mkdirSync(path.join(dir, 'utils'));
    fs.writeFileSync(
      path.join(dir, 'workers', 'sum.js'),
      "var util = require('../utils/sum.js');\nworker.onMessage(function (res) { worker.postMessage({ sum: util.sum(res.message.list) }); });"
    );
    fs.writeFileSync(
      path.join(dir, 'utils', 'sum.js'),
      'module.exports = { sum: function (list) { return list.reduce(function (a, b) { return a + b; }, 0); } };'
    );
    fs.writeFileSync(path.join(dir, 'index.js'), "wx.createWorker('workers/sum.js');");
    return dir;
  };

  it('收集 app.json 与代码里的 createWorker 入口', () => {
    const dir = makeProject();
    const paths = collectWorkerPaths({ workers: [{ path: 'workers/other' }] }, [path.join(dir, 'index.js')], dir);
    expect(paths).toEqual(['workers/other.js', 'workers/sum.js']);
  });

  it('把入口依赖的模块内联成自包含脚本', () => {
    const dir = makeProject();
    const source = bundleWorker(path.join(dir, 'workers', 'sum.js'), dir);
    expect(source).toContain('"utils/sum"');
    expect(source).toContain('self.worker');
    expect(source).toContain('onMessage: function');
    expect(source).toContain('load("workers/sum")');
  });
});

describe('关键帧动画', () => {
  it('数值补单位、transform 合并', () => {
    const frames = toKeyframes([
      { opacity: 0, scale: 0.5, offset: 0 },
      { opacity: 1, scale: 1, translateX: 10, rotate: 45, width: 100, offset: 1 }
    ]);
    expect(frames[0]).toEqual({ opacity: 0, transform: 'scale(0.5)', offset: 0 });
    expect(frames[1].transform).toBe('scale(1) translateX(10px) rotate(45deg)');
    expect((frames[1] as any).width).toBe('100px');
  });
});

describe('内联样式', () => {
  it('style 里的 rpx 编译成 calc', () => {
    const code = generate('p', parse('<view style="width: 100rpx; margin-top: 4rpx" />'));
    expect(code).toContain('calc(100 * var(--fmp-rpx))');
    expect(code).toContain('calc(4 * var(--fmp-rpx))');
  });
});
