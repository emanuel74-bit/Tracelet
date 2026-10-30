import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/dashboard');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const files = {};
let total = 0;
async function walk(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && !['asset-manifest.json', '.gitattributes'].includes(entry.name)) {
      const data = await readFile(path);
      const key = relative(output, path).split(sep).join('/');
      total += data.length;
      if (total > 8 * 1024 * 1024) throw new Error('Dashboard assets exceed the frozen 8 MiB cap');
      if (['.html', '.js', '.css'].includes(extname(path)) && /0199aabb-ccd1|0199f0e0-0000/.test(data.toString('utf8'))) throw new Error('Test fixtures found in production assets');
      files[key] = { size: data.length, sha256: createHash('sha256').update(data).digest('hex'), contentType: types[extname(path)] ?? 'application/octet-stream', immutable: /-[A-Za-z0-9_-]{8,}\.[^.]+$/.test(key) };
    }
  }
}
await writeFile(join(output, '.gitattributes'), '* -text\n');
await walk(output);
const html = await readFile(join(output, 'index.html'), 'utf8');
if (html.split('<!--tracelet:config-->').length !== 2) throw new Error('The runtime configuration placeholder must occur exactly once');
if (!Object.hasOwn(files, 'index.html')) throw new Error('Dashboard index is missing');
await writeFile(join(output, 'asset-manifest.json'), JSON.stringify({ manifestVersion: 1, entry: 'index.html', files }, null, 2) + '\n');
console.log('Dashboard manifest: ' + Object.keys(files).length + ' files, ' + total + ' bytes');
