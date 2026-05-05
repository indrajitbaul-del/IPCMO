// src/db/index.js
// Uses Node.js built-in SQLite (node:sqlite) — available in Node v22.5+ and v24+
// ZERO external dependencies, ZERO compilation, ZERO Python required.
// Falls back to better-sqlite3 if available (Node v18/v20 users).
const path = require('path');
const fs   = require('fs');

const DB_PATH = path.join(__dirname, '../../data/ipcmo.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;

function getDb() {
  if (_db) return _db;

  // ── 1. Node.js built-in SQLite (Node v22.5+ / v24+) ─────────────────────
  //    No installation needed — ships with Node itself.
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    // node:sqlite API is identical to better-sqlite3 — no wrapper needed
    _db = db;
    return _db;
  } catch (e) {
    if (!e.message.includes('Cannot find module')) {
      // node:sqlite exists but threw another error
      throw e;
    }
    // Node < v22.5 — fall through to better-sqlite3
  }

  // ── 2. better-sqlite3 (Node v18 / v20 users) ────────────────────────────
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    _db = db;
    return _db;
  } catch (_) {}

  throw new Error(
    'SQLite not available.\n' +
    'You are using Node.js ' + process.version + '.\n' +
    'SOLUTION: Update Node.js to v22 or v24 (recommended):\n' +
    '  https://nodejs.org  →  Download LTS (v22.x)\n' +
    'OR run: npm rebuild better-sqlite3'
  );
}

module.exports = { getDb };
