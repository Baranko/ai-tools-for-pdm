'use strict';

const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TIMES = ['09:00', '11:00', '13:00', '15:00', '17:00'];
const TIME_ZONE = 'Europe/Moscow';

function currentDate(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function json(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(data));
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw requestError(415, 'Отправьте данные в формате JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw requestError(413, 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw requestError(400, 'Не удалось прочитать данные записи.');
  }
}

function createApp({ dbPath = path.join(__dirname, 'boris.sqlite'), now = () => new Date() } = {}) {
  const html = readFileSync(path.join(__dirname, 'index.html'));
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS walk_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      walk_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      booked_by TEXT,
      booked_at TEXT,
      UNIQUE (walk_date, slot_time),
      CHECK (
        (booked_by IS NULL AND booked_at IS NULL)
        OR
        (booked_by IS NOT NULL AND booked_at IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS feedings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_name TEXT NOT NULL,
      fed_at TEXT NOT NULL
    );
  `);

  const insertSlot = db.prepare(`
    INSERT INTO walk_slots (walk_date, slot_time) VALUES (?, ?)
    ON CONFLICT (walk_date, slot_time) DO NOTHING
  `);
  const selectSlots = db.prepare(`
    SELECT id, walk_date, slot_time, booked_by, booked_at
    FROM walk_slots WHERE walk_date = ? ORDER BY slot_time
  `);
  const bookSlot = db.prepare(`
    UPDATE walk_slots SET booked_by = ?, booked_at = ?
    WHERE id = ? AND walk_date = ? AND booked_by IS NULL
  `);
  const insertFeeding = db.prepare('INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)');
  const selectLastFeeding = db.prepare('SELECT id, employee_name, fed_at FROM feedings ORDER BY id DESC LIMIT 1');

  function feedingState() {
    return { feeding: selectLastFeeding.get() || null, date: currentDate(now()), time_zone: TIME_ZONE };
  }

  function ensureSlots(date) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const time of TIMES) insertSlot.run(date, time);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function state(date) {
    return { date, time_zone: TIME_ZONE, slots: selectSlots.all(date) };
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(html);
        return;
      }

      if (request.method === 'GET' && ['/images/happyDog.jpg', '/images/sadDog.jpg'].includes(url.pathname)) {
        const image = readFileSync(path.join(__dirname, url.pathname.slice(1)));
        response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' });
        response.end(image);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/slots') {
        const date = currentDate(now());
        ensureSlots(date);
        json(response, 200, state(date));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/feedings/latest') {
        json(response, 200, feedingState());
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/feedings') {
        const data = await readJson(request);
        const name = typeof data.employee_name === 'string' ? data.employee_name.trim().replace(/\s+/g, ' ') : '';
        if (!name) throw requestError(400, 'Введите непустое ФИО.');
        insertFeeding.run(name, now().toISOString());
        json(response, 201, feedingState());
        return;
      }

      const match = url.pathname.match(/^\/api\/slots\/([1-9]\d*)\/book$/);
      if (request.method === 'POST' && match) {
        const data = await readJson(request);
        const name = typeof data.employee_name === 'string' ? data.employee_name.trim().replace(/\s+/g, ' ') : '';
        if (!name) throw requestError(400, 'Введите непустое ФИО.');
        if (typeof data.walk_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.walk_date)) {
          throw requestError(400, 'Укажите дату выбранного слота.');
        }
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id)) throw requestError(400, 'Некорректный слот.');
        const timestamp = now();
        const date = currentDate(timestamp);
        ensureSlots(date);
        if (data.walk_date !== date) {
          json(response, 409, { message: 'Наступил новый день. Выберите слот на текущую дату.', state: state(date) });
          return;
        }
        // Условие свободного слота проверяется в самой операции SQLite.
        const result = bookSlot.run(name, timestamp.toISOString(), id, date);
        if (result.changes === 0) {
          const exists = selectSlots.all(date).some((slot) => slot.id === id);
          json(response, exists ? 409 : 404, {
            message: exists ? 'Этот слот уже занят. Выберите другое время.' : 'Слот на сегодня не найден.',
            state: state(date)
          });
          return;
        }
        json(response, 200, { message: 'Запись подтверждена.', state: state(date) });
        return;
      }

      json(response, 404, { message: 'Страница или действие не найдены.' });
    } catch (error) {
      if (!error.status) console.error(error);
      if (!response.headersSent && !response.destroyed) {
        json(response, error.status || 500, {
          message: error.status ? error.message : 'Не удалось выполнить действие. Попробуйте ещё раз.'
        });
      }
    }
  });

  return {
    server,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        db.close();
        if (error) reject(error);
        else resolve();
      });
    })
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = createApp({ dbPath: process.env.BORIS_DB_PATH || path.join(__dirname, 'boris.sqlite') });
  app.server.on('error', (error) => {
    console.error('Не удалось запустить сервер:', error.message);
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`Борис ждёт прогулки: http://localhost:${app.server.address().port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => app.close().catch((error) => { console.error(error); process.exitCode = 1; }));
  }
}

module.exports = { createApp };
