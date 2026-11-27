import { walkRules, splitSelectors } from '../css';

/**
 * WXSS → CSS
 *
 * 1. rpx 换成 `calc(N * var(--fmp-rpx))`，尺寸变化时不需要重新编译
 * 2. `page` 选择器映射到页面容器 `wx-page`
 * 3. env(safe-area-inset-*) 换成运行时注入的 CSS 变量
 * 4. 以作用域标记隔离选择器，由运行时决定共享范围
 *
 * 复合选择器逐段限定作用域，避免组件外的同名祖先类影响隔离组件。
 */

const RX_RPX = /(-?\d*\.?\d+)rpx/g;
const RX_PAGE = /(^|[\s>,])page(?=\s*[,{:])/g;
// 页面窗口不一定贴着屏幕边缘：tabBar 页面底部没有安全区，自定义导航栏时顶部才有
const RX_SAFE_AREA = /\b(?:env|constant)\(\s*safe-area-inset-(top|right|bottom|left)\b/g;

// WXSS 里的标签选择器指的是小程序组件，运行时元素带 wx- 前缀
const COMPONENT_TAGS = new Set([
  'view',
  'text',
  'button',
  'image',
  'scroll-view',
  'swiper',
  'swiper-item',
  'input',
  'textarea',
  'switch',
  'slider',
  'picker',
  'picker-view',
  'picker-view-column',
  'movable-area',
  'movable-view',
  'map',
  'camera',
  'video',
  'audio',
  'canvas',
  'navigator',
  'web-view',
  'editor',
  'editor-portal',
  'selection',
  'cover-view',
  'cover-image',
  'form',
  'label',
  'checkbox',
  'checkbox-group',
  'radio',
  'radio-group',
  'rich-text',
  'progress',
  'icon',
  'slot',
  'block'
]);

/** 只替换选择器里的标签名，属性值里的同名文字不受影响 */
function mapTags(selector: string): string {
  return selector.replace(/(^|[\s>+~,(])([a-z][a-z-]*)(?=[\s>+~,.#:[)]|$)/g, (match, prefix: string, tag: string) =>
    COMPONENT_TAGS.has(tag) ? `${prefix}wx-${tag}` : match
  );
}

/** 内联 style 里的 rpx 也要换算（WXML 支持 style="width: 100rpx"） */
export function rpxToCalc(source: string): string {
  return source.replace(RX_RPX, (_match, size: string) => `calc(${size} * var(--fmp-rpx))`);
}

export function compileWxss(source: string): string {
  const base = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(RX_RPX, (_match, size: string) => `calc(${size} * var(--fmp-rpx))`)
    // 原来的右括号会保留，所以这里不补右括号
    .replace(RX_SAFE_AREA, 'var(--fmp-safe-area-inset-$1')
    .replace(RX_PAGE, '$1wx-page');

  return walkRules(base, (head, body) => `${mapTags(head).trimEnd()} {${body}}`);
}

function scopeSelector(selector: string, attr: string, value: string): string {
  const marker = `[${attr}="${value}"]`;
  if (attr === 'fmp-style~') {
    let quoted = '';
    let brackets = 0;
    selector = selector.replace(/(["'[\]])|\.([\w-\u0080-\uFFFF]+)/g, (match, delimiter, name) => {
      if (delimiter) {
        if (quoted) {
          if (delimiter === quoted) quoted = '';
        } else if (delimiter === '"' || delimiter === "'") quoted = delimiter;
        else if (delimiter === '[') brackets++;
        else brackets--;
        return match;
      }
      return !quoted && !brackets ? `.${name}--fmp-${value}` : match;
    });
  }
  selector = selector.replace(/:host(?:\(([^)]+)\))?/g, (_match, classes: string | undefined) => `[fmp-host="${value}"]${classes ?? ''}`);
  const compound = (part: string) => {
    if (!part || part.includes('[fmp-host=')) return part;
    let quote = '';
    let brackets = 0;
    let cut = part.length;
    for (let index = 0; index < part.length; index++) {
      const char = part[index];
      if (quote) {
        if (char === quote && part[index - 1] !== '\\') quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '[') brackets++;
      else if (char === ']') brackets--;
      else if (char === ':' && !brackets) {
        cut = index;
        break;
      }
    }
    return part.slice(0, cut) + marker + part.slice(cut);
  };
  let output = '';
  let part = '';
  let quote = '';
  let depth = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (!quote && !depth && /[\s>+~]/.test(char)) {
      output += compound(part) + char;
      part = '';
      continue;
    }
    part += char;
    if (quote) {
      if (char === quote && selector[index - 1] !== '\\') quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '(') depth++;
    else if (char === ']' || char === ')') depth--;
  }
  return output + compound(part);
}

/** 为样式中的每段复合选择器添加指定作用域 */
export function scopeWxss(source: string, attr: string, value: string, prefix = ''): string {
  return walkRules(source, (head, body) => {
    const wrappedPrefix =
      prefix && attr === 'fmp-style~' && !prefix.trimStart().startsWith(':where(')
        ? `:where(${prefix.trim()}) `
        : prefix;
    const selectors = splitSelectors(head)
      .map(selector => (selector.trim() ? wrappedPrefix + scopeSelector(selector.trim(), attr, value) : selector))
      .join(', ');
    return `${selectors} {${body}}`;
  });
}

/** `@import "a.wxss";` 内联，避免运行期多一次请求 */
export function inlineImports(source: string, resolve: (specifier: string) => string): string {
  return source.replace(/@import\s+["']([^"']+)["']\s*;/g, (_match, specifier: string) => {
    try {
      return inlineImports(resolve(specifier), resolve);
    } catch {
      return '';
    }
  });
}
