import { describe, expect, it } from 'vitest';
import { DESKTOP_PARALLEL_PIXELS, PARALLEL_PIXELS, readDeviceHints, workerLimit } from '../src/engine/parallelism';

const desktop = { mobile: false };
const phone = { mobile: true };

describe('how many format workers run at once', () => {
  it('runs every worker for a small image on any device', () => {
    expect(workerLimit(2_000_000, 4, desktop)).toBe(4);
    expect(workerLimit(PARALLEL_PIXELS, 4, phone)).toBe(4);
  });
  it('runs one at a time for a large image on a phone', () => {
    expect(workerLimit(PARALLEL_PIXELS + 1, 4, phone)).toBe(1);
    expect(workerLimit(12_000_000, 3, phone)).toBe(1);
  });
  it('treats a low-memory device as constrained even when it does not look like a phone', () => {
    expect(workerLimit(12_000_000, 4, { mobile: false, deviceMemoryGb: 4 })).toBe(1);
    expect(workerLimit(12_000_000, 4, { mobile: false, deviceMemoryGb: 8 })).toBe(4);
    expect(workerLimit(12_000_000, 4, { mobile: false, deviceMemoryGb: undefined })).toBe(4);
  });
  it('leaves a desktop alone until an image is very large, then runs two at a time', () => {
    expect(workerLimit(12_000_000, 4, desktop)).toBe(4);
    expect(workerLimit(DESKTOP_PARALLEL_PIXELS, 4, desktop)).toBe(4);
    expect(workerLimit(DESKTOP_PARALLEL_PIXELS + 1, 4, desktop)).toBe(2);
  });
  it('never asks for fewer than one or more than there are formats', () => {
    expect(workerLimit(30_000_000, 1, desktop)).toBe(1);
    expect(workerLimit(1_000, 0, desktop)).toBe(1);
    expect(workerLimit(1_000, 2, desktop)).toBe(2);
  });
});

describe('reading the device', () => {
  it('trusts userAgentData when the browser has it', () => {
    expect(readDeviceHints({ userAgentData: { mobile: true }, userAgent: 'Mozilla/5.0 (X11; Linux)' }).mobile).toBe(true);
    expect(readDeviceHints({ userAgentData: { mobile: false }, userAgent: 'Mobile' }).mobile).toBe(false);
  });
  it('falls back to the user agent (Safari has no userAgentData)', () => {
    expect(readDeviceHints({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' }).mobile).toBe(true);
    expect(readDeviceHints({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36' }).mobile).toBe(true);
    expect(readDeviceHints({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36' }).mobile).toBe(false);
    expect(readDeviceHints({}).mobile).toBe(false);
  });
  it('reports device memory only when the browser gives a number', () => {
    expect(readDeviceHints({ deviceMemory: 2 }).deviceMemoryGb).toBe(2);
    expect(readDeviceHints({}).deviceMemoryGb).toBeUndefined();
  });
});
