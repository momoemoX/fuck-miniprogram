export type Encoding = 'utf8' | 'utf-8' | 'ascii' | 'base64' | 'binary' | 'hex' | 'ucs2' | 'ucs-2' | 'utf16le' | 'utf-16le' | 'latin1';

function format(encoding: string) {
  const name = String(encoding).toLowerCase().replace(/-/g, '');
  if (name === 'ucs2') return 'utf16le';
  if (name === 'binary') return 'latin1';
  if (['utf8', 'ascii', 'base64', 'hex', 'utf16le', 'latin1'].includes(name)) return name;
  throw new Error(`Unknown encoding: ${encoding}`);
}

export function fileBytes(data: string | ArrayBuffer | ArrayBufferView, encoding: Encoding = 'utf8'): Uint8Array<ArrayBuffer> {
  if (typeof data !== 'string') {
    return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
  }
  const name = format(encoding);
  if (name === 'utf8') return new TextEncoder().encode(data);
  if (name === 'base64') {
    let text = data
      .split('=', 1)[0]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^a-z0-9+/]/gi, '');
    if (text.length % 4 === 1) text = text.slice(0, -1);
    text = text.padEnd(Math.ceil(text.length / 4) * 4, '=');
    return Uint8Array.from(atob(text), letter => letter.charCodeAt(0));
  }
  if (name === 'hex') {
    const bytes: number[] = [];
    for (let index = 0; index + 1 < data.length; index += 2) {
      const pair = data.slice(index, index + 2);
      if (!/^[a-f0-9]{2}$/i.test(pair)) break;
      bytes.push(parseInt(pair, 16));
    }
    return new Uint8Array(bytes);
  }
  const bytes = new Uint8Array(data.length * (name === 'utf16le' ? 2 : 1));
  for (let index = 0; index < data.length; index++) {
    const code = data.charCodeAt(index);
    if (name === 'utf16le') {
      bytes[index * 2] = code & 255;
      bytes[index * 2 + 1] = code >>> 8;
    } else bytes[index] = code & 255;
  }
  return bytes;
}

export function fileData(bytes: Uint8Array, encoding?: Encoding): string | ArrayBuffer {
  if (!encoding) return bytes.slice().buffer;
  const name = format(encoding);
  if (name === 'utf8') return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
  if (name === 'hex') return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 0x8000) {
    const codes: number[] = [];
    const end = Math.min(bytes.length, start + 0x8000);
    for (let index = start; index < end; index++) {
      if (name === 'utf16le') {
        if (index + 1 < end) codes.push(bytes[index] | (bytes[++index] << 8));
      } else codes.push(name === 'ascii' ? bytes[index] & 127 : bytes[index]);
    }
    chunks.push(String.fromCharCode(...codes));
  }
  const text = chunks.join('');
  return name === 'base64' ? btoa(text) : text;
}
