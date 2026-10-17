import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const filename of ['index.html', 'styles.css', 'mob.svg', 'src']) {
  await cp(path.join(root, filename), path.join(out, filename), { recursive: true });
}
await cp(path.join(root, 'public'), out, { recursive: true });
await writeFile(path.join(out, '.nojekyll'), '');
await cp(path.join(out, 'index.html'), path.join(out, '404.html'));

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const lists = await Promise.all(entries.map(async entry => entry.isDirectory()
    ? filesIn(path.join(directory, entry.name))
    : [path.join(directory, entry.name)]));
  return lists.flat().sort();
}

const files = await filesIn(out);
const hash = createHash('sha256');
for (const file of files) {
  hash.update(path.relative(out, file));
  hash.update(await readFile(file));
}
const version = hash.digest('hex').slice(0, 20);
const assets = files.filter(file => !path.basename(file).startsWith('.'))
  .map(file => './' + path.relative(out, file).split(path.sep).join('/'));

// Only public application assets enter CacheStorage. Personal data stays in
// IndexedDB; Google APIs and every other external origin bypass this worker.
const worker = `/* MOB offline shell — generated from the complete build. */
const VERSION = ${JSON.stringify(version)};
const PREFIX = 'mob-shell:' + self.registration.scope + ':';
const CACHE = PREFIX + VERSION;
const ASSETS = ${JSON.stringify(assets, null, 2)};
const URLS = ASSETS.map(asset => new URL(asset, self.registration.scope).href);
const SHELL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(URLS.map(url => new Request(url, { cache: 'reload' })));
    // An existing version remains active until its tabs close or the user
    // explicitly accepts the update, preserving an unfinished journal entry.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (request.mode === 'navigate') {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(SHELL)) || fetch(request))());
    return;
  }
  url.search = '';
  if (!URLS.includes(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(url.href)) || fetch(request);
  })());
});
`;
await writeFile(path.join(out, 'sw.js'), worker);
console.log(`Built dist/: ${files.length + 1} files; offline version ${version}.`);
