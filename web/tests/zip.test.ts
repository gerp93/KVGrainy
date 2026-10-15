import { describe, expect, it } from 'vitest';
import { buildZip, crc32, uniqueNames } from '../src/engine/zip';

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('uniqueNames', () => {
  it('numbers repeats before the extension', () => {
    expect(uniqueNames(['a.gif', 'b.gif', 'a.gif', 'a.gif', 'noext', 'noext'])).toEqual(['a.gif', 'b.gif', 'a (2).gif', 'a (3).gif', 'noext', 'noext (2)']);
  });
});

/** Read a stored ZIP back through its central directory, as an unzipper would. */
function readZip(zip: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength));
    expect(view.getUint32(localAt, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localAt + 26, true);
    const start = localAt + 30 + localNameLength;
    out.push({ name, crc, data: zip.subarray(start, start + size) });
    at += 46 + nameLength;
  }
  return out;
}

describe('buildZip', () => {
  const files = [
    { name: 'one.gif', data: Uint8Array.from([1, 2, 3, 4, 5]) },
    { name: 'two.gif', data: new Uint8Array(1000).fill(7) },
    { name: 'one.gif', data: Uint8Array.from([9]) },
    { name: 'naïve ✓.gif', data: Uint8Array.from([42]) },
  ];
  const entries = readZip(buildZip(files));

  it('round-trips every file through the central directory', () => {
    expect(entries).toHaveLength(4);
    expect([...entries[0]!.data]).toEqual([1, 2, 3, 4, 5]);
    expect(entries[1]!.data).toHaveLength(1000);
    expect([...entries[3]!.data]).toEqual([42]);
  });
  it('keeps names unique and UTF-8', () => {
    expect(entries.map((e) => e.name)).toEqual(['one.gif', 'two.gif', 'one (2).gif', 'naïve ✓.gif']);
  });
  it('stores a correct CRC for each file', () => {
    for (const e of entries) expect(e.crc).toBe(crc32(e.data));
  });
  it('writes an empty archive that is just the end record', () => {
    expect(buildZip([])).toHaveLength(22);
  });
});
