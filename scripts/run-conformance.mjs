import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function option(name, fallback = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const suiteDir = path.resolve(
  repoRoot,
  option('suite', '../fuck-miniprogram-conformance-tests')
);
const outReport = path.resolve(
  repoRoot,
  option('out', '.tmp/conformance-report.json')
);
const visualReport = path.resolve(
  repoRoot,
  option('visual-out', '.tmp/visual-report.json')
);
const selectedIdsRaw = option('ids', null);
const selectedIds = selectedIdsRaw
  ? selectedIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
  : null;
const runVisual = hasFlag('visual');
const visualOnly = hasFlag('visual-only');
const visualFilter = option('visual-only-keys', null);
const channel = option('channel', 'chrome');
const timeoutMs = Number(option('timeout', '240000'));

const tmpRoot = path.join(repoRoot, '.tmp');
const workSrc = path.join(tmpRoot, 'conformance-src');
const workDist = path.join(tmpRoot, 'conformance-dist');
const visualShots = path.join(tmpRoot, 'visual-shots');
const visualDiff = path.join(tmpRoot, 'visual-diff');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function findFreePort(start) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(findFreePort(start + 1)));
    srv.once('listening', () => srv.close(() => resolve(start)));
    srv.listen(start, '127.0.0.1');
  });
}

function waitForPort(port, host = '127.0.0.1', timeout = 5000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.createConnection({ port, host });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 50);
        }
      });
    };
    attempt();
  });
}

function copySuiteProject(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const skipTop = new Set([
    '.git',
    '.github',
    '.scratch',
    '.workbuddy',
    'node_modules',
    'tools',
    'research'
  ]);
  for (const entry of fs.readdirSync(src)) {
    if (skipTop.has(entry)) continue;
    fs.cpSync(path.join(src, entry), path.join(dst, entry), { recursive: true });
  }
}

function startStaticServer(rootDir, port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    const file = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function summarizeReport(report) {
  const results = Array.isArray(report.results) ? report.results : [];
  const byCategory = {};
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const cat = r.category || 'behavior';
    if (!byCategory[cat]) byCategory[cat] = { passed: 0, failed: 0, total: 0 };
    byCategory[cat].total += 1;
    if (r.status === 'PASS') {
      passed += 1;
      byCategory[cat].passed += 1;
    } else {
      failed += 1;
      byCategory[cat].failed += 1;
    }
  }
  const failures = results
    .filter(r => r.status !== 'PASS')
    .map(r => ({
      id: r.id,
      category: r.category || 'behavior',
      status: r.status,
      evidence: r.evidence,
      expected: r.expected,
      actual: r.actual
    }));
  return {
    passed,
    failed,
    total: results.length,
    interrupted: report.interrupted || null,
    reportedSDK: report.reportedSDK || null,
    profiles: report.profiles || null,
    byCategory,
    failures
  };
}

function runAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

async function main() {
  if (!fs.existsSync(suiteDir)) {
    throw new Error(`Conformance suite directory not found: ${suiteDir}`);
  }
  fs.mkdirSync(tmpRoot, { recursive: true });

  const httpPort = await findFreePort(8123);
  const wsPort = await findFreePort(Math.max(8124, httpPort + 1));
  const appPort = await findFreePort(3100);

  copySuiteProject(suiteDir, workSrc);

  // Inject suite-config.js only into the temporary copy
  const suiteConfigContent = `module.exports = { fixtureUrl: "http://127.0.0.1:${httpPort}", socketUrl: "ws://127.0.0.1:${wsPort}", testAppId: "", driver: false, profile: "" };\n`;
  fs.writeFileSync(path.join(workSrc, 'suite-config.js'), suiteConfigContent, 'utf8');

  // Compile using @fuck-miniprogram/cli
  const cliBin = path.join(repoRoot, 'packages/cli/dist/index.js');
  const buildRes = spawnSync(process.execPath, [cliBin, 'build', workSrc, '--out', workDist], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  if (buildRes.status !== 0) {
    console.error('[conformance] Build failed:');
    console.error(buildRes.stdout);
    console.error(buildRes.stderr);
    process.exit(1);
  }
  console.log(`[conformance] ${buildRes.stdout.trim()}`);

  const children = [];
  let staticServer = null;
  let browser = null;

  try {
    const httpFixture = spawn(
      process.execPath,
      [path.join(suiteDir, 'tools/http-fixture.mjs')],
      { env: { ...process.env, PORT: String(httpPort), HOST: '127.0.0.1' }, stdio: 'pipe' }
    );
    children.push(httpFixture);

    const wsEcho = spawn(
      process.execPath,
      [path.join(suiteDir, 'tools/socket/echo.cjs')],
      { env: { ...process.env, PORT: String(wsPort), HOST: '127.0.0.1' }, stdio: 'pipe' }
    );
    children.push(wsEcho);

    await Promise.all([waitForPort(httpPort), waitForPort(wsPort)]);
    staticServer = await startStaticServer(workDist, appPort);
    const appUrl = `http://127.0.0.1:${appPort}/`;
    console.log(`[conformance] Serving at ${appUrl} (http:${httpPort}, ws:${wsPort})`);

    if (!visualOnly) {
      browser = await chromium.launch({ channel });
      const context = await browser.newContext({
        viewport: { width: 375, height: 812 },
        deviceScaleFactor: 2,
        permissions: ['clipboard-read', 'clipboard-write']
      });
      const page = await context.newPage();

      const consoleErrors = [];
      page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));
      page.on('console', msg => {
        if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
      });

      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () =>
          typeof globalThis.getCurrentPages === 'function' &&
          globalThis.getCurrentPages().some(p => p && p.route === 'pages/suite/index'),
        null,
        { timeout: 15000 }
      );

      // Trigger suite run
      await page.evaluate(ids => {
        const suite = globalThis.getCurrentPages().find(p => p && p.route === 'pages/suite/index');
        if (!suite) throw new Error('Suite page not found');
        if (ids && ids.length) {
          suite.runSelected(ids);
        } else {
          suite.run();
        }
      }, selectedIds);

      // Wait for report to be attached to the suite page
      await page.waitForFunction(
        () => {
          const pages = typeof globalThis.getCurrentPages === 'function' ? globalThis.getCurrentPages() : [];
          const suite = pages.find(p => p && p.route === 'pages/suite/index');
          return !!(suite && suite.report);
        },
        null,
        { timeout: timeoutMs, polling: 500 }
      );

      const report = await page.evaluate(() => {
        const suite = globalThis.getCurrentPages().find(p => p && p.route === 'pages/suite/index');
        return suite.report;
      });

      const summary = summarizeReport(report);
      const output = {
        timestamp: new Date().toISOString(),
        summary,
        consoleErrors,
        report
      };
      fs.mkdirSync(path.dirname(outReport), { recursive: true });
      fs.writeFileSync(outReport, JSON.stringify(output, null, 2), 'utf8');

      console.log(
        `\n[conformance] Total: ${summary.passed}/${summary.total} passed (${summary.failed} failed)${summary.interrupted ? ` [INTERRUPTED: ${summary.interrupted}]` : ''}`
      );
      for (const [cat, stats] of Object.entries(summary.byCategory)) {
        console.log(`  - ${cat}: ${stats.passed}/${stats.total} passed (${stats.failed} failed)`);
      }
      if (consoleErrors.length) {
        console.log(`  - browser console/page errors: ${consoleErrors.length}`);
      }
      console.log(`[conformance] Full report written to ${outReport}`);

      await browser.close();
      browser = null;
    }

    if (runVisual || visualOnly) {
      fs.rmSync(visualShots, { recursive: true, force: true });
      fs.rmSync(visualDiff, { recursive: true, force: true });
      const captureArgs = [
        path.join(suiteDir, 'tools/visual/capture-browser.cjs'),
        '--url',
        appUrl,
        '--out',
        visualShots,
        '--channel',
        channel
      ];
      const manifestPath = path.join(suiteDir, 'fixtures/visual/manifest.json');
      const defaultKeys = fs.existsSync(manifestPath)
        ? Object.keys(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).references || {}).join(',')
        : null;
      const keysToCapture = visualFilter || defaultKeys;
      if (keysToCapture) captureArgs.push('--only', keysToCapture);
      console.log('\n[visual] Capturing screenshots...');
      const capStatus = await runAsync(process.execPath, captureArgs, {
        cwd: repoRoot,
        stdio: 'inherit'
      });
      if (capStatus !== 0) {
        console.error('[visual] capture-browser.cjs failed');
      } else {
        console.log('[visual] Comparing against references...');
        const cmpStatus = await runAsync(
          process.execPath,
          [
            path.join(suiteDir, 'tools/visual/compare.cjs'),
            '--candidate',
            visualShots,
            '--out',
            visualDiff,
            '--json',
            visualReport
          ],
          { cwd: repoRoot, stdio: 'inherit' }
        );
        console.log(`[visual] Report written to ${visualReport} (exit ${cmpStatus})`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (staticServer) staticServer.close();
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
