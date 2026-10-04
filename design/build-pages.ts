// A Pages artifact contains runtime assets, not local source models or personal music.
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repository = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'apex-racing';
const base = repository.endsWith('.github.io') ? '/' : `/${repository}/`;
execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--mode', 'production', '--base', base], {
  stdio: 'inherit',
  env: { ...process.env, VITE_MULTIPLAYER_BACKEND: 'cloudflare', VITE_MULTIPLAYER_URL: process.env.VITE_MULTIPLAYER_URL ?? 'https://apex-multiplayer.c28aa1-rgb.workers.dev' },
});
rmSync('dist/audio/music', { recursive: true, force: true });
for (const folder of ['cars', 'tracks']) {
  for (const file of readdirSync(`dist/models/${folder}`)) {
    if (file.endsWith('.glb') && (folder === 'cars' || !file.endsWith('.clean.glb'))) rmSync(`dist/models/${folder}/${file}`);
  }
}
let bytes = 0;
function check(folder: string) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name), stat = statSync(path);
    if (name === '.DS_Store' || name.endsWith('.gz')) { rmSync(path, { force: true }); continue; }
    if (stat.isDirectory()) check(path); else bytes += stat.size;
  }
}
check('dist');
if (bytes > 1_000_000_000) throw new Error('Pages artifact exceeds 1 GB. Reduce runtime assets before publishing.');
console.log(`Pages artifact: ${(bytes / 1048576).toFixed(1)} MiB, base ${base}`);
