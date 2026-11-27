import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchBrowser, openRuntime } from '../browser';
let browser: Browser;let page: Page;
beforeAll(async()=>{browser=await launchBrowser();});
beforeEach(async()=>{page=await openRuntime(browser,{'pages/home/index':{definition:'Page({})',template:'<scroll-view id="scroll" scroll-y style="height:100px;display:block"><view style="height:400px"/></scroll-view><view id="box" style="width:20px;height:10px;opacity:1"/>'}});});
afterEach(async()=>{await page?.close();});afterAll(async()=>{await browser?.close();});
describe('滚动动画、缓存与加密存储',()=>{
  it('滚动动画由偏移推进而不由墙上时间推进',async()=>{
    await page.evaluate(()=>{(window as any).__FMP__.currentPage().animate('#box',[{width:20},{width:100}],100,{scrollSource:'#scroll',timeRange:100,startScrollOffset:0,endScrollOffset:100});});
    await page.waitForTimeout(150);
    expect(await page.locator('#box').evaluate(el=>el.getBoundingClientRect().width)).toBe(20);
    await page.locator('#scroll').evaluate(el=>{el.scrollTop=50;});
    await page.waitForFunction(()=>Math.abs(document.querySelector('#box')!.getBoundingClientRect().width-60)<2);
    expect(await page.locator('#box').evaluate(el=>Math.round(el.getBoundingClientRect().width))).toBe(60);
  });
  it('clearAnimation 只清理 true 属性并恢复原内联值',async()=>{
    expect(await page.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.animate('#box',[{width:20,opacity:1},{width:100,opacity:0.5}],10,r));await new Promise<void>(r=>p.clearAnimation('#box',{width:true,opacity:false},r));const s=getComputedStyle(document.querySelector('#box')!);return [parseFloat(s.width),s.opacity];})).toEqual([20,'0.5']);
  });
  it('连续动画覆盖同一属性而清理不取消外部动画',async()=>{
    expect(await page.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();const el=document.querySelector('#box')!;const external=el.animate([{height:'10px'},{height:'30px'}],{duration:10000});await new Promise<void>(r=>p.animate('#box',[{width:20},{width:45}],10,r));p.clearAnimation('#box');return [external.playState,getComputedStyle(el).width];})).toEqual(['running','20px']);
  });
  it('缓存规则匹配 method、query 和动态路径，删除后不再命中',async()=>{
    expect(await page.evaluate(()=>{const cm=(window as any).wx.createCacheManager({origin:'https://cache.test'});const id=cm.addRule('GET /items/:id?kind=a');const match=(url:string,method='GET')=>!!cm.match({url:'https://cache.test'+url,method});const before=[typeof id,match('/items/7?kind=a'),match('/items/7?kind=b'),match('/items/7?kind=a','POST')];cm.deleteRule(id);return [...before,match('/items/7?kind=a')];})).toEqual(['string',true,false,false,false]);
  });
  it('addRules 支持正则与 dataSchema 并保持规则 id 对应',async()=>{
    expect(await page.evaluate(()=>{const cm=(window as any).wx.createCacheManager({origin:'https://cache.test'});const ids=cm.addRules([/\/info$/, {url:'/items',method:'POST',dataSchema:[{name:'n',schema:{type:'number'}}]}]);const good=cm.match({url:'https://cache.test/items',method:'POST',data:{n:1}});const bad=cm.match({url:'https://cache.test/items',method:'POST',data:{n:'1'}});cm.clearRules();return [ids.length,!!good,!!bad,!!cm.match({url:'https://cache.test/info',method:'GET'})];})).toEqual([2,true,false,false]);
  });
  it('缓存拦截 Promise 结果真实进入请求回调并支持 off 和手动开关',async()=>{
    expect(await page.evaluate(async()=>{const wx=(window as any).wx;const cm=wx.createCacheManager({mode:'none'});const trace:string[]=[];const fn=()=>Promise.resolve({data:{cached:true},statusCode:200,header:{},cookies:[]});cm.on('request',fn);cm.start();const state=cm.state;await new Promise<void>(r=>wx.request({url:'https://cache.test/items',success:(v:any)=>trace.push(String(v.data.cached)),complete:()=>{trace.push('complete');r();}}));cm.off('request',fn);cm.stop();return [state,cm.state,trace];})).toEqual([1,0,['true','complete']]);
  });
  it('有效网络响应写入缓存并在 always 模式返回带 fromCache 的响应',async()=>{
    await page.route('https://cache.test/**',route=>route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'{"value":7}'}));
    expect(await page.evaluate(async()=>{const wx=(window as any).wx;const cm=wx.createCacheManager({mode:'none',origin:'https://cache.test'});cm.addRule('/items');const request=()=>new Promise<any>((resolve,reject)=>wx.request({url:'https://cache.test/items',success:resolve,fail:reject}));await request();cm.start();const res=await request();return [res.data.value,res.fromCache,typeof cm.match({url:'https://cache.test/items',method:'GET'}).createTime];})).toEqual([7,true,'number']);
  });
  it('加密读写保持类型且未声明 encrypt 时成功结果不含 data 字段',async()=>{
    expect(await page.evaluate(async()=>{const wx=(window as any).wx;await wx.setStorage({key:'secret',data:{text:'private-marker',n:7,flag:false},encrypt:true});const good=await wx.getStorage({key:'secret',encrypt:true});const plain=await wx.getStorage({key:'secret'});return [good.data,Object.prototype.hasOwnProperty.call(plain,'data'),plain.errMsg,Object.values(localStorage).join('').includes('private-marker')];})).toEqual([{text:'private-marker',n:7,flag:false},false,'getStorage:ok',false]);
  });
  it('加密数据持久化后重新启动仍可解密且删除后失败',async()=>{
    expect(await page.evaluate(async()=>{const w=window as any;await w.wx.setStorage({key:'saved',data:[1,false,''],encrypt:true});w.__FMP__.boot({page:'pages/home/index'});await new Promise<void>(r=>setTimeout(r,0));const res=await w.wx.getStorage({key:'saved',encrypt:true});await w.wx.removeStorage({key:'saved'});let failed=false;try{await w.wx.getStorage({key:'saved',encrypt:true});}catch{failed=true;}return [res.data,failed];})).toEqual([[1,false,''],true]);
  });
  it('Storage 拒绝非布尔 encrypt 且失败只走 fail 和 complete',async()=>{
    expect(await page.evaluate(async()=>{const trace:string[]=[];await new Promise<void>(r=>(window as any).wx.setStorage({key:'invalid',data:1,encrypt:'true',success:()=>trace.push('success'),fail:()=>trace.push('fail'),complete:()=>{trace.push('complete');r();}}));return trace;})).toEqual(['fail','complete']);
  });
  it('缓存 request 处理器挂起时请求仍可超时且只交付一次失败',async()=>{
    expect(await page.evaluate(async()=>{const wx=(window as any).wx;const cm=wx.createCacheManager({mode:'always'});cm.on('request',()=>new Promise(()=>{}));const trace:string[]=[];await new Promise<void>(r=>wx.request({url:'https://cache.test/hang',timeout:20,success:()=>trace.push('success'),fail:()=>trace.push('fail'),complete:()=>{trace.push('complete');r();}}));return trace;})).toEqual(['fail','complete']);
  });
  it('弱网模式随离线恢复通知状态且 off 后不再接收事件',async()=>{
    await page.evaluate(()=>{const w=window as any;w.cm=w.wx.createCacheManager();w.events=[];w.enter=()=>w.events.push('enter');w.cm.on('enterWeakNetwork',w.enter);w.cm.on('exitWeakNetwork',()=>w.events.push('exit'));});
    await page.context().setOffline(true);
    await page.waitForFunction(()=>(window as any).cm.state===1);
    await page.context().setOffline(false);
    await page.waitForFunction(()=>(window as any).cm.state===0);
    expect(await page.evaluate(()=>{const w=window as any;w.cm.off('enterWeakNetwork',w.enter);return w.events;})).toEqual(['enter','exit']);
  });

});
