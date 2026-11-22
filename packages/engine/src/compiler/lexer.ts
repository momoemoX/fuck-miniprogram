/**
 * WXML 词法分析：把源码切成文本、开始标签、结束标签
 *
 * 只做一层扫描，不做语义判断。属性值里的 `>` 不当作标签结束。
 */

import { findExpressionEnd } from './expr';

export interface RawAttr {
  name: string;
  /** 没有 `=` 的属性（如 `wx:else`）记为 true */
  value: string | true;
}

export type Token =
  | { type: 'text'; value: string; pos: number }
  | { type: 'open'; name: string; attrs: RawAttr[]; selfClosing: boolean; pos: number }
  | { type: 'close'; name: string; pos: number };

const isSpace = (ch: string) => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const lt = findTag(source, i);
    if (lt < 0) {
      pushText(tokens, source.slice(i), i);
      break;
    }
    if (lt > i) pushText(tokens, source.slice(i, lt), i);

    // 注释整段跳过
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }

    // 结束标签
    if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      const name = source.slice(lt + 2, end < 0 ? source.length : end).trim();
      tokens.push({ type: 'close', name, pos: lt });
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    // 开始标签
    let p = lt + 1;
    while (p < source.length && !isSpace(source[p]) && source[p] !== '>' && source[p] !== '/') p++;
    const name = source.slice(lt + 1, p);
    const attrs: RawAttr[] = [];
    let selfClosing = false;

    while (p < source.length) {
      while (p < source.length && isSpace(source[p])) p++;
      if (source[p] === '/') {
        selfClosing = true;
        p++;
        continue;
      }
      if (source[p] === '>') {
        p++;
        break;
      }
      if (p >= source.length) break;

      // 属性名
      const nameStart = p;
      while (p < source.length && !isSpace(source[p]) && source[p] !== '=' && source[p] !== '>' && source[p] !== '/') p++;
      const attrName = source.slice(nameStart, p);

      while (p < source.length && isSpace(source[p])) p++;
      if (source[p] !== '=') {
        if (attrName) attrs.push({ name: attrName, value: true });
        continue;
      }
      p++; // =
      while (p < source.length && isSpace(source[p])) p++;

      const quote = source[p];
      let attrValue = '';
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, p + 1);
        attrValue = source.slice(p + 1, end < 0 ? source.length : end);
        p = end < 0 ? source.length : end + 1;
      } else {
        const start = p;
        while (p < source.length && !isSpace(source[p]) && source[p] !== '>') p++;
        attrValue = source.slice(start, p);
      }
      if (attrName) attrs.push({ name: attrName, value: attrValue });
    }

    tokens.push({ type: 'open', name, attrs, selfClosing, pos: lt });
    i = p;
    if (name === 'wxs' && !selfClosing) {
      const close = /<\/wxs\s*>/g;
      close.lastIndex = p;
      const match = close.exec(source);
      pushText(tokens, source.slice(p, match?.index ?? source.length), p);
      if (match) tokens.push({ type: 'close', name: 'wxs', pos: match.index });
      i = match ? close.lastIndex : source.length;
    }
  }

  return tokens;
}

function findTag(source: string, start: number) {
  for (let i = start; i < source.length; i++) {
    if (source.startsWith('{{', i)) {
      const end = findExpressionEnd(source, i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (source[i] === '<' && /[a-zA-Z/!]/.test(source[i + 1] ?? '')) return i;
  }
  return -1;
}

function pushText(tokens: Token[], value: string, pos: number) {
  // 纯空白文本节点对渲染有意义（空格、换行会影响 inline 布局），只在整段空白且含换行时折叠
  if (!value) return;
  tokens.push({ type: 'text', value, pos });
}
