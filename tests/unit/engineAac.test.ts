import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { adtsHeader, createAacExtractor, extractAdts } from '../../packages/engine/src/runtime/api/aac';

const nativeRecording = () => new Uint8Array(fs.readFileSync(path.resolve('tests/e2e/fixtures/native-aac-16k.mp4')));

const topBoxes = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: Array<{ type: string; start: number; end: number }> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    result.push({ type, start: offset, end: offset + length });
    offset += length;
  }
  return result;
};

describe('AAC 录音容器转换', () => {
  it('ADTS 文件头记录 AAC-LC、16kHz、双声道和包含文件头的帧长度', () => {
    expect(Array.from(adtsHeader({ objectType: 2, sampleRate: 16000, channels: 2 }, 6))).toEqual([255, 241, 96, 128, 1, 191, 252]);
  });

  it('浏览器实际录制的分片 MP4 提取所有 AAC 帧并保持编码数据不变', () => {
    const source = nativeRecording(), result = extractAdts(source);
    expect(result.sampleRate).toBe(16000); expect(result.channels).toBe(2); expect(result.frames).toBe(6);
    expect(result.data.byteLength).toBe(468);
    expect(result.data.subarray(7, 13)).toEqual(source.subarray(791, 797));
    let offset = 0, frames = 0;
    while (offset < result.data.length) {
      const data = result.data.subarray(offset);
      expect(data[0]).toBe(255); expect(data[1] & 240).toBe(240);
      const length = ((data[3] & 3) << 11) | (data[4] << 3) | (data[5] >> 5);
      expect(length).toBeGreaterThan(7); offset += length; frames++;
    }
    expect(offset).toBe(result.data.length); expect(frames).toBe(6);
  });

  it('流式提取器按初始化片段加数据片段顺序转换与整体提取等价', () => {
    const source = nativeRecording();
    // Chrome 分片 MP4 的实际片段结构：首片含 moov 初始化段和首个 moof+mdat，后续片段只有 moof+mdat
    const boxes = topBoxes(source), firstMoof = boxes.findIndex(box => box.type === 'moof');
    const fragments = [source.subarray(0, boxes[firstMoof + 1].end)];
    for (let index = firstMoof + 2; index < boxes.length; index += 2) {
      fragments.push(source.subarray(boxes[index].start, boxes[index + 1].end));
    }
    expect(fragments.length).toBeGreaterThan(2);
    const extractor = createAacExtractor();
    const parts: Uint8Array[] = []; let frames = 0, sampleRate = 0, channels = 0;
    for (const fragment of fragments) {
      const result = extractor.extract(fragment);
      if (result.frames) { parts.push(result.data); frames += result.frames; sampleRate = result.sampleRate; channels = result.channels; }
    }
    const whole = extractAdts(source);
    expect(frames).toBe(whole.frames); expect(sampleRate).toBe(whole.sampleRate); expect(channels).toBe(whole.channels);
    const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    expect(Array.from(data)).toEqual(Array.from(whole.data));
    // 未初始化就到来的数据片段必须失败，不能生成看似成功的音频
    expect(() => createAacExtractor().extract(fragments[1])).toThrow();
  });

  it('截断的 MP4 不生成看似成功的部分音频', () => {
    const source = nativeRecording();
    for (const length of [0, 4, 8, source.length - 1]) expect(() => extractAdts(source.subarray(0, length))).toThrow();
  });

  it('无法用 ADTS 表示的配置和超长帧明确失败', () => {
    expect(() => adtsHeader({ objectType: 5, sampleRate: 16000, channels: 2 }, 100)).toThrow();
    expect(() => adtsHeader({ objectType: 2, sampleRate: 12345, channels: 2 }, 100)).toThrow();
    expect(() => adtsHeader({ objectType: 2, sampleRate: 16000, channels: 0 }, 100)).toThrow();
    expect(() => adtsHeader({ objectType: 2, sampleRate: 16000, channels: 2 }, 8192)).toThrow();
  });
});
