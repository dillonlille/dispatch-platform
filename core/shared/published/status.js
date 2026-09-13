'use strict';
const path = require('node:path');
const { openDatabase, transaction } = require('./database');
function saveStatus(directory, values, timestamp = Date.now()) {
  const db = openDatabase(path.join(directory, 'runtime.sqlite3'), { write: true });
  try {
    db.exec('CREATE TABLE IF NOT EXISTS status(key TEXT PRIMARY KEY,body TEXT NOT NULL,updated_at INTEGER NOT NULL); PRAGMA user_version=1;');
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO status VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at');
      for (const [key, value] of Object.entries(values)) {
        const body = JSON.stringify(value);
        if (Buffer.byteLength(body) > 256 * 1024) throw new Error('published_status_too_large');
        insert.run(key, body, timestamp);
      }
    });
  } finally { db.close(); }
}
function readStatus(directory, key) {
  const db = openDatabase(path.join(directory, 'runtime.sqlite3'));
  if (!db) return null;
  try {
    const row = db.prepare('SELECT body,updated_at FROM status WHERE key=?').get(key);
    return row ? { value: JSON.parse(row.body), observedAt: row.updated_at } : null;
  } finally { db.close(); }
}
module.exports = { saveStatus, readStatus };
