import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { createRequire, registerModule, setResolveAlias } from '../../packages/engine/src/runtime/modules';
import { launchBrowser, openRuntime } from '../browser';
let browser: Browser; let page: Page;
beforeAll(async () => { browser = await launchBrowser(); });
afterEach(async () => { await page?.close(); setResolveAlias({}); });
afterAll(async () => { await browser?.close(); });
describe('异步模块与分包', () => {
  it('require.async 异步交付并与同步别名共享导出身份', async () => {
    let executions=0;registerModule('async/shared',(_r,m)=>{executions++;m.exports={value:21};});setResolveAlias({'@shared':'async/shared'});
    const require=createRequire('async/page');const promise=require.async('@shared');expect(promise).toBeInstanceOf(Promise);
    const result=await promise;expect(result).toBe(require('./shared'));expect(executions).toBe(1);
  });
  it('缺失异步模块拒绝且回调加载错误只交付 errCb', async () => {
    const require=createRequire('async/page');await expect(require.async('./missing')).rejects.toBeInstanceOf(Error);
    const result=await new Promise(resolve=>require('./missing',()=>resolve('success'),error=>resolve(error instanceof Error)));
    expect(result).toBe(true);
  });
  it('独立分包冷启动不执行主 App，进入主包保留默认对象字段', async () => {
    page=await openRuntime(browser,{
      app:{definition:`App({globalData:{main:true},onLaunch:function(){this.launched=true}})`},
      'indie/page':{definition:`Page({onLoad:function(){this.before=typeof getApp();getApp({allowDefault:true}).marker='preserved'}})`,template:'<view/>'},
      'pages/home/index':{definition:'Page({})',template:'<view/>'}
    },{pages:['indie/page','pages/home/index'],entry:'indie/page',subpackages:[{root:'indie',pages:['page'],independent:true}]});
    expect(await page.evaluate(async()=>{const w=window as any;const before=w.__FMP__.currentPage().before;await w.wx.reLaunch({url:'/pages/home/index'});return [before,w.getApp().marker,w.getApp().launched,w.getApp().globalData.main];})).toEqual(['undefined','preserved',true,true]);
  });
  it('分包占位先挂载并替换为真实组件，保留最新属性与事件监听', async () => {
    page=await openRuntime(browser,{
      'pages/home/index':{definition:`Page({data:{title:'hello'},onNotify:function(e){this.notified=e.detail.title},onLoad:function(){this.trace=[]}})`,template:'<widget id="widget" title="{{title}}" bind:notify="onNotify"/>',options:{components:{widget:'pack/widget'}}},
      'components/placeholder':{definition:`Component({lifetimes:{attached:function(){getCurrentPages()[getCurrentPages().length-1].trace.push('placeholder')},detached:function(){getCurrentPages()[getCurrentPages().length-1].trace.push('detached')}}})`,template:'<text>loading</text>'},
      'pack/widget':{definition:`Component({properties:{title:String},lifetimes:{attached:function(){getCurrentPages()[getCurrentPages().length-1].trace.push('real')}},methods:{notify:function(){this.triggerEvent('notify',{title:this.data.title})}}})`,template:'<text>{{title}}</text>'}
    },{subpackages:[{root:'pack',pages:[]}],pageConfig:{'pages/home/index':{usingComponents:{widget:'pack/widget',loading:'components/placeholder'},componentPlaceholder:{widget:'loading'}}}});
    expect(await page.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({title:'updated'},r));const c=p.selectComponent('#widget');c.notify();return [p.trace,c.data.title,p.notified];})).toEqual([['placeholder','detached','real'],'updated','updated']);
  });
  it('requiredComponents 配置仅在目标页首次使用时执行组件模块', async () => {
    page=await openRuntime(browser,{
      'pages/home/index':{definition:'Page({})',template:'<view/>'},
      'pages/lazy/index':{definition:'Page({})',template:'<lazy/>',options:{components:{lazy:'components/lazy'}}},
      'components/lazy':{definition:`getApp({allowDefault:true}).executed=true;Component({})`,template:'<text>lazy</text>'}
    },{pages:['pages/home/index','pages/lazy/index'],lazyCodeLoading:'requiredComponents'});
    expect(await page.evaluate(async()=>{const w=window as any;const before=!!w.getApp({allowDefault:true}).executed;await w.wx.navigateTo({url:'/pages/lazy/index'});return [before,w.getApp({allowDefault:true}).executed];})).toEqual([false,true]);
  });
});
