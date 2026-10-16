// Build the shared Rust core for the browser: kvgrainy-wasm -> web/src/wasm (generated, not committed).
// Needs the wasm32-unknown-unknown target and a wasm-bindgen CLI matching Cargo.lock's wasm-bindgen version.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');
const out = resolve(web, 'src/wasm');
// The `wasm` profile (Cargo.toml) trades a little speed for size; see docs/web.md.
const wasm = resolve(repo, 'target/wasm32-unknown-unknown/wasm/kvgrainy_wasm.wasm');

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', cwd: repo, ...options });

const lock = readFileSync(resolve(repo, 'Cargo.lock'), 'utf8');
const wanted = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1];
let installed = '';
try {
  installed = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim().split(' ')[1] ?? '';
} catch {
  /* reported below */
}
if (installed !== wanted) {
  console.error(`wasm-bindgen CLI ${installed || '(not installed)'} does not match Cargo.lock's ${wanted}.\n  cargo install wasm-bindgen-cli --version ${wanted} --locked`);
  process.exit(1);
}

run('cargo', ['build', '-p', 'kvgrainy-wasm', '--target', 'wasm32-unknown-unknown', '--profile', 'wasm', '--locked']);
mkdirSync(out, { recursive: true });
run('wasm-bindgen', [wasm, '--target', 'web', '--out-dir', out, '--typescript']);
if (!existsSync(resolve(out, 'kvgrainy_wasm_bg.wasm'))) throw new Error('wasm-bindgen produced no output');
console.log(`built ${out}`);
