import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const port = Number(option('--port', process.env.PORT || '4173'));
const host = option('--host', process.env.HOST || '127.0.0.1');
const base = '/' + option('--base', process.env.BASE_PATH || '').split('/').filter(Boolean).join('/') + '/';
const prefix = base === '//' ? '/' : base;
const directory = await realpath(option('--dir', fileURLToPath(new URL('../dist', import.meta.url))));
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === prefix.slice(0, -1)) {
      response.writeHead(308, { Location: prefix }).end();
      return;
    }
    if (!pathname.startsWith(prefix) || pathname.includes('\0')) {
      response.writeHead(404).end('Not found');
      return;
    }
    const requested = pathname.slice(prefix.length) || 'index.html';
    let filename = path.resolve(directory, requested);
    const withinRoot = filename === directory || filename.startsWith(directory + path.sep);
    if (!withinRoot) { response.writeHead(403).end('Forbidden'); return; }
    if ((await stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
    filename = await realpath(filename);
    if (!filename.startsWith(directory + path.sep)) { response.writeHead(403).end('Forbidden'); return; }
    const content = await readFile(filename);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(filename)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400).end('Not found');
  }
});
server.listen(port, host, () => console.log(`MOB: http://${host}:${port}${prefix}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
