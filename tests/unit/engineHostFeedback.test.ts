import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';
let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await launchBrowser(); });
beforeEach(async () => {
  page = await openRuntime(browser, { 'pages/home/index': {
    definition: `Page({data:{mode:'selector',value:0,range:['Alpha','Beta']},choose(e){this.result=e.detail.value},under(){this.count=(this.count||0)+1}})`,
    template: '<button id="under" bindtap="under">底层</button><picker id="picker" mode="{{mode}}" value="{{value}}" range="{{range}}" bindchange="choose">选择</picker>'
  } });
});
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });
describe('反馈浮层与选择器交互', () => {
  it('用户在窄视口仍能点击操作菜单的取消并卸载菜单', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => (window as any).wx.showActionSheet({ itemList: ['第一项', '第二项'], fail: () => {} }));
    const cancel = page.getByRole('button', { name: '取消', exact: true });
    expect(await cancel.evaluate(el => { const r=el.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===el||el.contains(hit); })).toBe(true);
    await cancel.click();
    expect(await cancel.count()).toBe(0);
  });
  it.each(['selector', 'multiSelector', 'time', 'date', 'region'])('用户完成 %s 后返回明确选定的值', async mode => {
    const initial: Record<string, unknown> = { selector: 0, multiSelector: [0,0], time: '10:00', date: '2026-01-01', region: ['北京市','北京市','东城区'] };
    await page.evaluate(async ({mode,value}) => { const p=(window as any).getCurrentPages()[0];await new Promise<void>(r=>p.setData({mode,value,range:mode==='multiSelector'?[['Alpha','Beta'],['One','Two']]:['Alpha','Beta']},r)); }, {mode,value:initial[mode]});
    await page.locator('#picker').click();
    if (mode === 'selector' || mode === 'multiSelector') {
      await page.getByRole('option', { name: 'Beta', exact: true }).click();
      if (mode === 'multiSelector') await page.getByRole('option', { name: 'Two', exact: true }).click();
    } else if (mode === 'time') {
      await page.getByRole('spinbutton', { name: '时', exact: true }).fill('11');
      await page.getByRole('spinbutton', { name: '分', exact: true }).fill('30');
    } else if (mode === 'date') {
      await page.getByRole('spinbutton', { name: '年', exact: true }).fill('2026');
      await page.getByRole('spinbutton', { name: '月', exact: true }).fill('2');
      await page.getByRole('spinbutton', { name: '日', exact: true }).fill('3');
    } else {
      await page.getByRole('option', { name: '广东省', exact: true }).click();
      await page.getByRole('option', { name: '广州市', exact: true }).click();
      await page.getByRole('option', { name: '天河区', exact: true }).click();
    }
    await page.getByRole('button', { name: '确定', exact: true }).click();
    const expected: Record<string, unknown> = { selector: 1, multiSelector:[1,1], time:'11:30', date:'2026-02-03', region:['广东省','广州市','天河区'] };
    await expect.poll(()=>page.evaluate(()=>(window as any).getCurrentPages()[0].result)).toEqual(expected[mode]);
    expect(await page.getByRole('button', { name:'确定',exact:true }).count()).toBe(0);
  });
  it.each(['showToast','showLoading'])('%s 的 mask 阻止真实点击且隐藏后恢复底层交互', async method => {
    await page.locator('#under').click();
    const point=(await page.locator('#under').boundingBox())!;
    await page.evaluate(method=>(window as any).wx[method]({title:'处理中',mask:true,duration:60000}),method);
    await page.mouse.click(point.x+point.width/2,point.y+point.height/2);
    expect(await page.evaluate(()=>(window as any).getCurrentPages()[0].count)).toBe(1);
    await page.evaluate(method=>(window as any).wx[method==='showToast'?'hideToast':'hideLoading'](),method);
    await page.locator('#under').click();
    expect(await page.evaluate(()=>(window as any).getCurrentPages()[0].count)).toBe(2);
  });
});
