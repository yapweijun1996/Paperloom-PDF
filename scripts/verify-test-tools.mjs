import { spawnSync } from 'node:child_process';

// Interoperability checks may be skipped on a developer machine, but a CI
// result must not silently omit them when the tools are absent.
if (process.env.CI === 'true' || process.env.CI === '1') {
  const tools = [
    ['openssl', ['version']],
    ['qpdf', ['--version']],
    ['pdfsig', ['-v']],
  ];
  const missing = tools.filter(([name, args]) => {
    const result = spawnSync(name, args, { stdio: 'ignore' });
    return result.error || result.status !== 0;
  }).map(([name]) => name);
  if (missing.length) {
    console.error(`CI requires these PDF interoperability tools: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('PDF interoperability tools are available.');
  }
} else {
  console.log('PDF interoperability tool requirement is enforced in CI.');
}
