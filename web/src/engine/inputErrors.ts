/**
 * Plain-language messages for files the page cannot use. Pure functions, so they are unit-tested
 * without a browser. The browser's own errors ("The source image could not be decoded",
 * "Failed to construct 'ImageDecoder'") are accurate but mean nothing to a person who dropped a file.
 */

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

// HEIC/HEIF are listed so the file gets a card and a useful message (Safari can open them; Chrome and Firefox cannot).
const MEDIA_FILE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|mp4|m4v|mov|webm|mkv|avi)$/i;
const HEIC_FILE = /\.(heic|heif)$/i;

/** True when the file is worth trying to open: an image or video by its type, or by its extension when the type is empty. */
export function looksLikeMedia(file: FileLike): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/') || MEDIA_FILE.test(file.name);
}

/** Said under the drop zone when some dropped files were not images or clips, so a drop never fails silently. */
export function skippedMessage(files: FileLike[]): string {
  if (files.length === 1) return `"${files[0]?.name}" is not an image or a clip, so it was skipped.`;
  const shown = files.slice(0, 3).map((f) => f.name);
  const more = files.length - shown.length;
  return `Skipped ${files.length} files that are not images or clips: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`;
}

const DECODE_FAILURE = /could not be decoded|imagedecoder|failed to decode|unable to decode|cannot decode|decoding/i;

/**
 * Turn an error from opening a file into a sentence a person can act on. Anything that is not a
 * recognisable "could not open this file" failure passes through unchanged.
 */
export function explainLoadError(err: unknown, file: FileLike): string {
  const text = err instanceof Error ? err.message : String(err);
  if (file.size === 0) return 'This file is empty (0 bytes), so there is nothing to reduce.';
  const decodeFailure =
    DECODE_FAILURE.test(text) ||
    (err instanceof DOMException && ['InvalidStateError', 'EncodingError', 'NotSupportedError'].includes(err.name));
  if (!decodeFailure) return text;
  if (HEIC_FILE.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif') {
    return 'This browser cannot open HEIC photos (Safari can). Export the photo as a JPEG first; on an iPhone, Settings > Camera > Formats > Most Compatible makes new photos JPEGs.';
  }
  return 'This file could not be read as an image. It may be damaged, or in a format this browser cannot open.';
}
