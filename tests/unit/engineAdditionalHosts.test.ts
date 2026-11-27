import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';

let browser: Browser;
let page: Page;

beforeAll(async () => { browser = await launchBrowser(); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });

async function mount(template: string) {
  page = await openRuntime(browser, {
    'pages/home/index': { definition: 'Page({})', template }
  });
}

async function hostStyle(id: string) {
  return page.locator(`#${id}`).evaluate(el => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      display: style.display,
      position: style.position,
      overflow: style.overflow,
      background: style.backgroundColor,
      lineHeight: style.lineHeight,
      width: box.width,
      height: box.height
    };
  });
}

describe('额外内置组件宿主样式', () => {
  it('live-player 在未指定尺寸时保留独立的媒体盒', async () => {
    await mount('<live-player id="player"/>');
    expect(await hostStyle('player')).toEqual({
      display: 'inline-block', position: 'relative', overflow: 'hidden',
      background: 'rgb(0, 0, 0)', lineHeight: '0px', width: 300, height: 225
    });
  });

  it('live-pusher 在空内容时不会被预览占位撑高', async () => {
    await mount('<view style="width:240px"><live-pusher id="pusher"/></view>');
    expect(await hostStyle('pusher')).toMatchObject({
      display: 'block', position: 'relative', overflow: 'hidden',
      background: 'rgb(0, 0, 0)', width: 240, height: 0
    });
  });

  it('functional-page-navigator 在未隐藏时参与内容布局', async () => {
    await mount('<view style="width:240px"><functional-page-navigator id="navigator"><view style="height:24px">进入</view></functional-page-navigator></view>');
    expect(await hostStyle('navigator')).toMatchObject({ display: 'block', width: 240, height: 24 });
  });

  it('ad 的宿主在默认状态使用整行布局', async () => {
    await mount('<view style="width:240px"><ad id="ad"/></view>');
    expect(await hostStyle('ad')).toMatchObject({ display: 'block', width: 240 });
    expect(await page.locator('#ad').evaluate(el => {
      const style = getComputedStyle(el);
      return [style.opacity, style.pointerEvents];
    })).toEqual(['1', 'auto']);
  });

  it.each(['camera', 'web-view'])('%s 在设置横向外边距后仍以父内容宽度填充', async tag => {
    await mount(`<view style="width:240px;height:160px"><${tag} id="host" style="margin-left:10px;margin-right:10px"/></view>`);
    expect((await hostStyle('host')).width).toBe(240);
  });

  it('媒体宿主允许页面显式覆盖宽高', async () => {
    await mount('<live-player id="player" style="width:180px;height:90px"/><live-pusher id="pusher" style="width:160px;height:80px"/>');
    expect(await hostStyle('player')).toMatchObject({ width: 180, height: 90 });
    expect(await hostStyle('pusher')).toMatchObject({ width: 160, height: 80 });
  });

  it('额外宿主在 hidden 状态下不占据布局盒', async () => {
    await mount('<ad id="ad" hidden/><camera id="camera" hidden/><live-player id="player" hidden/><live-pusher id="pusher" hidden/><functional-page-navigator id="navigator" hidden/>');
    const boxes = await page.locator('#ad, #camera, #player, #pusher, #navigator').evaluateAll(nodes => nodes.map(el => {
      const box = el.getBoundingClientRect();
      return [getComputedStyle(el).display, box.width, box.height];
    }));
    expect(boxes).toEqual(Array.from({ length: 5 }, () => ['none', 0, 0]));
  });
});
