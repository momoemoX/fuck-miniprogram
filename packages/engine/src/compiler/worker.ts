/**
 * Worker 构建
 *
 * 小程序里的 Worker 是 CommonJS 环境，入口通常是 `workers/xxx.js`，内部还会
 * `require('../utils/foo')`。这里按 require 关系把入口和依赖收集起来，打成一个
 * 自包含脚本；运行期 `wx.createWorker` 用 Blob 建成真正的 Web Worker。
 */

import fs from 'node:fs';
import path from 'node:path';

function resolveModule(fromDir: string, request: string): string | null {
  const base = path.resolve(fromDir, request);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function bundleWorker(entry: string, root: string): string {
  const modules = new Map<string, string>();

  const visit = (file: string) => {
    const id = path.relative(root, file).replace(/\\/g, '/').replace(/\.js$/, '');
    if (modules.has(id)) return;
    const source = fs.readFileSync(file, 'utf8');
    modules.set(id, source);

    const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      const request = match[1];
      if (!request.startsWith('.')) continue;
      const resolved = resolveModule(path.dirname(file), request);
      if (resolved) visit(resolved);
      else console.warn(`[fmp-engine] worker 里找不到模块：${request}（${path.relative(root, file)}）`);
    }
  };
  visit(entry);

  const table = Array.from(modules)
    .map(([id, source]) => `${JSON.stringify(id)}: function (require, module, exports) {\n${source}\n}`)
    .join(',\n');

  const entryId = path.relative(root, entry).replace(/\\/g, '/').replace(/\.js$/, '');

  return `(function () {
  var modules = {
${table}
  };
  var cache = {};
  function resolve(from, request) {
    var parts = from.split('/');
    parts.pop();
    request.split('/').forEach(function (part) {
      if (!part || part === '.') return;
      if (part === '..') parts.pop();
      else parts.push(part);
    });
    return parts.join('/');
  }
  function load(id) {
    id = id.replace(/\\.js$/, '');
    if (cache[id]) return cache[id].exports;
    var module = (cache[id] = { exports: {} });
    if (!modules[id]) throw new Error('Cannot find module: ' + id);
    modules[id].call(module.exports, function (request) {
      return load(resolve(id, request));
    }, module, module.exports);
    return module.exports;
  }
  var handlers = { message: null };
  self.worker = {
    onMessage: function (fn) { handlers.message = fn; },
    postMessage: function (message) { self.postMessage(message); },
    terminate: function () { self.close(); }
  };
  self.onmessage = function (event) {
    if (typeof handlers.message !== 'function') return;
    handlers.message(event.data);
  };
  try {
    load(${JSON.stringify(entryId)});
  } catch (error) {
    self.postMessage({ __fmpWorkerError: String((error && error.stack) || error) });
    throw error;
  }
})();`;
}

/**
 * 收集需要打包成 Worker 的入口：
 * - `app.json` 的 `workers[].path`
 * - 业务代码里 `wx.createWorker('...')` 的静态字符串
 */
export function collectWorkerPaths(app: any, jsFiles: string[], _root: string): string[] {
  const paths = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== 'string' || !value) return;
    const normalized = value.replace(/^\.?\//, '');
    paths.add(normalized.endsWith('.js') ? normalized : `${normalized}.js`);
  };

  for (const worker of app.workers ?? []) add(worker?.path);

  const re = /createWorker\(\s*['"]([^'"]+)['"]/g;
  for (const file of jsFiles) {
    if (!file.endsWith('.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) add(match[1]);
  }

  return Array.from(paths);
}

export function workerBundleScript(paths: string[], root: string): string {
  const entries: string[] = [];
  for (const relative of paths) {
    const entry = path.join(root, relative);
    if (!fs.existsSync(entry)) {
      console.warn(`[fmp-engine] worker 入口不存在：${relative}`);
      continue;
    }
    entries.push(`${JSON.stringify(relative)}: ${JSON.stringify(bundleWorker(entry, root))}`);
  }
  return `(self.__FMP_WORKERS__ = self.__FMP_WORKERS__ || {});\nObject.assign(self.__FMP_WORKERS__, {\n${entries.join(',\n')}\n});\n`;
}
