/** Optional Google Drive sync. Access tokens live only in this module's memory. */
import { exportBackup, id, mergeStates, validateBackup } from './data.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
let accessToken = null;
let expiresAt = 0;
let identityScript;
let device;
let syncInProgress = false;
let authAttempt = 0;

function nativeBridge() {
  const bridge = globalThis.MOBAndroid;
  return bridge && typeof bridge.requestDriveToken === 'function' ? bridge : null;
}

export function isDriveConnected() { return Boolean(accessToken && Date.now() < expiresAt); }
export function isNativeAndroid() { return Boolean(nativeBridge()); }

function loadIdentityScript() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (identityScript) return identityScript;
  identityScript = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = setTimeout(() => { script.remove(); reject(new Error('Google не отвечает. Проверьте интернет и повторите подключение.')); }, 20_000);
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => { clearTimeout(timeout); resolve(); };
    script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Не удалось загрузить Google. Проверьте интернет и блокировщики.')); };
    document.head.append(script);
  }).catch(error => { identityScript = undefined; throw error; });
  return identityScript;
}

function acceptToken(response, attempt) {
  if (attempt !== authAttempt) throw new Error('Подключение Google отменено. Повторите подключение при необходимости.');
  if (!response || response.error || typeof response.access_token !== 'string' || !response.access_token) throw new Error(response?.error_description || response?.error || 'Google не предоставил доступ.');
  const lifetime = Number(response.expires_in ?? 3500);
  if (!Number.isFinite(lifetime) || lifetime <= 60) throw new Error('Google выдал недействительное разрешение. Повторите подключение.');
  accessToken = response.access_token;
  expiresAt = Date.now() + (lifetime - 60) * 1000;
  return { connected: true, expiresAt };
}

/** Call from a user gesture. Native APK uses Google Play services, never a WebView login. */
export async function connectDrive(clientId = '') {
  const attempt = ++authAttempt;
  const bridge = nativeBridge();
  if (bridge) {
    return new Promise((resolve, reject) => {
      const callbackName = `mobDriveAuth${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const finish = () => { clearTimeout(timeout); delete globalThis[callbackName]; };
      const timeout = setTimeout(() => { if (attempt === authAttempt) authAttempt++; finish(); reject(new Error('Вход в Google не завершён. Повторите подключение.')); }, 120_000);
      globalThis[callbackName] = response => {
        finish();
        try { resolve(acceptToken(typeof response === 'string' ? JSON.parse(response) : response, attempt)); } catch (error) { reject(error); }
      };
      try { bridge.requestDriveToken(clientId, callbackName); } catch (error) { finish(); reject(new Error(`Не удалось открыть Google: ${error.message}`)); }
    });
  }
  if (typeof clientId !== 'string' || !/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId.trim())) throw new Error('Укажите OAuth Client ID веб-приложения Google. Инструкция доступна в настройках.');
  await loadIdentityScript();
  if (attempt !== authAttempt) throw new Error('Подключение Google отменено.');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { if (attempt === authAttempt) authAttempt++; reject(new Error('Вход в Google не завершён. Разрешите всплывающее окно и повторите подключение.')); }, 120_000);
    const client = globalThis.google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(), scope: SCOPE,
      callback: response => {
        clearTimeout(timeout);
        try {
          if (response.scope && !response.scope.split(' ').includes(SCOPE)) throw new Error('Для синхронизации разрешите доступ к данным приложения на Google Диске.');
          resolve(acceptToken(response, attempt));
        } catch (error) { reject(error); }
      },
      error_callback: error => {
        clearTimeout(timeout);
        reject(new Error(error.type === 'popup_closed' ? 'Окно Google закрыто. Локальные данные сохранены.' : 'Google не смог открыть окно входа. Разрешите всплывающие окна для MOB.'));
      },
    });
    try { client.requestAccessToken({ prompt: 'select_account' }); }
    catch (error) { clearTimeout(timeout); reject(error); }
  });
}

export function disconnectDrive() {
  authAttempt++;
  const oldToken = accessToken;
  accessToken = null;
  expiresAt = 0;
  // Revocation is best-effort; disconnect always clears the in-memory credential.
  if (oldToken && globalThis.google?.accounts?.oauth2?.revoke) {
    try { globalThis.google.accounts.oauth2.revoke(oldToken, () => {}); } catch { /* Already disconnected locally. */ }
  }
  try { nativeBridge()?.disconnectDrive?.(); } catch { /* No token remains in JavaScript. */ }
}

function deviceId() {
  if (device) return device;
  try {
    const saved = globalThis.localStorage?.getItem('mob-drive-device-v1');
    if (saved && /^[a-z\d-]{8,100}$/i.test(saved)) device = saved;
  } catch { /* Storage can be disabled without disabling local journal access. */ }
  if (!device) {
    device = id('device');
    try { globalThis.localStorage?.setItem('mob-drive-device-v1', device); } catch { /* Use an isolated snapshot for this session. */ }
  }
  return device;
}

function credential() {
  if (!isDriveConnected()) {
    accessToken = null;
    throw new Error('Подключите Google Диск снова: разрешение действует только в текущем сеансе.');
  }
  return accessToken;
}

/** Dependency injection keeps the real API path covered by offline tests. */
export function createDriveClient({ fetchImpl = (...args) => fetch(...args), tokenProvider = credential, deviceIdProvider = deviceId, maxSnapshotBytes = 100 * 1024 * 1024 } = {}) {
  function checkSession(token) {
    if (tokenProvider() !== token) throw new Error('Подключение Google изменилось. Повторите синхронизацию с выбранным аккаунтом.');
  }

  async function request(token, url, options = {}) {
    checkSession(token);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 30_000);
    try {
      const response = await fetchImpl(url, { ...options, signal: abort.signal, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      checkSession(token);
      if (response.status === 401) {
        if (accessToken === token) { accessToken = null; expiresAt = 0; }
        throw new Error('Разрешение Google истекло. Подключите Диск снова.');
      }
      if (response.status === 403) throw new Error('Google запретил доступ. Проверьте, что Drive API включён, аккаунт добавлен в тестировщики и разрешение выдано.');
      if (!response.ok) throw new Error(`Google Диск вернул ошибку ${response.status}. Локальные данные сохранены; повторите позже.`);
      const maxBytes = maxSnapshotBytes;
      if (Number(response.headers?.get?.('content-length') || 0) > maxBytes) throw new Error('Резервная копия на Диске превышает 100 МБ.');
      // Keep the timeout active until the body is fully downloaded. A response
      // with headers but a stalled body must not leave sync stuck indefinitely.
      let content;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parts = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) { await reader.cancel(); throw new Error('Резервная копия на Диске превышает 100 МБ.'); }
          parts.push(decoder.decode(value, { stream: true }));
        }
        parts.push(decoder.decode());
        content = parts.join('');
      } else content = await response.text();
      checkSession(token);
      return { headers: response.headers, text: async () => content, json: async () => JSON.parse(content) };
    } catch (error) {
      abort.abort();
      if (error.name === 'AbortError') throw new Error('Google Диск не ответил вовремя. Повторите синхронизацию.');
      if (error instanceof TypeError) throw new Error('Не удалось связаться с Google Диском. Локальные данные сохранены.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function listSnapshots(token) {
    const files = [];
    const seenPages = new Set();
    let nextPageToken;
    do {
      const query = new URLSearchParams({ spaces: 'appDataFolder', q: "trashed = false and appProperties has { key='mob' and value='1' }", fields: 'files(id,name,appProperties),nextPageToken', pageSize: '100' });
      if (nextPageToken) query.set('pageToken', nextPageToken);
      const response = await request(token, `${API}/files?${query}`);
      const data = await response.json();
      if (!Array.isArray(data.files)) throw new Error('Google Диск вернул некорректный список файлов.');
      files.push(...data.files);
      nextPageToken = data.nextPageToken;
      if (nextPageToken) {
        if (typeof nextPageToken !== 'string' || nextPageToken.length > 4096 || seenPages.has(nextPageToken)) throw new Error('Google Диск вернул некорректную последовательность страниц. Повторите синхронизацию.');
        seenPages.add(nextPageToken);
      }
      if (files.length > 1000) throw new Error('На Диске слишком много копий MOB. Скачайте резервную копию и проверьте данные приложения в Google Drive.');
    } while (nextPageToken);
    return files.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  async function sync(localState) {
    const token = tokenProvider();
    let merged = validateBackup(localState);
    const currentDevice = deviceIdProvider();
    const files = await listSnapshots(token);
    let ownFile;
    for (const file of files) {
      if (typeof file.id !== 'string' || !/^[\w-]+$/.test(file.id)) throw new Error('Google Диск вернул некорректный ID файла.');
      const response = await request(token, `${API}/files/${encodeURIComponent(file.id)}?alt=media`);
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > 100 * 1024 * 1024) throw new Error('Резервная копия на Диске превышает 100 МБ. Скачайте её через экспорт данных Google.');
      let remote;
      try { remote = validateBackup(await response.text()); }
      catch (error) { throw new Error(`Не удалось прочитать копию на Google Диске. Загрузка остановлена, чтобы сохранить данные. ${error.message}`); }
      merged = mergeStates(merged, remote);
      if (file.appProperties?.device === currentDevice && !ownFile) ownFile = file;
    }
    // Every device writes only its own snapshot. Concurrent devices cannot erase
    // each other's only copy, even when their reads happen before either write.
    const cloudState = { ...merged, settings: {} };
    const body = exportBackup(cloudState);
    if (new TextEncoder().encode(body).byteLength > maxSnapshotBytes) throw new Error('Облачная копия превышает 100 МБ. Скачайте локальную резервную копию; синхронизация не изменила файлы на Диске.');
    let fileId;
    if (ownFile) {
      const response = await request(token, `${UPLOAD}/files/${encodeURIComponent(ownFile.id)}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body });
      const data = await response.json();
      fileId = data.id || ownFile.id;
    } else {
      const boundary = `mob_${id().replaceAll('-', '')}`;
      const metadata = { name: `mob-${currentDevice}.json`, parents: ['appDataFolder'], mimeType: 'application/json', appProperties: { mob: '1', device: currentDevice } };
      const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${body}\r\n--${boundary}--`;
      const response = await request(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
      const data = await response.json();
      if (typeof data.id !== 'string') throw new Error('Google не подтвердил сохранение файла. Повторите синхронизацию.');
      fileId = data.id;
    }
    return { state: merged, syncedAt: new Date().toISOString(), fileId };
  }
  return { sync };
}

const defaultClient = createDriveClient();

export async function syncDrive(state) {
  if (syncInProgress) throw new Error('Синхронизация уже выполняется.');
  syncInProgress = true;
  try {
    const run = () => defaultClient.sync(state);
    return globalThis.navigator?.locks?.request ? await navigator.locks.request('mob-drive-sync', run) : await run();
  } finally { syncInProgress = false; }
}
