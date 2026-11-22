import { describe, expect, it } from 'vitest';
import { loadModule, registerModule } from '../../packages/engine/src/runtime/modules';

describe('小程序模块加载', () => {
  it('同名 JavaScript 与 WXS 文件分别解析且互不覆盖', () => {
    registerModule('coexist/tool', (_require, module) => {
      module.exports = 'logic';
    });
    registerModule('coexist/tool.wxs', (_require, module) => {
      module.exports = 'view';
    });
    expect(loadModule('coexist/tool.js')).toBe('logic');
    expect(loadModule('coexist/tool.wxs')).toBe('view');
  });
  it('模块在同一实例缓存中复用，并在不同渲染实例间隔离', () => {
    registerModule('context/counter', (_require, module) => {
      let count = 0;
      module.exports = { next: () => ++count };
    });
    registerModule('context/reader', (require, module) => {
      module.exports = require('./counter');
    });
    const first = new Map();
    const second = new Map();
    expect(loadModule('context/counter', undefined, first).next()).toBe(1);
    expect(loadModule('context/reader', undefined, first).next()).toBe(2);
    expect(loadModule('context/reader', undefined, second).next()).toBe(1);
    expect(loadModule('context/counter').next()).toBe(1);
  });
  it('相互引用的模块能读到已经替换的导出对象', () => {
    registerModule('cycle/a', (require, module) => {
      module.exports = { name: 'a' };
      module.exports.other = require('./b').seen;
    });
    registerModule('cycle/b', (require, module) => {
      module.exports = { seen: require('./a').name };
    });
    expect(loadModule('cycle/a')).toEqual({ name: 'a', other: 'a' });
  });
  it('模块加载失败后再次读取仍然抛出原错误', () => {
    registerModule('broken/a', () => {
      throw new Error('broken module');
    });
    expect(() => loadModule('broken/a')).toThrow('broken module');
    expect(() => loadModule('broken/a')).toThrow('broken module');
  });
  it('目录引用能解析到 index 模块', () => {
    registerModule('directory/utils/index', (_require, module) => {
      module.exports = 'index';
    });
    registerModule('directory/app', (require, module) => {
      module.exports = require('./utils');
    });
    expect(loadModule('directory/app')).toBe('index');
  });
  it('包引用优先使用所在目录的 miniprogram_npm', () => {
    registerModule('pkg/miniprogram_npm/tool/index', (_require, module) => {
      module.exports = 'nested';
    });
    registerModule('miniprogram_npm/tool/index', (_require, module) => {
      module.exports = 'root';
    });
    registerModule('pkg/page', (require, module) => {
      module.exports = require('tool');
    });
    expect(loadModule('pkg/page')).toBe('nested');
  });
  it('不存在的模块明确抛错，不静默返回空对象', () => {
    expect(() => loadModule('missing/module')).toThrow(/missing\/module/);
  });
});
