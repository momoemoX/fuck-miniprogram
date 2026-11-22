import { describe, expect, it } from 'vitest';
import { encodePcm16, wavHeader } from '../../packages/engine/src/runtime/api/pcm-recorder';

describe('PCM 与 WAV 音频编码', () => {
  it('双声道采样按左右顺序交错为小端有符号 16 位数据并裁剪越界输入', () => {
    const bytes = encodePcm16([new Float32Array([-1, 0, 1, -2]), new Float32Array([0.5, -0.5, NaN, 2])], 2);
    const view = new DataView(bytes.buffer);
    expect(Array.from({ length: bytes.length / 2 }, (_, index) => view.getInt16(index * 2, true))).toEqual([-32768, 16383, 0, -16384, 32767, 0, -32768, 32767]);
  });

  it('单声道输入扩展为双声道时保持左右声音一致', () => {
    const bytes = encodePcm16([new Float32Array([0.5, -0.5])], 2);
    const view = new DataView(bytes.buffer);
    expect([0, 2, 4, 6].map(offset => view.getInt16(offset, true))).toEqual([16383, 16383, -16384, -16384]);
  });

  it('WAV 文件头记录实际音频长度、采样率、声道和每秒字节数', () => {
    const header = wavHeader(3200, 16000, 2), view = new DataView(header.buffer);
    expect(new TextDecoder().decode(header.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(header.subarray(8, 16))).toBe('WAVEfmt ');
    expect(view.getUint32(4, true)).toBe(3236);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(64000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(3200);
  });
});
