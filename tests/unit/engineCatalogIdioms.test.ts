import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { parse } from '../../packages/engine/src/compiler/parser';
import { launchBrowser, openRuntime } from '../browser';
import contract from '../fixtures/component-contract-3.7.12.json';
let browser: Browser;let page: Page;
const entries=Object.entries(contract);
beforeAll(async()=>{
  browser=await launchBrowser();
  const template=entries.map(([tag,spec])=>`<${tag} id="d-${tag}"/><${tag} id="b-${tag}" ${spec.attributes.filter(a=>a.property in spec.values).map(a=>`${a.name}="{{values['${tag}']['${a.property}']}}"`).join(' ')}/>`).join('');
  page=await openRuntime(browser,{'pages/home/index':{definition:`Page({data:{values:${JSON.stringify(Object.fromEntries(entries.map(([tag,spec])=>[tag,spec.values])))}}})`,template}});
});
afterAll(async()=>{await page?.close();await browser?.close();});
async function properties(id:string,names:string[]) {
  return page.evaluate(({id,names})=>new Promise<any>(resolve=>{
    const p=(window as any).__FMP__.currentPage();p.createSelectorQuery().select('#'+id).fields({properties:names},(node:any)=>{const out:any={};for(const name of names)out[name]=node[name]===undefined?null:node[name];resolve(out);}).exec();
  }),{id,names});
}
describe('3.7.12 内置组件公开属性查询',()=>{
  it.each(entries)('%s 省略属性时返回目标版本默认值',async(tag,spec)=>{expect(await properties('d-'+tag,Object.keys(spec.defaults).length ? Object.keys(spec.defaults) : ['value'])).toEqual(Object.keys(spec.defaults).length ? spec.defaults : {value:null});});
  it.each(entries)('%s 绑定属性时返回目标版本值及类型',async(tag,spec)=>{expect(await properties('b-'+tag,Object.keys(spec.bound).length ? Object.keys(spec.bound) : ['value'])).toEqual(Object.keys(spec.bound).length ? spec.bound : {value:null});});
  it('input 的 value 动态清空且 slider 数值同步更新',async()=>{
    await page.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({'values.input.value':'','values.slider.value':11},r));});
    expect(await properties('b-input',['value'])).toEqual({value:''});expect(await properties('b-slider',['value'])).toEqual({value:11});
  });
});
describe('编译框架习语',()=>{
  it('同名模板递归进入不同数据时完整显示有限树',async()=>{
    const p=await openRuntime(browser,{'pages/home/index':{definition:`Page({data:{node:{name:'a',child:{name:'b',child:{name:'c'}}}}})`,template:'<template is="tree" data="{{node:node}}"/>',options:{templates:{tree:[{type:'element',tag:'text',attrs:[],children:[{type:'text',value:'{{node.name}}'}]},{type:'element',tag:'template',attrs:[{name:'wx:if',value:'{{node.child}}'},{name:'is',value:'tree'},{name:'data',value:'{{node:node.child}}'}],children:[]}]}}}});
    try{expect(await p.locator('wx-page wx-text').allTextContents()).toEqual(['a','b','c']);}finally{await p.close();}
  });
  it('连字符属性、关联事件、空处理器与表单工厂组合保留公开行为',async()=>{
    const p=await openRuntime(browser,{
      'pages/home/index':{definition:`Page({data:{handler:''},linked:function(e){this.link=e.detail},submitted:function(e){this.form=e.detail.value},outer:function(){this.taps=(this.taps||0)+1}})`,template:'<view bindtap="outer"><button id="tap" bindtap="{{handler}}">tap</button></view><form bindsubmit="submitted"><field id="field" u-i="x" u-p="y" name="answer" value="two" bind:__l="linked"/><button id="submit" form-type="submit">submit</button></form>',options:{components:{field:'components/field'}}},
      'components/field':{definition:`Component({behaviors:['wx://form-field'],properties:{uI:String,uP:String},lifetimes:{attached:function(){this.triggerEvent('__l',{id:this.data.uI,parent:this.data.uP})}}})`,template:'<text>{{value}}</text>'}
    });
    try{await p.locator('#tap').click();await p.locator('#submit').click();expect(await p.evaluate(()=>{const p=(window as any).__FMP__.currentPage();return [p.link,p.form,p.taps];})).toEqual([{id:'x',parent:'y'},{answer:'two'},1]);}finally{await p.close();}
  });
  it('WXS 计算模板名在数据切换后重新分派',async()=>{
    const p=await openRuntime(browser,{
      'pages/home/index':{definition:"Page({data:{kind:'a'}})",template:'<template is="{{r.choose(kind)}}"/>',options:{wxs:['r'],wxsMap:{r:'handler'},templates:{a:parse('<text>A</text>'),b:parse('<text>B</text>')}}},
      handler:{definition:"module.exports={choose:function(kind){return kind}}"}
    });
    try{expect(await p.locator('wx-page wx-text').allTextContents()).toEqual(['A']);await p.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({kind:'b'},r));});expect(await p.locator('wx-page wx-text').allTextContents()).toEqual(['B']);}finally{await p.close();}
  });
  it('自引用虚拟组件按有限深度挂载并随深度缩小销毁子树',async()=>{
    const p=await openRuntime(browser,{
      'pages/home/index':{definition:'Page({data:{depth:3}})',template:'<tree depth="{{depth}}"/>',options:{components:{tree:'components/tree'}}},
      'components/tree':{definition:'Component({options:{virtualHost:true,addGlobalClass:true},properties:{depth:Number}})',template:'<text>{{depth}}</text><tree wx:if="{{depth>1}}" depth="{{depth-1}}"/>',options:{components:{tree:'components/tree'}}}
    });
    try{expect(await p.locator('wx-page wx-text').allTextContents()).toEqual(['3','2','1']);await p.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({depth:1},r));});expect(await p.locator('wx-page wx-text').allTextContents()).toEqual(['1']);}finally{await p.close();}
  });
  it('textarea focus 和 cursor 绑定作用于真实输入控件',async()=>{
    const p=await openRuntime(browser,{'pages/home/index':{definition:'Page({data:{focus:false,cursor:2}})',template:'<textarea id="area" value="hello" focus="{{focus}}" cursor="{{cursor}}"/>'}});
    try{await p.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({focus:true},r));});expect(await p.locator('#area textarea').evaluate(el=>[document.activeElement===el,(el as HTMLTextAreaElement).selectionStart])).toEqual([true,2]);}finally{await p.close();}
  });
  it('slider changing 事件通过真实控件输出 number 类型',async()=>{
    const p=await openRuntime(browser,{'pages/home/index':{definition:'Page({changed:function(e){this.value=e.detail.value}})',template:'<slider id="slider" bindchanging="changed"/>'}});
    try{await p.locator('#slider input').evaluate(el=>{(el as HTMLInputElement).value='42';el.dispatchEvent(new Event('input',{bubbles:true}));});expect(await p.evaluate(()=>(window as any).__FMP__.currentPage().value)).toBe(42);}finally{await p.close();}
  });

  it('swiper 受控 current 更新交付 change 与实际滚动完成事件',async()=>{
    const p=await openRuntime(browser,{'pages/home/index':{definition:"Page({data:{current:0},changed:function(e){(this.events||(this.events=[])).push(['change',e.detail.current,e.detail.source])},finished:function(e){(this.events||(this.events=[])).push(['finish',e.detail.current,e.detail.source])}})",template:'<swiper current="{{current}}" style="width:300px;height:100px" bindchange="changed" bindanimationfinish="finished"><swiper-item>A</swiper-item><swiper-item>B</swiper-item><swiper-item>C</swiper-item></swiper>'}});
    try{await p.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();p.events=[];await new Promise<void>(r=>p.setData({current:2},r));});await p.waitForFunction(()=>(window as any).__FMP__.currentPage().events.length===2);expect(await p.evaluate(()=>(window as any).__FMP__.currentPage().events)).toEqual([['change',2,''],['finish',2,'']]);}finally{await p.close();}
  });
  it('progress 只在 active 填充动画真正完成后交付 activeend',async()=>{
    const p=await openRuntime(browser,{'pages/home/index':{definition:"Page({data:{active:false,percent:0},finished:function(e){this.ended=e.detail.curPercent}})",template:'<progress percent="{{percent}}" active="{{active}}" duration="1" bindactiveend="finished"/>'}});
    try{await p.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({percent:50},r));});expect(await p.evaluate(()=>(window as any).__FMP__.currentPage().ended)).toBeUndefined();await p.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();await new Promise<void>(r=>p.setData({active:true,percent:100},r));});await p.waitForFunction(()=>(window as any).__FMP__.currentPage().ended!==undefined);expect(await p.evaluate(()=>(window as any).__FMP__.currentPage().ended)).toBe(100);}finally{await p.close();}
  });

  it('disabled 按钮拦截自身 tap 并在解除禁用后恢复',async()=>{
    const p=await openRuntime(browser,{'pages/home/index':{definition:'Page({data:{disabled:true,count:0},tap:function(){this.setData({count:this.data.count+1})}})',template:'<button id="blocked" disabled="{{disabled}}" bindtap="tap">tap</button>'}});
    try{expect(await p.evaluate(async()=>{const p=(window as any).__FMP__.currentPage();(document.querySelector('#blocked') as HTMLElement).click();const disabled=p.data.count;await new Promise<void>(r=>p.setData({disabled:false},r));(document.querySelector('#blocked') as HTMLElement).click();return [disabled,p.data.count];})).toEqual([0,1]);}finally{await p.close();}
  });

});
