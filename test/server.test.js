'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');

const DATE = '2026-11-08';
const NOW = () => new Date(DATE + 'T09:00:00Z');
const ANNA = 'Анна Тестова';
const ILYA = 'Илья Примеров';

function databasePath() {
  // Каждый запуск изолирован: рабочая boris.sqlite не меняется.
  return path.join(mkdtempSync(path.join(tmpdir(), 'boris-test-')), 'test.sqlite');
}

async function serve(t, options = {}) {
  const app = createApp({ dbPath: databasePath(), now: NOW, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  return `http://127.0.0.1:${app.server.address().port}`;
}

async function state(base) {
  const response = await fetch(base + '/api/slots');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

async function book(base, id, employee_name, walk_date = DATE) {
  const response = await fetch(`${base}/api/slots/${id}/book`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employee_name, walk_date })
  });
  return { status: response.status, data: await response.json() };
}

async function lastFeeding(base) {
  const response = await fetch(base + '/api/feedings/latest');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}

async function feed(base, employee_name) {
  const response = await fetch(base + '/api/feedings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // Время из клиента сервер должен игнорировать.
    body: JSON.stringify({ employee_name, fed_at: '2000-01-01T00:00:00Z' })
  });
  return { status: response.status, data: await response.json() };
}

test('страница отдаётся сервером; сегодня ровно пять свободных слотов без дублей', async (t) => {
  const dbPath = databasePath();
  const base = await serve(t, { dbPath });
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<html lang="ru">/);
  const first = await state(base);
  assert.equal(first.date, DATE);
  assert.equal(first.time_zone, 'Europe/Moscow');
  assert.deepEqual(first.slots.map((slot) => slot.slot_time), ['09:00', '11:00', '13:00', '15:00', '17:00']);
  assert.ok(first.slots.every((slot) => slot.booked_by === null && slot.booked_at === null));
  assert.deepEqual(await state(base), first);
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('SELECT count(*) AS total FROM walk_slots').get().total, 5);
  assert.equal(db.prepare('SELECT count(*) AS total FROM feedings').get().total, 0);
  assert.throws(() => db.prepare('UPDATE walk_slots SET booked_by = ? WHERE id = ?').run(ANNA, first.slots[0].id), /CHECK/);
  db.close();
  assert.equal((await fetch(base + '/boris.sqlite')).status, 404);
  assert.equal((await fetch(base + '/server.js')).status, 404);
  for (const filename of ['happyDog.jpg', 'sadDog.jpg']) {
    const image = await fetch(base + '/images/' + filename);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), readFileSync(path.join(__dirname, '../images', filename)));
  }
  assert.equal((await fetch(base + '/images/server.js')).status, 404);
});

test('ФИО проверяется сервером и нормализуется; другой клиент видит запись', async (t) => {
  const base = await serve(t);
  const initial = await state(base);
  const id = initial.slots[0].id;
  for (const name of ['', '   ', '\t\n', null, 42]) {
    assert.equal((await book(base, id, name)).status, 400);
  }
  assert.equal((await state(base)).slots[0].booked_by, null);
  const result = await book(base, id, '  Анна   Тестова  ');
  assert.equal(result.status, 200);
  assert.equal(result.data.state.slots[0].booked_by, ANNA);
  assert.equal(result.data.state.slots[0].booked_at, NOW().toISOString());
  assert.equal((await state(base)).slots[0].booked_by, ANNA);
  assert.equal((await book(base, 999999, ILYA)).status, 404);
});

test('два сервера с общей SQLite: ровно один победитель, повтор не перезаписывает ФИО', async (t) => {
  const dbPath = databasePath();
  const first = await serve(t, { dbPath });
  const second = await serve(t, { dbPath });
  const id = (await state(first)).slots[0].id;
  const responses = await Promise.all([book(first, id, ANNA), book(second, id, ILYA)]);
  assert.deepEqual(responses.map((result) => result.status).sort(), [200, 409]);
  const winner = responses.find((result) => result.status === 200).data.state.slots[0];
  const conflict = responses.find((result) => result.status === 409);
  assert.match(conflict.data.message, /уже занят/);
  assert.equal(conflict.data.state.slots[0].booked_by, winner.booked_by);
  assert.equal((await book(second, id, 'Другой Тестов')).status, 409);
  assert.deepEqual((await state(first)).slots[0], winner);
  assert.deepEqual((await state(second)).slots[0], winner);
});

test('новый московский день создаёт пять слотов; старая вкладка не записывает на вчера', async (t) => {
  let instant = '2026-11-08T20:59:59Z';
  const base = await serve(t, { now: () => new Date(instant) });
  const yesterday = await state(base);
  assert.equal(yesterday.date, DATE);
  await book(base, yesterday.slots[0].id, ANNA);
  const feeding = await feed(base, ANNA);
  assert.equal(feeding.data.date, DATE);
  instant = '2026-11-08T21:00:00Z';
  const stale = await book(base, yesterday.slots[1].id, ILYA);
  assert.equal(stale.status, 409);
  assert.match(stale.data.message, /новый день/);
  assert.equal(stale.data.state.date, '2026-11-09');
  assert.equal(stale.data.state.slots.length, 5);
  assert.ok(stale.data.state.slots.every((slot) => slot.booked_by === null));
  const afterMidnight = await lastFeeding(base);
  assert.equal(afterMidnight.date, '2026-11-09');
  assert.deepEqual(afterMidnight.feeding, feeding.data.feeding);
});

test('пустая карточка; новая отметка хранит ФИО и серверное время, последняя побеждает при одинаковом времени', async (t) => {
  const dbPath = databasePath();
  const base = await serve(t, { dbPath });
  const walks = await state(base);
  assert.deepEqual(await lastFeeding(base), { feeding: null, date: DATE, time_zone: 'Europe/Moscow' });
  const first = await feed(base, '  Анна   Тестова  ');
  assert.equal(first.status, 201);
  assert.equal(first.data.feeding.employee_name, ANNA);
  assert.equal(first.data.feeding.fed_at, NOW().toISOString());
  assert.deepEqual(await lastFeeding(base), first.data);
  const second = await feed(base, ILYA);
  assert.equal(second.status, 201);
  assert.equal(second.data.feeding.employee_name, ILYA);
  assert.ok(second.data.feeding.id > first.data.feeding.id);
  assert.deepEqual(await lastFeeding(base), second.data);
  const db = new DatabaseSync(dbPath);
  assert.deepEqual(db.prepare('SELECT employee_name FROM feedings ORDER BY id').all().map((row) => row.employee_name), [ANNA, ILYA]);
  db.close();
  assert.deepEqual(await state(base), walks);
});

test('кормление: сервер отклоняет пустые ФИО и некорректные запросы, сохраняя последнюю отметку', async (t) => {
  const base = await serve(t);
  const first = await feed(base, ANNA);
  for (const name of ['', '   ', '\t\n', null, 42, [], {}]) {
    assert.equal((await feed(base, name)).status, 400);
  }
  const malformed = await fetch(base + '/api/feedings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{'
  });
  assert.equal(malformed.status, 400);
  const wrongType = await fetch(base + '/api/feedings', { method: 'POST', body: ANNA });
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await lastFeeding(base), first.data);
});

async function startProcess(t, dbPath) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '0', BORIS_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  t.after(stop);
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Сервер не запустился: ' + errors)), 10000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Сервер завершился: ' + errors)); });
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  return { base, stop };
}

test('SQLite-файл сохраняет запись после завершения и нового запуска процесса Node.js', async (t) => {
  const dbPath = databasePath();
  const first = await startProcess(t, dbPath);
  const initial = await state(first.base);
  const result = await book(first.base, initial.slots[0].id, ANNA, initial.date);
  assert.equal(result.status, 200);
  const feeding = await feed(first.base, ILYA);
  assert.equal(feeding.status, 201);
  await first.stop();
  assert.equal(readFileSync(dbPath).subarray(0, 16).toString(), 'SQLite format 3\0');
  const second = await startProcess(t, dbPath);
  assert.deepEqual(await state(second.base), result.data.state);
  assert.deepEqual(await lastFeeding(second.base), feeding.data);
});
