import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await launchBrowser(); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });
async function fixture(binding = 'value') {
  page = await openRuntime(browser, {
    'pages/home/index': {
      definition: `Component({data:{value:'seed',count:5,flag:true,obj:{name:'nested'},shown:true},observers:{value:function(v){this.seen=(this.seen||[]).concat(v)} }})`,
      template: `<text id="mirror">{{value}}</text><child id="a" wx:if="{{shown}}" model:value="{{${binding}}}" model:count="{{count}}" model:flag="{{flag}}"/><child id="b" model:value="{{value}}"/><input id="input" model:value="{{value}}"/><textarea id="area" model:value="{{value}}"/>`,
      options: { components: { child: 'components/child/index' } }
    },
    'components/child/index': {
      definition: `Component({properties:{value:String,count:Number,flag:Boolean}})`,
      template: '<text>{{value}}</text>'
    }
  });
}
describe('model 双向绑定', () => {
  it('父组件更新同步到两个子组件和输入控件', async () => {
    await fixture();
    expect(await page.evaluate(async () => {
      const p = (window as any).__FMP__.currentPage();
      await new Promise<void>(resolve => p.setData({ value: 'parent' }, resolve));
      return [p.selectComponent('#a').data.value, p.selectComponent('#b').data.value, document.querySelector('#input')?.textContent, document.querySelector('#mirror')?.textContent];
    })).toEqual(['parent', 'parent', '', 'parent']);
  });
  it('子组件回写通知父 observers 并收敛同级显示', async () => {
    await fixture();
    expect(await page.evaluate(async () => {
      const p = (window as any).__FMP__.currentPage(); p.seen = [];
      await new Promise<void>(resolve => p.selectComponent('#a').setData({ value: 'child' }, resolve));
      return [p.data.value, p.selectComponent('#b').data.value, document.querySelector('#mirror')?.textContent, p.seen];
    })).toEqual(['child', 'child', 'child', ['child']]);
  });
  it('子组件回写保持数字、false 与空字符串类型', async () => {
    await fixture();
    expect(await page.evaluate(async () => {
      const p = (window as any).__FMP__.currentPage();
      await new Promise<void>(resolve => p.selectComponent('#a').setData({ value: '', count: 42, flag: false }, resolve));
      return [p.data.value, typeof p.data.value, p.data.count, typeof p.data.count, p.data.flag, typeof p.data.flag];
    })).toEqual(['', 'string', 42, 'number', false, 'boolean']);
  });
  it.each(['input','area'])('原生 %s 键入及清空回写父数据', async id => {
    await fixture();
    const input = page.locator(`#${id} ${id === 'area' ? 'textarea' : 'input'}`);
    await input.fill('typed');
    expect(await page.evaluate(() => (window as any).__FMP__.currentPage().data.value)).toBe('typed');
    await input.fill('');
    expect(await page.evaluate(() => (window as any).__FMP__.currentPage().data.value)).toBe('');
  });
  it.each(['obj.name', 'value + "!"', 'count + 1', 'flag ? value : ""'])('非法 model 表达式 %s 不把依赖误作回写目标', async binding => {
    await fixture(binding);
    expect(await page.evaluate(async () => {
      const p = (window as any).__FMP__.currentPage();
      await new Promise<void>(resolve => p.selectComponent('#a').setData({ value: 'unexpected' }, resolve));
      return [p.data.value, p.data.obj.name, p.data.count, p.data.flag];
    })).toEqual(['seed','nested',5,true]);
  });
  it('子组件销毁后保存的实例不能继续回写父数据', async () => {
    await fixture();
    expect(await page.evaluate(async () => {
      const p = (window as any).__FMP__.currentPage(); const old = p.selectComponent('#a');
      await new Promise<void>(resolve => p.setData({ shown: false }, resolve));
      old.setData({ value: 'late' }); await Promise.resolve();
      return p.data.value;
    })).toBe('seed');
  });
});
