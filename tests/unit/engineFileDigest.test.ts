import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileDigest } from '../../packages/engine/src/runtime/api/file-digest';

describe('文件摘要', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 100000]) {
    it(`MD5 对 ${length} 字节内容按标准填充并生成摘要`, async () => {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) & 255);
      expect(await fileDigest(bytes)).toBe(createHash('md5').update(bytes).digest('hex'));
    });
  }
  it('不支持的摘要算法通过失败路径返回', async () => {
    await expect(fileDigest(new Uint8Array(), 'unknown')).rejects.toThrow('unsupported digest algorithm');
  });
});
