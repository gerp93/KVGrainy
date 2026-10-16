/**
 * How many format workers may run at once.
 *
 * A still is searched by one Web Worker per output format, in parallel. Each holds its own copy of the pixels and
 * its own scoring and codec memory (measured in Chromium at 12 MP: about 550 MB per worker, whatever the format),
 * so the workers' memory adds up. That is fine on a desktop and is how the search stays fast, but a phone gives
 * a tab far less. Running the workers one after another bounds the peak at one worker's. The result is the same
 * (each format's search is independent and the winner is picked afterwards); only the time changes.
 */

export interface DeviceHints {
  /** A phone or tablet, as far as the browser says. */
  mobile: boolean;
  /** `navigator.deviceMemory` in GB (Chromium only, rounded and capped at 8), when the browser reports it. */
  deviceMemoryGb?: number;
}

/** Images up to this many pixels run all workers at once on any device: their memory is modest. */
export const PARALLEL_PIXELS = 4_000_000;
/** Above this, even a desktop runs two workers at a time rather than all of them. */
export const DESKTOP_PARALLEL_PIXELS = 16_000_000;
/** A device reporting this much memory or less is treated as constrained, whatever its user agent says. */
export const LOW_MEMORY_GB = 4;

/** At least 1 and at most `formats`. */
export function workerLimit(pixels: number, formats: number, device: DeviceHints): number {
  const constrained = device.mobile || (device.deviceMemoryGb !== undefined && device.deviceMemoryGb <= LOW_MEMORY_GB);
  let limit = formats;
  if (pixels > PARALLEL_PIXELS && constrained) limit = 1;
  else if (pixels > DESKTOP_PARALLEL_PIXELS) limit = 2;
  return Math.max(1, Math.min(formats, limit));
}

/** What this browser says about the device it runs on. Absent or odd values mean "not constrained". */
export function readDeviceHints(nav: { userAgent?: string; userAgentData?: { mobile?: boolean }; deviceMemory?: number } = navigator): DeviceHints {
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? '');
  return { mobile, deviceMemoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined };
}
