import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState, extractTagNames, parseSomnio, mergeStates, validateBackup, exportBackup, restoreConflict, localDate, nextTimestamp } from '../src/data.js';

const epoch = '2026-01-01T12:00:00.000Z';
const later = '2026-01-02T12:00:00.000Z';
const makeEntry = (overrides = {}) => ({ id: 'entry-1', title: 'Лестница', body: 'Я поднялся по лестнице.', date: '2026-01-01', type: 'dream', tagIds: [], images: [], createdAt: epoch, updatedAt: epoch, ...overrides });
const makeTag = (overrides = {}) => ({ id: 'tag-1', name: 'Город', type: 'location', description: '', image: null, createdAt: epoch, updatedAt: epoch, ...overrides });
const stateWith = (...entries) => ({ ...createEmptyState(), entries });

test('empty state and backup round-trip preserve Markdown and raster illustrations', () => {
  const state = stateWith(makeEntry({ body: '# Сон\n\n**Текст** <script>alert(1)</script>', images: [{ id: 'img-1', src: 'data:image/png;base64,aGVsbG8=', caption: 'Эскиз' }] }));
  assert.deepEqual(validateBackup(exportBackup(state)), state);
});

test('extracts Unicode @ and % tags, quoted and bracketed names, excludes emails', () => {
  assert.deepEqual(extractTagNames('Почта a@host.ru; @ОС %[Дом детства] @"Старая башня" @ОС (%ночь) 50%рост'), ['ОС', 'Дом детства', 'Старая башня', 'ночь']);
});

test('localDate uses local calendar fields rather than a UTC slice', () => {
  assert.equal(localDate(new Date(2026, 9, 17, 23, 59)), '2026-10-17');
  assert.throws(() => localDate('invalid'), /дата/);
});

test('Somnio imports Unix seconds, keeps full text and maps lucid result', () => {
  const input = [{ text: 'Первый заголовок\n\nПодробный сон.', timestamp: 1767268800, tags: ['ОС', 'Город'] }];
  const { state, imported, skipped } = parseSomnio(input);
  assert.equal(imported, 1); assert.equal(skipped, 0);
  assert.equal(state.entries[0].body, input[0].text);
  assert.equal(state.entries[0].createdAt, epoch);
  assert.equal(state.entries[0].source.timestamp, input[0].timestamp);
  assert.equal(state.tags.find(tag => tag.name === 'ОС').type, 'result');
  assert.deepEqual(validateBackup(state), state);
});

test('Somnio deduplicates repeated import, tag case, ordering and seconds versus milliseconds', () => {
  const input = [{ text: 'Сон', timestamp: 1767268800, tags: ['Город', 'ОС', 'город'] }];
  const first = parseSomnio(input);
  const repeated = parseSomnio([{ ...input[0], timestamp: input[0].timestamp * 1000, tags: ['ос', 'город'] }], first.state);
  assert.equal(first.state.tags.length, 2);
  assert.equal(repeated.imported, 0); assert.equal(repeated.skipped, 1);
  assert.equal(repeated.state.entries.length, 1);
});

test('Somnio never resurrects an already imported deleted entry', () => {
  const rows = [{ text: 'Сон', timestamp: 1767268800, tags: [] }];
  const { state } = parseSomnio(rows);
  state.entries[0].deletedAt = later;
  state.entries[0].updatedAt = later;
  assert.equal(parseSomnio(rows, state).imported, 0);
});

test('Somnio reports malformed rows while retaining valid rows; all-invalid file fails', () => {
  const { imported, skipped, warnings } = parseSomnio([{ text: 'Сон', timestamp: 1767268800, tags: [] }, { text: 'Сон', timestamp: 'wrong', tags: [] }]);
  assert.equal(imported, 1); assert.equal(skipped, 1); assert.match(warnings[0], /Строка 2/);
  assert.throws(() => parseSomnio([{ text: '', timestamp: 1 }]), /нет корректных/);
  assert.throws(() => parseSomnio('not json'), /JSON/);
  assert.throws(() => parseSomnio({ other: [] }), /Ожидается/);
});

test('Somnio reuses user tag details and does not mutate existing state', () => {
  const original = { ...createEmptyState(), tags: [makeTag()] };
  const snapshot = structuredClone(original);
  const result = parseSomnio([{ text: 'Сон', timestamp: 1767268800, tags: ['город'] }], original);
  assert.equal(result.state.tags.length, 1);
  assert.equal(result.state.entries[0].tagIds[0], 'tag-1');
  assert.deepEqual(original, snapshot);
});

test('backup validation rejects unsupported versions, duplicate IDs and dangling tags', () => {
  assert.throws(() => validateBackup({ ...createEmptyState(), version: 2 }), /версии 1/);
  assert.throws(() => validateBackup(stateWith(makeEntry(), makeEntry())), /повторяются/);
  assert.throws(() => validateBackup(stateWith(makeEntry({ tagIds: ['missing'] }))), /отсутствующими/);
});

test('backup validation rejects invalid calendar dates, unsafe URLs and image SVG', () => {
  assert.throws(() => validateBackup(stateWith(makeEntry({ date: '2026-02-30' }))), /Дата/);
  for (const src of ['https://tracker.example/p.png', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    assert.throws(() => validateBackup(stateWith(makeEntry({ images: [{ src }] }))), /Иллюстрации/);
  }
});

test('backup drops prototype keys and accepts undefined optional settings', () => {
  const state = createEmptyState();
  state.settings = JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}');
  state.settings.optional = undefined;
  assert.deepEqual(validateBackup(state).settings, { theme: 'dark' });
  assert.equal({}.polluted, undefined);
});

test('merge unions independent records and preserves local preferences', () => {
  const a = stateWith(makeEntry()); a.settings = { clientId: 'local' };
  const b = stateWith(makeEntry({ id: 'entry-2' })); b.settings = { clientId: 'remote' };
  const result = mergeStates(a, b);
  assert.equal(result.entries.length, 2); assert.equal(result.settings.clientId, 'local');
  assert.equal(result.conflicts.length, 0);
});

test('merge picks newer record and preserves losing version once across repeated syncs', () => {
  const old = stateWith(makeEntry());
  const newer = stateWith(makeEntry({ body: 'Новая версия', updatedAt: later }));
  const merged = mergeStates(old, newer);
  assert.equal(merged.entries[0].body, 'Новая версия');
  assert.equal(merged.conflicts[0].record.body, 'Я поднялся по лестнице.');
  assert.deepEqual(mergeStates(merged, old), merged);
  assert.deepEqual(mergeStates(old, newer), mergeStates(newer, old));
});

test('equal-time conflicts converge deterministically and preserve both versions', () => {
  const a = stateWith(makeEntry({ body: 'Версия A' }));
  const b = stateWith(makeEntry({ body: 'Версия B' }));
  const merged = mergeStates(a, b);
  assert.deepEqual(merged, mergeStates(b, a));
  assert.equal(merged.conflicts.length, 1);
  assert.notEqual(merged.entries[0].body, merged.conflicts[0].record.body);
});

test('tombstones win time ties and stale remote versions do not revive deletions', () => {
  const live = stateWith(makeEntry());
  const deleted = stateWith(makeEntry({ deletedAt: epoch }));
  assert.equal(mergeStates(deleted, live).entries[0].deletedAt, epoch);
  assert.equal(mergeStates(live, deleted).entries[0].deletedAt, epoch);
  assert.equal(mergeStates(live, stateWith(makeEntry({ deletedAt: later, updatedAt: later }))).entries[0].deletedAt, later);
});

test('restoring an archived version preserves current version and sets a fresh timestamp', () => {
  const merged = mergeStates(stateWith(makeEntry()), stateWith(makeEntry({ body: 'Новая версия', updatedAt: later })));
  const restored = restoreConflict(merged, merged.conflicts[0].id);
  assert.equal(restored.entries[0].body, 'Я поднялся по лестнице.');
  assert.equal(restored.conflicts[0].record.body, 'Новая версия');
  assert.ok(Date.parse(restored.entries[0].updatedAt) > Date.parse(later));
});

test('progress completion and reset merge by per-lesson timestamps', () => {
  const a = createEmptyState(), b = createEmptyState();
  a.progress = { lesson: { completed: true, updatedAt: epoch }, legacy: false };
  b.progress = { lesson: { completed: false, updatedAt: later }, legacy: true };
  assert.deepEqual(mergeStates(a, b).progress, { lesson: { completed: false, updatedAt: later }, legacy: true });
});

test('archived deleted versions restore deletion while live versions revive the entry', () => {
  const deleted = makeEntry({ deletedAt: later, updatedAt: later });
  const merged = mergeStates(stateWith(makeEntry()), stateWith(deleted));
  const revived = restoreConflict(merged, merged.conflicts.find(c => !c.record.deletedAt).id);
  assert.equal(revived.entries[0].deletedAt, undefined);
  const deletedAgain = restoreConflict(revived, revived.conflicts.find(c => c.record.deletedAt).id);
  assert.equal(deletedAgain.entries[0].deletedAt, deletedAgain.entries[0].updatedAt);
  assert.ok(Date.parse(deletedAgain.entries[0].deletedAt) > Date.parse(later));
  assert.ok(deletedAgain.conflicts.some(c => !c.record.deletedAt));
});

test('backup rejects archived versions referencing nonexistent tags', () => {
  const state = createEmptyState();
  state.conflicts = [{ collection: 'entries', record: makeEntry({ tagIds: ['missing'] }) }];
  assert.throws(() => validateBackup(state), /архиве версий.*отсутствующими/);
});

test('nextTimestamp uses wall time or strictly follows the newest previous record clock', t => {
  t.mock.method(Date, 'now', () => Date.parse(epoch));
  assert.equal(nextTimestamp(), epoch);
  assert.equal(nextTimestamp('invalid'), epoch);
  assert.equal(nextTimestamp(epoch), '2026-01-01T12:00:00.001Z');
  assert.equal(nextTimestamp(Date.parse(later)), '2026-01-02T12:00:00.001Z');
  assert.equal(nextTimestamp({ updatedAt: later, deletedAt: '2030-01-01T00:00:00.000Z' }), '2030-01-01T00:00:00.001Z');
  assert.equal(nextTimestamp({ createdAt: '2031-01-01T00:00:00.000Z' }), '2031-01-01T00:00:00.001Z');
});

test('edit and restore remain selected after merging a device with a future clock', t => {
  t.mock.method(Date, 'now', () => Date.parse(epoch));
  const future = makeEntry({ body: 'Future-clock version', updatedAt: '2030-01-01T00:00:00.000Z' });
  const edit = { ...future, body: 'User correction', updatedAt: nextTimestamp(future) };
  assert.equal(mergeStates(stateWith(edit), stateWith(future)).entries[0].body, 'User correction');
  const merged = mergeStates(stateWith(makeEntry()), stateWith(future));
  const restored = restoreConflict(merged, merged.conflicts[0].id);
  assert.equal(restored.entries[0].updatedAt, '2030-01-01T00:00:00.001Z');
  assert.equal(mergeStates(restored, stateWith(future)).entries[0].body, makeEntry().body);
});
