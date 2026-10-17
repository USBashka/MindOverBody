import test from 'node:test';
import assert from 'node:assert/strict';
import { alive, defaultEntryType, buildGraph, diaryStats, isLucid, daysBack, demoState } from '../src/model.js';
import { validateBackup } from '../src/data.js';

const tag = (id, type, name = id, extra = {}) => ({ id, type, name, ...extra });
const entry = (id, tagIds, extra = {}) => ({ id, type: 'dream', date: '2026-10-17', tagIds, ...extra });

test('first entry of each local day defaults to dream; deleted records do not count', () => {
  const entries = [entry('a', [], { date: '2026-10-16' }), entry('b', [], { deletedAt: '2026-10-17T10:00:00Z' })];
  assert.equal(defaultEntryType(entries, '2026-10-17'), 'dream');
  entries.push(entry('c', [], { type: 'practice' }));
  assert.equal(defaultEntryType(entries, '2026-10-17'), 'practice');
  assert.equal(defaultEntryType(entries, '2026-10-18'), 'dream');
  assert.equal(alive(entries).length, 2);
});

test('map weights links by shared records and ties characters to encountered locations', () => {
  const state = {
    tags: [tag('a', 'location', 'Лес', { x: 0, y: 25 }), tag('b', 'location', 'Дом'), tag('c', 'character', 'Проводник'), tag('os', 'result', ' ОС '), tag('gone', 'location', 'Удалено', { deletedAt: '2026-10-17T10:00:00Z' })],
    entries: [entry('one', ['a', 'b', 'c', 'os']), entry('two', ['a', 'b']), entry('three', ['a']), entry('deleted', ['a', 'os'], { deletedAt: '2026-10-17T10:00:00Z' })],
  };
  const graph = buildGraph(state);
  assert.equal(graph.nodes.length, 2);
  const forest = graph.nodes.find(node => node.id === 'a');
  assert.deepEqual({ x: forest.x, y: forest.y, count: forest.count, lucidCount: forest.lucidCount }, { x: 0, y: 25, count: 3, lucidCount: 1 });
  assert.deepEqual(graph.edges, [{ source: 'a', target: 'b', count: 2 }]);
  assert.deepEqual(graph.characters[0].locations, ['a', 'b']);
  assert.ok(Number.isFinite(graph.nodes[1].x));
});

test('lucid percentage counts dreams only and ignores removed tags', () => {
  const state = {
    tags: [tag('os', 'result', 'ОС'), tag('removed', 'result', 'lucid', { deletedAt: '2026-10-17T10:00:00Z' }), tag('a', 'location')],
    entries: [entry('a', ['os']), entry('b', ['os'], { type: 'practice' }), entry('c', ['removed'], { date: '2026-10-16' }), entry('d', ['os'], { deletedAt: '2026-10-17T10:00:00Z' })],
  };
  assert.deepEqual(diaryStats(state), { total: 3, dreams: 2, practice: 1, lucid: 1, days: 2, locations: 1 });
  assert.equal(isLucid(state.entries[2], state.tags), false);
});

test('calendar uses calendar dates across leap days and month boundaries', () => {
  assert.deepEqual(daysBack(3, new Date(2024, 2, 1, 12)), ['2024-02-28', '2024-02-29', '2024-03-01']);
  assert.deepEqual(daysBack(3, new Date(2026, 0, 1, 12)), ['2025-12-30', '2025-12-31', '2026-01-01']);
  assert.deepEqual(daysBack(0), []);
});

test('built-in fictional demo is a complete valid state', () => {
  const demo = validateBackup(demoState());
  assert.equal(demo.entries.length, 4);
  assert.equal(demo.tags.length, 6);
  assert.equal(buildGraph(demo).nodes.length, 3);
  assert.equal(diaryStats(demo).lucid, 1);
});
