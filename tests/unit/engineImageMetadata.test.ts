import { describe, expect, it } from 'vitest';
import { png } from '../helpers';
import { readImageMetadata } from '../../packages/engine/src/runtime/api/image-metadata';

function tiff(orientation: number, little: boolean) {
  const bytes = new Uint8Array(50);
  const view = new DataView(bytes.buffer);
  bytes.set(little ? [73, 73] : [77, 77]);
  view.setUint16(2, 42, little);
  view.setUint32(4, 8, little);
  view.setUint16(8, 3, little);
  for (const [index, tag, value] of [
    [0, 0x100, 40],
    [1, 0x101, 20],
    [2, 0x112, orientation]
  ]) {
    const position = 10 + index * 12;
    view.setUint16(position, tag, little);
    view.setUint16(position + 2, 3, little);
    view.setUint32(position + 4, 1, little);
    view.setUint16(position + 8, value, little);
  }
  return bytes;
}

function jpeg(orientation: number, little: boolean) {
  const exif = tiff(orientation, little);
  const bytes = new Uint8Array(2 + 4 + 6 + exif.length + 13 + 2);
  bytes.set([255, 216, 255, 225, 0, exif.length + 8, 69, 120, 105, 102, 0, 0]);
  bytes.set(exif, 12);
  // SOF2 gives coded dimensions; Exif width/height above must not replace them.
  bytes.set([255, 194, 0, 11, 8, 0, 3, 0, 7, 1, 1, 17, 0, 255, 217], 12 + exif.length);
  return bytes;
}

describe('图片文件元数据', () => {
  for (const little of [false, true]) {
    for (const [index, orientation] of [
      'up',
      'up-mirrored',
      'down',
      'down-mirrored',
      'left-mirrored',
      'right',
      'right-mirrored',
      'left'
    ].entries()) {
      it(`JPEG 的 ${little ? '小端' : '大端'} EXIF 方向 ${index + 1} 保留编码宽高`, () => {
        expect(readImageMetadata(jpeg(index + 1, little))).toEqual({ type: 'jpeg', width: 7, height: 3, orientation });
      });
    }
  }

  it('TIFF 从首个 IFD 读取尺寸和方向', () => {
    expect(readImageMetadata(tiff(6, true))).toEqual({ type: 'tiff', width: 40, height: 20, orientation: 'right' });
  });

  it('PNG 和 GIF 使用文件内容识别格式及原始尺寸', () => {
    expect(readImageMetadata(png(3, 2))).toEqual({ type: 'png', width: 3, height: 2, orientation: 'up' });
    expect(readImageMetadata(new Uint8Array([71, 73, 70, 56, 57, 97, 4, 0, 5, 0]))).toEqual({
      type: 'gif',
      width: 4,
      height: 5,
      orientation: 'up'
    });
  });

  it('JPEG 跳过非 EXIF APP1 和无长度标记并且保留视图边界', () => {
    const source = jpeg(8, true);
    const extra = new Uint8Array([255, 225, 0, 5, 1, 2, 3, 255, 1, 255]);
    const wrapped = new Uint8Array(source.length + extra.length + 4);
    wrapped.set(source.slice(0, 2), 2);
    wrapped.set(extra, 4);
    wrapped.set(source.slice(2), 4 + extra.length);
    expect(readImageMetadata(wrapped.subarray(2, wrapped.length - 2))).toEqual({ type: 'jpeg', width: 7, height: 3, orientation: 'left' });
  });

  it('损坏偏移、非法方向和截断文件不会越界读取', () => {
    const invalid = tiff(9, false);
    new DataView(invalid.buffer).setUint32(4, 0xffffffff);
    expect(readImageMetadata(invalid)).toEqual({ type: 'tiff', orientation: 'up' });
    expect(readImageMetadata(jpeg(99, true))).toEqual({ type: 'jpeg', width: 7, height: 3, orientation: 'up' });
    for (let length = 0; length < 65; length++) expect(() => readImageMetadata(jpeg(6, true).slice(0, length))).not.toThrow();
    expect(readImageMetadata(new Uint8Array([0, 1, 2]))).toEqual({ type: 'unknown', orientation: 'up' });
  });
});
