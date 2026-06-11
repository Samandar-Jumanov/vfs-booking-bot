/**
 * Wrapper for the nodriver VFS idle network probe.
 *
 * Run from backend:
 *   npx.cmd tsx scripts/probe-vfs-idle-network-nodriver.ts
 */
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..', '..');
const probe = path.join(repoRoot, 'nodriver-spike', 'probe_idle_network.py');
const python = process.env.PYTHON_BIN || 'python';

const result = spawnSync(python, [probe, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error('[ND-PROBE-WRAPPER] failed:', result.error.message);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
