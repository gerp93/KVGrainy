/** Parse a size like `500kb`, `1.5mb`, `2048` or `12b` into bytes. Same rules as the desktop engine. */
export function parseSizeLimit(text: string): number {
  const value = text.trim().toLowerCase();
  if (!value) throw new Error('Enter a size limit, like 500kb or 1.5mb.');
  let number = value;
  let multiplier = 1;
  if (value.endsWith('mb')) {
    number = value.slice(0, -2);
    multiplier = 1024 * 1024;
  } else if (value.endsWith('kb')) {
    number = value.slice(0, -2);
    multiplier = 1024;
  } else if (value.endsWith('b')) {
    number = value.slice(0, -1);
  }
  number = number.trim();
  const parsed = number === '' ? NaN : Number(number);
  if (!Number.isFinite(parsed)) throw new Error(`"${text.trim()}" isn't a size. Try 500kb or 1.5mb.`);
  const bytes = Math.floor(parsed * multiplier);
  if (bytes < 1) throw new Error('The size limit must be greater than zero.');
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
