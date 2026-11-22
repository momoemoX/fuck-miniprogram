import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';
let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await launchBrowser(); });
beforeEach(async () => { page = await openRuntime(browser, { 'pages/home/index': { definition: 'Page({})', template: '<button id="choose">选择文件</button>' } }); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });
const image = (width: number) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="300"><rect width="100%" height="100%" fill="red"/></svg>`);

describe('媒体宿主交互', () => {
  it.each([
    ['previewImage', { urls: [] }], ['previewImage', {}], ['previewMedia', { sources: [] }],
    ['openLocation', {}], ['openLocation', { latitude: 31 }], ['openLocation', { longitude: 121 }]
  ])('%s 缺少必要参数时按 fail、complete 顺序结束', async (method, options) => {
    const result = await page.evaluate(async ({ method, options }) => {
      const events: string[] = []; let failure = '';
      await new Promise<void>(resolve => {
        (window as any).wx[method as string]({ ...options as object,
          success: () => events.push('success'), fail: (res: any) => { events.push('fail'); failure = res.errMsg; },
          complete: (res: any) => { events.push('complete'); events.push(String(res.errMsg === failure)); resolve(); }
        });
      });
      return { events, failure };
    }, { method, options });
    expect(result.events).toEqual(['fail', 'complete', 'true']);
    expect(result.failure).toMatch(new RegExp('^' + method + ':fail'));
  });

  it.each([0, 1, 'url'])('用户按 current=%s 打开预览并能切换和关闭', async current => {
    const urls = [image(400), image(480)];
    await page.evaluate(({ urls, current }) => (window as any).wx.previewImage({ urls, current: current === 'url' ? urls[1] : current }), { urls, current });
    const dialog = page.getByRole('dialog');
    expect(await dialog.count()).toBe(1);
    await expect.poll(() => dialog.locator('img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(current === 0 ? 400 : 480);
    await dialog.getByRole('button', { name: '下一张' }).click();
    await expect.poll(() => dialog.locator('img').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(current === 0 ? 480 : 400);
    await dialog.locator('img').click();
    expect(await dialog.count()).toBe(0);
  });

  it('用户选择图片后获得可读取并可解码的虚拟文件', async () => {
    await page.locator('#choose').evaluate(el => el.addEventListener('click', () => {
      (window as any).wx.chooseImage({ count: 1, success: (res: any) => { (window as any).chosen = res; } });
    }));
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#choose').click();
    await (await chooser).setFiles({ name: 'photo.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(decodeURIComponent(image(400).split(',')[1])) });
    await page.waitForFunction(() => !!(window as any).chosen);
    const path = await page.evaluate(() => (window as any).chosen.tempFilePaths[0]);
    expect(path).toMatch(/^wxfile:\/\/tmp\//);
    const result = await page.evaluate(async path => {
      const wx = (window as any).wx;
      const info = await wx.getImageInfo({ src: path });
      const bytes = await new Promise<any>((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: path, success: resolve, fail: reject }));
      return [info.width, info.height, bytes.data.byteLength];
    }, path);
    expect(result.slice(0, 2)).toEqual([400, 300]);
    expect(result[2]).toBeGreaterThan(0);
  });
});
