/**
 * Size limits for places people commonly upload to. Every entry must carry the page it came
 * from and the date someone read that page. Never add a limit from memory, a blog or a search
 * summary: read the site's own page, and re-check these now and then, because they change
 * (Discord's has more than once).
 *
 * Sizes are stored in bytes. Where a site writes "MB" without saying MB or MiB, the smaller
 * (decimal) reading is used, so a file that fits here fits under either.
 */

export interface Preset {
  id: string;
  /** Short button text. */
  label: string;
  bytes: number;
  /** One line shown after the button is chosen: what the limit applies to. */
  detail: string;
  source: { title: string; url: string };
  /** ISO date someone last read the source and confirmed the number. */
  verifiedOn: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'discord-upload',
    label: 'Discord upload',
    bytes: 20_000_000,
    detail: 'Discord: 20 MB per file for accounts without Nitro. Discord says it is testing other limits, so some accounts may differ.',
    source: { title: 'Discord: File Attachments FAQ', url: 'https://support.discord.com/hc/en-us/articles/25444343291031-File-Attachments-FAQ' },
    verifiedOn: '2026-10-15',
  },
  {
    id: 'discord-emoji',
    label: 'Discord emoji',
    bytes: 256 * 1024,
    detail: 'Discord: custom emoji, static or animated, up to 256 KiB. Discord shows them small, so 128×128 is plenty.',
    source: { title: 'Discord developer docs: Emoji', url: 'https://docs.discord.com/developers/resources/emoji' },
    verifiedOn: '2026-10-15',
  },
  {
    id: 'gmail',
    label: 'Gmail attachment',
    bytes: 25_000_000,
    detail: 'Gmail: 25 MB for personal accounts, counting all attachments on one message. Work and school accounts are set by their admin.',
    source: { title: 'Gmail Help: Send attachments with your Gmail message', url: 'https://support.google.com/mail/answer/6584?hl=en' },
    verifiedOn: '2026-10-15',
  },
  {
    id: 'github',
    label: 'GitHub image',
    bytes: 10_000_000,
    detail: 'GitHub: images and GIFs attached to issues, pull requests and comments, up to 10 MB each.',
    source: { title: 'GitHub Docs: Attaching files', url: 'https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files' },
    verifiedOn: '2026-10-15',
  },
  {
    id: 'youtube-thumbnail-mobile',
    label: 'YouTube thumbnail (phone)',
    bytes: 2_000_000,
    detail: 'YouTube: video thumbnails uploaded from the mobile app, up to 2 MB. Uploading from a computer allows 50 MB.',
    source: { title: 'YouTube Help: Add video thumbnails', url: 'https://support.google.com/youtube/answer/72431?hl=en' },
    verifiedOn: '2026-10-15',
  },
  {
    id: 'slack-emoji',
    label: 'Slack emoji',
    bytes: 128_000,
    detail: 'Slack recommends custom emoji under 128 KB, square with a transparent background. That is a recommendation, not a hard limit.',
    source: { title: 'Slack Help: Add custom emoji and aliases', url: 'https://slack.com/help/articles/206870177-Add-custom-emoji-and-aliases-to-your-workspace' },
    verifiedOn: '2026-10-15',
  },
];

/**
 * Text for the size box that parses back to just under `bytes` (never over), like "23.84mb".
 * The box uses binary units (1 MB = 1,048,576 bytes), so decimal limits are rounded down.
 */
export function limitText(bytes: number): string {
  const mib = 1024 * 1024;
  const unit = bytes >= mib ? mib : 1024;
  const suffix = bytes >= mib ? 'mb' : 'kb';
  const value = Math.floor((bytes / unit) * 100) / 100;
  return `${value}${suffix}`;
}
