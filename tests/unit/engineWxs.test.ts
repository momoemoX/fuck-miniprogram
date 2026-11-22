import { describe, expect, it } from 'vitest';
import { compileWxs } from '../../packages/engine/src/compiler/wxs';
import { exposeWxs, wxsCall, wxsProperty } from '../../packages/engine/src/runtime/wxs';

function execute(source: string) {
  const module = { exports: {} as any };
  new Function('__FMP__', 'module', 'exports', compileWxs(source))({ wxsProperty, wxsCall }, module, module.exports);
  return module.exports;
}

describe('WXS 属性语义', () => {
  it('WXS 不暴露宿主全局对象和未提供的 JavaScript 构造器', () => {
    expect(
      execute(
        `module.exports = [typeof globalThis, typeof process, typeof Function, typeof Array, typeof Object, typeof String, typeof Boolean, typeof Promise, typeof setTimeout, typeof exports];`
      )
    ).toEqual(Array(10).fill('undefined'));
  });

  it('WXS 保留 Number Date Math JSON 与本地同名变量的词法作用域', () => {
    expect(
      execute(
        `function local(Array) { var Object = 'local'; return Array + ':' + Object; } module.exports = [typeof Number, typeof Date, typeof Math, typeof JSON, local('array'), typeof Array, typeof Object];`
      )
    ).toEqual(['function', 'function', 'object', 'object', 'array:local', 'undefined', 'undefined']);
  });

  it('WXS 的对象字段名不会遮蔽模块顶层变量', () => {
    expect(execute(`var label = 'value'; module.exports = { label: label, globalThis: 'field', constructor: 'own' };`)).toEqual({
      label: 'value',
      globalThis: 'field',
      constructor: 'own'
    });
  });

  it('WXS 拒绝 this、动态依赖和 JavaScript 模块依赖', () => {
    expect(() => compileWxs('module.exports = typeof this;')).toThrow();
    expect(() => compileWxs('var path = "./other.wxs"; module.exports = require(path);')).toThrow();
    expect(() => compileWxs('module.exports = require("./logic.js");')).toThrow();
  });

  it('WXS 的 require 只能用于静态依赖调用', () => {
    expect(() => compileWxs('module.exports = typeof require;')).toThrow();
    expect(() => compileWxs('var load = require; module.exports = load;')).toThrow();
  });

  it('WXS 调用与返回的对象不会修改调用方数据或模块内部状态', () => {
    const state = { count: 0 };
    const source = {
      state,
      change(value: any) {
        value.count = 99;
        this.state.count++;
        return this.state;
      }
    };
    const module = exposeWxs(source);
    const input = { count: 1 };
    const result = module.change(input);
    result.count = 100;
    expect(input).toEqual({ count: 1 });
    expect(source.state).toEqual({ count: 1 });
    expect(module.change).toBe(module.change);
  });
  it('WXS 将内置构造器读取为类型名称并保留用户字段', () => {
    expect(
      execute(
        `var key = 'constructor'; var object = { constructor: 'own' }; module.exports = [ [].constructor, ({})[key], (1).constructor, ''.constructor, true.constructor, object.constructor ];`
      )
    ).toEqual(['Array', 'Object', 'Number', 'String', 'Boolean', 'own']);
  });

  it('WXS 的计算属性调用保留方法接收者和参数顺序', () => {
    expect(
      execute(`var a = [1, 2], method = 'join'; module.exports = { joined: a[method]('-'), length: a['length'], item: a[1] };`)
    ).toEqual({ joined: '1-2', length: 2, item: 2 });
  });

  it('WXS 在参数改变方法前取得计算属性调用的函数', () => {
    expect(
      execute(
        `var value = { run: function(arg) { return 'old:' + arg; } }; function replace() { value.run = function() { return 'new'; }; return 'argument'; } module.exports = value['run'](replace());`
      )
    ).toBe('old:argument');
  });

  it('WXS 的属性赋值、自增和删除继续修改原对象', () => {
    expect(
      execute(
        `var value = { constructor: 'old', count: 1 }; value['count']++; value.constructor = 'new'; value['other'] = 5; delete value['other']; module.exports = [value.constructor, value.count, value.other];`
      )
    ).toEqual(['new', 2, undefined]);
  });

  it('WXS 的字符串和注释不参与属性改写', () => {
    expect(
      execute(`// [].constructor
      module.exports = 'array.constructor|value["constructor"]';`)
    ).toBe('array.constructor|value["constructor"]');
  });
});
