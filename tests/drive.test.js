import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveClient, connectDrive, disconnectDrive, isDriveConnected } from '../src/drive.js';
import { createEmptyState } from '../src/data.js';

function response(data, status = 200) { return new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
const entry = id => ({ id, title: id, body: 'Сон', date: '2026-01-01', type: 'dream', tagIds: [], images: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const stateWith = (...entries) => ({ ...createEmptyState(), entries });
const client = fetchImpl => createDriveClient({ fetchImpl, tokenProvider: () => 'TEST_TOKEN', deviceIdProvider: () => 'device-local' });

test('first sync creates appDataFolder snapshot with scoped metadata and no local settings', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, options });
    return response(calls.length === 1 ? { files: [] } : { id: 'snapshot-1' });
  });
  const state = stateWith(entry('local')); state.settings = { googleClientId: 'client', privatePreference: 'device only' };
  const result = await api.sync(state);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /spaces=appDataFolder/);
  assert.equal(calls[1].options.method, 'POST');
  assert.match(calls[1].options.body, /"parents":\["appDataFolder"\]/);
  assert.match(calls[1].options.body, /"device":"device-local"/);
  assert.doesNotMatch(calls[1].options.body, /privatePreference|googleClientId|TEST_TOKEN/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer TEST_TOKEN');
  assert.equal(result.state.settings.privatePreference, 'device only');
  assert.equal(result.fileId, 'snapshot-1');
});

test('sync merges all device snapshots and only updates this device file', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/files?') && !url.includes('upload')) return response({ files: [{ id: 'remote-file', appProperties: { device: 'other' } }, { id: 'own-file', appProperties: { device: 'device-local' } }] });
    if (url.includes('alt=media')) return response(url.includes('remote-file') ? stateWith(entry('remote')) : stateWith(entry('prior-local')));
    return response({ id: 'own-file' });
  });
  const result = await api.sync(stateWith(entry('new-local')));
  assert.deepEqual(result.state.entries.map(record => record.id), ['new-local', 'prior-local', 'remote']);
  const upload = calls.find(call => call.options.method === 'PATCH');
  assert.match(upload.url, /own-file/);
  assert.equal(JSON.parse(upload.options.body).entries.length, 3);
  assert.equal(calls.filter(call => call.options.method === 'PATCH').length, 1);
});

test('paginated snapshots are all read before upload', async () => {
  let listPages = 0, reads = 0;
  const api = client(async (url, options) => {
    if (options.method === 'POST') return response({ id: 'created' });
    if (url.includes('alt=media')) { reads++; return response(createEmptyState()); }
    listPages++;
    return response(listPages === 1 ? { files: [{ id: 'a' }], nextPageToken: 'next' } : { files: [{ id: 'b' }] });
  });
  await api.sync(createEmptyState());
  assert.equal(listPages, 2); assert.equal(reads, 2);
});

test('corrupt remote archive blocks uploads rather than overwriting it', async () => {
  const calls = [];
  const api = client(async (url, options) => {
    calls.push(options.method || 'GET');
    return response(url.includes('alt=media') ? '{invalid' : { files: [{ id: 'remote' }] });
  });
  await assert.rejects(api.sync(createEmptyState()), /сохранить данные/);
  assert.deepEqual(calls, ['GET', 'GET']);
});

test('network and authorization failures provide actionable errors and never claim success', async () => {
  await assert.rejects(client(async () => response({}, 401)).sync(createEmptyState()), /истекло/);
  await assert.rejects(client(async () => response({}, 403)).sync(createEmptyState()), /запретил доступ/);
  await assert.rejects(client(async () => { throw new TypeError('network'); }).sync(createEmptyState()), /Локальные данные сохранены/);
});

test('native bridge connects without web client ID, and disconnect clears in-memory token', async () => {
  globalThis.MOBAndroid = { requestDriveToken(_clientId, callback) { globalThis[callback]({ access_token: 'native-test', expires_in: 3600 }); } };
  try {
    const result = await connectDrive();
    assert.equal(result.connected, true); assert.equal(isDriveConnected(), true);
    disconnectDrive(); assert.equal(isDriveConnected(), false);
    assert.equal(Object.keys(globalThis).some(key => key.startsWith('mobDriveAuth')), false);
  } finally { delete globalThis.MOBAndroid; disconnectDrive(); }
});

test('browser rejects missing OAuth config before injecting Google script', async () => {
  await assert.rejects(connectDrive(''), /OAuth Client ID/);
});

test('Google GIS receives only appData scope and tokens are never written to storage', async () => {
  let requestConfig;
  globalThis.google = { accounts: { oauth2: { initTokenClient(config) {
    requestConfig = config;
    return { requestAccessToken() { queueMicrotask(() => config.callback({ access_token: 'browser-test', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.appdata' })); } };
  } } } };
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = { setItem() { throw new Error('Credentials must not be persisted'); } };
  try {
    await connectDrive('123-test.apps.googleusercontent.com');
    assert.equal(requestConfig.scope, 'https://www.googleapis.com/auth/drive.appdata');
    assert.equal(isDriveConnected(), true);
  } finally { disconnectDrive(); delete globalThis.google; globalThis.localStorage = originalStorage; }
});

test('late native authorization after disconnect cannot silently reconnect', async () => {
  let callback;
  globalThis.MOBAndroid = { requestDriveToken(_clientId, callbackName) { callback = globalThis[callbackName]; } };
  try {
    const authorization = connectDrive();
    const rejected = assert.rejects(authorization, /отменено/);
    disconnectDrive();
    callback({ access_token: 'late-token', expires_in: 3600 });
    await rejected;
    assert.equal(isDriveConnected(), false);
  } finally { delete globalThis.MOBAndroid; disconnectDrive(); }
});

test('account changes while listing cancel sync before uploading any data', async () => {
  let token = 'account-A';
  const calls = [];
  const api = createDriveClient({ tokenProvider: () => token, deviceIdProvider: () => 'device', fetchImpl: async (url, options) => {
    calls.push(options);
    token = 'account-B';
    return response({ files: [] });
  } });
  await assert.rejects(api.sync(stateWith(entry('private-A'))), /Подключение Google изменилось/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, 'Bearer account-A');
});

test('simultaneous devices create independent snapshots and later converge', async () => {
  const files = new Map();
  const fetchImpl = async (url, options) => {
    if (options.method === 'POST') {
      const sections = options.body.split('Content-Type: application/json; charset=UTF-8\r\n\r\n');
      const metadata = JSON.parse(sections[1].split('\r\n--')[0]);
      const state = JSON.parse(sections[2].split('\r\n--')[0]);
      const id = `file-${files.size + 1}`;
      files.set(id, { id, appProperties: metadata.appProperties, state });
      return response({ id });
    }
    if (options.method === 'PATCH') {
      const id = url.match(/\/files\/([^?]+)/)[1];
      files.get(id).state = JSON.parse(options.body);
      return response({ id });
    }
    if (url.includes('alt=media')) return response(files.get(url.match(/\/files\/([^?]+)/)[1]).state);
    return response({ files: [...files.values()].map(({ id, appProperties }) => ({ id, appProperties })) });
  };
  const a = createDriveClient({ fetchImpl, tokenProvider: () => 'same-account', deviceIdProvider: () => 'A' });
  const b = createDriveClient({ fetchImpl, tokenProvider: () => 'same-account', deviceIdProvider: () => 'B' });
  await Promise.all([a.sync(stateWith(entry('entry-A'))), b.sync(stateWith(entry('entry-B')))]);
  assert.equal(files.size, 2);
  const next = await a.sync(stateWith(entry('entry-A')));
  assert.deepEqual(next.state.entries.map(record => record.id), ['entry-A', 'entry-B']);
});

test('oversized UTF-8 snapshot is rejected before creating an unreadable cloud file', async () => {
  const calls = [];
  const api = createDriveClient({ tokenProvider: () => 'test', deviceIdProvider: () => 'A', maxSnapshotBytes: 1500, fetchImpl: async (url, options) => {
    calls.push(options.method || 'GET');
    return response({ files: [] });
  } });
  const record = entry('large'); record.body = 'я'.repeat(700);
  await assert.rejects(api.sync(stateWith(record)), /Облачная копия превышает/);
  assert.deepEqual(calls, ['GET']);
});

test('repeated pagination token stops instead of leaving sync running forever', async () => {
  let calls = 0;
  const api = client(async () => { calls++; return response({ files: [], nextPageToken: 'repeated' }); });
  await assert.rejects(api.sync(createEmptyState()), /последовательность страниц/);
  assert.equal(calls, 2);
});
