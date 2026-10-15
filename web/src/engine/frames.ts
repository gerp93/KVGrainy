/**
 * Turn an animated image or a video into a list of RGBA frames with delays, using only
 * browser decoders (ImageDecoder for animated GIF/WebP, a <video> element for clips).
 * Same idea as the desktop engine: both sources end up as one frames-and-durations
 * shape that a single GIF-fitting search consumes.
 */

export interface FrameSource {
  kind: 'animation';
  origin: 'image' | 'video';
  width: number;
  height: number;
  /** Tightly packed RGBA, one entry per frame, all `width` x `height`. */
  frames: Uint8ClampedArray[];
  /** Milliseconds each frame is shown. */
  delays: number[];
  hasAlpha: boolean;
  /** GIF loop setting to write back: 0 forever, -1 play once, n repeat n times. */
  repeat: number;
  /** Video only: length of the whole clip in seconds, so the UI can offer a sensible trim range. */
  sourceSeconds?: number;
  /** Set when frames were shrunk to fit memory, so the UI can say so. */
  note?: string;
}

/** Video sampling options, as `--fps`, `--start` and `--end` on the desktop CLI. */
export interface VideoOptions {
  /** Frames per second to sample at (default {@link VIDEO_FPS}). */
  fps?: number;
  /** Seconds into the clip to start at. */
  start?: number;
  /** Seconds into the clip to stop at. */
  end?: number;
}

/** Working-set limits, so a long or large clip can't take the tab down. */
const MAX_TOTAL_PIXELS = 80_000_000;
const MAX_EDGE = 1280;
export const VIDEO_FPS = 12;
export const MAX_VIDEO_SECONDS = 30;

const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSION.test(file.name);
}

/** Largest factor <= 1 that keeps the long edge and the whole frame stack within the limits. */
function fitFactor(width: number, height: number, frameCount: number): number {
  const byEdge = MAX_EDGE / Math.max(width, height);
  const byTotal = Math.sqrt(MAX_TOTAL_PIXELS / (frameCount * width * height));
  return Math.min(1, byEdge, byTotal);
}

function shrinkNote(from: [number, number], to: [number, number]): string | undefined {
  return from[0] === to[0] && from[1] === to[1] ? undefined : `Working at ${to[0]}×${to[1]} (the original is ${from[0]}×${from[1]}).`;
}

function hasTransparency(frames: Uint8ClampedArray[]): boolean {
  for (const data of frames) {
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  }
  return false;
}

// ---- Animated images ---------------------------------------------------------------------

/** Count image frames in a GIF without decoding it (so we never silently flatten an animation). Stops early at `stopAt`. */
export function gifFrameCount(bytes: Uint8Array, stopAt = Number.POSITIVE_INFINITY): number {
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return 0;
  let pos = 13;
  const flags = bytes[10]!;
  if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1));
  const skipSubBlocks = () => {
    while (pos < bytes.length && bytes[pos] !== 0) pos += bytes[pos]! + 1;
    pos++;
  };
  let count = 0;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      pos++; // extension label
      skipSubBlocks();
    } else if (block === 0x2c) {
      count++;
      if (count >= stopAt) return count;
      const local = bytes[pos + 8]!;
      pos += 9;
      if (local & 0x80) pos += 3 * (1 << ((local & 7) + 1));
      pos++; // LZW minimum code size
      skipSubBlocks();
    } else {
      break;
    }
  }
  return count;
}

export type Animation = 'animated' | 'still' | 'unknown';

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/**
 * Say whether a file is an animation by reading only its header, without decoding any pixels, so a
 * still can be flagged the moment it is added. 'unknown' means the header doesn't say (a type this
 * doesn't recognise, or a truncated file); the decoder gets the final word then.
 *
 * Video is reported as animated: whether it can be read is only known by playing it.
 */
export async function probeAnimation(file: Blob & { name?: string }): Promise<Animation> {
  const name = file.name ?? '';
  if (file.type.startsWith('video/') || VIDEO_EXTENSION.test(name)) return 'animated';
  const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());

  if (ascii(head, 0, 3) === 'GIF') {
    // Frame blocks can sit anywhere, so look at the whole file (it stops at the second frame).
    const all = head.length < file.size ? new Uint8Array(await file.arrayBuffer()) : head;
    const frames = gifFrameCount(all, 2);
    return frames === 0 ? 'unknown' : frames > 1 ? 'animated' : 'still';
  }

  // PNG: an animation has an acTL chunk before the first IDAT.
  if (head.length > 8 && head[0] === 0x89 && ascii(head, 1, 4) === 'PNG') {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let at = 8;
    while (at + 8 <= head.length) {
      const type = ascii(head, at + 4, at + 8);
      if (type === 'acTL') return 'animated';
      if (type === 'IDAT' || type === 'IEND') return 'still';
      at += 12 + view.getUint32(at, false);
    }
    return 'unknown';
  }

  // WebP: the VP8X header carries an animation flag; a plain VP8 / VP8L file has no VP8X at all.
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
    const first = ascii(head, 12, 16);
    if (first === 'VP8X') return head[20]! & 0x02 ? 'animated' : 'still';
    return first === 'VP8 ' || first === 'VP8L' ? 'still' : 'unknown';
  }

  // AVIF: an image sequence declares the 'avis' brand; a single image declares 'avif'.
  if (ascii(head, 4, 8) === 'ftyp') {
    const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, false);
    const brands = ascii(head, 8, Math.min(Math.max(size, 12), head.length));
    if (brands.includes('avis')) return 'animated';
    return brands.includes('avif') || brands.includes('mif1') ? 'still' : 'unknown';
  }

  // Formats that can't animate at all.
  if ((head[0] === 0xff && head[1] === 0xd8) || ascii(head, 0, 2) === 'BM') return 'still';
  return 'unknown';
}

function mimeFor(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : ext === 'png' ? 'image/png' : 'image/avif';
}

/**
 * Decode an animated image into frames, or return null when `file` is a still (the caller
 * then takes the still-image path). Throws, rather than quietly keeping one frame, if the file
 * is an animated GIF this browser has no decoder for.
 */
export async function loadAnimatedImage(file: File, onStatus: (text: string) => void): Promise<FrameSource | null> {
  const type = mimeFor(file);
  if (!['image/gif', 'image/webp', 'image/png', 'image/avif'].includes(type)) return null;

  if (typeof ImageDecoder === 'undefined') {
    if (type === 'image/gif' && gifFrameCount(new Uint8Array(await file.arrayBuffer())) > 1) {
      throw new Error("This is an animated GIF, and this browser can't decode animations yet. Try Chrome, Edge or a recent Safari or Firefox.");
    }
    return null;
  }
  if (!(await ImageDecoder.isTypeSupported(type))) return null;

  const decoder = new ImageDecoder({ data: await file.arrayBuffer(), type });
  try {
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (!track || !track.animated || track.frameCount < 2) return null;

    const count = track.frameCount;
    const first = (await decoder.decode({ frameIndex: 0, completeFramesOnly: true })).image;
    const nativeW = first.displayWidth;
    const nativeH = first.displayHeight;
    first.close();
    const factor = fitFactor(nativeW, nativeH, count);
    const width = Math.max(1, Math.round(nativeW * factor));
    const height = Math.max(1, Math.round(nativeH * factor));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the animation (no canvas available).');
    ctx.imageSmoothingQuality = 'high';

    const frames: Uint8ClampedArray[] = [];
    const delays: number[] = [];
    for (let i = 0; i < count; i++) {
      onStatus(`Reading frame ${i + 1} of ${count}…`);
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      frames.push(ctx.getImageData(0, 0, width, height).data);
      // Browsers show delays of 10 ms or less as 100 ms, so do the same.
      const ms = (image.duration ?? 100_000) / 1000;
      delays.push(ms <= 10 ? 100 : ms);
      image.close();
    }
    // ImageDecoder reports Infinity for a GIF that loops forever; GIF writes that as 0, and "play once" as -1.
    const loops = track.repetitionCount;
    const repeat = !Number.isFinite(loops) ? 0 : loops <= 0 ? -1 : loops;
    return { kind: 'animation', origin: 'image', width, height, frames, delays, hasAlpha: hasTransparency(frames), repeat, note: shrinkNote([nativeW, nativeH], [width, height]) };
  } finally {
    decoder.close();
  }
}

// ---- Video -------------------------------------------------------------------------------

function once(target: HTMLVideoElement, event: string, failMessage: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(failMessage)), timeoutMs);
    const onEvent = () => done();
    const onError = () => done(new Error(failMessage));
    function done(error?: Error) {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    }
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

const VIDEO_UNREADABLE = "This browser can't read that video. MP4 (H.264) and WebM work in most browsers.";

/**
 * Sample a clip by seeking a muted <video> and drawing each frame: {@link VIDEO_FPS} frames per
 * second by default, over the whole clip unless a start and/or end is given.
 */
export async function loadVideoFrames(file: File, onStatus: (text: string) => void, options: VideoOptions = {}): Promise<FrameSource> {
  const fps = options.fps && options.fps > 0 ? options.fps : VIDEO_FPS;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    video.src = url;
    await once(video, 'loadedmetadata', VIDEO_UNREADABLE);
    if (video.duration === Number.POSITIVE_INFINITY) {
      // Browser-recorded WebM (MediaRecorder, screen recorders) has no stored duration. Seeking far
      // past the end makes the browser work it out.
      video.currentTime = 1e101;
      await once(video, 'timeupdate', VIDEO_UNREADABLE);
      video.currentTime = 0;
      await once(video, 'seeked', VIDEO_UNREADABLE);
    }
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(VIDEO_UNREADABLE);
    // The range to sample: the whole clip unless trimmed.
    const start = Math.min(Math.max(0, options.start ?? 0), duration - 0.001);
    const end = Math.min(duration, Math.max(options.end ?? duration, start + 0.001));
    const length = end - start;
    if (length > MAX_VIDEO_SECONDS) {
      throw new Error(
        `Clips over ${MAX_VIDEO_SECONDS} seconds aren't supported yet (${options.start !== undefined || options.end !== undefined ? 'that range is' : 'this one is'} ${Math.round(length)} s). Trim it with Start and End in the Fine-Tune GIF tab.`,
      );
    }
    if (video.readyState < 2) await once(video, 'loadeddata', VIDEO_UNREADABLE);

    const nativeW = video.videoWidth;
    const nativeH = video.videoHeight;
    if (!nativeW || !nativeH) throw new Error(VIDEO_UNREADABLE);
    const count = Math.max(2, Math.ceil(length * fps));
    const factor = fitFactor(nativeW, nativeH, count);
    const width = Math.max(1, Math.round(nativeW * factor));
    const height = Math.max(1, Math.round(nativeH * factor));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not read the video (no canvas available).');
    ctx.imageSmoothingQuality = 'high';

    const frames: Uint8ClampedArray[] = [];
    for (let i = 0; i < count; i++) {
      onStatus(`Reading the clip: frame ${i + 1} of ${count}…`);
      const t = Math.min(end - 0.001, start + i / fps);
      if (Math.abs(video.currentTime - t) > 0.0005) {
        video.currentTime = t;
        await once(video, 'seeked', VIDEO_UNREADABLE);
      }
      ctx.drawImage(video, 0, 0, width, height);
      frames.push(ctx.getImageData(0, 0, width, height).data);
    }
    const delays = frames.map(() => 1000 / fps);
    return {
      kind: 'animation',
      origin: 'video',
      width,
      height,
      frames,
      delays,
      hasAlpha: false,
      repeat: 0,
      sourceSeconds: duration,
      note: shrinkNote([nativeW, nativeH], [width, height]),
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
