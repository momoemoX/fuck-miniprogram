type RequestEvent = { url: string; method?: string; data?: any; [key: string]: any };
type RuleInput = string | RegExp | { id?: string; url: string | RegExp; method?: string; maxAge?: number; dataSchema?: any[] };
type Cache = { cacheId: string; ruleId: string; createTime: number; maxAge: number; data: any };
type Rule = { id: string; maxAge: number; test: (evt: RequestEvent) => boolean };
const DAY = 86400000;

function schemaMatches(value: any, schema: any): boolean {
  if (Array.isArray(schema)) return schema.some(item => schemaMatches(value, item));
  if (!schema || typeof schema !== 'object') throw new TypeError('invalid data schema');
  const type = schema.type;
  if (typeof type !== 'string') throw new TypeError('schema type is required');
  if (type.endsWith('[]')) return Array.isArray(value) && value.every(item => schemaMatches(item, { ...schema, type: type.slice(0, -2) }));
  if (type !== 'any' && (type === 'null' ? value !== null : type === 'object' ? value === null || typeof value !== 'object' : typeof value !== type)) return false;
  if (schema.value === undefined) return true;
  if (typeof schema.value === 'function') return !!schema.value(value);
  if (schema.value instanceof RegExp) { schema.value.lastIndex = 0; return schema.value.test(String(value)); }
  if (type === 'object' && Array.isArray(schema.value)) return schema.value.every((rule: any) => schemaMatches(value?.[rule.name], rule.schema));
  return String(value) === String(schema.value);
}

export class CacheManager {
  readonly origin: string;
  readonly mode: 'none' | 'always' | 'weakNetwork';
  readonly maxAge: number;
  state: 0 | 1 | 2;
  private rules = new Map<string, Rule>();
  private caches = new Map<string, Cache>();
  private listeners = new Map<string, Set<(...args: any[]) => any>>();
  private sequence = 0;
  constructor(options: any = {}, weak = false) {
    this.mode = options.mode ?? 'weakNetwork';
    if (!['none','always','weakNetwork'].includes(this.mode)) throw new TypeError('invalid cache mode');
    this.origin = options.origin ?? '';
    if (typeof this.origin !== 'string') throw new TypeError('origin must be a string');
    this.maxAge = options.maxAge ?? 7 * DAY;
    if (!Number.isFinite(this.maxAge) || this.maxAge < 0) throw new TypeError('invalid maxAge');
    this.maxAge = Math.min(this.maxAge,30 * DAY);
    this.state = this.mode === 'always' || (this.mode === 'weakNetwork' && weak) ? 1 : 0;
  }
  addRule(input: RuleInput): string {
    const spec = typeof input === 'string' || input instanceof RegExp ? { url: input } : input;
    if (!spec || !(typeof spec.url === 'string' || spec.url instanceof RegExp)) throw new TypeError('rule url is required');
    const id = spec.id ?? `rule-${++this.sequence}`;
    if (typeof id !== 'string' || !id) throw new TypeError('rule id must be a string');
    const maxAge = spec.maxAge ?? this.maxAge;
    if (!Number.isFinite(maxAge) || maxAge < 0) throw new TypeError('invalid rule maxAge');
    let method = spec.method?.toUpperCase();
    let pattern = spec.url;
    if (typeof pattern === 'string') {
      const match = /^(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(pattern);
      if (match) { method ??= match[1].toUpperCase(); pattern = match[2]; }
    }
    let urlMatches: (url: URL) => boolean;
    if (pattern instanceof RegExp) {
      const expression = pattern;
      const full = expression.source.includes('https');
      urlMatches = url => {
        expression.lastIndex = 0;
        return (full || !this.origin || url.origin === new URL(this.origin).origin) && expression.test(full ? url.href : `${url.pathname}${url.search}`);
      };
    } else {
      const expected = new URL(pattern, this.origin || 'http://localhost');
      const parts = expected.pathname.split('/');
      urlMatches = url => {
        const actual = url.pathname.split('/');
        return url.origin === expected.origin && actual.length === parts.length && parts.every((part,i)=>part.startsWith(':') ? !!actual[i] : part === actual[i]) && [...expected.searchParams].every(([key,value]) => url.searchParams.has(key) && (!value || url.searchParams.get(key) === value));
      };
    }
    const test = (evt: RequestEvent) => {
      if (method && method !== String(evt.method ?? 'GET').toUpperCase()) return false;
      let url: URL;
      try { url = new URL(evt.url,this.origin || undefined); } catch { return false; }
      if (!urlMatches(url)) return false;
      return !spec.dataSchema || spec.dataSchema.every(rule => schemaMatches(evt.data?.[rule.name],rule.schema));
    };
    this.deleteRule(id);
    this.rules.set(id,{id,maxAge:Math.min(maxAge,30*DAY),test});
    return id;
  }
  addRules(rules: RuleInput[]): string[] {
    if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
    return rules.map(rule=>this.addRule(rule));
  }
  deleteRule(id: string) { this.rules.delete(id); for (const [key,cache] of this.caches) if(cache.ruleId===id)this.caches.delete(key); }
  deleteRules(ids: string[]) { ids.forEach(id=>this.deleteRule(id)); }
  clearRules() { this.rules.clear(); this.caches.clear(); }
  clearCaches() { this.caches.clear(); }
  deleteCache(id: string) { for(const [key,cache] of this.caches)if(cache.cacheId===id)this.caches.delete(key); }
  deleteCaches(ids: string[]) { ids.forEach(id=>this.deleteCache(id)); }
  private key(evt: RequestEvent) { return JSON.stringify([evt.url,String(evt.method??'GET').toUpperCase(),evt.data??null]); }
  match(evt: RequestEvent): (Pick<Cache, 'ruleId' | 'maxAge'> & Partial<Cache>) | undefined {
    const rule = [...this.rules.values()].find(rule=>rule.test(evt));
    if(!rule)return undefined;
    const cache = this.caches.get(this.key(evt));
    if(cache && cache.ruleId===rule.id && Date.now()-cache.createTime<cache.maxAge) return structuredClone(cache);
    if(cache)this.caches.delete(this.key(evt));
    return {ruleId:rule.id,maxAge:rule.maxAge};
  }
  store(evt: RequestEvent,data: any) {
    const rule = [...this.rules.values()].find(rule=>rule.test(evt));
    if(!rule)return;
    this.caches.set(this.key(evt),{cacheId:`cache-${++this.sequence}`,ruleId:rule.id,createTime:Date.now(),maxAge:rule.maxAge,data:{...structuredClone(data),fromCache:true}});
  }
  on(name: string,handler: (...args: any[])=>any) {
    if(!['request','enterWeakNetwork','exitWeakNetwork'].includes(name)||typeof handler!=='function')throw new TypeError('invalid cache event');
    let handlers=this.listeners.get(name);if(!handlers)this.listeners.set(name,handlers=new Set());handlers.add(handler);
  }
  off(name: string,handler: (...args: any[])=>any) { this.listeners.get(name)?.delete(handler); }
  start() { if(this.mode==='none')this.state=1; }
  stop() { if(this.mode==='none')this.state=0; }
  setWeak(weak: boolean) {
    if(this.mode==='weakNetwork')this.state=weak?1:0;
    for(const handler of this.listeners.get(weak?'enterWeakNetwork':'exitWeakNetwork')??[])handler();
  }
  handler() { return this.listeners.get('request')?.values().next().value as ((evt:RequestEvent)=>Promise<any>)|undefined; }
  dispose() { this.listeners.clear(); }
}

export class RequestCaches {
  private managers = new Set<CacheManager>();
  private weak = typeof navigator !== 'undefined' && navigator.onLine === false;
  private update = () => {
    const weak = navigator.onLine === false;
    if(weak===this.weak)return;this.weak=weak;
    for(const manager of this.managers)manager.setWeak(weak);
  };
  constructor() { if(typeof window!=='undefined'){window.addEventListener('online',this.update);window.addEventListener('offline',this.update);} }
  create(options?: any) { const manager=new CacheManager(options,this.weak);this.managers.add(manager);return manager; }
  async request(evt: RequestEvent,original:()=>Promise<any>):Promise<any> {
    const update = (data: any) => { for(const manager of this.managers)manager.store(evt,data);return data; };
    if(evt.responseType==='arraybuffer'||evt.data instanceof ArrayBuffer)return original();
    for(const manager of this.managers) {
      if(manager.state!==1)continue;
      const handler=manager.handler();
      if(handler)return handler({...evt,method:evt.method??'GET',request:(options?:any)=>original().then(data=>options?.needUpdateCache?update(data):data)});
      const cache=manager.match(evt);
      if(cache?.data)return cache.data;
    }
    return update(await original());
  }
  dispose() { if(typeof window!=='undefined'){window.removeEventListener('online',this.update);window.removeEventListener('offline',this.update);}for(const manager of this.managers)manager.dispose();this.managers.clear(); }
}
