import { execFileSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';

const publicExtensions = new Set([
  '.html', '.css', '.js', '.png', '.webp', '.jpg', '.jpeg',
  '.svg', '.ico', '.xml', '.txt', '.woff', '.woff2',
]);
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .filter((file) => publicExtensions.has(extname(file).toLowerCase()))
  .filter((file) => !file.startsWith('worker/') && !file.startsWith('scripts/'));

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) {
  const target = join('dist', file);
  await mkdir(join(target, '..'), { recursive: true });
  await cp(file, target);
}
console.log(`Built ${files.length} tracked public files in dist/`);
