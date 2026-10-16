// Run a command with KVG_TARGET set, without needing cross-env: `node scripts/with-target.mjs desktop astro build`.
import { spawnSync } from 'node:child_process';

const [target, command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, { stdio: 'inherit', shell: true, env: { ...process.env, KVG_TARGET: target } });
process.exit(result.status ?? 1);
