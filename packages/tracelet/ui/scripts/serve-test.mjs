// Test-only static host. Production mounting and authorization belong to LEAD stage 07.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../assets/dashboard');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
export async function startStaticHost() {
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:4173');
    const mount = ['/test/observe', '/observe'].find(path => url.pathname === path || url.pathname.startsWith(path + '/'));
    if (!mount || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
    if (url.pathname === mount) { res.writeHead(308, { Location: mount + '/' + url.search }); res.end(); return; }
    if (url.pathname.startsWith(mount + '/api/')) { res.writeHead(501, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Test did not mock this API route' } })); return; }
    const name = decodeURIComponent(url.pathname.slice(mount.length + 1)) || 'index.html';
    const path = resolve(root, name);
    if (!path.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
    let data = await readFile(path);
    if (name === 'index.html') {
      const config = JSON.stringify({ basePath: mount, apiBase: mount + '/api/v1', contractVersion: '1.0.0', schemaVersion: 1 });
      data = Buffer.from(data.toString('utf8').replace('<!--tracelet:config-->', '<script id="tracelet-config" type="application/json">' + config + '</script>'));
    }
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((ready, fail) => { server.once('error', fail); server.listen(4173, '127.0.0.1', ready); });
return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startStaticHost();
  console.log('Test-only dashboard static host ready');
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
