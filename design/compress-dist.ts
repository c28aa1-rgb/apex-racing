// Pre-gzips the runtime files in dist/ so the server can send them compressed
// (@fastify/static preCompressed). Over a classroom network this roughly halves
// a track load; collision meshes shrink by about 70%. Browsers only accept
// Brotli over HTTPS, so plain-HTTP LAN play needs gzip.
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// Only what the game actually downloads; the supplied source models stay uncompressed.
const runtime = /(\.clean\.glb|collision\/.+\.bin|cars\/runtime\/.+\.glb|garage\/.+\.glb|assets\/.+\.(js|css|wasm)|\.(ttf|woff2?|json))$/;
let before = 0, after = 0, files = 0;
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = statSync(path);
    if (stat.isDirectory()) { walk(path); continue; }
    if (name.endsWith('.gz') || stat.size < 20_000 || !runtime.test(path.replaceAll('\\', '/'))) continue;
    const target = `${path}.gz`;
    if (existsSync(target) && statSync(target).mtimeMs >= stat.mtimeMs) { before += stat.size; after += statSync(target).size; files++; continue; }
    const packed = gzipSync(readFileSync(path), { level: 6 });
    // Little gain is not worth the decompression; serve those files as they are.
    if (packed.length > stat.size * .9) continue;
    writeFileSync(target, packed); before += stat.size; after += packed.length; files++;
  }
};
walk('dist');
console.log(`Gzipped ${files} runtime files: ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB`);
