import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';
let browser: Browser; let page: Page;
beforeAll(async () => { browser = await launchBrowser(); });
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });
async function fixture() {
  page = await openRuntime(browser, {
    'pages/home/index': {
      definition: `Page({data:{payload:{value:1},style:'width:10px',classes:'base'},record:function(v){(this.log||(this.log=[])).push(v)},stateRecord:function(v){(this.stateLog||(this.stateLog=[])).push(v)},outer:function(){this.bubbled=true}})`,
      template: '<view bind:touchmove="outer"><view id="box" data-n="{{7}}" prop="{{payload}}" change:prop="{{r.changed}}" style="{{style}}" class="{{classes}}" bind:touchmove="{{r.stop}}"/><view class="chip"/><view class="chip"/></view>',
      options: { wxs: ['r'], wxsMap: { r: 'handler' } }
    },
    handler: { definition: `module.exports={changed:function(n,o,owner,node){owner.callMethod('record',{next:n,prev:o||null});var s=node.getState();s.hits=(s.hits||0)+1;owner.callMethod('stateRecord',{hits:s.hits,n:node.getDataset().n,count:owner.selectAllComponents('.chip').length});node.setStyle('height:14px');node.addClass('remove-me');node.removeClass('remove-me');node.setStyle({width:'40rpx',opacity:0.5});node.addClass('added');},stop:function(){return false}}` }
  });
}
describe('WXS 视图响应器', () => {
  it('对象属性的局部更新触发响应并保留旧 payload 快照', async () => {
    await fixture();
    expect(await page.evaluate(async () => {
      const p=(window as any).__FMP__.currentPage(); await new Promise<void>(r=>p.setData({'payload.value':2},r)); return p.log;
    })).toEqual([{next:{value:1},prev:null},{next:{value:2},prev:{value:1}}]);
  });
  it('WXS 样式支持 rpx 和无单位数值且优先于后续模板绑定', async () => {
    await fixture();
    expect(await page.evaluate(async () => {
      const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({style:'width:90px;opacity:1',classes:'replacement'},r));
      const el=document.querySelector('#box')!;const s=getComputedStyle(el);return [parseFloat(s.width),s.opacity,el.classList.contains('added')];
    })).toEqual([20,'0.5',true]);
  });
  it('WXS 返回 false 同时阻止冒泡与可取消事件默认行为', async () => {
    await fixture();
    expect(await page.evaluate(() => {
      const p=(window as any).__FMP__.currentPage();const el=document.querySelector('#box')!;el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'touch'}));
      const e=new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId:1,pointerType:'touch',clientY:20});el.dispatchEvent(e);return [e.defaultPrevented,!!p.bubbled];
    })).toEqual([true,false]);
  });
  it('描述符状态跨调用持久、选择结果及 dataset 可供逻辑方法读取', async () => {
    await fixture();
    expect(await page.evaluate(async () => {
      const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({payload:{value:3}},r));
      return [p.stateLog, getComputedStyle(document.querySelector('#box')!).height, document.querySelector('#box')!.classList.contains('remove-me')];
    })).toEqual([[{hits:1,n:7,count:2},{hits:2,n:7,count:2}],'14px',false]);
  });
  it('WXS callMethod 的逻辑通知先于后续冒泡逻辑处理器',async()=>{
    page=await openRuntime(browser,{
      'pages/home/index':{definition:"Page({data:{},record:function(){(this.trace||(this.trace=[])).push('wxs')},outer:function(){(this.trace||(this.trace=[])).push('outer')}})",template:'<view bindtouchstart="outer"><view id="touch" bindtouchstart="{{r.start}}"/></view>',options:{wxs:['r'],wxsMap:{r:'handler'}}},
      handler:{definition:"module.exports={start:function(e,owner){owner.callMethod('record',{})}}"}
    });
    expect(await page.evaluate(async()=>{const el=document.querySelector('#touch')!;el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:2,pointerType:'touch'}));await Promise.resolve();return (window as any).__FMP__.currentPage().trace;})).toEqual(['wxs','outer']);
  });

});
