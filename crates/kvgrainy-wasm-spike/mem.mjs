// Peak WASM linear-memory size after each step (it only ever grows, so this is the high-water mark).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const m = require("../../target/wasm-spike-pkg/kvgrainy_wasm_spike.js");
const mem = () => (m.wasm_memory_bytes() / 1048576).toFixed(0);
const [path, limit = "100000"] = process.argv.slice(2);
const spike = new m.Spike(new Uint8Array(readFileSync(path)));
const mp = (spike.width() * spike.height() / 1e6).toFixed(1);
const out = [`${mp}MP`, `load=${mem()}MB`];
spike.prepare_reference(); out.push(`reference=${mem()}MB`);
spike.encode("jpeg", 80); out.push(`encode=${mem()}MB`);
spike.score_last(); out.push(`score=${mem()}MB`);
try { spike.search(BigInt(limit), "jpeg"); } catch {}
out.push(`search=${mem()}MB`);
console.log(out.join("  "));
