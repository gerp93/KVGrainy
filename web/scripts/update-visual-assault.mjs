#!/usr/bin/env node
// Re-vendor VisualAssault's CSS themes at a release tag (never main), per KVG_Standards
// themes-versioning.md: a marked, tag-sourced copy plus this script, so a version bump is a
// deliberate, reviewable change.
//
//   node scripts/update-visual-assault.mjs            # re-fetch the pinned tag below
//   node scripts/update-visual-assault.mjs v0.3.0     # move to a newer tag (do this in its own commit)
//
// Writes:
//   src/styles/visual-assault.css        verbatim copy of packages/css/themes.css at the tag
//   src/ui/visual-assault-themes.json    theme ids and display names, from themes/THEMES.md at the same tag
// After a bump, re-test the theme picker: a new tag can add or rename themes.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PINNED_TAG = 'v0.2.0';
const tag = process.argv[2] ?? PINNED_TAG;
const base = `https://raw.githubusercontent.com/gerp93/VisualAssault/${tag}`;
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function get(path) {
  const response = await fetch(`${base}/${path}`);
  if (!response.ok) throw new Error(`${path} at ${tag}: HTTP ${response.status}`);
  return response.text();
}

const [css, doc] = await Promise.all([get('packages/css/themes.css'), get('themes/THEMES.md')]);

// Display names come from the "### Name" headings; every one must have a matching CSS block.
const names = [...doc.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
const cssIds = [...css.matchAll(/^body\.([a-z0-9-]+)-theme\b/gm)].map((m) => m[1]);
const themes = names.map((name) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name }));

const missing = themes.filter((t) => !cssIds.includes(t.id)).map((t) => t.id);
const extra = cssIds.filter((id) => !themes.some((t) => t.id === id));
if (missing.length || extra.length) {
  throw new Error(`THEMES.md and themes.css disagree. In the doc only: [${missing}]. In the CSS only: [${extra}].`);
}

const header = `/* Vendored verbatim from gerp93/VisualAssault, packages/css/themes.css at tag ${tag}.
 * Do not hand-edit. To change it, run: node scripts/update-visual-assault.mjs <tag>
 * (KVG_Standards themes-versioning.md: pin to a tag, never main.) */

`;
writeFileSync(resolve(web, 'src/styles/visual-assault.css'), header + css);
writeFileSync(resolve(web, 'src/ui/visual-assault-themes.json'), JSON.stringify({ tag, themes }, null, 2) + '\n');
console.log(`Vendored VisualAssault ${tag}: ${themes.length} themes (${themes.map((t) => t.id).join(', ')})`);
