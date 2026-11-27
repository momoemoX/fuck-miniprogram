/**
 * 把一个小程序目录编译成静态站点
 *
 * 产物：runtime.js（引擎）+ templates.js（所有页面/组件的渲染函数）
 *      + modules.js（业务 JS，按模块注册）+ app.css + index.html
 * 不需要开发服务器也能打开。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import less from 'less';
import { generate } from './codegen';
import { attr, parse, type WxmlNode, type TemplateDefinition, type TemplateMap } from './parser';
import { collectWorkerPaths, workerBundleScript } from './worker';
import { compileWxss, inlineImports, scopeWxss } from './wxss';
import { compileWxs } from './wxs';

const here = path.dirname(fileURLToPath(import.meta.url));

function readWxss(file: string): string {
  const source = fs.readFileSync(file, 'utf8');
  return compileWxss(
    inlineImports(source, specifier => {
      const target = path.resolve(path.dirname(file), specifier);
      return fs.readFileSync(target, 'utf8');
    })
  );
}

/**
 * 与开发者工具一致：有 .less 时用 .less，其余 .less 自动引用根目录的 app.less
 * （reference 方式，只借变量和 mixin，不重复产出 app.less 里的规则）
 */
async function compileLess(file: string, root: string): Promise<string> {
  const dir = path.dirname(file);
  const appLess = path.join(root, 'app.less');
  let source = fs.readFileSync(file, 'utf8');

  if (path.basename(file) !== 'app.less' && fs.existsSync(appLess)) {
    const relative = path.relative(dir, appLess).replace(/\\/g, '/');
    source = `@import (reference) "${relative.startsWith('.') ? relative : `./${relative}`}";\n${source}`;
  }

  const result = await less.render(source, { filename: file, paths: [root, dir] });
  return compileWxss(result.css);
}

async function styleFor(base: string, root: string): Promise<string | null> {
  if (fs.existsSync(`${base}.less`)) return compileLess(`${base}.less`, root);
  if (fs.existsSync(`${base}.wxss`)) return readWxss(`${base}.wxss`);
  return null;
}

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

interface LoadedTemplate {
  nodes: WxmlNode[];
  templates: TemplateMap;
  ownTemplates: TemplateMap;
  wxsMap: Record<string, string>;
}

function loadTemplate(
  file: string,
  root: string,
  modules: string[],
  cache = new Map<string, LoadedTemplate>(),
  loading = new Set<string>()
): LoadedTemplate {
  const key = path.resolve(file);
  const cached = cache.get(key);
  if (cached) return cached;
  const nodes = parse(fs.readFileSync(key, 'utf8'));
  const loaded: LoadedTemplate = { nodes: [], templates: {}, ownTemplates: {}, wxsMap: collectWxs(nodes, key, root, modules) };
  cache.set(key, loaded);
  loading.add(key);
  const definitions = new Map<WxmlNode, TemplateDefinition>();
  const collect = (nodes: WxmlNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      const name = node.tag === 'template' ? attr(node, 'name') : null;
      if (name) {
        const definition = { nodes: [] as WxmlNode[], templates: loaded.templates, wxsMap: loaded.wxsMap };
        loaded.ownTemplates[String(name)] = definition;
        definitions.set(node, definition);
      }
      collect(node.children);
    }
  };
  collect(nodes);
  const expand = (nodes: WxmlNode[]): WxmlNode[] => {
    const result: WxmlNode[] = [];
    for (const node of nodes) {
      if (node.type !== 'element') {
        result.push(node);
        continue;
      }
      if (node.tag === 'import' || node.tag === 'include') {
        const src = attr(node, 'src');
        if (typeof src !== 'string' || !src) continue;
        const target = src.startsWith('/') ? path.join(root, src) : path.resolve(path.dirname(key), src);
        if (node.tag === 'include' && loading.has(path.resolve(target))) continue;
        const imported = loadTemplate(target, root, modules, cache, loading);
        if (node.tag === 'import') Object.assign(loaded.templates, imported.ownTemplates);
        else
          result.push({
            type: 'element',
            tag: 'block',
            attrs: [],
            children: [],
            templateScope: { nodes: imported.nodes, templates: imported.templates, wxsMap: loaded.wxsMap }
          });
        continue;
      }
      const definition = definitions.get(node);
      if (definition) definition.nodes = expand(node.children);
      else result.push({ ...node, children: expand(node.children) });
    }
    return result;
  };
  loaded.nodes = expand(nodes);
  Object.assign(loaded.templates, loaded.ownTemplates);
  loading.delete(key);
  return loaded;
}

function collectWxs(nodes: WxmlNode[], file: string, root: string, modules: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (nodes: WxmlNode[]) => {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      if (node.tag !== 'wxs') {
        walk(node.children);
        continue;
      }
      const name = attr(node, 'module');
      const src = attr(node, 'src');
      if (typeof name !== 'string') continue;
      if (typeof src === 'string') {
        const target = src.startsWith('/') ? path.join(root, src) : path.resolve(path.dirname(file), src);
        result[name] = path.relative(root, target).replace(/\\/g, '/');
      } else {
        const id =
          path
            .relative(root, file)
            .replace(/\\/g, '/')
            .replace(/\.wxml$/, '') +
          '$wxs$' +
          name;
        const source = node.children
          .filter(node => node.type === 'text')
          .map(node => node.value)
          .join('');
        modules.push(`__FMP__.module(${JSON.stringify(id)}, function (require, module, exports) {\n${compileWxs(source)}\n});`);
        result[name] = id;
      }
    }
  };
  walk(nodes);
  return result;
}

/** 组件路径归一化成相对项目根、不带扩展名的 id */
function normalizeComponentPath(specifier: string, baseDir: string, root: string): string {
  const candidates: string[] = [];
  if (specifier.startsWith('/')) candidates.push(path.join(root, specifier));
  else if (specifier.startsWith('.')) candidates.push(path.resolve(baseDir, specifier));
  else {
    let dir = baseDir;
    while (dir.startsWith(root)) {
      candidates.push(path.join(dir, 'miniprogram_npm', specifier));
      if (dir === root) break;
      dir = path.dirname(dir);
    }
    candidates.push(path.join(root, specifier));
  }
  for (const candidate of candidates) {
    for (const target of [candidate, path.join(candidate, 'index')]) {
      if (fs.existsSync(`${target}.wxml`)) return path.relative(root, target).replace(/\\/g, '/');
    }
  }
  throw new Error(`找不到组件 ${specifier}（引用目录：${baseDir}）`);
}

function resolveComponents(value: Record<string, string> | undefined, baseDir: string, root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [tag, specifier] of Object.entries(value ?? {})) {
    result[tag] = normalizeComponentPath(specifier, baseDir, root);
  }
  return result;
}

const HTML = (title: string, scripts: string[]) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<link rel="stylesheet" href="./app.css">
</head>
<body>
<div id="app"></div>
<script src="./runtime.js"></script>
${scripts.map(src => `<script src="${src}"></script>`).join('\n')}
</body>
</html>
`;

export interface BuildResult {
  outDir: string;
  pages: string[];
  components: string[];
}

export async function buildProject(projectDir: string, outDir: string): Promise<BuildResult> {
  const root = path.resolve(projectDir);
  if (root === path.resolve(outDir)) throw new Error('输出目录必须与小程序源目录不同');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const pages: string[] = [...(app.pages ?? [])];
  if (!pages.length) throw new Error('app.json 里没有 pages');

  // 分包页面与主包页面一起编译，运行时按需加载模块
  const subpackages: Array<{ root: string; pages?: string[]; independent?: boolean }> = app.subpackages ?? app.subPackages ?? [];
  for (const pkg of subpackages) {
    const base = String(pkg.root ?? '').replace(/^\/+|\/+$/g, '');
    for (const page of pkg.pages ?? []) pages.push(base ? `${base}/${page}` : page);
  }

  // 不整目录删除：沙箱 / 安全删除钩子对批量删除会拦截，直接覆盖写即可
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join(here, 'runtime.js'), path.join(outDir, 'runtime.js'));
  fs.copyFileSync(path.join(here, '../THIRD_PARTY_NOTICES.md'), path.join(outDir, 'THIRD_PARTY_NOTICES.md'));
  fs.cpSync(path.join(here, '../licenses'), path.join(outDir, 'licenses'), { recursive: true });

  const css: string[] = [];
  const templates: string[] = [];
  const modules: string[] = [];
  const componentIds = new Set<string>();
  const pageConfig: Record<string, any> = {};
  const componentConfig: Record<string, any> = {};

  // 页面 / 组件样式各带作用域（等价于 styleIsolation: isolated），app.wxss 是全局的
  const scopes = { pages: {} as Record<string, string>, components: {} as Record<string, string> };

  const appStyle = await styleFor(path.join(root, 'app'), root);
  if (appStyle) css.push(scopeWxss(appStyle, 'fmp-style~', 'global'));

  const readJson = (file: string) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

  // 页面
  pages.forEach((page, pageIndex) => {
    scopes.pages[page] = String(pageIndex);
  });

  for (const page of pages) {
    const base = path.join(root, page);
    const dir = path.dirname(base);
    const pageJson = readJson(`${base}.json`);
    const components = {
      ...resolveComponents(app.usingComponents, root, root),
      ...resolveComponents(pageJson.usingComponents, dir, root)
    };
    const loaded = loadTemplate(`${base}.wxml`, root, modules);
    const nodes = loaded.nodes;
    const wxs = loaded.wxsMap;

    templates.push(
      generate(page, nodes, {
        templates: loaded.templates,
        wxs: Object.keys(wxs),
        components,
        wxsMap: wxs
      })
    );

    pageConfig[page] = {
      ...pageJson,
      usingComponents: components
    };

    const pageStyle = await styleFor(base, root);
    if (pageStyle) css.push(scopeWxss(pageStyle, 'fmp-style~', `p${scopes.pages[page]}`));
  }

  // 组件（递归：组件里可能再用组件）
  const pending = new Set<string>();
  for (const id of Object.values(pageConfig).flatMap((item: any) => Object.values(item.usingComponents ?? {}) as string[])) {
    pending.add(id);
  }
  for (const id of Object.values(resolveComponents(app.usingComponents, root, root))) pending.add(id);
  // 自定义 tabBar 不在 usingComponents 里，需要单独编译
  if (app.tabBar?.custom && fs.existsSync(path.join(root, 'custom-tab-bar/index.wxml'))) {
    pending.add('custom-tab-bar/index');
  }

  while (pending.size) {
    const id = pending.values().next().value as string;
    pending.delete(id);
    if (componentIds.has(id)) continue;
    componentIds.add(id);
    scopes.components[id] = String(componentIds.size - 1);

    const base = path.join(root, id);
    if (!fs.existsSync(`${base}.wxml`)) {
      console.warn(`[fmp-engine] 组件缺少 wxml：${id}`);
      continue;
    }
    const dir = path.dirname(base);
    const json = readJson(`${base}.json`);
    const components = {
      ...resolveComponents(app.usingComponents, root, root),
      ...resolveComponents(json.usingComponents, dir, root)
    };
    const generics = Object.fromEntries(
      Object.entries<any>(json.componentGenerics ?? {}).map(([name, spec]) => [
        name,
        spec?.default ? normalizeComponentPath(spec.default, dir, root) : null
      ])
    );
    componentConfig[id] = { ...json, usingComponents: components, generics };
    for (const child of Object.values(generics)) if (child && !componentIds.has(child)) pending.add(child);
    for (const child of Object.values(components)) if (!componentIds.has(child)) pending.add(child);

    const loaded = loadTemplate(`${base}.wxml`, root, modules);
    const nodes = loaded.nodes;
    const wxs = loaded.wxsMap;

    templates.push(
      generate(id, nodes, {
        templates: loaded.templates,
        wxs: Object.keys(wxs),
        components,
        generics: Object.keys(generics),
        wxsMap: wxs
      })
    );
    const componentStyle = await styleFor(base, root);
    if (componentStyle) {
      const own = `c${scopes.components[id]}`;
      css.push(scopeWxss(componentStyle, 'fmp-style~', own));
      css.push(scopeWxss(componentStyle, 'fmp-style~', 'shared', `:where(wx-page[fmp-shared~="${own}"]) `));
    }
  }

  // 业务 JS：整棵目录下的 .js 都包成模块，require 的相对路径不用改
  const ASSET_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp3', '.mp4', '.webm', '.json', '.txt', '.pdf', '.br', '.zip', '.bin'];
  const jsFiles: string[] = [];
  const assetFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (path.resolve(full) === path.resolve(outDir)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.wxs')) jsFiles.push(full);
      else if (ASSET_EXT.some(ext => entry.name.endsWith(ext))) assetFiles.push(full);
    }
  };
  walk(root);

  for (const file of jsFiles) {
    const id = path.relative(root, file).replace(/\\/g, '/').replace(/\.js$/, '');
    const rawSource = fs.readFileSync(file, 'utf8');
    const source = file.endsWith('.wxs') ? compileWxs(rawSource) : rawSource;
    modules.push(`__FMP__.module(${JSON.stringify(id)}, function (require, module, exports) {\n${source}\n});`);
  }

  // 静态资源原样拷过去（图片、音视频等）
  for (const file of assetFiles) {
    const relative = path.relative(root, file);
    const target = path.join(outDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
  }

  write(path.join(outDir, 'app.css'), css.join('\n'));
  write(path.join(outDir, 'templates.js'), templates.join('\n'));
  write(path.join(outDir, 'modules.js'), modules.join('\n'));

  // Worker：app.json 的 workers 与业务代码里的 wx.createWorker('...')
  const workerPaths = collectWorkerPaths(app, jsFiles, root);
  write(path.join(outDir, 'workers.js'), workerBundleScript(workerPaths, root));

  // 插件：app.json.plugins 里带 path 的按本地源码编译（官方插件包无法离线获取）
  const pluginEntries: Record<string, string> = {};
  for (const [name, plugin] of Object.entries<any>(app.plugins ?? {})) {
    if (!plugin?.path) continue;
    const entryFile = path.join(root, String(plugin.path), String(plugin.export ?? 'index.js'));
    if (!fs.existsSync(entryFile)) {
      console.warn(`[fmp-engine] 插件 ${name} 的入口不存在：${path.relative(root, entryFile)}`);
      continue;
    }
    pluginEntries[name] = path.relative(root, entryFile).replace(/\\/g, '/').replace(/\.js$/, '');
  }

  // ext.json：第三方平台代管的扩展配置
  const extJson = readJson(path.join(root, 'ext.json'));
  const extConfig = extJson.extEnable === false ? {} : (extJson.ext ?? {});

  const config = {
    pages,
    entry: app.entryPagePath ?? pages[0],
    window: app.window ?? {},
    tabBar: app.tabBar,
    subpackages: subpackages.map(pkg => ({ root: pkg.root, pages: pkg.pages ?? [], independent: !!pkg.independent })),
    networkTimeout: app.networkTimeout ?? {},
    resolveAlias: app.resolveAlias ?? {},
    lazyCodeLoading: app.lazyCodeLoading,
    requiredPrivateInfos: app.requiredPrivateInfos ?? [],
    permission: app.permission ?? {},
    workers: workerPaths,
    pluginEntries,
    extConfig,
    pageConfig,
    componentConfig,
    scopes
  };
  write(path.join(outDir, 'boot.js'), `__FMP__.boot({ config: ${JSON.stringify(config)} });\n`);
  write(
    path.join(outDir, 'index.html'),
    HTML(app.window?.navigationBarTitleText ?? 'fmp-engine', ['./templates.js', './modules.js', './workers.js', './boot.js'])
  );

  return { outDir, pages, components: Array.from(componentIds) };
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const [projectArg, outArg] = process.argv.slice(2);
  if (!projectArg || !outArg) {
    console.error('用法：node dist/build.js <小程序目录> <输出目录>');
    process.exit(1);
  }
  const result = await buildProject(path.resolve(projectArg), path.resolve(outArg));
  console.log(`已生成 ${result.pages.length} 个页面、${result.components.length} 个组件 → ${result.outDir}`);
}
