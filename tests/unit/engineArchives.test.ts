import { brotliCompressSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { FsApi } from '../../packages/engine/src/runtime/api/fs';

let fs: any;
const root = 'wxfile://usr';
const archive =
  'UEsDBBQAAAAIAO5icl2GphA2BwAAAAUAAAAJAAAAZGlyL2EudHh0y0jNyckHAFBLAwQUAAAACADuYnJd1K7A6QUAAAADAAAABwAAAHJhdy5iaW5jaPgPAFBLAQIUAxQAAAAIAO5icl2GphA2BwAAAAUAAAAJAAAAAAAAAAAAAACAAQAAAABkaXIvYS50eHRQSwECFAMUAAAACADuYnJd1K7A6QUAAAADAAAABwAAAAAAAAAAAAAAgAEuAAAAcmF3LmJpblBLBQYAAAAAAgACAGwAAABYAAAAAAA=';
beforeEach(() => {
  fs = new FsApi({} as any).api().getFileSystemManager();
});

function call(name: string, options: any): Promise<any> {
  return new Promise((resolve, reject) => fs[name]({ ...options, success: resolve, fail: reject }));
}

describe('压缩文件读取', () => {
  it('Brotli 同步与异步读取返回原始字节', async () => {
    const bytes = new TextEncoder().encode('hello 世界\u0000'.repeat(100));
    const compressed = new Uint8Array(brotliCompressSync(bytes));
    fs.writeFileSync(`${root}/file.br`, compressed.buffer);
    const options = { filePath: `${root}/file.br`, compressionAlgorithm: 'br' };
    expect(Array.from(new Uint8Array(fs.readCompressedFileSync(options)))).toEqual(Array.from(bytes));
    expect(Array.from(new Uint8Array(((await call('readCompressedFile', options)) as any).data))).toEqual(Array.from(bytes));
  });
  it('压缩文件在算法不支持或内容损坏时失败', async () => {
    fs.writeFileSync(`${root}/file.br`, 'invalid compressed data');
    expect(() => fs.readCompressedFileSync({ filePath: `${root}/file.br`, compressionAlgorithm: 'unknown' })).toThrow();
    await expect(call('readCompressedFile', { filePath: `${root}/file.br`, compressionAlgorithm: 'br' })).rejects.toMatchObject({
      errMsg: expect.stringContaining(':fail')
    });
  });
  it('ZIP 可以选择编码读取指定条目且报告缺失条目', async () => {
    fs.writeFileSync(`${root}/archive.zip`, archive, 'base64');
    const result = (await call('readZipEntry', {
      filePath: `${root}/archive.zip`,
      entries: [{ path: 'dir/a.txt', encoding: 'utf8' }, { path: 'raw.bin' }, { path: 'missing' }]
    })) as any;
    expect(result.entries['dir/a.txt'].data).toBe('hello');
    expect(Array.from(new Uint8Array(result.entries['raw.bin'].data))).toEqual([0, 128, 255]);
    expect(result.entries.missing.errMsg).toContain(':fail');
  });
  it('ZIP 解压后保留目录结构并可立即同步读取', async () => {
    fs.writeFileSync(`${root}/archive.zip`, archive, 'base64');
    await call('unzip', { zipFilePath: `${root}/archive.zip`, targetPath: `${root}/output` });
    expect(fs.readFileSync(`${root}/output/dir/a.txt`, 'utf8')).toBe('hello');
    expect(fs.readFileSync(`${root}/output/raw.bin`, 'hex')).toBe('0080ff');
    const result = (await call('readZipEntry', { filePath: `${root}/archive.zip`, entries: 'all', encoding: 'hex' })) as any;
    expect(result.entries['dir/a.txt'].data).toBe('68656c6c6f');
  });
});
