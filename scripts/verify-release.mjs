import { spawnSync } from 'node:child_process';

// All checks use the same environment, including NEXT_PUBLIC_BASE_PATH.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const commands = [
  ['test'],
  ['run', 'lint'],
  ['run', 'typecheck'],
  ['run', 'build'],
  ['run', 'verify:pdf-worker'],
  ['run', 'verify:base-path'],
  ['run', 'verify:browser-only'],
  ['run', 'verify:browser-core'],
];

for (const args of commands) {
  console.log(`\n[release] npm ${args.join(' ')}`);
  // Windows npm is a cmd script and must be started through the command shell.
  const result = spawnSync(npm, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
  if (result.error) {
    console.error(`[release] Could not start npm: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[release] npm ${args.join(' ')} failed${result.signal ? ` (${result.signal})` : ''}`);
    process.exit(result.status ?? 1);
  }
}
console.log('\n[release] All applicable local checks passed.');
