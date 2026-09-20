// Sweep anything an interrupted e2e run left behind: headless browsers still holding a throwaway profile,
// and the profile directories themselves. Safe to run at any time - it only ever touches processes whose
// command line names one of our own profiles, never a browser someone is actually using.
import { execSync } from 'node:child_process';
import { PROFILE_PREFIX, sweepProfiles } from './cdp.mjs';

const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;

let pids = [];
try {
  pids = execSync(`pgrep -f "user-data-dir=.*${PROFILE_PREFIX}"`, { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean).filter((p) => Number(p) !== process.pid);
} catch { /* pgrep exits 1 when nothing matches */ }

for (const pid of pids) {
  try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
}
// every profile is fair game once its browser is dead
const { removed, bytes } = sweepProfiles(0);
console.log(`e2e clean: killed ${pids.length} stray browser process(es), removed ${removed} profile(s), freed ${mb(bytes)}`);
