// WASM counterpart of examples/native_timing.rs. Run after:
//   cargo build -p kvgrainy-wasm-spike --target wasm32-unknown-unknown --release
//   wasm-bindgen target/wasm32-unknown-unknown/release/kvgrainy_wasm_spike.wasm --target nodejs --out-dir target/wasm-spike-pkg
// usage: node run.mjs <image> [limit_bytes] [format]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const require = createRequire(import.meta.url);
const { Spike } = require("../../target/wasm-spike-pkg/kvgrainy_wasm_spike.js");

const [path, limitArg = "100000", format = "jpeg"] = process.argv.slice(2);
const ms = (t) => (performance.now() - t).toFixed(1);
const bytes = new Uint8Array(readFileSync(path));

let t = performance.now();
const spike = new Spike(bytes);
console.log(`decode_ms=${ms(t)} size=${spike.width()}x${spike.height()}`);
t = performance.now();
spike.prepare_reference();
console.log(`prepare_reference_ms=${ms(t)}`);
t = performance.now();
const len = spike.encode(format, 80);
console.log(`encode_q80_ms=${ms(t)} bytes=${len}`);
t = performance.now();
const score = spike.score_last();
console.log(`score_ms=${ms(t)} score=${score.toFixed(4)}`);
t = performance.now();
let result;
try { result = `Ok(${spike.search(BigInt(limitArg), format)})`; } catch (e) { result = `Err(${e})`; }
console.log(`search_ms=${ms(t)} limit=${limitArg} result=${result}`);
console.log(`wasm_memory_mb=${(process.memoryUsage().rss / 1048576).toFixed(0)} (process RSS)`);
