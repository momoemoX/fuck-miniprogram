import { describe, expect, it } from 'vitest';
import { compileExpr, splitExpression } from '../../packages/engine/src/compiler/expr';
import { parse } from '../../packages/engine/src/compiler/parser';
import { generate } from '../../packages/engine/src/compiler/codegen';

const evaluate = (expression: string, data: object) => {
  const result = compileExpr(expression);
  return new Function('s', `return (${result.code})`)({ data });
};

describe('WXML 表达式兼容', () => {
  it('对象简写保留字段名并读取页面数据', () => {
    expect(evaluate('{name, count}', { name: 'A', count: 3 })).toEqual({ name: 'A', count: 3 });
  });
  it('对象展开与简写混用时按声明顺序覆盖字段', () => {
    expect(evaluate('{...base, name, nested: {count}}', { base: { name: 'old', x: 1 }, name: 'A', count: 3 })).toEqual({
      name: 'A',
      x: 1,
      nested: { count: 3 }
    });
  });
  it('插值允许字符串内的结束符和相邻的对象括号', () => {
    expect(splitExpression("x{{ {label: '}}', nested: {value: count}} }}y")).toEqual([
      { type: 'text', value: 'x' },
      { type: 'expr', value: " {label: '}}', nested: {value: count}} " },
      { type: 'text', value: 'y' }
    ]);
  });
  it('模板文本里的小于运算不会被识别为标签', () => {
    const nodes = parse("<text>{{count < 5 ? 'less' : 'more'}}</text><view/>");
    expect(nodes).toHaveLength(2);
    expect((nodes[0] as any).children).toEqual([{ type: 'text', value: "{{count < 5 ? 'less' : 'more'}}" }]);
  });
  it('模板表达式中的科学计数法按数值解析', () => {
    expect(evaluate('1e-3 + count', { count: 2 })).toBe(2.001);
  });
  it('模板读取缺失成员时返回空值并保留其他表达式', () => {
    expect(evaluate('missing.deep.name', {})).toBeUndefined();
    expect(evaluate('items[index].name', { items: [], index: 3 })).toBeUndefined();
    expect(evaluate('missing.value || title', { title: 'fallback' })).toBe('fallback');
    expect(evaluate('({ name: title }).name', { title: 'present' })).toBe('present');
  });
  it('递归模板编译为可在运行时截断的调用', () => {
    const nodes = parse('<view>{{node.label}}</view><template wx:if="{{node.child}}" is="tree" data="{{node: node.child}}"/>');
    const code = generate('tree-page', parse('<template is="tree" data="{{node: root}}"/>'), { templates: { tree: nodes } });
    expect(code.length).toBeLessThan(10000);
    expect(() => new Function('__FMP__', code)).not.toThrow();
  });
  it('动态模板选择器生成可更新的模板绑定', () => {
    const code = generate('page', parse('<template is="{{selected}}" data="{{name}}"/>'), {
      templates: { one: parse('<text>{{name}}</text>') }
    });
    expect(code).toContain('selected');
    expect(code).toContain('$.template(');
  });
});
