import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const publicExtensions = new Set([
  '.html', '.css', '.js', '.png', '.webp', '.jpg', '.jpeg',
  '.svg', '.ico', '.xml', '.txt', '.woff', '.woff2',
]);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  // git ls-files also includes pending deletions. Retired pages must never
  // be copied back into the public build.
  .filter((file) => file !== 'what-are-peptides.html')
  .filter((file) => publicExtensions.has(extname(file).toLowerCase()))
  .filter((file) => !file.startsWith('worker/') && !file.startsWith('scripts/'));

await mkdir('dist', { recursive: true });
// A running Windows preview can hold the directory itself open.
// Clear generated contents while preserving its root.
for (const entry of await readdir('dist')) {
  await rm(join('dist', entry), { recursive: true, force: true });
}
for (const file of files) {
  const target = join('dist', file);
  await mkdir(join(target, '..'), { recursive: true });
  await cp(file, target);
}
console.log(`Built ${files.length} tracked public files in dist/`);
