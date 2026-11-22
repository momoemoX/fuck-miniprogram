const orientations = ['up', 'up-mirrored', 'down', 'down-mirrored', 'left-mirrored', 'right', 'right-mirrored', 'left'] as const;

interface ImageMetadata {
  type: 'unknown' | 'jpeg' | 'png' | 'gif' | 'tiff';
  orientation: (typeof orientations)[number];
  width?: number;
  height?: number;
}

export function readImageMetadata(bytes: Uint8Array): ImageMetadata {
  const result: ImageMetadata = { type: 'unknown', orientation: 'up' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = (position: number, values: number[]) => values.every((value, index) => bytes[position + index] === value);
  const isTiff = (base: number) => signature(base, [73, 73, 42, 0]) || signature(base, [77, 77, 0, 42]);
  const readTiff = (base: number, end: number, dimensions = false) => {
    if (base + 8 > end || !isTiff(base)) return;
    const little = bytes[base] === 73;
    const offset = view.getUint32(base + 4, little);
    const directory = base + offset;
    if (offset < 8 || directory + 2 > end) return;
    const entries = Math.min(view.getUint16(directory, little), Math.floor((end - directory - 2) / 12));
    for (let index = 0; index < entries; index++) {
      const entry = directory + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      if ((type !== 3 && type !== 4) || view.getUint32(entry + 4, little) !== 1) continue;
      const value = type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
      if (tag === 0x112 && type === 3 && value >= 1 && value <= 8) result.orientation = orientations[value - 1];
      if (dimensions && value > 0 && tag === 0x100) result.width = value;
      if (dimensions && value > 0 && tag === 0x101) result.height = value;
    }
  };

  if (signature(0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    result.type = 'png';
    if (bytes.length >= 24 && signature(12, [73, 72, 68, 82])) {
      result.width = view.getUint32(16);
      result.height = view.getUint32(20);
    }
    for (let position = 8; position + 12 <= bytes.length;) {
      const length = view.getUint32(position);
      if (position + length + 12 > bytes.length) break;
      if (signature(position + 4, [101, 88, 73, 102])) readTiff(position + 8, position + 8 + length);
      position += length + 12;
    }
  } else if (signature(0, [71, 73, 70, 56, 55, 97]) || signature(0, [71, 73, 70, 56, 57, 97])) {
    result.type = 'gif';
    if (bytes.length >= 10) {
      result.width = view.getUint16(6, true);
      result.height = view.getUint16(8, true);
    }
  } else if (isTiff(0)) {
    result.type = 'tiff';
    readTiff(0, bytes.length, true);
  } else if (signature(0, [255, 216])) {
    result.type = 'jpeg';
    let width: number | undefined, height: number | undefined;
    for (let position = 2; position + 1 < bytes.length;) {
      if (bytes[position++] !== 255) break;
      while (bytes[position] === 255) position++;
      const marker = bytes[position++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (position + 2 > bytes.length) break;
      const length = view.getUint16(position);
      if (length < 2 || position + length > bytes.length) break;
      const payload = position + 2;
      if (marker === 0xe1 && length >= 16 && signature(payload, [69, 120, 105, 102, 0, 0])) readTiff(payload + 6, position + length);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && length >= 8) {
        height = view.getUint16(payload + 1);
        width = view.getUint16(payload + 3);
      }
      position += length;
    }
    if (width && height) {
      result.width = width;
      result.height = height;
    }
  }
  return result;
}
