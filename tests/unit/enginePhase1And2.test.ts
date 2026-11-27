import { describe, expect, it } from 'vitest';
import { CacheManager } from '../../packages/engine/src/runtime/api/cache-manager';
import { parseAnimateOptions } from '../../packages/engine/src/runtime/animate';
import { componentStyles, pageStyles } from '../../packages/engine/src/runtime/styles';

function fakeElement() {
  const attrs = new Map<string, string>();
  return {
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    getAttribute(name: string) {
      return attrs.get(name) ?? null;
    }
  } as unknown as Element;
}

describe('CacheManager 规则匹配与管理', () => {
  it('支持字符串简写规则、正则与对象规则的增删与匹配', () => {
    const cm = new CacheManager({ origin: 'http://127.0.0.1:8123', mode: 'always' });
    const ruleId = cm.addRule('GET /plain');
    expect(typeof ruleId).toBe('string');
    expect(ruleId.length).toBeGreaterThan(0);

    const hit = cm.match({ url: 'http://127.0.0.1:8123/plain', method: 'GET' });
    expect(hit).toBeTruthy();
    expect(hit?.ruleId).toBe(ruleId);

    expect(cm.match({ url: 'http://127.0.0.1:8123/other', method: 'GET' })).toBeUndefined();
    expect(cm.match({ url: 'http://127.0.0.1:8123/plain', method: 'POST' })).toBeUndefined();
    expect(cm.match({ url: 'http://example.com/plain', method: 'GET' })).toBeUndefined();

    cm.deleteRule(ruleId);
    expect(cm.match({ url: 'http://127.0.0.1:8123/plain', method: 'GET' })).toBeUndefined();

    const [r1, r2] = cm.addRules([/^\/items\/\d+$/, { method: 'POST', url: '/users/:id' }]);
    expect(cm.match({ url: 'http://127.0.0.1:8123/items/42', method: 'GET' })?.ruleId).toBe(r1);
    expect(cm.match({ url: 'http://127.0.0.1:8123/users/alice', method: 'POST' })?.ruleId).toBe(r2);
    cm.clearRules();
    expect(cm.match({ url: 'http://127.0.0.1:8123/items/42', method: 'GET' })).toBeUndefined();
  });
});

describe('滚动驱动关键帧参数解析', () => {
  it('识别 scrollTimeline 配置对象', () => {
    const parsed = parseAnimateOptions(200, [
      {
        scrollSource: '#node-scroll',
        timeRange: 200,
        startScrollOffset: 0,
        endScrollOffset: 100
      }
    ]);
    expect(parsed.duration).toBe(200);
    expect(parsed.scroll).toEqual({
      scrollSource: '#node-scroll',
      timeRange: 200,
      startScrollOffset: 0,
      endScrollOffset: 100
    });
  });
});

describe('样式作用域、独立分包与 externalClasses / ~ / ^ 前缀', () => {
  it('独立分包页面不继承 global (app.wxss) 样式作用域', () => {
    const page: any = {};
    const el = fakeElement();
    pageStyles(page, el, { attr: 'fmp-page', value: '3' }, true);
    expect(page.__pageStyles).not.toContain('global');
    expect(page.__pageStyles).toContain('p3');
  });

  it('支持两级 externalClasses 转发以及 ~ 和 ^ 类前缀', () => {
    const page: any = {};
    const pageEl = fakeElement();
    pageStyles(page, pageEl, { attr: 'fmp-page', value: '0' }, false);

    const bar: any = {};
    const barEl = fakeElement();
    componentStyles(bar, barEl, { attr: 'fmp-component', value: '1' }, 'isolated', page, ['bar-class'], () => ({
      'bar-class': 'ext-pass-width'
    }));

    const foo: any = {};
    const fooEl = fakeElement();
    componentStyles(foo, fooEl, { attr: 'fmp-component', value: '2' }, 'isolated', bar, ['my-class'], () => ({
      'my-class': 'bar-class'
    }));

    const leaf = fakeElement();
    foo.__applyClasses(leaf, 'my-class');
    expect(leaf.getAttribute('class')?.split(' ')).toEqual(
      expect.arrayContaining(['ext-pass-width', 'ext-pass-width--fmp-p0'])
    );

    const tildeNode = fakeElement();
    bar.__applyClasses(tildeNode, '~page-tilde-cls');
    expect(tildeNode.getAttribute('class')?.split(' ')).toEqual(
      expect.arrayContaining(['page-tilde-cls', 'page-tilde-cls--fmp-p0'])
    );

    const caretNode = fakeElement();
    foo.__applyClasses(caretNode, '^caret-parent-cls');
    expect(caretNode.getAttribute('class')?.split(' ')).toEqual(
      expect.arrayContaining(['caret-parent-cls', 'caret-parent-cls--fmp-c1'])
    );
  });
});
