import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { createProject } from '../helpers';

const compiler = path.resolve('packages/engine/dist/build.js');
let project: string;
afterAll(() => {
  if (project) fs.rmSync(project, { recursive: true, force: true });
});

describe.skipIf(!fs.existsSync(compiler))('引擎构建产物', () => {
  it('输出目录在项目内部时重复构建保持产物稳定', () => {
    project = createProject({
      'app.json': { pages: ['pages/index'] },
      'app.js': 'App({})',
      'pages/index.js': 'Page({ data: { title: "hello" } })',
      'pages/index.wxml': '<text>{{title}}</text>',
      'assets/content.txt': 'package-content',
      'assets/manual.pdf': '%PDF-1.4\n%%EOF'
    });
    const output = path.join(project, 'output');
    const compile = () => execFileSync(process.execPath, [compiler, project, output]);
    compile();
    const first = fs.readFileSync(path.join(output, 'modules.js'), 'utf8');
    compile();
    expect(fs.readFileSync(path.join(output, 'modules.js'), 'utf8')).toBe(first);
    expect(fs.existsSync(path.join(output, 'output'))).toBe(false);
    expect(fs.readFileSync(path.join(output, 'assets/manual.pdf'), 'utf8')).toBe('%PDF-1.4\n%%EOF');
    expect(fs.readFileSync(path.join(output, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain('@breezystack/lamejs 1.2.7');
    expect(fs.readFileSync(path.join(output, 'licenses/LGPL-3.0.txt'), 'utf8')).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(fs.readFileSync(path.join(output, 'licenses/GPL-3.0.txt'), 'utf8')).toContain('GNU GENERAL PUBLIC LICENSE');
  });
});
