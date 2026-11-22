/**
 * WXML → 渲染代码
 *
 * 生成的是普通 JS 函数：静态结构固化成 createElement / appendChild 直写，
 * 动态部分变成 `$.text` / `$.attr` / `$.cond` / `$.list` 里的小闭包，
 * 每个闭包声明自己依赖的数据路径。运行期不做 diff，也没有虚拟 DOM。
 *
 * 产物形态（普通 script，注册到全局）：
 *   __FMP__.define('pages/index/index', function ($, parent) { ... })
 */

import type { ElementNode, TextNode, WxmlNode, TemplateContent, TemplateMap } from './parser';
import { attr, hasAttr } from './parser';
import { compileExpr, isDynamic, splitExpression } from './expr';
import { rpxToCalc } from './wxss';

const EVENT_PREFIXES = [
  'capture-catch:',
  'capture-bind:',
  'capture-catch',
  'capture-bind',
  'mut-bind:',
  'catch:',
  'bind:',
  'mut-bind',
  'catch',
  'bind'
];

interface Branch {
  node: ElementNode;
}

export interface GenerateOptions {
  /** 本页用到的 wxs 模块名，表达式里引用时改写成 s.wxs.<name> */
  wxs?: string[];
  /** wxs 模块名 → 模块 id，运行期 require 出来挂到 s.wxs 上 */
  wxsMap?: Record<string, string>;
  /** 本页的自定义组件：标签名 → 组件路径（已归一化，不含开头的 /） */
  components?: Record<string, string>;
  generics?: string[];
  /** import 进来的 template 定义：名字 → 节点 */
  templates?: TemplateMap;
}

class Emitter {
  lines: string[] = [];
  counter = 0;
  depth = 1;
  locals = new Set<string>();
  wxs: Set<string>;
  components: Record<string, string>;
  templates: TemplateMap;
  templateIds = new Map<TemplateContent, string>();
  projectSlots = false;

  constructor(options: GenerateOptions = {}) {
    this.wxs = new Set(options.wxs ?? []);
    this.components = { ...options.components, ...Object.fromEntries((options.generics ?? []).map(name => [name, `@generic:${name}`])) };
    this.templates = options.templates ?? {};
  }

  id(prefix: string) {
    return `${prefix}${this.counter++}`;
  }

  line(code: string) {
    this.lines.push('  '.repeat(this.depth) + code);
  }

  /** 多行语句：只给第一行加基础缩进，其余行自己带相对缩进 */
  raw(code: string) {
    this.line(code.replace(/\n/g, '\n' + '  '.repeat(this.depth)));
  }

  fork(): Emitter {
    const sub = new Emitter();
    sub.locals = new Set(this.locals);
    sub.wxs = this.wxs;
    sub.components = this.components;
    sub.templates = this.templates;
    sub.templateIds = this.templateIds;
    sub.projectSlots = this.projectSlots;
    sub.counter = this.counter;
    return sub;
  }

  toString() {
    return this.lines.join('\n');
  }
}

export function generate(id: string, nodes: WxmlNode[], options: GenerateOptions = {}): string {
  const e = new Emitter(options);
  const register = (templates: TemplateMap) => {
    for (const content of Object.values(templates)) {
      if (!e.templateIds.has(content)) e.templateIds.set(content, `template${e.templateIds.size}`);
    }
  };
  register(e.templates);
  emitChildren(e, nodes, 'parent');
  const declarations: string[] = [];
  for (const [content, name] of e.templateIds) {
    const definition = Array.isArray(content) ? { nodes: content } : content;
    const templates = definition.templates ?? e.templates;
    const wxsMap = definition.wxsMap ?? options.wxsMap ?? {};
    register(templates);
    const body = new Emitter({ ...options, templates, wxs: Object.keys(wxsMap) });
    body.templateIds = e.templateIds;
    body.projectSlots = true;
    body.line(`$.useWxs(${JSON.stringify(wxsMap)});`);
    emitChildren(body, definition.nodes, 'host');
    declarations.push(`  const ${name} = function (host) { $.callTemplate(${name}, function () {\n${body.toString()}\n  }); };`);
  }
  return [
    `__FMP__.define(${JSON.stringify(id)}, function ($, parent) {`,
    ...declarations,
    e.toString(),
    `}, ${JSON.stringify(options.wxsMap ?? {})});`,
    ''
  ].join('\n');
}

/** 换行+缩进的空白文本节点不产生 DOM，单个空格保留 */
function isLayoutWhitespace(node: WxmlNode): boolean {
  return node.type === 'text' && node.value.trim() === '' && node.value.includes('\n');
}

function emitChildren(e: Emitter, nodes: WxmlNode[], parentVar: string) {
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];

    if (isLayoutWhitespace(node)) {
      i++;
      continue;
    }

    if (node.type === 'element' && node.tag === 'wxs') {
      i++;
      continue;
    }

    if (node.type === 'element' && hasAttr(node, 'wx:for')) {
      emitList(e, node, parentVar);
      i++;
      continue;
    }

    if (node.type === 'element' && hasAttr(node, 'wx:if')) {
      const { branches, next } = collectBranches(nodes, i);
      emitCond(e, branches, parentVar);
      i = next;
      continue;
    }

    if (
      e.projectSlots &&
      (node.type === 'text' || (!['block', 'template', 'import', 'include'].includes(node.tag) && !node.templateScope))
    ) {
      emitSlotSource(e, node, parentVar);
      i++;
      continue;
    }

    if (node.type === 'text') {
      emitText(e, node, parentVar);
      i++;
      continue;
    }

    emitElement(e, node, parentVar);
    i++;
  }
}

function emitSlotSource(e: Emitter, node: WxmlNode, parentVar: string) {
  const name = node.type === 'element' ? attr(node, 'slot') : '';
  const spec = propExpression(typeof name === 'string' ? name : '', e.locals, e.wxs);
  const sub = e.fork();
  sub.projectSlots = false;
  if (node.type === 'text') emitText(sub, node, 'host');
  else emitElement(sub, node, 'host');
  e.counter = sub.counter;
  e.raw(`$.slotSource(${parentVar}, ${spec}, function (host) {\n${sub.toString()}\n});`);
}

function collectBranches(nodes: WxmlNode[], start: number): { branches: Branch[]; next: number } {
  const branches: Branch[] = [];
  let i = start;

  while (i < nodes.length) {
    const node = nodes[i];
    if (isLayoutWhitespace(node)) {
      i++;
      continue;
    }
    if (node.type !== 'element') break;
    const isFirst = i === start;
    if (isFirst ? !hasAttr(node, 'wx:if') : !hasAttr(node, 'wx:elif') && !hasAttr(node, 'wx:else')) break;
    branches.push({ node });
    i++;
  }

  return { branches, next: i };
}

function emitCond(e: Emitter, branches: Branch[], parentVar: string) {
  const parts: string[] = [];

  for (const branch of branches) {
    const node = branch.node;
    const test = attr(node, 'wx:if') ?? attr(node, 'wx:elif');
    let testCode = 'function () { return true }';
    let branchDeps: string[][] = [];

    if (typeof test === 'string' && test) {
      const compiled = compileExpr(stripMustache(test), e.locals, e.wxs);
      testCode = `function (s) { return !!(${compiled.code}) }`;
      branchDeps = compiled.deps;
    }

    const sub = e.fork();
    const inner = node.tag === 'block' ? node.children : [stripDirectives(node)];
    emitChildren(sub, inner, 'host');
    e.counter = sub.counter;

    parts.push(
      `  { deps: ${JSON.stringify(branchDeps)}, test: ${testCode}, build: function (host) {\n` + indent(sub.toString(), 2) + `\n  } }`
    );
  }

  e.raw(`$.cond(${parentVar}, [\n${parts.join(',\n')}\n]);`);
}

function emitList(e: Emitter, node: ElementNode, parentVar: string) {
  const source = stripMustache(String(attr(node, 'wx:for') ?? ''));
  const compiled = compileExpr(source, e.locals, e.wxs);
  const direct = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*(?:\d+|'[^']*'|"[^"]*")\s*\])*\s*$/.test(source.trim());
  const itemName = String(attr(node, 'wx:for-item') ?? 'item');
  const indexName = String(attr(node, 'wx:for-index') ?? 'index');
  const keyRaw = attr(node, 'wx:key');

  let keyCode = 'null';
  if (keyRaw === '*this') {
    keyCode = 'function (item) { return item }';
  } else if (typeof keyRaw === 'string' && keyRaw && !keyRaw.includes('{{')) {
    keyCode = `function (item) { return item[${JSON.stringify(keyRaw)}] }`;
  }

  const sub = e.fork();
  sub.locals.add(itemName);
  sub.locals.add(indexName);
  sub.counter = e.counter + 1;

  const itemNode = { ...node, attrs: node.attrs.filter(item => !['wx:for', 'wx:for-item', 'wx:for-index', 'wx:key'].includes(item.name)) };
  const inner = [itemNode];
  emitChildren(sub, inner, 'host');
  e.counter = sub.counter;

  e.raw(
    `$.list(${parentVar}, ${JSON.stringify(compiled.deps)}, {\n` +
      `  key: ${keyCode},\n` +
      `  path: ${direct && compiled.deps.length === 1 ? JSON.stringify(compiled.deps[0]) : 'null'},\n` +
      `  item: ${JSON.stringify(itemName)},\n` +
      `  index: ${JSON.stringify(indexName)},\n` +
      `  get: function (s) { return (${compiled.code}) },\n` +
      `  create: function (host) {\n` +
      indent(sub.toString(), 2) +
      `\n  }\n});`
  );
}

function emitElement(e: Emitter, node: ElementNode, parentVar: string) {
  if (node.templateScope) {
    const scope = node.templateScope;
    const sub = e.fork();
    sub.templates = scope.templates ?? {};
    sub.wxs = new Set(Object.keys(scope.wxsMap ?? {}));
    emitChildren(sub, scope.nodes, 'host');
    e.counter = sub.counter;
    e.raw(`$.scopeWxs(${parentVar}, ${JSON.stringify(scope.wxsMap ?? {})}, function (host) {\n${sub.toString()}\n});`);
    return;
  }

  if (node.tag === 'template') {
    emitTemplate(e, node, parentVar);
    return;
  }

  // import / include 在编译期已经展开
  if (node.tag === 'import' || node.tag === 'include') return;

  if (node.tag === 'slot') {
    const name = attr(node, 'name');
    const varName = e.id('sl');
    e.line(`const ${varName} = $.slot(${parentVar}, ${JSON.stringify(typeof name === 'string' ? name : '')});`);
    return;
  }

  if (node.tag === 'block') {
    emitChildren(e, node.children, parentVar);
    return;
  }

  if (e.components[node.tag]) {
    emitComponent(e, node, parentVar);
    return;
  }

  const varName = e.id('n');
  e.line(`const ${varName} = $.el(${JSON.stringify(node.tag)});`);
  emitAttrs(e, node, varName);
  emitChildren(e, node.children, varName);
  e.line(`${parentVar}.appendChild(${varName});`);
}

function emitTemplate(e: Emitter, node: ElementNode, parentVar: string) {
  const is = attr(node, 'is');
  if (typeof is !== 'string') return;
  const selected = isDynamic(is) ? valueExpression(is, e.locals, e.wxs) : null;
  const data = attr(node, 'data');
  const raw = typeof data === 'string' && data ? stripMustache(data) : '';
  const source = raw ? (raw.trim().startsWith('{') ? raw : `{${raw}}`) : '';
  const compiled = source ? compileExpr(source, e.locals, e.wxs) : { code: '{}', deps: [] as string[][] };
  const deps = dedupe([...compiled.deps, ...(selected?.deps ?? [])]);
  for (const content of Object.values(e.templates)) {
    if (!e.templateIds.has(content)) e.templateIds.set(content, `template${e.templateIds.size}`);
  }
  const variants = Object.entries(e.templates).map(([name, content]) => `${JSON.stringify(name)}: ${e.templateIds.get(content)}`);
  const call = selected
    ? `const render = ({${variants.join(', ')}})[String(name)]; if (render) render(host);`
    : e.templates[is]
      ? `${e.templateIds.get(e.templates[is])}(host);`
      : '';
  const select = selected ? `, function (s) { return (${selected.code}); }` : '';
  e.raw(
    `$.template(${parentVar}, ${JSON.stringify(deps)}, function (s) {\n  return (${compiled.code});\n}, function (host, name) {\n  ${call}\n}${select});`
  );
}

function emitAttrs(e: Emitter, node: ElementNode, varName: string) {
  const classAttr = attr(node, 'class');
  if (typeof classAttr === 'string') {
    if (!isDynamic(classAttr)) {
      const value = classAttr.trim();
      if (value) e.line(`$.classes(${varName}, ${JSON.stringify(value)});`);
    } else {
      const { code, deps } = valueExpression(classAttr, e.locals, e.wxs);
      e.raw(`$.attr(${varName}, "class", ${JSON.stringify(deps)}, function (s) {\n  return ${code};\n});`);
    }
  }

  // change:prop 要看的是同名属性的表达式，先收集一遍
  const bound = new Map<string, string | true>();
  for (const item of node.attrs) if (!item.name.includes(':') && item.name !== 'class') bound.set(item.name, item.value);

  for (const item of node.attrs) {
    const { name, value } = item;
    if (name === 'class' || name.startsWith('wx:')) continue;

    const change = parseChange(name);
    if (change) {
      if (typeof value === 'string' && value) {
        const watched = bound.get(change);
        const spec =
          typeof watched === 'string' ? propExpression(watched, e.locals, e.wxs) : '{ deps: [], get: function () { return undefined } }';
        const handler = valueExpression(value, e.locals, e.wxs);
        e.raw(
          `$.change(${varName}, ${JSON.stringify(change)}, ${spec}, function (s) {\n  return (${handler.code});\n});`
        );
      }
      continue;
    }

    const model = parseModel(name);
    if (model) {
      // model: 只支持单一数据字段，复杂表达式无法回写
      if (typeof value === 'string' && value) {
        e.raw(`$.model(${varName}, ${JSON.stringify(model)}, ${propExpression(value, e.locals, e.wxs)});`);
      }
      continue;
    }

    const eventType = parseEvent(name);
    if (eventType) {
      if (typeof value === 'string' && value) {
        const handler = isDynamic(value)
          ? `function (s) { return (${valueExpression(value, e.locals, e.wxs).code}); }`
          : JSON.stringify(value);
        e.line(
          `$.on(${varName}, ${JSON.stringify(eventType.type)}, ${handler}, ${eventType.catch}, ${eventType.capture}${eventType.mut ? ', false, true' : ''});`
        );
      }
      continue;
    }

    if (value === true) {
      e.line(`$.attribute(${varName}, ${JSON.stringify(name)}, true);`);
      continue;
    }

    if (!isDynamic(value)) {
      const staticValue = name === 'style' && typeof value === 'string' && value.includes('rpx') ? rpxToCalc(value) : value;
      e.line(`$.attribute(${varName}, ${JSON.stringify(name)}, ${JSON.stringify(staticValue)});`);
      continue;
    }

    const { code, deps } = valueExpression(value, e.locals, e.wxs);
    e.raw(`$.attr(${varName}, ${JSON.stringify(name)}, ${JSON.stringify(deps)}, function (s) {\n  return ${code};\n});`);
  }
}

function emitComponent(e: Emitter, node: ElementNode, parentVar: string) {
  const varName = e.id('c');
  const componentPath = e.components[node.tag];

  e.line(`const ${varName} = $.el(${JSON.stringify(node.tag)});`);

  const props = new Map<string, string>();
  const models = new Map<string, string>();
  const generics: Record<string, string> = {};

  for (const item of node.attrs) {
    const { name, value } = item;
    if (name.startsWith('wx:')) continue;
    if (name.startsWith('generic:')) {
      if (typeof value === 'string' && e.components[value]) generics[name.slice(8)] = e.components[value];
      continue;
    }

    const model = parseModel(name);
    if (model) {
      // model:<prop>：属性本身照常下发，同时登记回写父级数据的通道
      if (typeof value === 'string' && value) {
        const spec = propExpression(value, e.locals, e.wxs);
        props.set(model, spec);
        models.set(model, spec);
      }
      continue;
    }

    const eventType = parseEvent(name);
    if (eventType) {
      if (typeof value === 'string' && value) {
        const handler = isDynamic(value)
          ? `function (s) { return (${valueExpression(value, e.locals, e.wxs).code}); }`
          : JSON.stringify(value);
        e.line(
          `$.on(${varName}, ${JSON.stringify(eventType.type)}, ${handler}, ${eventType.catch}, ${eventType.capture}, true${eventType.mut ? ', true' : ''});`
        );
      }
      continue;
    }

    // class / id / style / data-* / mark:* 挂在宿主元素上，其余作为属性传进组件
    if (name === 'class' || name === 'id' || name === 'style' || name.startsWith('data-') || name.startsWith('mark:') || name === 'slot') {
      if (value === true) continue;
      if (!isDynamic(value)) {
        const staticValue = name === 'style' && typeof value === 'string' && value.includes('rpx') ? rpxToCalc(value) : value;
        if (name === 'class') e.line(`$.classes(${varName}, ${JSON.stringify(staticValue)});`);
        else e.line(`$.attribute(${varName}, ${JSON.stringify(name)}, ${JSON.stringify(staticValue)});`);
      } else {
        const { code, deps } = valueExpression(value, e.locals, e.wxs);
        e.raw(`$.attr(${varName}, ${JSON.stringify(name)}, ${JSON.stringify(deps)}, function (s) {\n  return ${code};\n});`);
      }
      continue;
    }

    props.set(name, propExpression(value, e.locals, e.wxs));
  }

  if (node.children.length) {
    const sub = e.fork();
    sub.projectSlots = true;
    emitChildren(sub, node.children, 'host');
    e.counter = sub.counter;
    e.raw(`$.slotBody(${varName}, function (host) {\n${sub.toString()}\n});`);
  }

  const spec = (entries: Map<string, string>) =>
    entries.size ? `{\n${indent([...entries].map(([name, value]) => `${JSON.stringify(name)}: ${value}`).join(',\n'), 1)}\n}` : '{}';

  e.raw(
    `$.component(${varName}, ${JSON.stringify(componentPath)}, ${spec(props)}, {}, ${JSON.stringify(generics)}, ${spec(models)});`
  );

  e.line(`$.appendComponent(${parentVar}, ${varName});`);
}

/** 组件属性：单个表达式时保留原始类型，混合文本时拼成字符串 */
function propExpression(value: string | true, locals: Set<string>, wxs: Set<string>): string {
  if (value === true) return '{ deps: [], get: function () { return true } }';

  const chunks = splitExpression(value);
  if (chunks.length === 1 && chunks[0].type === 'expr') {
    const compiled = compileExpr(chunks[0].value, locals, wxs);
    return `{ deps: ${JSON.stringify(compiled.deps)}, get: function (s) { return (${compiled.code}) } }`;
  }

  const { code, deps } = valueExpression(value, locals, wxs);
  return `{ deps: ${JSON.stringify(deps)}, get: function (s) { return ${code} } }`;
}

function emitText(e: Emitter, node: TextNode, parentVar: string) {
  const value = node.value;

  if (!isDynamic(value)) {
    e.line(`$.txt(${parentVar}, ${JSON.stringify(value)});`);
    return;
  }

  const { code, deps } = valueExpression(value, e.locals, e.wxs);
  const varName = e.id('t');
  e.line(`const ${varName} = $.txt(${parentVar});`);
  e.raw(`$.text(${varName}, ${JSON.stringify(deps)}, function (s) {\n  return ${code};\n});`);
}

/** 属性值 / 文本：把「静态 + 表达式」拼成一个返回字符串的表达式 */
function valueExpression(value: string, locals: Set<string>, wxs: Set<string>): { code: string; deps: string[][] } {
  const chunks = splitExpression(value);

  // 只有一个表达式时保留原始类型：picker 的 range / value 传的是数组，
  // 字符串化之后就再也还原不回去了
  if (chunks.length === 1 && chunks[0].type === 'expr') {
    const compiled = compileExpr(chunks[0].value, locals, wxs);
    return { code: compiled.code, deps: compiled.deps };
  }

  const deps: string[][] = [];
  const parts: string[] = [];

  for (const chunk of chunks) {
    if (chunk.type === 'text') {
      parts.push(JSON.stringify(chunk.value));
      continue;
    }
    const compiled = compileExpr(chunk.value, locals, wxs);
    for (const dep of compiled.deps) deps.push(dep);
    parts.push(`$.str(${compiled.code})`);
  }

  return { code: parts.length ? parts.join(' + ') : '""', deps: dedupe(deps) };
}

/** 去掉 wx: 开头的指令，供 wx:for / wx:if 内部复用同一节点 */
function stripDirectives(node: ElementNode): ElementNode {
  return {
    type: 'element',
    tag: node.tag,
    attrs: node.attrs.filter(item => !item.name.startsWith('wx:')),
    children: node.children
  };
}

function dedupe(deps: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const dep of deps) {
    const key = dep.join('.');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep);
  }
  return out;
}

function stripMustache(value: string): string {
  const trimmed = value.trim();
  const match = /^\{\{([\s\S]*)\}\}$/.exec(trimmed);
  return match ? match[1] : trimmed;
}

/** `change:prop` → 被观察的属性名 */
function parseChange(name: string): string | null {
  if (!name.startsWith('change:')) return null;
  const prop = name.slice(7);
  return prop || null;
}

/** `model:value` → 双向绑定的属性名；官方只允许单一字段，不做表达式展开 */
function parseModel(name: string): string | null {
  if (!name.startsWith('model:')) return null;
  const prop = name.slice(6);
  return prop || null;
}

function parseEvent(name: string): { type: string; catch: boolean; capture: boolean; mut: boolean } | null {
  for (const prefix of EVENT_PREFIXES) {
    if (!name.startsWith(prefix)) continue;
    let rest = name.slice(prefix.length);
    if (rest.startsWith(':')) rest = rest.slice(1);
    if (!rest) return null;
    return {
      type: rest,
      catch: prefix.includes('catch'),
      capture: prefix.startsWith('capture'),
      mut: prefix.startsWith('mut-bind')
    };
  }
  return null;
}

function indent(text: string, depth: number): string {
  const pad = '  '.repeat(depth);
  return text
    .split('\n')
    .map(line => (line ? pad + line : line))
    .join('\n');
}
