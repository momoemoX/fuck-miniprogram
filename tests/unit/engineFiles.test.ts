import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FsApi } from '../../packages/engine/src/runtime/api/fs';

const root = 'wxfile://usr';
let files: FsApi;
let fs: any;
beforeEach(() => {
  files = new FsApi({} as any);
  fs = files.api().getFileSystemManager();
});

function call(name: string, options: any): Promise<any> {
  return new Promise((resolve, reject) => fs[name]({ ...options, success: resolve, fail: reject }));
}

describe('文件描述符与文件操作', () => {
  it('读写描述符时尊重文件位置和目标缓冲区偏移', () => {
    const fd = fs.openSync({ filePath: `${root}/file`, flag: 'w+' });
    expect(fs.writeSync({ fd, data: 'abcdef', position: 0, encoding: 'utf8' }).bytesWritten).toBe(6);
    const target = new Uint8Array(8).fill(9);
    expect(fs.readSync({ fd, arrayBuffer: target.buffer, offset: 2, length: 3, position: 1 }).bytesRead).toBe(3);
    expect(Array.from(target)).toEqual([9, 9, 98, 99, 100, 9, 9, 9]);
    fs.closeSync({ fd });
    expect(() => fs.readSync({ fd, arrayBuffer: target.buffer })).toThrow();
  });
  it('追加描述符始终从文件末尾写入并执行独占创建', () => {
    fs.writeFileSync(`${root}/file`, 'a');
    const fd = fs.openSync({ filePath: `${root}/file`, flag: 'a+' });
    expect(fs.writeSync({ fd, data: 'b', position: 0 }).bytesWritten).toBe(1);
    expect(fs.readFileSync(`${root}/file`, 'utf8')).toBe('ab');
    expect(() => fs.openSync({ filePath: `${root}/file`, flag: 'wx' })).toThrow();
    expect(() => fs.openSync({ filePath: `${root}/missing`, flag: 'r' })).toThrow();
  });
  it('只读描述符拒绝写入且截断扩展时填入零字节', () => {
    fs.writeFileSync(`${root}/file`, 'abc');
    const read = fs.openSync({ filePath: `${root}/file`, flag: 'r' });
    expect(() => fs.writeSync({ fd: read, data: 'x' })).toThrow();
    const write = fs.openSync({ filePath: `${root}/file`, flag: 'r+' });
    fs.ftruncateSync({ fd: write, length: 5 });
    expect(Array.from(new Uint8Array(fs.readFileSync(`${root}/file`) as ArrayBuffer))).toEqual([97, 98, 99, 0, 0]);
    expect(fs.fstatSync({ fd: write }).size).toBe(5);
    expect(fs.fstatSync({ fd: write }).isFile()).toBe(true);
  });
  it('异步描述符读写在回调前同步有效字节', async () => {
    const opened = (await call('open', { filePath: `${root}/file`, flag: 'w+' })) as any;
    expect(((await call('write', { fd: opened.fd, data: 'abc', position: 0 })) as any).bytesWritten).toBe(3);
    const target = new ArrayBuffer(5);
    const result = (await call('read', { fd: opened.fd, arrayBuffer: target, offset: 1, length: 2, position: 1 })) as any;
    expect(result.bytesRead).toBe(2);
    expect(Array.from(new Uint8Array(result.arrayBuffer))).toEqual([0, 98, 99, 0, 0]);
    await call('close', { fd: opened.fd });
  });
  it('显式读取不改变文件指针且多个描述符共享字节内容', () => {
    fs.writeFileSync(`${root}/file`, 'abc');
    const first = fs.openSync({ filePath: `${root}/file`, flag: 'r+' });
    const second = fs.openSync({ filePath: `${root}/file`, flag: 'r' });
    const target = new ArrayBuffer(1);
    fs.readSync({ fd: second, arrayBuffer: target, length: 1, position: 2 });
    fs.readSync({ fd: second, arrayBuffer: target, length: 1 });
    expect(Array.from(new Uint8Array(target))).toEqual([97]);
    fs.writeSync({ fd: first, data: new Uint8Array([0, 88, 99]).buffer, offset: 1, length: 1, position: 1 });
    fs.readSync({ fd: second, arrayBuffer: target, length: 1 });
    expect(Array.from(new Uint8Array(target))).toEqual([88]);
  });
  it('删除文件后已打开的描述符仍可使用且不重新创建路径', () => {
    fs.writeFileSync(`${root}/file`, 'abc');
    const fd = fs.openSync({ filePath: `${root}/file`, flag: 'r+' });
    fs.unlinkSync(`${root}/file`);
    fs.writeSync({ fd, data: 'X', position: 1 });
    expect(() => fs.accessSync(`${root}/file`)).toThrow();
    const target = new ArrayBuffer(3);
    fs.readSync({ fd, arrayBuffer: target, length: 3 });
    expect(Array.from(new Uint8Array(target))).toEqual([97, 88, 99]);
  });
  for (const digestAlgorithm of ['md5', 'sha1', 'sha256']) {
    it(`文件信息按 ${digestAlgorithm} 返回内容摘要`, async () => {
      const bytes = new Uint8Array([0, 128, 255, 65]);
      fs.writeFileSync(`${root}/file`, bytes.buffer);
      const result = (await call('getFileInfo', { filePath: `${root}/file`, digestAlgorithm })) as any;
      expect(result).toEqual({ errMsg: 'getFileInfo:ok', size: 4, digest: createHash(digestAlgorithm).update(bytes).digest('hex') });
    });
  }
  it('文件读取按字节区间截取后再进行字符解码', async () => {
    fs.writeFileSync(`${root}/file`, 'A中B');
    expect(fs.readFileSync(`${root}/file`, 'utf8', 1, 3)).toBe('中');
    expect(Array.from(new Uint8Array(fs.readFileSync(`${root}/file`, undefined, 4) as ArrayBuffer))).toEqual([66]);
    expect(((await call('readFile', { filePath: `${root}/file`, encoding: 'hex', position: 1, length: 3 })) as any).data).toBe('e4b8ad');
    expect(() => fs.readFileSync(`${root}/file`, 'utf8', -1)).toThrow();
  });
  it('目录递归状态读取保持文件类型与字节大小', () => {
    fs.mkdirSync(`${root}/dir/nested`, true);
    fs.writeFileSync(`${root}/dir/nested/file`, 'abc');
    const entries = fs.statSync(`${root}/dir`, true) as any[];
    expect(
      entries.map(entry => ({ path: entry.path.split('/').pop(), directory: entry.stats.isDirectory(), size: entry.stats.size }))
    ).toEqual([
      { path: 'nested', directory: true, size: 0 },
      { path: 'file', directory: false, size: 3 }
    ]);
  });
  it('保存临时文件后保留同步字节并移动原路径', async () => {
    await files.saveBlob('wxfile://tmp/source', new Blob([new Uint8Array([0, 128, 255])]));
    const result = await call('saveFile', { tempFilePath: 'wxfile://tmp/source' }) as any;
    expect(fs.readFileSync(result.savedFilePath, 'hex')).toBe('0080ff');
    expect(() => fs.accessSync('wxfile://tmp/source')).toThrow();
    await files.saveBlob('wxfile://tmp/second', new Blob(['sync']));
    const target = fs.saveFileSync('wxfile://tmp/second', `${root}/saved`);
    expect(target).toBe(`${root}/saved`);
    expect(fs.readFileSync(target, 'utf8')).toBe('sync');
  });
  it('目录重命名后保留子文件、字节缓存并移除旧路径', () => {
    fs.mkdirSync(`${root}/old`);
    fs.writeFileSync(`${root}/old/file`, new Uint8Array([0, 128, 255]).buffer);
    fs.renameSync(`${root}/old`, `${root}/new`);
    expect(fs.readdirSync(`${root}/new`)).toEqual(['file']);
    expect(fs.readFileSync(`${root}/new/file`, 'hex')).toBe('0080ff');
    expect(() => fs.accessSync(`${root}/old/file`)).toThrow();
  });
  it('文件与目录操作在路径缺失或类型不符时失败', () => {
    expect(() => fs.writeFileSync(`${root}/missing/file`, 'value')).toThrow();
    expect(() => fs.mkdirSync(`${root}/missing/child`)).toThrow();
    expect(() => fs.readdirSync(`${root}/missing`)).toThrow();
    expect(() => fs.unlinkSync(root)).toThrow();
    expect(() => fs.unlinkSync(`${root}/missing`)).toThrow();
  });
});
