import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const chunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
};

/** A photo-like RGB(A) PNG made without any image library: smooth gradients plus a little noise. */
export function photoPng(width: number, height: number, alpha = false): Buffer {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * channels + 1) * height);
  let seed = 4242;
  for (let y = 0; y < height; y++) {
    const row = y * (width * channels + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed >>> 24) % 14;
      const o = row + 1 + x * channels;
      raw[o] = Math.min(255, 30 + (x * 190) / width + noise);
      raw[o + 1] = Math.min(255, 50 + (y * 160) / height + noise);
      raw[o + 2] = Math.min(255, 110 + ((x + y) * 70) / (width + height) + noise);
      if (alpha) raw[o + 3] = Math.round((x / width) * 255);
    }
  }
  const ihdr = Buffer.concat([u32(width), u32(height), Uint8Array.of(8, alpha ? 6 : 2, 0, 0, 0)]);
  return Buffer.concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}
