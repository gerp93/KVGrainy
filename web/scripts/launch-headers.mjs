/**
 * The launch-dependent part of the production response headers.
 *
 * `public/_headers` holds the fixed policy. Search-engine visibility is the one header that must follow
 * the launch flag (PUBLIC_LAUNCH=1): a launch build that still says `X-Robots-Tag: noindex` would stay
 * out of Google even with `robots.txt` and the page tags open, because the header wins. So this adds
 * the header to the `/*` block for a pre-launch build and guarantees it is absent from a launch build.
 */
const NOINDEX = '  X-Robots-Tag: noindex';
const ROBOTS_LINE = /^\s+X-Robots-Tag:.*$/i;

export function applyLaunchHeaders(headersText, launched) {
  const lines = headersText.replace(/\r\n/g, '\n').split('\n').filter((line) => !ROBOTS_LINE.test(line));
  if (!launched) {
    const start = lines.findIndex((line) => line.trim() === '/*');
    if (start === -1) throw new Error('_headers has no "/*" block to add the noindex header to');
    let end = start + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++;
    lines.splice(end, 0, NOINDEX);
  }
  return lines.join('\n').replace(/\n*$/, '\n');
}
