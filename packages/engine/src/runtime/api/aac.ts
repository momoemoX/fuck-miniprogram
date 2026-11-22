interface AacConfig { objectType: number; sampleRate: number; channels: number }
interface Box { type: string; start: number; data: number; end: number }
const sampleRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export function adtsHeader(config: AacConfig, payload: number): Uint8Array<ArrayBuffer> {
  const frequency = sampleRates.indexOf(config.sampleRate), length = payload + 7;
  if (config.objectType < 1 || config.objectType > 4 || frequency < 0 || config.channels < 1 || config.channels > 7 || length > 8191 || payload < 0) throw new Error('unsupported ADTS audio configuration');
  return new Uint8Array([255, 241, ((config.objectType - 1) << 6) | (frequency << 2) | (config.channels >> 2), ((config.channels & 3) << 6) | (length >> 11), (length >> 3) & 255, ((length & 7) << 5) | 31, 252]);
}

/**
 * 读取 AAC 配置、分片 MP4 样本并输出 ADTS。当前针对浏览器录音产生的分片 MP4：
 * Chrome 的 MediaRecorder 先发一次含 moov 的初始化片段，后续片段只有 moof + mdat，
 * 因此跨片段的流式提取用 createAacExtractor 缓存轨道配置，一次性转换用 extractAdts。
 */
export function createAacExtractor() {
  let config: AacConfig | null = null;
  let trackId = 0;
  let defaultSize = 0;

  const extract = (bytes: Uint8Array): { data: Uint8Array<ArrayBuffer>; sampleRate: number; channels: number; frames: number } => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (offset: number) => view.getUint32(offset);
    const u64 = (offset: number) => {
      const value = u32(offset) * 4294967296 + u32(offset + 4);
      if (!Number.isSafeInteger(value)) throw new Error('MP4 offset exceeds supported range');
      return value;
    };
    const text = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const boxes = (start: number, end: number): Box[] => {
      const result: Box[] = [];
      while (start < end) {
        if (start + 8 > end) throw new Error('truncated MP4 box');
        const type = text(start + 4), shortSize = u32(start), header = shortSize === 1 ? 16 : 8;
        if (start + header > end) throw new Error('truncated MP4 box header');
        const length = shortSize === 0 ? end - start : shortSize === 1 ? u64(start + 8) : shortSize;
        if (length < header || length > end - start) throw new Error('invalid MP4 box length');
        result.push({ type, start, data: start + header, end: start + length }); start += length;
      }
      return result;
    };
    const child = (parent: Box, type: string) => {
      const result = boxes(parent.data, parent.end).find(box => box.type === type);
      if (!result) throw new Error(`MP4 ${type} box not found`);
      return result;
    };
    const descriptor = (offset: number, end: number) => {
      if (offset >= end) throw new Error('missing MPEG-4 audio descriptor');
      const tag = bytes[offset++]; let length = 0, count = 0, next: number;
      do {
        if (offset >= end || count++ === 4) throw new Error('invalid MPEG-4 audio descriptor length');
        next = bytes[offset++]; length = length * 128 + (next & 127);
      } while (next & 128);
      if (length > end - offset) throw new Error('truncated MPEG-4 audio descriptor');
      return { tag, data: offset, end: offset + length };
    };

    const top = boxes(0, bytes.length), moov = top.find(box => box.type === 'moov');
    if (moov) {
      const track = boxes(moov.data, moov.end).find(box => box.type === 'trak' && text(child(child(box, 'mdia'), 'hdlr').data + 8) === 'soun');
      if (!track) throw new Error('AAC audio track not found');
      const tkhd = child(track, 'tkhd');
      trackId = u32(tkhd.data + (bytes[tkhd.data] === 1 ? 20 : 12));
      const stsd = child(child(child(child(track, 'mdia'), 'minf'), 'stbl'), 'stsd');
      const entry = boxes(stsd.data + 8, stsd.end).find(box => box.type === 'mp4a');
      if (!entry) throw new Error('MP4 track is not AAC');
      const esds = boxes(entry.data + 28, entry.end).find(box => box.type === 'esds');
      if (!esds) throw new Error('AAC decoder configuration not found');
      const es = descriptor(esds.data + 4, esds.end);
      if (es.tag !== 3 || es.data + 3 > es.end) throw new Error('invalid AAC elementary stream descriptor');
      const flags = bytes[es.data + 2]; let cursor = es.data + 3;
      if (flags & 128) cursor += 2;
      if (flags & 64) cursor += 1 + bytes[cursor];
      if (flags & 32) cursor += 2;
      const decoder = descriptor(cursor, es.end);
      if (decoder.tag !== 4 || decoder.data + 13 > decoder.end || bytes[decoder.data] !== 64) throw new Error('unsupported AAC decoder');
      const specific = descriptor(decoder.data + 13, decoder.end);
      if (specific.tag !== 5 || specific.end - specific.data < 2) throw new Error('invalid AAC audio configuration');
      const first = bytes[specific.data], second = bytes[specific.data + 1];
      config = { objectType: first >> 3, sampleRate: sampleRates[((first & 7) << 1) | (second >> 7)] ?? 0, channels: (second >> 3) & 15 };
      if (second & 4) throw new Error('AAC 960-sample frames are not supported');
      adtsHeader(config, 0);
      defaultSize = 0;
      const mvex = boxes(moov.data, moov.end).find(box => box.type === 'mvex');
      if (mvex) {
        const trex = boxes(mvex.data, mvex.end).find(box => box.type === 'trex' && u32(box.data + 4) === trackId);
        if (trex) defaultSize = u32(trex.data + 16);
      }
    }
    if (!config) throw new Error('AAC recording has no MP4 initialization');

    const media = top.filter(box => box.type === 'mdat'), parts: Uint8Array[] = []; let length = 0, frames = 0;
    for (const moof of top.filter(box => box.type === 'moof')) {
      for (const traf of boxes(moof.data, moof.end).filter(box => box.type === 'traf')) {
        const tfhd = child(traf, 'tfhd');
        if (u32(tfhd.data + 4) !== trackId) continue;
        const flags = u32(tfhd.data) & 16777215; let cursor = tfhd.data + 8, base = moof.start, size = defaultSize;
        if (flags & 1) { base = u64(cursor); cursor += 8; }
        if (flags & 2) cursor += 4;
        if (flags & 8) cursor += 4;
        if (flags & 16) { size = u32(cursor); cursor += 4; }
        let offset = media.find(box => box.start >= moof.end)?.data ?? -1;
        for (const run of boxes(traf.data, traf.end).filter(box => box.type === 'trun')) {
          const flags = u32(run.data) & 16777215, count = u32(run.data + 4); let cursor = run.data + 8;
          if (flags & 1) { offset = base + view.getInt32(cursor); cursor += 4; }
          if (flags & 4) cursor += 4;
          if (count > bytes.length) throw new Error('invalid AAC sample count');
          for (let index = 0; index < count; index++) {
            if (flags & 256) cursor += 4;
            let sampleSize = size;
            if (flags & 512) { sampleSize = u32(cursor); cursor += 4; }
            if (flags & 1024) cursor += 4;
            if (flags & 2048) cursor += 4;
            if (cursor > run.end || sampleSize <= 0 || !media.some(box => offset >= box.data && sampleSize <= box.end - offset)) throw new Error('truncated AAC sample');
            const header = adtsHeader(config, sampleSize), sample = bytes.subarray(offset, offset + sampleSize);
            parts.push(header, sample); length += header.length + sampleSize; offset += sampleSize; frames++;
          }
        }
      }
    }
    const data = new Uint8Array(length); let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    return { data, sampleRate: config.sampleRate, channels: config.channels, frames };
  };

  return { extract };
}

export function extractAdts(bytes: Uint8Array): { data: Uint8Array<ArrayBuffer>; sampleRate: number; channels: number; frames: number } {
  const result = createAacExtractor().extract(bytes);
  if (!result.frames) throw new Error('AAC recording contains no audio frames');
  return result;
}
