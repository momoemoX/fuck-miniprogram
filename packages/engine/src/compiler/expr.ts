/**
 * WXML 表达式：依赖提取 + 源码改写
 *
 * 思路：不做完整的 JS 语法分析，只扫描"根标识符 + 成员链"，把每个根换成
 * `s.data.x` / `s.item`，同时记录它依赖的数据路径。表达式本身原样交给 V8，
 * 编译期就变成真正的 JS，运行期没有解析、没有 eval。
 */

interface Tok {
  type: 'ident' | 'num' | 'str' | 'punct';
  value: string;
  start: number;
  end: number;
}

const KEYWORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'typeof',
  'instanceof',
  'in',
  'new',
  'void',
  'delete',
  'function',
  'return',
  'if',
  'else',
  'var',
  'let',
  'const',
  'do',
  'while',
  'for',
  'switch',
  'case',
  'break',
  'continue',
  'throw',
  'try',
  'catch',
  'finally',
  'class',
  'extends',
  'super',
  'yield',
  'await',
  'async'
]);

/** 模板里能直接调用的全局函数，不当成数据字段 */
const GLOBALS = new Set([
  'Math',
  'JSON',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'Date',
  'RegExp',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'NaN',
  'Infinity',
  'encodeURIComponent',
  'decodeURIComponent'
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const PUNCT = ['...', '===', '!==', '>>>', '**', '&&', '||', '??', '?.', '<=', '>=', '==', '!=', '=>', '<<', '>>', '**'];

function tokenize(source: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i++;
      continue;
    }

    if (IDENT_START.test(ch)) {
      const start = i;
      while (i < source.length && IDENT_PART.test(source[i])) i++;
      tokens.push({ type: 'ident', value: source.slice(start, i), start, end: i });
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const start = i;
      const number = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(source.slice(i))!;
      i += number[0].length;
      tokens.push({ type: 'num', value: source.slice(start, i), start, end: i });
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      tokens.push({ type: 'str', value: source.slice(start, i), start, end: i });
      continue;
    }

    const multi = PUNCT.find(op => source.startsWith(op, i));
    const value = multi ?? ch;
    tokens.push({ type: 'punct', value, start: i, end: i + value.length });
    i += value.length;
  }

  return tokens;
}

export interface ExprResult {
  /** 改写后的 JS 源码，根标识符已换成 s.data.x / s.item 形式 */
  code: string;
  /** 相对依赖：局部变量去掉根名（item.name → ['name']），数据字段保留完整路径 */
  deps: string[][];
}

/**
 * @param locals 当前作用域里的局部变量（wx:for 的 item / index）
 * @param externals 模板外部注入的命名空间（wxs 模块），形如 fmt → s.wxs.fmt
 */
export function compileExpr(
  source: string,
  locals: ReadonlySet<string> = new Set(),
  externals: ReadonlySet<string> = new Set()
): ExprResult {
  const tokens = tokenize(source);
  const inserts: Array<{ at: number; text: string }> = [];
  const deps: string[][] = [];
  let externalCall = false;
  const nesting: string[] = [];
  const containers = tokens.map(token => {
    const container = nesting[nesting.length - 1];
    if (['{', '[', '('].includes(token.value)) nesting.push(token.value);
    else if (['}', ']', ')'].includes(token.value)) nesting.pop();
    return container;
  });

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok.type !== 'ident') continue;

    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    // 成员访问的属性名，不是根标识符
    if (prev && prev.type === 'punct' && (prev.value === '.' || prev.value === '?.')) continue;
    // 对象字面量的键：{ a: 1 } / { ..., a: 1 }；三元表达式的冒号后面是值，不能跳过
    if (
      next &&
      next.type === 'punct' &&
      next.value === ':' &&
      prev &&
      prev.type === 'punct' &&
      (prev.value === '{' || prev.value === ',')
    ) {
      continue;
    }
    if (KEYWORDS.has(tok.value) || GLOBALS.has(tok.value)) continue;

    const path: string[] = [tok.value];
    let last = tok.end;
    let cursor = k + 1;

    while (cursor < tokens.length) {
      const cur = tokens[cursor];
      if (cur.type === 'punct' && (cur.value === '.' || cur.value === '?.') && tokens[cursor + 1]?.type === 'ident') {
        path.push(tokens[cursor + 1].value);
        last = tokens[cursor + 1].end;
        cursor += 2;
        continue;
      }
      // a[0] / a['x'] 收进路径；a[i] 这类动态下标只依赖到 a
      if (cur.type === 'punct' && cur.value === '[') {
        const key = tokens[cursor + 1];
        const close = tokens[cursor + 2];
        if (key && close && close.type === 'punct' && close.value === ']') {
          if (key.type === 'num' || key.type === 'str') {
            path.push(key.type === 'str' ? key.value.slice(1, -1) : key.value);
            last = close.end;
            cursor += 3;
            continue;
          }
        }
      }
      break;
    }

    // 方法调用只依赖到对象本身：list.slice(0, 2) 依赖 list，不依赖 list.slice
    const after = tokens[cursor];
    if (after && after.type === 'punct' && after.value === '(' && path.length > 1) path.pop();

    if (!locals.has(path[0]) && externals.has(path[0])) {
      if (after?.value === '(') externalCall = true;
      inserts.push({ at: tok.start, text: 's.wxs.' });
      k = cursor - 1;
      continue;
    }

    const isLocal = locals.has(path[0]);
    const shorthand = containers[k] === '{' && (prev?.value === '{' || prev?.value === ',') && (next?.value === ',' || next?.value === '}');
    inserts.push({ at: tok.start, text: (shorthand ? `${tok.value}: ` : '') + (isLocal ? 's.' : 's.data.') });
    // 依赖保留完整路径：`item.name` 带上前缀，运行期才知道它是列表局部变量而不是根数据
    deps.push(path);
    k = cursor - 1;
    void last;
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    if (token.value === '.' && tokens[index + 1]?.type === 'ident') inserts.push({ at: token.start, text: '?' });
    else if (
      token.value === '[' &&
      previous &&
      ((previous.type === 'ident' && !KEYWORDS.has(previous.value)) ||
        previous.type === 'str' ||
        previous.type === 'num' ||
        previous.value === ']' ||
        previous.value === ')')
    )
      inserts.push({ at: token.start, text: '?.' });
  }
  inserts.sort((a, b) => a.at - b.at);

  let code = '';
  let pos = 0;
  for (const insert of inserts) {
    code += source.slice(pos, insert.at) + insert.text;
    pos = insert.at;
  }
  code += source.slice(pos);

  if (externalCall && !deps.length) deps.push([]);
  return { code, deps };
}

export function findExpressionEnd(source: string, start: number): number {
  let depth = 0;
  let quote = '';
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth) depth--;
      else if (source[i + 1] === '}') return i;
    }
  }
  return -1;
}

/** 把属性值切成「静态文本 + 表达式」的片段 */
export type Chunk = { type: 'text'; value: string } | { type: 'expr'; value: string };

export function splitExpression(value: string): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;

  while (i < value.length) {
    const open = value.indexOf('{{', i);
    if (open < 0) {
      chunks.push({ type: 'text', value: value.slice(i) });
      break;
    }
    if (open > i) chunks.push({ type: 'text', value: value.slice(i, open) });
    const close = findExpressionEnd(value, open + 2);
    if (close < 0) {
      chunks.push({ type: 'text', value: value.slice(open) });
      break;
    }
    chunks.push({ type: 'expr', value: value.slice(open + 2, close) });
    i = close + 2;
  }

  return chunks.filter(chunk => chunk.type === 'expr' || chunk.value !== '');
}

export function isDynamic(value: string | true | undefined): boolean {
  return typeof value === 'string' && value.includes('{{');
}
