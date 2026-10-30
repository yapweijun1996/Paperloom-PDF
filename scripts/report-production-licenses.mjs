import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const root = process.cwd();
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')).packages;
const paths = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).slice(1);
const records = new Map();
for (const path of paths) {
  const metadata = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
  const key = relative(root, path).split(sep).join('/');
  if (!lock[key] || lock[key].version !== metadata.version) throw new Error(`Installed package differs from lockfile: ${key}`);
  const license = typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license ?? 'Not declared');
  records.set(`${metadata.name}\u0000${metadata.version}`, { name: metadata.name, version: metadata.version, license });
}
console.log('# Production dependency license inventory\n');
console.log('This inventory records declared `license` fields from the installed production');
console.log('dependency tree (`npm ls --omit=dev --all --parseable`). Each installed version');
console.log('matched this checkout\'s `package-lock.json` when recorded. Declarations are');
console.log('metadata, not a legal review: consult the license and notice files shipped');
console.log('with each dependency before redistribution. Optional platform packages and');
console.log('future lockfile changes may differ; regenerate for the release environment.\n');
console.log('Regenerate after installation with `node scripts/report-production-licenses.mjs > docs/THIRD_PARTY_LICENSES.md`.\n');
console.log('| Package | Version | Declared license |\n| --- | --- | --- |');
for (const item of [...records.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  console.log(`| \`${item.name}\` | \`${item.version}\` | ${item.license.replaceAll('|', '\\|')} |`);
}
