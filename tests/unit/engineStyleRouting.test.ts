import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';
import { scopeWxss } from '../../packages/engine/src/compiler/wxss';
let browser: Browser; let page: Page;
beforeAll(async()=>{browser=await launchBrowser();});afterEach(async()=>{await page?.close();});afterAll(async()=>{await browser?.close();});
async function styles(mode='isolated',pageMode='shared') {
  page=await openRuntime(browser,{
    'pages/home/index':{definition:`Component({options:{styleIsolation:${JSON.stringify(pageMode)}},data:{external:'pageClass'}})`,template:'<view id="page" class="parentClass"/><parent outer="{{external}}"/>',options:{components:{parent:'components/parent/index'}}},
    'components/parent/index':{definition:`Component({externalClasses:['outer'],options:{styleIsolation:${JSON.stringify(mode)}}})`,template:'<view id="inside" class="pageClass"/><view id="fromPage" class="~pageClass"/><view id="parentOwn" class="parentClass"/><child forwarded="outer"/>',options:{components:{child:'components/child/index'}}},
    'components/child/index':{definition:`Component({externalClasses:['forwarded']})`,template:'<view id="fromParent" class="^parentClass"/><view id="forwarded" class="forwarded"/>'}
  },{scopes:{pages:{'pages/home/index':'0'},components:{'components/parent/index':'1','components/child/index':'2'}}});
  await page.addStyleTag({content:'wx-view{width:13px}'+scopeWxss('.pageClass{width:61px}.parentClass{height:11px}', 'fmp-style~','p0')+scopeWxss('.parentClass{height:73px}','fmp-style~','c1')+scopeWxss('.parentClass{height:99px}','fmp-style~','c2')+scopeWxss('.parentClass{height:73px}','fmp-style~','shared','wx-page[fmp-shared~="c1"] ')});
}
describe('路由与样式边界',()=>{
  it.each([['isolated',false],['apply-shared',true],['shared',true]] as const)('组件 %s 控制页面类是否流入',async(mode,inherited)=>{
    await styles(mode);expect(await page.locator('#inside').evaluate(el=>getComputedStyle(el).width)).toBe(inherited?'61px':'13px');
  });
  it('页面类和父类前缀选择准确的样式来源',async()=>{
    await styles();expect(await page.evaluate(()=>[getComputedStyle(document.querySelector('#fromPage')!).width,getComputedStyle(document.querySelector('#fromParent')!).height])).toEqual(['61px','73px']);
  });
  it('外部类经过两级转发仍保留页面样式来源',async()=>{
    await styles();expect(await page.locator('#forwarded').evaluate(el=>getComputedStyle(el).width)).toBe('61px');
  });
  it('page-apply-shared 页面不接受共享子组件反向样式',async()=>{
    await styles('shared','page-apply-shared');expect(await page.locator('#page').evaluate(el=>getComputedStyle(el).height)).toBe('11px');
  });
  it('组件 Router 与 pageRouter 按各自目录解析并保留 query',async()=>{
    page=await openRuntime(browser,{
      'pages/home/index':{definition:'Page({})',template:'<child id="child"/>',options:{components:{child:'components/card/index'}}},
      'components/card/index':{definition:'Component({})',template:'<view/>'},
      'components/detail/index':{definition:'Page({})',template:'<view/>'},
      'pages/detail/index':{definition:'Page({})',template:'<view/>'}
    },{pages:['pages/home/index','components/detail/index','pages/detail/index']});
    expect(await page.evaluate(async()=>{const w=window as any;let p=w.__FMP__.currentPage();await p.selectComponent('#child').router.navigateTo({url:'../detail/index?x=1'});const first=w.__FMP__.currentPage();await w.wx.navigateBack({});p=w.__FMP__.currentPage();await p.selectComponent('#child').pageRouter.navigateTo({url:'../detail/index?x=2'});return [first.route,first.options.x,w.__FMP__.currentPage().route,w.__FMP__.currentPage().options.x];})).toEqual(['components/detail/index','1','pages/detail/index','2']);
  });
  it('routeDone 在目标 onReady 之后且返回时通知原实例',async()=>{
    page=await openRuntime(browser,{
      'pages/home/index':{definition:'Page({})',template:'<probe id="probe"/>',options:{components:{probe:'components/probe'}}},
      'pages/next':{definition:`Page({onReady:function(){this.ready=true}})`,template:'<probe id="probe"/>',options:{components:{probe:'components/probe'}}},
      'components/probe':{definition:`Component({data:{hits:0},pageLifetimes:{routeDone:function(){this.setData({hits:this.data.hits+1})}}})`,template:'<view/>'}
    },{pages:['pages/home/index','pages/next']});
    await page.evaluate(async()=>{await (window as any).wx.navigateTo({url:'/pages/next'});});
    await page.waitForFunction(()=>{const p=(window as any).__FMP__.currentPage();return p.ready&&p.selectComponent('#probe').data.hits===1;});
    const before=await page.evaluate(()=>(window as any).getCurrentPages()[0].selectComponent('#probe').data.hits);
    await page.evaluate(async()=>{await (window as any).wx.navigateBack({});});
    await page.waitForFunction(n=>(window as any).__FMP__.currentPage().selectComponent('#probe').data.hits===n+1,before);
    expect(await page.evaluate(()=>(window as any).getCurrentPages().length)).toBe(1);
  });
  it('共享样式的作用域前缀不增加业务选择器优先级',async()=>{
    page=await openRuntime(browser,{
      'pages/home/index':{definition:'Page({})',template:'<child/>',options:{components:{child:'components/shared'}}},
      'components/shared':{definition:"Component({options:{styleIsolation:'shared'}})",template:'<view id="specific" class="fallback pageClass"/>'}
    },{scopes:{pages:{'pages/home/index':'0'},components:{'components/shared':'1'}}});
    await page.addStyleTag({content:scopeWxss('.pageClass.pageClass{width:61px}','fmp-style~','p0')+scopeWxss('.fallback{width:11px}','fmp-style~','c1')+scopeWxss('.fallback{width:11px}','fmp-style~','shared','wx-page[fmp-shared~="c1"] ')});
    expect(await page.locator('#specific').evaluate(el=>getComputedStyle(el).width)).toBe('61px');
  });
  it('Component 页面查询参数进入 properties 时解码',async()=>{
    page=await openRuntime(browser,{
      'pages/home/index':{definition:'Page({})',template:'<view/>'},
      'pages/component':{definition:'Component({properties:{code:String}})',template:'<text>{{code}}</text>'}
    },{pages:['pages/home/index','pages/component']});
    expect(await page.evaluate(async()=>{const w=window as any;await w.wx.navigateTo({url:'/pages/component?code=a%20b%2Fc'});return w.__FMP__.currentPage().properties.code;})).toBe('a b/c');
  });

});
