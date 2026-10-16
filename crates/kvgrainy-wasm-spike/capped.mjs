// Time and memory of capped / proxy scoring in WASM (Phase 1.4).
// usage: node capped.mjs <image> [quality]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
const require = createRequire(import.meta.url);
const m = require("../../target/wasm-spike-pkg/kvgrainy_wasm_spike.js");
const mb = () => (m.wasm_memory_bytes() / 1048576).toFixed(0);
const [path, quality = "60"] = process.argv.slice(2);
const spike = new m.Spike(new Uint8Array(readFileSync(path)));
console.log(`${(spike.width() * spike.height() / 1e6).toFixed(1)} MP, after load: ${mb()} MB`);
spike.encode("jpeg", Number(quality));
console.log("metric       cap     prepare_ms  score_ms  score   peak_wasm_MB");
for (const [metric, cap] of [["s2", 1], ["s2", 0.5], ["blend", 4], ["blend", 1], ["blend", 0.25], ["ssim", 1], ["ssim", 0.25]]) {
  let t = performance.now();
  spike.prepare_capped(metric, cap);
  const prep = performance.now() - t;
  t = performance.now();
  const s = spike.score_capped_last();
  const sc = performance.now() - t;
  console.log(`${metric.padEnd(10)} ${String(cap).padStart(5)}MP ${prep.toFixed(0).padStart(10)} ${sc.toFixed(0).padStart(9)}  ${s.toFixed(4)}  ${mb().padStart(8)}`);
}
