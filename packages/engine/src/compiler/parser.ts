/**
 * WXML 语法树
 *
 * `block` 保留成元素节点，由代码生成阶段展开（它不产生 DOM）。
 * `wx:else` / `wx:elif` 只是属性，分组合并在代码生成阶段做。
 */

import type { RawAttr } from './lexer';
import { tokenize } from './lexer';

export interface ElementNode {
  type: 'element';
  tag: string;
  attrs: RawAttr[];
  children: WxmlNode[];
  templateScope?: TemplateDefinition;
}

export interface TextNode {
  type: 'text';
  value: string;
}

export type WxmlNode = ElementNode | TextNode;

export interface TemplateDefinition {
  nodes: WxmlNode[];
  templates?: TemplateMap;
  wxsMap?: Record<string, string>;
}
export type TemplateContent = WxmlNode[] | TemplateDefinition;
export type TemplateMap = Record<string, TemplateContent>;

const VOID_TAGS = new Set(['input', 'image', 'img', 'br', 'hr', 'icon', 'progress', 'slider', 'switch', 'textarea']);

export function parse(source: string): WxmlNode[] {
  const tokens = tokenize(source);
  const root: ElementNode = { type: 'element', tag: '#root', attrs: [], children: [] };
  const stack: ElementNode[] = [root];

  for (const token of tokens) {
    const top = stack[stack.length - 1];

    if (token.type === 'text') {
      top.children.push({ type: 'text', value: token.value });
      continue;
    }

    if (token.type === 'open') {
      const node: ElementNode = { type: 'element', tag: token.name, attrs: token.attrs, children: [] };
      top.children.push(node);
      if (!token.selfClosing && !VOID_TAGS.has(token.name)) stack.push(node);
      continue;
    }

    // 结束标签：容忍不闭合的写法，向上找到同名节点后整体出栈
    const index = stack.map(node => node.tag).lastIndexOf(token.name);
    if (index > 0) stack.length = index;
  }

  return root.children;
}

export function attr(node: ElementNode, name: string): string | true | undefined {
  const found = node.attrs.find(item => item.name === name);
  return found && found.value;
}

export function hasAttr(node: ElementNode, name: string): boolean {
  return node.attrs.some(item => item.name === name);
}
