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
    'pages/home/index': {
      definition: `Page({data:{checked:false,disabled:false,color:'#123456',value:30,showValue:true,type:'switch'},changed:function(e){this.result=e.detail.value}})`,
      template
    }
  });
}

describe('内置组件外观', () => {
  it('image 固定比例使用布局尺寸并保持父级缩放后的正确比例', async () => {
    const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>');
    await mount(`<view style="transform:scale(.5);transform-origin:0 0"><image id="scaled-image" src="${src}" mode="widthFix" style="width:120px;height:120px"/></view>`);
    await expect.poll(()=>page.locator('#scaled-image').evaluate(el=>[el.getBoundingClientRect().width,el.getBoundingClientRect().height])).toEqual([60,30]);
  });
  it('input 内层填满宿主并清除浏览器默认内边距', async () => {
    await mount('<input id="field" value="Text"/>');
    expect(await page.locator('#field input').evaluate(el=>[getComputedStyle(el).padding,el.getBoundingClientRect().width-el.parentElement!.getBoundingClientRect().width])).toEqual(['0px',0]);
  });
  it('picker-view 未设置高度时由页面决定占用空间', async () => {
    await mount('<picker-view id="empty-height"><picker-view-column id="empty-column"><view>第一</view><view>第二</view></picker-view-column></picker-view>');
    expect(await page.locator('#empty-height, #empty-column').evaluateAll(items=>items.map(el=>el.getBoundingClientRect().height))).toEqual([0,0]);
  });
  it('swiper 前后边距与同时展示数量更新子项可见宽度', async () => {
    await mount('<swiper id="margins" style="width:300px;height:100px" previous-margin="10px" next-margin="20px" display-multiple-items="2"><swiper-item>A</swiper-item><swiper-item>B</swiper-item><swiper-item>C</swiper-item></swiper>');
    expect(await page.locator('#margins > wx-swiper-item').evaluateAll(items=>items.map(el=>{const r=el.getBoundingClientRect();const parent=el.parentElement!.getBoundingClientRect();return [r.x-parent.x,r.width]}))).toEqual([[10,135],[145,135],[280,135]]);
  });
  it('picker-view 的指示框和遮罩接受页面类名与动态内联样式', async () => {
    await mount('<picker-view id="wheel" style="height:100px" indicator-class="highlight" mask-class="veil"><picker-view-column><view>第一</view><view>第二</view></picker-view-column></picker-view>');
    await page.addStyleTag({content:'.highlight{height:40px;border-color:rgb(1,2,3)}.veil{background:rgba(1,2,3,.2)}'});
    await page.locator('#wheel').evaluate(el=>el.setAttribute('value','[1]'));
    expect(await page.locator('#wheel .highlight').evaluate(el=>[getComputedStyle(el).height,getComputedStyle(el).borderTopColor])).toEqual(['40px','rgb(1, 2, 3)']);
    expect(await page.locator('#wheel .veil').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(1, 2, 3, 0.2)');
    await page.locator('#wheel').evaluate(el=>el.setAttribute('indicator-style','height:28px;border-color:red'));
    expect(await page.locator('#wheel .highlight').evaluate(el=>[getComputedStyle(el).height,getComputedStyle(el).borderTopColor])).toEqual(['28px','rgb(255, 0, 0)']);
  });
  it('video 空资源只显示进度和全屏控件，赋予资源后恢复播放入口', async () => {
    await mount('<video id="video"/>');
    expect(await page.locator('#video button[aria-label="播放"]:visible').count()).toBe(0);
    await page.locator('#video').evaluate(el=>el.setAttribute('src','https://example.test/video.mp4'));
    expect(await page.locator('#video button[aria-label="播放"]:visible').count()).toBe(2);
    expect(await page.locator('#video button[aria-label="进入全屏"]').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  });
  it('scroll-view 未启用滚动时在宿主边缘裁剪内容', async () => {
    await mount('<scroll-view id="clip" style="height:40px"><view style="height:90px;background:red"/></scroll-view>');
    expect(await page.locator('#clip').evaluate(el=>[getComputedStyle(el).overflow,getComputedStyle(el).clipPath])).toEqual(['visible','inset(0px)']);
  });
  it('swiper 的内部滚动支持鼠标拖动并切换当前项', async () => {
    await mount('<swiper id="swipe" style="width:300px;height:100px" bindchange="changed"><swiper-item>A</swiper-item><swiper-item>B</swiper-item></swiper>');
    const box=(await page.locator('#swipe').boundingBox())!;
    await page.mouse.move(box.x+260,box.y+40);await page.mouse.down();await page.mouse.move(box.x+20,box.y+40,{steps:15});await page.mouse.up();
    await expect.poll(()=>page.locator('#swipe').getAttribute('current')).toBe('1');
  });
  it('image 的固定宽高模式在加载后按图片比例更新宿主尺寸', async () => {
    const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="red"/></svg>');
    await mount(`<image id="image" src="${src}" mode="widthFix" style="width:120px;height:120px"/>`);
    await expect.poll(()=>page.locator('#image').evaluate(el=>[el.getBoundingClientRect().width,el.getBoundingClientRect().height])).toEqual([120,60]);
    await page.locator('#image').evaluate(el=>{el.setAttribute('mode','heightFix');el.style.height='80px';});
    await expect.poll(()=>page.locator('#image').evaluate(el=>[el.getBoundingClientRect().width,el.getBoundingClientRect().height])).toEqual([160,80]);
    await page.locator('#image').evaluate(el=>el.setAttribute('mode','scaleToFill'));
    expect(await page.locator('#image').evaluate(el=>el.style.width)).toBe('120px');
  });
  it('rich-text 的 space 属性保留每个空格的指定宽度并支持恢复', async () => {
    await mount('<rich-text id="rich" nodes="a   b" space="ensp"/>');
    expect(await page.locator('#rich').textContent()).toBe('a\u2002\u2002\u2002b');
    await page.locator('#rich').evaluate(el=>el.setAttribute('space','emsp'));
    expect(await page.locator('#rich').textContent()).toBe('a\u2003\u2003\u2003b');
    await page.locator('#rich').evaluate(el=>el.removeAttribute('space'));
    expect(await page.locator('#rich').textContent()).toBe('a   b');
  });
  it('progress 信息继承正文颜色并保留可读字号和轨道间距', async () => {
    await mount('<progress id="progress" percent="40" show-info style="color:rgb(1,2,3)"/>');
    expect(await page.locator('#progress span').evaluate(el=>{const c=getComputedStyle(el);return [el.textContent,c.fontSize,c.color,c.marginLeft,c.minWidth]})).toEqual(['40%','16px','rgb(1, 2, 3)','15px','32px']);
    expect(await page.locator('#progress > div').evaluate(el=>getComputedStyle(el).borderRadius)).toBe('0px');
  });
  it('textarea 去除浏览器默认内边距并保持文本行距', async () => {
    await mount('<textarea id="area" value="示例"/>');
    expect(await page.locator('#area textarea').evaluate(el=>{const c=getComputedStyle(el);return [c.padding,c.position,c.lineHeight]})).toEqual(['0px','absolute','19.2px']);
  });
  it('icon 不同类型具有独立默认颜色且移除 color 后恢复', async () => {
    await mount('<icon id="icon" type="success"/>');
    expect(await page.locator('#icon').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(7, 193, 96)');
    await page.locator('#icon').evaluate(el=>{el.setAttribute('color','red');el.setAttribute('type','info');el.removeAttribute('color')});
    expect(await page.locator('#icon').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(16, 174, 255)');
  });
  it('page-container 动态方向、圆角和遮罩更新并在移除后清理完成事件', async () => {
    await mount('<page-container id="popup" show position="right" round duration="20"><view style="width:120px;height:100px">内容</view></page-container>');
    expect(await page.locator('#popup').evaluate(el => {
      const panel=el.firstElementChild!;const css=getComputedStyle(panel);
      return [getComputedStyle(el,'::before').backgroundColor,css.maxHeight,css.overflow,css.boxSizing,css.right,css.borderTopLeftRadius];
    })).toEqual(['rgba(0, 0, 0, 0.7)','100%','hidden','border-box','0px','20px']);
    await page.locator('#popup').evaluate(el=>{el.setAttribute('position','top');el.setAttribute('overlay','false');});
    expect(await page.locator('#popup').evaluate(el=>[getComputedStyle(el,'::before').display,getComputedStyle(el.firstElementChild!).borderBottomLeftRadius])).toEqual(['none','20px']);
    expect(await page.locator('#popup').evaluate(async el=>{let n=0;el.addEventListener('afterleave',()=>n++);el.removeAttribute('show');el.remove();await new Promise(r=>setTimeout(r,40));return n;})).toBe(0);
  });
  it('switch 默认绘制圆角轨道并保留布尔 change', async () => {
    await mount('<switch id="switch" checked="{{checked}}" bindchange="changed"/>');
    expect(await page.locator('#switch input').evaluate(el => {
      const css = getComputedStyle(el); const rect = el.getBoundingClientRect();
      return [css.appearance, rect.width, rect.height, css.borderRadius];
    })).toEqual(['none',52,32,'16px']);
    await page.locator('#switch input').check();
    expect(await page.evaluate(() => (window as any).getCurrentPages()[0].result)).toBe(true);
  });
  it('switch 的 checkbox 模式使用方形选框并支持动态切回', async () => {
    await mount('<switch id="switch" type="{{type}}"/>');
    await page.evaluate(async () => { const p=(window as any).getCurrentPages()[0];await new Promise<void>(r=>p.setData({type:'checkbox'},r)); });
    expect(await page.locator('#switch input').evaluate(el => [el.getBoundingClientRect().width,getComputedStyle(el).borderRadius])).toEqual([24,'3px']);
    await page.evaluate(async () => { const p=(window as any).getCurrentPages()[0];await new Promise<void>(r=>p.setData({type:'switch'},r)); });
    expect(await page.locator('#switch input').evaluate(el=>el.getBoundingClientRect().width)).toBe(52);
  });
  it('switch 自定义颜色和禁用状态更新可见样式', async () => {
    await mount('<switch id="switch" checked="{{checked}}" color="{{color}}" disabled="{{disabled}}"/>');
    await page.evaluate(async () => { const p=(window as any).getCurrentPages()[0];await new Promise<void>(r=>p.setData({checked:true,disabled:true},r)); });
    await expect.poll(()=>page.locator('#switch input').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(18, 52, 86)');
    expect(await page.locator('#switch input').evaluate(el=>[(el as HTMLInputElement).disabled,getComputedStyle(el).opacity])).toEqual([true,'0.3']);
  });
  it('slider 使用自绘轨道和滑块并显示绑定值', async () => {
    await mount('<slider id="slider" value="{{value}}" show-value="{{showValue}}" bindchanging="changed"/>');
    expect(await page.locator('#slider input').evaluate(el=>getComputedStyle(el).appearance)).toBe('none');
    expect(await page.locator('#slider output').textContent()).toBe('30');
    await page.locator('#slider input').evaluate(el=>{(el as HTMLInputElement).value='70';el.dispatchEvent(new Event('input',{bubbles:true}));});
    expect(await page.locator('#slider output').textContent()).toBe('70');
    expect(await page.evaluate(()=>(window as any).getCurrentPages()[0].result)).toBe(70);
  });
  it('slider 未指定 value 时从最小值开始', async () => {
    await mount('<slider id="slider" min="10" max="90"/>');
    expect(await page.locator('#slider input').inputValue()).toBe('10');
  });
  it('checkbox 选中时保留白底并响应 color 绑定', async () => {
    await mount('<checkbox id="checkbox" checked color="{{color}}"/>');
    expect(await page.locator('#checkbox span').first().evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el,'::after').borderRightColor])).toEqual(['rgb(255, 255, 255)','rgb(18, 52, 86)']);
  });
  it('radio 选中时以选定颜色填充圆形选框', async () => {
    await mount('<radio id="radio" checked color="{{color}}"/>');
    expect(await page.locator('#radio span').first().evaluate(el=>[getComputedStyle(el).backgroundColor,getComputedStyle(el).borderRadius])).toEqual(['rgb(18, 52, 86)','50%']);
  });
  it('所有内置宿主的 hidden 属性都隐藏组件', async () => {
    const tags=['view','text','button','image','input','textarea','switch','slider','picker','picker-view','swiper','swiper-item','scroll-view','checkbox','radio','form','label','progress','rich-text','icon','audio','video','canvas','map','camera','cover-view','cover-image','movable-area','movable-view','match-media','editor'];
    await mount(tags.map((tag,index)=>`<${tag} id="hidden-${index}" hidden/>`).join(''));
    expect(await page.evaluate(n=>Array.from({length:n},(_,i)=>getComputedStyle(document.querySelector('#hidden-'+i)!).display),tags.length)).toEqual(tags.map(()=> 'none'));
  });
  it('swiper 的内部布局保持普通宿主盒模型', async () => {
    await mount('<swiper id="swiper" current="{{value}}" style="width:300px;height:150px" bindanimationfinish="changed"><swiper-item>A</swiper-item><swiper-item>B</swiper-item></swiper>');
    expect(await page.locator('#swiper').evaluate(el=>{const s=getComputedStyle(el);return [s.display,s.position,s.overflowX,s.overflowY];})).toEqual(['block','static','visible','visible']);
  });
  it('picker-view 的滚轮样式不污染宿主盒模型', async () => {
    await mount('<picker-view id="picker" style="height:150px"><picker-view-column id="column"><view>A</view><view>B</view></picker-view-column></picker-view>');
    expect(await page.locator('#picker').evaluate(el=>[getComputedStyle(el).position,getComputedStyle(el).overflow])).toEqual(['static','visible']);
    expect(await page.locator('#column').evaluate(el=>[getComputedStyle(el).paddingTop,getComputedStyle(el).overflow,getComputedStyle(el).boxSizing])).toEqual(['0px','hidden','content-box']);
  });
});
