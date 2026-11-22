import { describe, expect, it } from 'vitest';
import { fileBytes, fileData, type Encoding } from '../../packages/engine/src/runtime/api/file-codecs';

describe('文件字符编码', () => {
  for (const encoding of [
    'utf8',
    'utf-8',
    'latin1',
    'binary',
    'ascii',
    'ucs2',
    'ucs-2',
    'utf16le',
    'utf-16le',
    'hex',
    'base64'
  ] as Encoding[]) {
    it(`文件以 ${encoding} 写入和读取时保持字节与编码契约`, () => {
      const value = encoding === 'base64' ? 'AP+AQQ==' : encoding === 'hex' ? '00ff8041zz99' : 'Aé中😀\ufeff\ud800';
      const expected = Buffer.from(value, encoding as BufferEncoding);
      expect(Array.from(fileBytes(value, encoding))).toEqual(Array.from(expected));
      expect(fileData(new Uint8Array(expected), encoding)).toBe(expected.toString(encoding as BufferEncoding));
    });
  }
  it('文件读取原始字节时返回副本并保留视图的有效范围', () => {
    const buffer = new Uint8Array([9, 0, 128, 255, 8]);
    const bytes = fileBytes(buffer.subarray(1, 4));
    const read = new Uint8Array(fileData(bytes) as ArrayBuffer);
    read[0] = 7;
    expect(Array.from(bytes)).toEqual([0, 128, 255]);
    expect(Array.from(buffer)).toEqual([9, 0, 128, 255, 8]);
  });
  it('文件解析 base64 时接受空白与 URL 字母表', () => {
    expect(Array.from(fileBytes(' A P - _ \n', 'base64'))).toEqual(Array.from(Buffer.from(' A P - _ \n', 'base64')));
  });
  it('文件转换大二进制内容时不超过调用栈限制', () => {
    const bytes = Uint8Array.from({ length: 200000 }, (_, index) => index & 255);
    expect(fileData(bytes, 'base64')).toBe(Buffer.from(bytes).toString('base64'));
  });
});
