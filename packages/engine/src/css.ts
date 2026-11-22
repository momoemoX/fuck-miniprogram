/** 按顶层 `}` 切规则，保留 @media 等嵌套结构 */
export function walkRules(css: string, onRule: (selector: string, body: string) => string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace < 0) {
      out += css.slice(i);
      break;
    }
    const head = css.slice(i, brace);
    let depth = 1;
    let j = brace + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(brace + 1, j - 1);
    const trimmed = head.trimStart();

    if (/^@(media|supports|container|layer)/i.test(trimmed)) {
      out += `${head.trimEnd()} {${walkRules(body, onRule)}}`;
    } else if (/^@(keyframes|-webkit-keyframes|font-face|page)/i.test(trimmed)) {
      // 这些 at-rule 里的不是 DOM 选择器，不能加属性
      out += `${head.trimEnd()} {${body}}`;
    } else {
      out += onRule(head, body);
    }
    i = j;
  }
  return out;
}

export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let last = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      if (ch === quote && list[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(list.slice(last, i));
      last = i + 1;
    }
  }
  out.push(list.slice(last));
  return out;
}

export function prefixCss(source: string, prefix: string): string {
  return walkRules(
    source,
    (head, body) =>
      `${splitSelectors(head)
        .map(selector => prefix + selector.trim())
        .join(', ')} {${body}}`
  );
}
