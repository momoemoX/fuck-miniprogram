import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';
let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await launchBrowser(); });
beforeEach(async () => { page = await openRuntime(browser, { 'pages/home/index': { definition: 'Page({})', template: '<view>页面</view>' } }); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });
async function open(method: string) {
  await page.evaluate(method => {
    const w = window as any;
    w.trace = [];
    w.wx[method]({ latitude: 31.2, longitude: 121.4,
      success: (res: any) => { w.trace.push('success'); w.result = res; },
      fail: (res: any) => { w.trace.push('fail'); w.result = res; }, complete: () => w.trace.push('complete') });
  }, method);
  await page.getByRole('dialog').waitFor();
}
describe('位置宿主交互', () => {
  it.each(['chooseLocation', 'choosePoi'])('%s 不传坐标时先显示地图供用户选择', async method => {
    await page.evaluate(method => (window as any).wx[method]({ fail() {} }), method);
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 1500 }).toBe(1);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(await page.getByRole('dialog').count()).toBe(0);
  });
  it.each(['chooseLocation', 'choosePoi'])('用户取消 %s 后失败回调只交付一次并卸载浮层', async method => {
    await open(method);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).trace)).toEqual(['fail', 'complete']);
    expect(await page.evaluate(() => (window as any).result.errMsg)).toMatch(/:fail.*cancel/);
    expect(await page.getByRole('dialog').count()).toBe(0);
  });
  it.each(['chooseLocation', 'choosePoi'])('用户在 %s 选择可见坐标后返回对应地点', async method => {
    await open(method);
    await page.getByRole('button', { name: '地图中心', exact: true }).click();
    expect(await page.getByRole('dialog').count()).toBe(1);
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).trace)).toEqual(['success', 'complete']);
    const result = await page.evaluate(() => (window as any).result);
    expect(result).toMatchObject({ name: '地图中心', latitude: 31.2, longitude: 121.4 });
    expect(result.address.length).toBeGreaterThan(0);
    expect(await page.getByRole('dialog').count()).toBe(0);
  });
  it('用户查看传入位置后可以关闭详情且内容作为文本显示', async () => {
    await page.evaluate(() => (window as any).wx.openLocation({ latitude: 31.2, longitude: 121.4, name: '<b>海边</b>', address: '示例地址' }));
    expect(await page.getByRole('dialog').count()).toBe(1);
    expect(await page.getByText('<b>海边</b>', { exact: true }).count()).toBe(1);
    expect(await page.getByText('示例地址', { exact: true }).count()).toBe(1);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    expect(await page.getByRole('dialog').count()).toBe(0);
  });
});
