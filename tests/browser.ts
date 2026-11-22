import { buildSync } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { generate, type GenerateOptions } from '../packages/engine/src/compiler/codegen';
import { parse } from '../packages/engine/src/compiler/parser';

export interface Fixture {
  definition: string;
  template?: string;
  options?: GenerateOptions;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ channel: process.env.FMP_BROWSER_CHANNEL ?? 'chrome', headless: true });
}

export async function openRuntime(browser: Browser, fixtures: Record<string, Fixture>, config: Record<string, any> = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('http://localhost:9876');
  const bundle = buildSync({
    entryPoints: ['packages/engine/src/runtime/index.ts'], bundle: true, write: false,
    format: 'iife', globalName: '__FMP__', platform: 'browser', loader: { '.css': 'text' }
  }).outputFiles[0].text;
  await page.addScriptTag({ content: bundle });
  for (const [id, fixture] of Object.entries(fixtures)) {
    await page.addScriptTag({ content: `__FMP__.module(${JSON.stringify(id)}, function(require,module,exports){${fixture.definition}\n});` });
    if (fixture.template !== undefined) await page.addScriptTag({ content: generate(id, parse(fixture.template), fixture.options) });
  }
  await page.evaluate(config => (window as any).__FMP__.boot({ config: { pages: ['pages/home/index'], ...config } }), config);
  await page.waitForFunction(() => (window as any).__FMP__.currentPage());
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  return page;
}
