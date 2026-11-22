import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveCompilerBin(): string {
  return require.resolve('@fuck-miniprogram/engine/compiler');
}

function option(args: string[], name: string, fallback?: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return fallback;
  return args[idx + 1] ?? fallback;
}

function printHelp() {
  console.log(`
fuck-miniprogram (fmp) — Pure Web Mini Program Base Library & Compiler CLI

Usage:
  fmp dev <project-dir> [--port 3000] [--out .tmp/web]
  fmp build <project-dir> [--out dist-web]

Examples:
  fmp dev ./examples/starter
  fmp build ./examples/starter --out ./dist-web
`);
}

function runBuild(projectDir: string, outDir: string): boolean {
  const started = Date.now();
  const compilerBin = resolveCompilerBin();
  const result = spawnSync(process.execPath, [compilerBin, projectDir, outDir], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout || 'Build failed');
    return false;
  }
  const summary = (result.stdout || '').trim();
  console.log(`[fmp] ${summary || 'built'} (${Date.now() - started}ms)`);
  return true;
}

function findFreePort(start: number): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(findFreePort(start + 1)));
    server.once('listening', () => server.close(() => resolve(start)));
    server.listen(start, '127.0.0.1');
  });
}

const MIME: Record<string, string> = {
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
  '.webm': 'video/webm'
};

const RELOAD_SCRIPT = `<script>new EventSource('/__fmp_reload').onmessage = () => location.reload();</script>`;

async function runDev(projectDir: string, outDir: string, requestedPort: number) {
  if (!runBuild(projectDir, outDir)) process.exit(1);

  const clients = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (url === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    if (url === '/__fmp_reload') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const file = path.join(outDir, url === '/' ? 'index.html' : url);
    if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(file);
    if (ext === '.html') {
      const html = fs.readFileSync(file, 'utf8').replace('</body>', `${RELOAD_SCRIPT}</body>`);
      res.writeHead(200, { 'content-type': MIME['.html'] }).end(html);
      return;
    }
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });

  const port = await findFreePort(requestedPort);
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve()));

  console.log(`\n  fuck-miniprogram dev server`);
  console.log(`  URL      http://localhost:${port}`);
  console.log(`  Project  ${projectDir}`);
  console.log(`  Output   ${outDir}\n`);

  let timer: NodeJS.Timeout | null = null;
  let building = false;
  fs.watch(projectDir, { recursive: true }, (_event, filename) => {
    if (!filename || filename.includes('node_modules') || filename.startsWith('.')) return;
    if (building) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      building = true;
      try {
        if (runBuild(projectDir, outDir)) {
          for (const client of clients) client.write('data: reload\n\n');
        }
      } finally {
        building = false;
      }
    }, 120);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp();
    process.exit(0);
  }
  const positional = args.slice(1).filter((arg, idx, list) => {
    if (arg.startsWith('-')) return false;
    const prev = list[idx - 1];
    return prev !== '--port' && prev !== '--out' && prev !== '-o';
  });
  const projectDir = path.resolve(process.cwd(), positional[0] ?? '.');
  if (!fs.existsSync(projectDir)) {
    console.error(`[fmp] Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  if (cmd === 'build') {
    const outDir = path.resolve(process.cwd(), option(args, '--out') ?? option(args, '-o') ?? 'dist-web');
    if (!runBuild(projectDir, outDir)) process.exit(1);
    return;
  }

  if (cmd === 'dev') {
    const outDir = path.resolve(process.cwd(), option(args, '--out') ?? option(args, '-o') ?? '.tmp/web');
    const port = Number(option(args, '--port', '3000'));
    await runDev(projectDir, outDir, Number.isFinite(port) ? port : 3000);
    return;
  }

  console.error(`[fmp] Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
