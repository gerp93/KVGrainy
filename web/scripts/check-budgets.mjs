// Fail the build when a shipped asset grows past its budget (budgets.json). Run after `astro build`.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(web, 'dist');
const budgets = JSON.parse(readFileSync(resolve(web, 'budgets.json'), 'utf8'));
const gz = (path) => gzipSync(readFileSync(path)).length;
const kb = (bytes) => (bytes / 1024).toFixed(1);

const failures = [];
const rows = [];

const assets = resolve(dist, '_astro');
for (const file of readdirSync(assets).sort()) {
  const rule = budgets.rules.find((r) => new RegExp(r.match).test(file)) ?? budgets.default;
  const size = gz(resolve(assets, file));
  rows.push({ label: rule.label, file, size, max: rule.maxGzipKB });
  if (size > rule.maxGzipKB * 1024) failures.push(`${file} (${rule.label}): ${kb(size)} KB gzipped, budget ${rule.maxGzipKB} KB`);
}

// What a visitor downloads before doing anything: the page plus the CSS and scripts it references.
const html = readFileSync(resolve(dist, 'index.html'));
const referenced = [...html.toString('utf8').matchAll(/(?:src|href)="\/(_astro\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
const initial = gzipSync(html).length + referenced.reduce((total, file) => total + gz(resolve(dist, file)), 0);
rows.push({ label: budgets.initialLoad.label, file: `index.html + ${referenced.length} files`, size: initial, max: budgets.initialLoad.maxGzipKB });
if (initial > budgets.initialLoad.maxGzipKB * 1024) failures.push(`initial load: ${kb(initial)} KB gzipped, budget ${budgets.initialLoad.maxGzipKB} KB`);

rows.sort((a, b) => b.size - a.size);
for (const r of rows.slice(0, 14)) console.log(`${kb(r.size).padStart(8)} KB / ${String(r.max).padStart(4)} KB  ${r.label.padEnd(28)} ${r.file}`);
if (failures.length) {
  console.error(`\nOver budget:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll assets within budget.');
