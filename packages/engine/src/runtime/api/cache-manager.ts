/**
 * 弱网缓存管理器（wx.createCacheManager）
 *
 * 按公开规范维护规则表与缓存条目：支持字符串简写（如 `"GET /plain"`、`"/api/*"`）、
 * 正则与对象规则的增删查以及按 origin / method / url 匹配。
 */

export interface CacheManagerOptions {
  origin?: string;
  mode?: 'weakNetwork' | 'always' | 'none';
  maxAge?: number;
  extra?: { apiList?: string[] };
}

export interface CacheRuleObject {
  id?: string;
  method?: string;
  url: string | RegExp;
  maxAge?: number;
  dataSchema?: Record<string, unknown>;
}

export type CacheRuleInput = string | RegExp | CacheRuleObject;

interface StoredRule {
  id: string;
  method: string;
  pattern: string | RegExp;
  maxAge: number;
  dataSchema?: Record<string, unknown>;
}

interface CacheEntry {
  cacheId: string;
  ruleId: string;
  data: any;
  createTime: number;
  maxAge: number;
}

const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function normalizeOrigin(origin?: string): string {
  if (!origin) return '';
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, '');
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePathMatcher(pattern: string): RegExp {
  const clean = pattern.split('?')[0] || '/';
  const normalized = clean.startsWith('/') ? clean : `/${clean}`;
  const regexStr = normalized
    .split('/')
    .map(seg => {
      if (seg === '*') return '.*';
      if (seg.startsWith(':')) return '[^/]+';
      return escapeRegex(seg);
    })
    .join('/');
  return new RegExp(`^${regexStr}$`);
}

function parseRuleInput(input: CacheRuleInput, fallbackId: string, defaultMaxAge: number): StoredRule {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|ALL)$/i.test(parts[0])) {
      return {
        id: fallbackId,
        method: parts[0].toUpperCase(),
        pattern: parts.slice(1).join(' '),
        maxAge: defaultMaxAge
      };
    }
    return {
      id: fallbackId,
      method: 'ALL',
      pattern: trimmed,
      maxAge: defaultMaxAge
    };
  }
  if (input instanceof RegExp) {
    return {
      id: fallbackId,
      method: 'ALL',
      pattern: input,
      maxAge: defaultMaxAge
    };
  }
  return {
    id: input.id || fallbackId,
    method: (input.method || 'ALL').toUpperCase(),
    pattern: input.url,
    maxAge: typeof input.maxAge === 'number' ? input.maxAge : defaultMaxAge,
    dataSchema: input.dataSchema
  };
}

export class CacheManager {
  origin: string;
  mode: 'weakNetwork' | 'always' | 'none';
  maxAge: number;
  state = 1;

  private rules = new Map<string, StoredRule>();
  private caches = new Map<string, CacheEntry>();
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private seq = 0;

  constructor(options: CacheManagerOptions = {}) {
    this.origin = normalizeOrigin(options.origin);
    this.mode = options.mode ?? 'weakNetwork';
    this.maxAge = typeof options.maxAge === 'number' ? options.maxAge : DEFAULT_MAX_AGE;
  }

  addRule(rule: CacheRuleInput): string {
    const id = `rule_${++this.seq}`;
    const stored = parseRuleInput(rule, id, this.maxAge);
    this.rules.set(stored.id, stored);
    return stored.id;
  }

  addRules(rules: CacheRuleInput[]): string[] {
    return (rules ?? []).map(rule => this.addRule(rule));
  }

  deleteRule(id: string): void {
    this.rules.delete(id);
  }

  deleteRules(ids: string[]): void {
    for (const id of ids ?? []) this.rules.delete(id);
  }

  clearRules(): void {
    this.rules.clear();
  }

  deleteCache(id: string): void {
    this.caches.delete(id);
  }

  deleteCaches(ids: string[]): void {
    for (const id of ids ?? []) this.caches.delete(id);
  }

  clearCaches(): void {
    this.caches.clear();
  }

  match(request: { url: string; method?: string; data?: any; maxAge?: number }) {
    if (!request || typeof request.url !== 'string') return null;
    const method = (request.method || 'GET').toUpperCase();
    let parsed: URL | null = null;
    try {
      parsed = this.origin ? new URL(request.url, this.origin) : new URL(request.url, 'http://localhost');
    } catch {
      return null;
    }

    if (this.origin && /^https?:\/\//i.test(request.url) && parsed.origin !== this.origin) {
      return null;
    }

    const pathname = parsed.pathname;
    const pathWithSearch = `${parsed.pathname}${parsed.search}`;

    for (const rule of this.rules.values()) {
      if (rule.method !== 'ALL' && rule.method !== method) continue;
      let matched = false;
      if (rule.pattern instanceof RegExp) {
        matched = rule.pattern.test(request.url) || rule.pattern.test(pathWithSearch) || rule.pattern.test(pathname);
      } else if (/^https?:\/\//i.test(rule.pattern)) {
        try {
          const ruleUrl = new URL(rule.pattern);
          matched = ruleUrl.origin === parsed.origin && compilePathMatcher(ruleUrl.pathname).test(pathname);
        } catch {
          matched = rule.pattern === request.url;
        }
      } else {
        matched = compilePathMatcher(rule.pattern).test(pathname);
      }
      if (!matched) continue;

      const cacheKey = `${rule.id}:${method}:${pathWithSearch}`;
      const existing = this.caches.get(cacheKey);
      const effectiveMaxAge = typeof request.maxAge === 'number' ? request.maxAge : rule.maxAge;
      const valid = existing && Date.now() - existing.createTime <= effectiveMaxAge;
      return {
        ruleId: rule.id,
        cacheId: existing?.cacheId ?? cacheKey,
        data: valid ? existing.data : undefined,
        createTime: valid ? existing.createTime : 0,
        maxAge: effectiveMaxAge
      };
    }

    return null;
  }

  on(event: string, listener: (...args: any[]) => void): void {
    let bucket = this.listeners.get(event);
    if (!bucket) this.listeners.set(event, (bucket = new Set()));
    bucket.add(listener);
  }

  off(event: string, listener?: (...args: any[]) => void): void {
    if (!listener) {
      this.listeners.delete(event);
      return;
    }
    this.listeners.get(event)?.delete(listener);
  }
}

export function createCacheManager(options?: CacheManagerOptions): CacheManager {
  return new CacheManager(options);
}
