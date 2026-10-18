import { describe, expect, it } from 'vitest';
import { explainLoadError, looksLikeMedia, skippedMessage } from '../src/engine/inputErrors';
import { applyLaunchHeaders } from '../scripts/launch-headers.mjs';

const file = (name: string, type = '', size = 1000) => ({ name, type, size });

describe('which dropped files are tried', () => {
  it('accepts images and clips by type, or by extension when the type is empty', () => {
    expect(looksLikeMedia(file('a.jpg', 'image/jpeg'))).toBe(true);
    expect(looksLikeMedia(file('clip.mkv'))).toBe(true);
    expect(looksLikeMedia(file('IMG_0001.HEIC'))).toBe(true); // empty type in Chrome: still gets a card and a message
  });
  it('rejects documents and unknown files', () => {
    expect(looksLikeMedia(file('notes.txt', 'text/plain'))).toBe(false);
    expect(looksLikeMedia(file('paper.pdf', 'application/pdf'))).toBe(false);
    expect(looksLikeMedia(file('noextension'))).toBe(false);
  });
});

describe('the message for skipped files', () => {
  it('names a single file', () => {
    expect(skippedMessage([file('notes.txt')])).toBe('"notes.txt" is not an image or a clip, so it was skipped.');
  });
  it('lists a few and counts the rest', () => {
    const many = ['a.txt', 'b.pdf', 'c.zip', 'd.doc', 'e.doc'].map((n) => file(n));
    expect(skippedMessage(many)).toBe('Skipped 5 files that are not images or clips: a.txt, b.pdf, c.zip and 2 more.');
  });
});

describe('explaining why a file would not open', () => {
  const decode = new DOMException('The source image could not be decoded.', 'InvalidStateError');
  it('says an empty file is empty, not "ImageDecoder"', () => {
    const raw = new TypeError("Failed to construct 'ImageDecoder': No image data provided");
    expect(explainLoadError(raw, file('empty.png', 'image/png', 0))).toMatch(/empty/);
  });
  it('explains HEIC, which Chrome and Firefox cannot open', () => {
    expect(explainLoadError(decode, file('IMG.HEIC', '', 3_000_000))).toMatch(/HEIC.*JPEG/);
    expect(explainLoadError(decode, file('IMG.jpg', 'image/heic', 3_000_000))).toMatch(/HEIC/);
  });
  it('gives a plain message for any other file that will not decode', () => {
    const msg = explainLoadError(decode, file('broken.jpg', 'image/jpeg'));
    expect(msg).toMatch(/could not be read as an image/);
    expect(msg).not.toMatch(/decoded/);
  });
  it('leaves other errors alone, such as the size cap and search failures', () => {
    expect(explainLoadError(new Error('This image is 54 megapixels. The browser version handles up to 24'), file('big.png', 'image/png'))).toMatch(/54 megapixels/);
    expect(explainLoadError(new Error('worker crashed'), file('a.jpg', 'image/jpeg'))).toBe('worker crashed');
  });
});

describe('launch headers', () => {
  const base = "/*\n  Content-Security-Policy: default-src 'self'\n  X-Content-Type-Options: nosniff\n";
  it('adds noindex before launch', () => {
    const out = applyLaunchHeaders(base, false);
    expect(out).toContain('X-Robots-Tag: noindex');
    expect(out).toContain('Content-Security-Policy');
  });
  it('leaves noindex out of a launch build, even if the source file had it', () => {
    expect(applyLaunchHeaders(base, true)).not.toMatch(/robots/i);
    expect(applyLaunchHeaders(base + '  X-Robots-Tag: noindex\n', true)).not.toMatch(/robots/i);
  });
  it('never doubles the header and keeps the policy lines inside the /* block', () => {
    const once = applyLaunchHeaders(base, false);
    expect(applyLaunchHeaders(once, false).match(/X-Robots-Tag/g)).toHaveLength(1);
    expect(once.split('\n').slice(0, 4).join('\n')).toContain('X-Robots-Tag');
  });
  it('fails loudly if the file has no /* block', () => {
    expect(() => applyLaunchHeaders('/foo\n  A: b\n', false)).toThrow(/no "\/\*" block/);
  });
});
