const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const constants = Int32Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000));

function md5(input: Uint8Array) {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const data = new DataView(padded.buffer);
  data.setUint32(padded.length - 8, (input.length * 8) >>> 0, true);
  data.setUint32(padded.length - 4, Math.floor(input.length / 0x20000000), true);
  const state = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  for (let offset = 0; offset < padded.length; offset += 64) {
    let [a, b, c, d] = state;
    for (let index = 0; index < 64; index++) {
      const round = index >>> 4;
      const value = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const word = round === 0 ? index : round === 1 ? (5 * index + 1) % 16 : round === 2 ? (3 * index + 5) % 16 : (7 * index) % 16;
      const sum = (a + value + constants[index] + data.getInt32(offset + word * 4, true)) | 0;
      const shift = shifts[round * 4 + (index % 4)];
      const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
  }
  const output = new Uint8Array(16);
  const words = new DataView(output.buffer);
  state.forEach((value, index) => words.setInt32(index * 4, value, true));
  return output;
}

export async function fileDigest(bytes: Uint8Array, algorithm = 'md5') {
  let digest: Uint8Array;
  if (algorithm === 'md5') digest = md5(bytes);
  else if (algorithm === 'sha1' || algorithm === 'sha256') {
    digest = new Uint8Array(await crypto.subtle.digest(algorithm === 'sha1' ? 'SHA-1' : 'SHA-256', bytes.slice().buffer));
  } else throw new Error(`unsupported digest algorithm ${algorithm}`);
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
