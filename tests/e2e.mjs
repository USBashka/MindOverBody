/** End-to-end checks run against the production build at a GitHub Pages-style subpath.
 * Optional private Somnio fixture: SOMNIO_FIXTURE=/absolute/path.json npm run test:e2e
 * Its contents never enter logs, screenshots, the repository, or network requests.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { parseSomnio } from '../src/data.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:4178/MindOverBody/';
const screenshotDirectory = process.env.E2E_SCREENSHOTS;
let server;
let browser;
let serverLogs = '';

async function start() {
  if (!process.env.E2E_BASE_URL) {
    if (!existsSync(path.join(root, 'dist/index.html'))) throw new Error('Build the application before running browser tests: npm run build');
    server = spawn(process.execPath, ['scripts/serve.mjs', '--dir', 'dist', '--port', '4178', '--base', 'MindOverBody'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', data => { serverLogs += data; });
    server.stderr.on('data', data => { serverLogs += data; });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(baseURL)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Local test server failed: ${serverLogs}`);
  }
  const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath: executable, headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
}

async function getState(page) {
  return page.evaluate(async () => (await import('./src/data.js')).loadState());
}
async function route(page, destination) {
  await page.evaluate(value => { location.hash = value; }, destination);
  await page.waitForFunction(value => document.title.includes(value), ({ diary: 'Дневник', lessons: 'Уроки', library: 'Библиотека', map: 'Карта', stats: 'Статистика', tags: 'Личное пространство', settings: 'Личное пространство' })[destination]);
}
async function closeReader(page) {
  const dialog = page.locator('dialog[open]').last();
  await dialog.locator('[data-close]').first().click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
}
async function assertNoOverflow(page, label) {
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  assert.ok(size.content <= size.width + 2, `${label}: page exceeds viewport (${size.content} > ${size.width})`);
}
async function saveEditor(page) {
  await page.locator('#entry-form [type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('#entry-form'));
}

async function addEditorTag(page, name, type) {
  await page.locator('#tag-input').fill(name);
  await page.locator('#tag-type').selectOption(type);
  await page.locator('[data-add-tag]').click();
}

async function exerciseApplication(mobile) {
  const label = mobile ? 'mobile' : 'desktop';
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile, hasTouch: mobile, timezoneId: 'Europe/Samara', reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL).origin) externalRequests.push(request.url()); });
  try {
    await page.goto(baseURL);
    await page.getByRole('heading', { name: 'Между сном и явью' }).waitFor();
    assert.equal((await getState(page)).entries.length, 0);
    await assertNoOverflow(page, `${label} diary`);
    if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `${label}-diary.png`), fullPage: true });

    await page.locator('[data-action=new-entry]').first().click();
    assert.equal(await page.locator('#entry-form [name=type]').inputValue(), 'dream');
    await page.locator('#entry-title').fill('Тестовая ночная гавань');
    await page.locator('#entry-body').fill('## Ночная гавань\n\n**Ясный образ** и *тихий берег*. @ОС %[Тихий лес]\n\n- Вспомнить детали\n- Замедлиться\n\n<img src=x onerror="window.__unsafe=1">\n\n[опасно](javascript:window.__unsafe=1)\n\n![удалённое изображение](https://tracking.invalid/pixel.png)');
    await addEditorTag(page, 'Тихий лес', 'location');
    await addEditorTag(page, 'Маяк', 'location');
    await addEditorTag(page, 'Проводник', 'character');
    await page.locator('[data-mode=preview]').click();
    assert.equal(await page.locator('#markdown-preview h2').innerText(), 'Ночная гавань');
    assert.equal(await page.locator('#markdown-preview strong').innerText(), 'Ясный образ');
    assert.equal(await page.locator('#markdown-preview script, #markdown-preview img, #markdown-preview a').count(), 0);
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    await page.locator('[data-mode=write]').click();

    await page.locator('[data-media=draw]').click();
    const canvas = page.locator('.mob-drawing canvas');
    const bounds = await canvas.boundingBox();
    const blank = await canvas.evaluate(node => node.toDataURL());
    await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.6, { steps: 12 });
    await page.mouse.up();
    assert.notEqual(await canvas.evaluate(node => node.toDataURL()), blank);
    await page.locator('[data-drawing=undo]').click();
    assert.equal(await canvas.evaluate(node => node.toDataURL()), blank);
    await page.mouse.click(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.45);
    await page.locator('[data-drawing=save]').click();
    await page.locator('#editor-images img').waitFor();
    await page.locator('[data-caption="0"]').fill('Тестовый рисунок');
    for (const source of ['file', 'camera']) {
      const chooser = page.waitForEvent('filechooser');
      await page.locator(`[data-media="${source}"]`).click();
      const picker = await chooser;
      if (source === 'camera') assert.equal(await picker.element().getAttribute('capture'), 'environment');
      await picker.setFiles(path.join(root, 'public/icons/icon-512.png'));
      await page.waitForFunction(count => document.querySelectorAll('#editor-images img').length === count, source === 'file' ? 2 : 3);
    }
    await page.evaluate(async () => {
      const data = new DataTransfer();
      data.items.add(new File([await (await fetch('./icons/icon-192.png')).blob()], 'pasted.png', { type: 'image/png' }));
      document.querySelector('#entry-body').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('#editor-images img').length === 4);
    await saveEditor(page);
    let saved = await getState(page);
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0].type, 'dream');
    assert.equal(saved.entries[0].images.length, 4);
    assert.equal(saved.entries[0].images[0].caption, 'Тестовый рисунок');
    assert.equal(saved.entries[0].tagIds.length, 4);
    assert.equal(saved.tags.find(tag => tag.name === 'ОС').type, 'result');

    await page.locator('[data-action=new-entry]').first().click();
    assert.equal(await page.locator('#entry-form [name=type]').inputValue(), 'practice');
    await page.locator('#entry-title').fill('Тестовая дневная практика');
    await page.locator('#entry-body').fill('Три детали настоящего. @[Тихий лес]');
    await addEditorTag(page, 'Спокойствие', 'modifier');
    await addEditorTag(page, 'Тема практики', 'theme');
    await addEditorTag(page, 'Из книги', 'reference');
    await page.locator('.editor-modal [data-close]').first().click();
    await page.locator('.confirm-modal [data-confirm]').click();
    await page.waitForFunction(() => !document.querySelector('#entry-form'));
    await page.locator('[data-action=new-entry]').first().click();
    assert.equal(await page.locator('#entry-title').inputValue(), 'Тестовая дневная практика');
    assert.equal(await page.locator('#selected-tags [data-remove-tag]').count(), 3);
    await saveEditor(page);
    assert.equal(new Set((await getState(page)).tags.map(tag => tag.type)).size, 6);
    await page.reload();
    await page.locator('.entry-card').first().waitFor();
    assert.equal(await page.locator('.entry-card').count(), 2);
    await page.locator('#diary-search').fill('ночная гавань');
    assert.equal(await page.locator('.entry-card').count(), 1);
    await page.locator('.entry-open').click();
    assert.equal(await page.locator('.reader-modal .prose h2').innerText(), 'Ночная гавань');
    assert.equal(await page.locator('.reader-image').count(), 4);
    await closeReader(page);
    await page.locator('#diary-search').fill('');

    await route(page, 'tags');
    await page.locator('[data-new-tag]').waitFor();
    await page.getByRole('button', { name: 'Редактировать тег Тихий лес', exact: true }).click();
    await page.locator('#tag-form [name=description]').fill('Тестовое описание места.');
    await page.locator('[data-image=draw]').click();
    await page.locator('[data-drawing=save]').click();
    await page.locator('#tag-image-preview img').waitFor();
    await page.locator('#tag-form [type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#tag-form'));
    assert.equal((await getState(page)).tags.find(tag => tag.name === 'Тихий лес').description, 'Тестовое описание места.');

    await route(page, 'map');
    await page.locator('#dream-map[data-engine="rusterize-wasm"]').waitFor();
    assert.equal(await page.locator('[data-map-open]').count(), 2);
    await page.locator('#dream-map').scrollIntoViewIfNeeded();
    const mapBounds = await page.locator('#dream-map').boundingBox();
    const mapScale = Math.min(mapBounds.width / 1000, mapBounds.height / 700);
    const forestNode = await page.evaluate(async () => {
      const [{ loadState }, { buildGraph }] = await Promise.all([import('./src/data.js'), import('./src/model.js')]);
      return buildGraph(await loadState()).nodes.find(node => node.name === 'Тихий лес');
    });
    // Drag through the real WASM canvas and verify the application's IndexedDB callback.
    const nodeX = mapBounds.x + mapBounds.width / 2 + (forestNode.x - 500) * mapScale;
    const nodeY = mapBounds.y + mapBounds.height / 2 + (forestNode.y - 350) * mapScale;
    await page.mouse.move(nodeX, nodeY);
    await page.mouse.down();
    await page.mouse.move(nodeX + 45, nodeY + 30, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(async () => Number.isFinite((await (await import('./src/data.js')).loadState()).tags.find(tag => tag.name === 'Тихий лес')?.x));
    const moved = (await getState(page)).tags.find(tag => tag.name === 'Тихий лес');
    assert.ok(Math.abs(moved.x - (forestNode.x + 45 / mapScale)) < 2, `${label}: map location moved in world coordinates`);
    assert.ok(Math.abs(moved.y - (forestNode.y + 30 / mapScale)) < 2, `${label}: map vertical position persisted`);
    await page.reload();
    await page.locator('#dream-map[data-engine="rusterize-wasm"]').waitFor();
    assert.equal((await getState(page)).tags.find(tag => tag.name === 'Тихий лес').x, moved.x);
    await page.getByRole('button', { name: 'Приблизить карту' }).click();
    await page.getByRole('button', { name: 'Вся карта', exact: true }).click();
    await assertNoOverflow(page, `${label} map`);
    if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `${label}-map.png`), fullPage: true });
    await page.locator(`[data-map-open="${forestNode.id}"]`).click();
    assert.equal(await page.locator('[data-location-entry]').count(), 2);
    await closeReader(page);

    await route(page, 'stats');
    assert.equal(await page.locator('[data-day]').count(), 84);
    assert.equal((await page.locator('.stat-card strong').allTextContents()).join(','), '1,1,1,100%');
    await assertNoOverflow(page, `${label} statistics`);

    await route(page, 'lessons');
    assert.ok(await page.locator('[data-lesson]').count() >= 20);
    await page.locator('[data-lesson]').first().click();
    assert.ok((await page.locator('.reader-modal .prose').first().innerText()).length > 3000);
    await page.locator('[data-complete]').click();
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(await page.locator('.lesson-card.complete').count(), 1);
    await assertNoOverflow(page, `${label} lessons`);

    await route(page, 'library');
    await page.locator('#library-search').fill('MILD');
    assert.ok(await page.locator('[data-glossary]').count() > 0);
    await page.locator('[data-glossary]').first().click();
    assert.ok((await page.locator('.reader-modal .prose').innerText()).length > 150);
    await closeReader(page);
    await assertNoOverflow(page, `${label} library`);

    await route(page, 'settings');
    await page.getByRole('heading', { name: /Настройки|Личное пространство|На вашем устройстве/ }).first().waitFor();
    await assertNoOverflow(page, `${label} settings`);

    await page.evaluate(() => Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Service worker registration did not become ready within 15 seconds')), 15000)),
    ]));
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await context.setOffline(true);
    await page.reload();
    await page.locator('#main').waitFor();
    await route(page, 'diary');
    assert.equal(await page.locator('.entry-card').count(), 2);
    await page.locator('[data-action=new-entry]').first().click();
    await page.locator('#entry-title').fill('Офлайн запись');
    await page.locator('#entry-body').fill('Сохранено без подключения к сети.');
    await saveEditor(page);
    await route(page, 'lessons');
    await page.locator('[data-lesson]').first().click();
    assert.ok((await page.locator('.reader-modal .prose').first().innerText()).length > 3000);
    await closeReader(page);
    await context.setOffline(false);
    await page.reload();
    assert.equal((await getState(page)).entries.length, 3);
    assert.equal(await page.locator('.lesson-card.complete').count(), 1);
    await route(page, 'diary');
    await page.locator('#diary-search').fill('Офлайн запись');
    await page.locator('.entry-open').click();
    await page.locator('[data-edit-current]').click();
    await page.locator('#entry-title').fill('Изменённая офлайн запись');
    await page.locator('#entry-form [name=type]').selectOption('dream');
    await saveEditor(page);
    assert.equal((await getState(page)).entries.find(entry => entry.title === 'Изменённая офлайн запись').type, 'dream');
    await page.locator('.entry-open').click();
    await page.locator('[data-delete]').click();
    await page.locator('.confirm-modal [data-confirm]').click();
    await page.waitForFunction(() => !document.querySelector('.reader-modal[open]'));
    assert.equal((await getState(page)).entries.filter(entry => !entry.deletedAt).length, 2);
    await route(page, 'settings');
    const downloaded = page.waitForEvent('download');
    await page.locator('[data-export=json]').click();
    const download = await downloaded;
    const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(backup.entries.filter(entry => !entry.deletedAt).length, 2);
    assert.equal(backup.entries.find(entry => entry.title === 'Тестовая ночная гавань').images.length, 4);
    assert.ok(backup.tags.find(tag => tag.name === 'Тихий лес').image.src.startsWith('data:image/png;base64,'));
    assert.equal(backup.tags.find(tag => tag.name === 'Тихий лес').x, moved.x);
    assert.deepEqual(errors, [], `${label}: browser errors`);
    assert.deepEqual(externalRequests, [], `${label}: unexpected external requests`);
    console.log(`PASS ${label}: diary CRUD, Markdown security, six tag types, draft recovery, drawing/file/camera/paste, persistence, map, statistics, course, library, offline, backup export`);
  } catch (error) {
    if (errors.length) console.error(`${label} browser errors:`, errors);
    if (screenshotDirectory) await page.screenshot({ path: path.join(screenshotDirectory, `${label}-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function privateSomnioImport() {
  if (!process.env.SOMNIO_FIXTURE) { console.log('SKIP private Somnio fixture (set SOMNIO_FIXTURE to test an external local export)'); return; }
  const fixture = await readFile(process.env.SOMNIO_FIXTURE, 'utf8');
  const expected = parseSomnio(fixture);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const externalRequests = [];
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL).origin) externalRequests.push(request.url()); });
  try {
    await page.goto(baseURL);
    await page.locator('[data-action=import]').first().waitFor();
    const importFixture = async () => {
      const chooser = page.waitForEvent('filechooser');
      await page.locator('[data-action=import]').first().click();
      await (await chooser).setFiles(process.env.SOMNIO_FIXTURE);
      // The import preview is intentionally asserted by controls/counts only.
      await page.locator('.confirm-modal [data-confirm]').click();
      await page.waitForFunction(() => !document.querySelector('.confirm-modal[open]'));
    };
    await importFixture();
    let imported = await getState(page);
    assert.equal(imported.entries.length, expected.imported, 'Private fixture count must match parsed record count');
    assert.equal(imported.tags.length, expected.state.tags.length, 'Private fixture tag count must be preserved');
    assert.ok(imported.entries.every(entry => entry.type === 'dream'));
    // Repeat the same import through Settings and verify no duplicate dreams.
    await route(page, 'settings');
    await importFixture();
    await page.reload();
    imported = await getState(page);
    assert.equal(imported.entries.length, expected.imported, 'Duplicate import must be idempotent');
    assert.deepEqual(externalRequests, [], 'Import must never send data outside this device');
    console.log(`PASS private Somnio fixture: ${expected.imported} records; duplicate import and reload preserved counts; no external requests`);
  } finally {
    // No screenshots, tracing, videos, or persisted browser profile for private input.
    await context.close();
  }
}

try {
  await start();
  await exerciseApplication(false);
  await exerciseApplication(true);
  await privateSomnioImport();
} finally {
  await browser?.close();
  if (server) server.kill('SIGTERM');
}
