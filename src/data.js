/** Local-first data model. This module never sends data over the network. */
export const DATA_VERSION = 1;
export const TAG_TYPES = ['modifier', 'location', 'character', 'theme', 'reference', 'result'];
const DB_NAME = 'mob-journal';
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const EPOCH = '1970-01-01T00:00:00.000Z';
let database;

export function id(prefix = '') {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return prefix ? `${prefix}-${value}` : value;
}

export function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Некорректная дата.');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createEmptyState() {
  return { version: DATA_VERSION, entries: [], tags: [], progress: {}, settings: {}, conflicts: [] };
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
const normalizedName = name => name.normalize('NFKC').trim().toLocaleLowerCase('ru');
const text = (value, max, field, fallback = '') => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > max) throw new Error(`Некорректное поле «${field}».`);
  return value;
};
const timestamp = (value, fallback = EPOCH) => {
  if (value === undefined || value === null || value === '') return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isFinite(new Date(value).getTime())) throw new Error('В файле есть некорректная дата изменения.');
  return new Date(value).toISOString();
};

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function extractTagNames(body = '') {
  if (typeof body !== 'string') return [];
  // A boundary excludes email addresses and percentages embedded in words.
  const pattern = /(?:^|[\s([{>])[@%](?:\[([^\]\n]{1,120})\]|"([^"\n]{1,120})"|([\p{L}\p{N}_][\p{L}\p{N}_-]{0,119}))/gu;
  const names = new Map();
  for (const match of body.matchAll(pattern)) {
    const name = (match[1] || match[2] || match[3]).trim();
    if (name) names.set(normalizedName(name), name);
  }
  return [...names.values()];
}

function normalizeImage(image, index = 0) {
  if (typeof image === 'string') image = { src: image };
  if (!plain(image)) throw new Error('Некорректная иллюстрация.');
  const src = text(image.src, 28 * 1024 * 1024, 'иллюстрация');
  // Backups are self-contained and cannot cause tracking requests or SVG execution.
  if (!/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z\d+/=\s]+$/i.test(src)) throw new Error('Иллюстрации должны быть встроенными PNG, JPEG, WebP, GIF или AVIF.');
  return { id: text(image.id, 200, 'ID иллюстрации', `image-${index}-${hash(src)}`), src, caption: text(image.caption, 2000, 'подпись') };
}

function normalizeRecord(record, collection) {
  if (!plain(record)) throw new Error('Некорректная запись в резервной копии.');
  const recordId = text(record.id, 200, 'ID');
  if (!recordId || /[\u0000-\u001f]/.test(recordId)) throw new Error('У каждой записи должен быть корректный ID.');
  const updatedAt = timestamp(record.updatedAt, timestamp(record.createdAt));
  const result = { id: recordId, createdAt: timestamp(record.createdAt, updatedAt), updatedAt };
  if (record.deletedAt) result.deletedAt = timestamp(record.deletedAt);
  if (collection === 'entries') {
    if (!validDate(record.date)) throw new Error('Дата записи должна иметь формат ГГГГ-ММ-ДД.');
    if (!['dream', 'practice'].includes(record.type)) throw new Error('Неизвестный тип записи.');
    if (!Array.isArray(record.tagIds) || record.tagIds.some(t => typeof t !== 'string' || t.length > 200)) throw new Error('Некорректные теги записи.');
    if (!Array.isArray(record.images ?? []) || (record.images?.length ?? 0) > 100) throw new Error('Некорректный список иллюстраций.');
    Object.assign(result, {
      title: text(record.title, 500, 'заголовок'), body: text(record.body, 2_000_000, 'текст'),
      date: record.date, type: record.type, tagIds: [...new Set(record.tagIds)],
      images: (record.images ?? []).map(normalizeImage),
    });
    if (plain(record.source) && record.source.app === 'somnio') {
      result.source = { app: 'somnio', fingerprint: text(record.source.fingerprint, 200, 'источник'), timestamp: Number(record.source.timestamp) || 0 };
    }
  } else {
    if (!TAG_TYPES.includes(record.type)) throw new Error('Неизвестный тип тега.');
    const name = text(record.name, 120, 'название тега').trim();
    if (!name) throw new Error('Название тега не может быть пустым.');
    Object.assign(result, { name, type: record.type, description: text(record.description, 100_000, 'описание тега'), image: record.image ? normalizeImage(record.image) : null });
    for (const key of ['x', 'y']) if (Number.isFinite(record[key])) result[key] = Math.max(-100_000, Math.min(100_000, record[key]));
  }
  return result;
}

function safeObject(value, label) {
  if (value === undefined) return {};
  if (!plain(value)) throw new Error(`Некорректное поле «${label}».`);
  // Use own data properties and strip dangerous keys from arbitrary preference maps.
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    if (item === undefined) continue;
    const serialized = JSON.stringify(item);
    if (!serialized || key.length > 200 || serialized.length > 100_000) throw new Error(`Слишком большое поле «${label}».`);
    result[key] = clone(item);
  }
  return result;
}

export function validateBackup(input) {
  let value = input;
  if (typeof input === 'string') {
    if (input.length > MAX_BACKUP_BYTES) throw new Error('Файл больше 100 МБ. Разделите архив или уменьшите иллюстрации.');
    try { value = JSON.parse(input); } catch { throw new Error('Не удалось прочитать JSON. Выберите резервную копию MOB.'); }
  }
  if (!plain(value) || value.version !== DATA_VERSION || !Array.isArray(value.entries) || !Array.isArray(value.tags)) throw new Error('Это не резервная копия MOB версии 1.');
  if (value.entries.length > 100_000 || value.tags.length > 100_000) throw new Error('В файле слишком много записей или тегов.');
  const result = createEmptyState();
  for (const collection of ['entries', 'tags']) {
    result[collection] = value[collection].map(record => normalizeRecord(record, collection));
    const ids = result[collection].map(record => record.id);
    if (new Set(ids).size !== ids.length) throw new Error('В резервной копии повторяются ID записей.');
  }
  const tagIds = new Set(result.tags.map(tag => tag.id));
  if (result.entries.some(entry => entry.tagIds.some(tagId => !tagIds.has(tagId)))) throw new Error('В резервной копии есть записи с отсутствующими тегами.');
  result.progress = safeObject(value.progress, 'прогресс');
  result.settings = safeObject(value.settings, 'настройки');
  if (value.conflicts !== undefined && (!Array.isArray(value.conflicts) || value.conflicts.length > 100_000)) throw new Error('Некорректный или слишком большой архив версий.');
  result.conflicts = (value.conflicts ?? []).map(conflict => {
    if (!plain(conflict) || !['entries', 'tags'].includes(conflict.collection)) throw new Error('Некорректная сохранённая версия.');
    const record = normalizeRecord(conflict.record, conflict.collection);
    return { id: conflictId(conflict.collection, record), collection: conflict.collection, recordId: record.id, record };
  });
  if (result.conflicts.some(conflict => conflict.collection === 'entries' && conflict.record.tagIds.some(tagId => !tagIds.has(tagId)))) throw new Error('В архиве версий есть запись с отсутствующими тегами.');
  result.conflicts = [...new Map(result.conflicts.map(conflict => [conflict.id, conflict])).values()];
  return result;
}

export function exportBackup(state) {
  return JSON.stringify({ ...validateBackup(state), exportedAt: new Date().toISOString(), application: 'MOB' }, null, 2);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// A deterministic 64-bit fingerprint is used for deduplication, never for security.
function hash(value) {
  let a = 2166136261, b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519); }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

function conflictId(collection, record) { return `${collection}-${record.id}-${hash(stable(record))}`; }
function recordClock(record) { return Math.max(Date.parse(record.updatedAt) || 0, Date.parse(record.deletedAt) || 0); }

/** Merge without discarding either device's version. Preferences remain local. */
export function mergeStates(local, remote) {
  const left = validateBackup(local), right = validateBackup(remote);
  const result = createEmptyState();
  const conflicts = new Map([...left.conflicts, ...right.conflicts].map(c => [c.id, c]));
  for (const collection of ['entries', 'tags']) {
    const records = new Map(left[collection].map(record => [record.id, record]));
    for (const incoming of right[collection]) {
      const current = records.get(incoming.id);
      if (!current) { records.set(incoming.id, incoming); continue; }
      if (stable(current) === stable(incoming)) continue;
      const clockDifference = recordClock(incoming) - recordClock(current);
      const incomingWins = clockDifference > 0 || (clockDifference === 0 && (
        Boolean(incoming.deletedAt) !== Boolean(current.deletedAt) ? Boolean(incoming.deletedAt) : stable(incoming) > stable(current)
      ));
      const winner = incomingWins ? incoming : current;
      const alternate = incomingWins ? current : incoming;
      conflicts.set(conflictId(collection, alternate), { id: conflictId(collection, alternate), collection, recordId: alternate.id, record: alternate });
      records.set(incoming.id, winner);
    }
    result[collection] = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  // Do not keep the currently selected version in the alternative-version archive.
  for (const collection of ['entries', 'tags']) for (const record of result[collection]) conflicts.delete(conflictId(collection, record));
  result.conflicts = [...conflicts.values()].sort((a, b) => a.id.localeCompare(b.id));
  result.settings = left.settings;
  const progressKeys = new Set([...Object.keys(left.progress), ...Object.keys(right.progress)]);
  for (const key of progressKeys) {
    const a = left.progress[key], b = right.progress[key];
    if (a === undefined) result.progress[key] = b;
    else if (b === undefined) result.progress[key] = a;
    else if (typeof a === 'boolean' && typeof b === 'boolean') result.progress[key] = a || b;
    else if (plain(a) && plain(b)) {
      const difference = (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0);
      result.progress[key] = difference ? (difference > 0 ? a : b) : stable(a) >= stable(b) ? a : b;
    }
    else result.progress[key] = stable(a) >= stable(b) ? a : b;
  }
  return result;
}

export function restoreConflict(state, savedId) {
  const result = validateBackup(state);
  const saved = result.conflicts.find(conflict => conflict.id === savedId);
  if (!saved) throw new Error('Сохранённая версия не найдена.');
  const current = result[saved.collection].find(record => record.id === saved.recordId);
  if (current) result.conflicts.push({ id: conflictId(saved.collection, current), collection: saved.collection, recordId: current.id, record: clone(current) });
  const restored = { ...clone(saved.record), updatedAt: new Date(Math.max(Date.now(), recordClock(saved.record) + 1, current ? recordClock(current) + 1 : 0)).toISOString() };
  // Restoring a deletion restores that action too; choosing an earlier live
  // version explicitly revives the record without losing the deletion history.
  if (restored.deletedAt) restored.deletedAt = restored.updatedAt;
  result[saved.collection] = result[saved.collection].filter(record => record.id !== saved.recordId).concat(restored);
  result.conflicts = result.conflicts.filter(conflict => conflict.id !== savedId);
  result.conflicts = [...new Map(result.conflicts.map(conflict => [conflict.id, conflict])).values()];
  return result;
}

export function parseSomnio(input, existingState = createEmptyState()) {
  let records = input;
  if (typeof input === 'string') {
    if (input.length > MAX_BACKUP_BYTES) throw new Error('Файл импорта больше 100 МБ.');
    try { records = JSON.parse(input); } catch { throw new Error('Не удалось прочитать JSON Somnio.'); }
  }
  if (!Array.isArray(records)) {
    records = plain(records) ? records.dreams ?? records.entries ?? records.history : null;
  }
  if (!Array.isArray(records) || records.length > 100_000) throw new Error('Ожидается JSON Somnio: список снов с полями text, timestamp и tags.');
  const state = validateBackup(existingState);
  const fingerprints = new Set(state.entries.filter(entry => entry.source?.app === 'somnio').map(entry => entry.source.fingerprint));
  const entryIds = new Set(state.entries.map(entry => entry.id));
  const tagsByName = new Map(state.tags.filter(tag => !tag.deletedAt).map(tag => [normalizedName(tag.name), tag]));
  let imported = 0, skipped = 0;
  const warnings = [];
  records.forEach((record, index) => {
    try {
      if (!plain(record) || typeof record.text !== 'string' || !record.text.trim() || record.text.length > 2_000_000) throw new Error('пустой или некорректный текст');
      const rawTimestamp = record.timestamp;
      if (typeof rawTimestamp !== 'number' || !Number.isFinite(rawTimestamp) || rawTimestamp <= 0) throw new Error('некорректный timestamp');
      const milliseconds = rawTimestamp < 100_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
      const date = new Date(milliseconds);
      if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) throw new Error('некорректная дата');
      if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some(tag => typeof tag !== 'string' || tag.trim().length > 120))) throw new Error('некорректные теги');
      const names = [...new Map((record.tags ?? []).map(name => [normalizedName(name), name.trim()])).values()].filter(Boolean);
      const fingerprint = hash(stable({ timestamp: milliseconds, text: record.text, tags: names.map(normalizedName).sort() }));
      const entryId = `somnio-${fingerprint}`;
      if (fingerprints.has(fingerprint) || entryIds.has(entryId)) { skipped++; return; }
      const createdAt = date.toISOString();
      const tagIds = names.map(name => {
        const normalized = normalizedName(name);
        let tag = tagsByName.get(normalized);
        if (!tag) {
          tag = { id: `somnio-tag-${hash(normalized)}`, name, type: ['ос', 'lucid', 'осознанный сон'].includes(normalized) ? 'result' : 'theme', description: '', image: null, createdAt, updatedAt: createdAt };
          // A removed imported tag keeps its tombstone; reimport uses a fresh ID.
          if (state.tags.some(item => item.id === tag.id)) tag.id = id('tag');
          state.tags.push(tag); tagsByName.set(normalized, tag);
        }
        return tag.id;
      });
      const firstLine = record.text.trim().split(/\r?\n/, 1)[0].replace(/^#{1,6}\s*/, '').trim();
      const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim().slice(0, 500) : firstLine.slice(0, 80) + (firstLine.length > 80 ? '…' : '');
      state.entries.push({ id: entryId, title, body: record.text, date: localDate(date), type: 'dream', tagIds, images: [], createdAt, updatedAt: createdAt, source: { app: 'somnio', fingerprint, timestamp: rawTimestamp } });
      fingerprints.add(fingerprint); entryIds.add(entryId); imported++;
    } catch (error) {
      skipped++; warnings.push(`Строка ${index + 1}: ${error.message}.`);
    }
  });
  if (records.length > 0 && imported === 0 && warnings.length === records.length) throw new Error(`В файле нет корректных записей Somnio. ${warnings[0]}`);
  return { state, imported, skipped, warnings };
}

function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Браузер не предоставляет локальное хранилище IndexedDB. Откройте MOB в обычном окне современного браузера.')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(new Error('Не удалось открыть локальное хранилище. Проверьте разрешения браузера.'));
    request.onblocked = () => reject(new Error('Закройте другие вкладки MOB и повторите открытие.'));
  }).catch(error => { database = undefined; throw error; });
  return database;
}

export async function loadState() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('state', 'readonly');
    const request = transaction.objectStore('state').get('current');
    request.onsuccess = () => {
      try { resolve(request.result ? validateBackup(request.result) : createEmptyState()); }
      catch (error) { reject(new Error(`Локальные данные не удалось прочитать: ${error.message} Данные сохранены в браузере и не перезаписаны.`)); }
    };
    request.onerror = () => reject(new Error('Не удалось прочитать локальные данные.'));
  });
}

export async function saveState(state) {
  const normalized = validateBackup(state);
  const db = await openDatabase();
  const saved = await new Promise((resolve, reject) => {
    const transaction = db.transaction('state', 'readwrite');
    const storage = transaction.objectStore('state');
    // Reading and merging inside one write transaction also serializes saves
    // across tabs. A stale tab cannot replace another tab's unseen entries.
    const request = storage.get('current');
    let merged;
    request.onsuccess = () => {
      try {
        merged = request.result ? mergeStates(normalized, request.result) : normalized;
        storage.put(merged, 'current');
      } catch (error) {
        transaction.abort();
        reject(new Error(`Сохранение остановлено, чтобы не повредить локальные данные: ${error.message}`));
      }
    };
    transaction.oncomplete = () => resolve(merged);
    transaction.onerror = () => reject(new Error(transaction.error?.name === 'QuotaExceededError' ? 'Хранилище заполнено. Скачайте резервную копию и освободите место на устройстве.' : 'Не удалось сохранить данные. Скачайте резервную копию, прежде чем закрывать приложение.'));
    transaction.onabort = () => reject(new Error('Сохранение прервано. Скачайте резервную копию, прежде чем закрывать приложение.'));
  });
  return saved;
}

export async function requestPersistentStorage() {
  try { return Boolean(await globalThis.navigator?.storage?.persist?.()); } catch { return false; }
}
