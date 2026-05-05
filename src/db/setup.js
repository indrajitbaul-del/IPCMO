// src/db/setup.js — uses node:sqlite (built into Node v22+/v24)
const path = require('path');
const fs   = require('fs');

const DB_DIR = path.join(__dirname, '../../data');
fs.mkdirSync(DB_DIR, { recursive: true });

const { getDb } = require('./index');
const bcrypt = require('bcryptjs');
const db = getDb();

console.log('Setting up database...');

// Create all tables — exec each separately (node:sqlite is strict about multi-statement)
const tables = [
`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'site_user', company TEXT, location TEXT,
  active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`,
`CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL, location TEXT, client TEXT, active INTEGER DEFAULT 1,
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
`CREATE TABLE IF NOT EXISTS pipe_master (
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_code TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL, material TEXT NOT NULL, size_nominal TEXT NOT NULL,
  size_od_mm REAL, wall_thickness_mm REAL, schedule TEXT, standard TEXT,
  cutting_allowance_mm REAL DEFAULT 5, project_id INTEGER, created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')))`,
`CREATE TABLE IF NOT EXISTS pipe_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pipe_tag TEXT UNIQUE NOT NULL,
  item_code TEXT NOT NULL, heat_number TEXT, full_length_mm REAL NOT NULL,
  current_length_mm REAL NOT NULL, status TEXT DEFAULT 'available',
  location TEXT, received_date TEXT, remarks TEXT, project_id INTEGER,
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now')))`,
`CREATE TABLE IF NOT EXISTS spools (
  id INTEGER PRIMARY KEY AUTOINCREMENT, spool_no TEXT NOT NULL,
  iso_no TEXT NOT NULL, description TEXT, project_id INTEGER,
  status TEXT DEFAULT 'pending', created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now')))`,
`CREATE TABLE IF NOT EXISTS spool_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, spool_id INTEGER NOT NULL,
  part_no TEXT NOT NULL, item_code TEXT NOT NULL,
  required_length_mm REAL NOT NULL, qty INTEGER DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS cutting_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plan_no TEXT UNIQUE NOT NULL,
  project_id INTEGER, simulated_by INTEGER,
  simulated_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'draft', notes TEXT)`,
`CREATE TABLE IF NOT EXISTS cutting_plan_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL,
  spool_id INTEGER NOT NULL, part_no TEXT NOT NULL, item_code TEXT NOT NULL,
  pipe_tag TEXT NOT NULL, required_length_mm REAL NOT NULL,
  cutting_allowance_mm REAL DEFAULT 5, actual_cut_mm REAL NOT NULL,
  cut_from TEXT NOT NULL, source_remnant_id INTEGER, sequence_on_pipe INTEGER DEFAULT 0,
  iso_no_snapshot TEXT, spool_no_snapshot TEXT)`,
`CREATE TABLE IF NOT EXISTS remnants (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rem_no TEXT UNIQUE NOT NULL,
  item_code TEXT NOT NULL, heat_number TEXT, size_nominal TEXT, description TEXT,
  source_pipe_tag TEXT NOT NULL, source_plan_id INTEGER,
  theoretical_length_mm REAL NOT NULL, actual_length_mm REAL,
  theoretical_qty INTEGER DEFAULT 1, actual_qty INTEGER,
  status TEXT DEFAULT 'available', location TEXT, last_updated_by INTEGER,
  last_updated_at TEXT DEFAULT (datetime('now')), project_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')))`,
`CREATE TABLE IF NOT EXISTS remnant_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, remnant_id INTEGER NOT NULL,
  used_in_plan_id INTEGER NOT NULL, used_in_spool_id INTEGER NOT NULL,
  part_no TEXT NOT NULL, length_used_mm REAL NOT NULL, used_by INTEGER,
  used_at TEXT DEFAULT (datetime('now')))`,
`CREATE TABLE IF NOT EXISTS remnant_upload_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, upload_no TEXT UNIQUE NOT NULL,
  uploaded_by INTEGER, uploaded_at TEXT DEFAULT (datetime('now')),
  filename TEXT, rows_processed INTEGER, rows_updated INTEGER,
  rows_failed INTEGER, notes TEXT)`,
`CREATE TABLE IF NOT EXISTS remnant_upload_detail (
  id INTEGER PRIMARY KEY AUTOINCREMENT, upload_id INTEGER NOT NULL,
  rem_no TEXT, field_updated TEXT, old_value TEXT, new_value TEXT, status TEXT)`,
`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
  module TEXT NOT NULL, record_id TEXT, details TEXT, ip TEXT,
  timestamp TEXT DEFAULT (datetime('now')))`,
`CREATE TABLE IF NOT EXISTS cutting_allowance_chart (
  id INTEGER PRIMARY KEY AUTOINCREMENT, size_nominal TEXT NOT NULL,
  material TEXT NOT NULL, od_mm REAL, cutting_method TEXT NOT NULL,
  allowance_mm REAL NOT NULL, bevel_allowance_mm REAL DEFAULT 0,
  total_mm REAL NOT NULL, standard TEXT, notes TEXT)`
];

tables.forEach(sql => db.exec(sql));
console.log('✓ All tables ready');

// ── MIGRATIONS for existing databases ──────────────────────────────────────
function addColumnIfMissing(table, colDef) {
  const colName = colDef.split(' ')[0];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === colName)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      console.log(`✓ Migration: added ${table}.${colName}`);
    } catch (e) {
      console.error(`Migration failed for ${table}.${colName}:`, e.message);
    }
  }
}
addColumnIfMissing('cutting_plan_details', 'iso_no_snapshot TEXT');
addColumnIfMissing('cutting_plan_details', 'spool_no_snapshot TEXT');
addColumnIfMissing('cutting_plan_details', 'entry_type TEXT DEFAULT \'auto\'');
addColumnIfMissing('remnants', 'notes TEXT');
addColumnIfMissing('pipe_stock', 'length_unit TEXT DEFAULT \'mm\'');

// Backfill snapshots for existing rows where they're NULL
try {
  const result = db.prepare(`UPDATE cutting_plan_details
    SET iso_no_snapshot = (SELECT iso_no FROM spools WHERE spools.id = cutting_plan_details.spool_id),
        spool_no_snapshot = (SELECT spool_no FROM spools WHERE spools.id = cutting_plan_details.spool_id)
    WHERE iso_no_snapshot IS NULL OR spool_no_snapshot IS NULL`).run();
  if (result.changes > 0) console.log(`✓ Backfilled ISO/Spool snapshot on ${result.changes} existing detail rows`);
} catch (e) { /* non-fatal */ }

// Seed admin
const adminExists = db.prepare("SELECT id FROM users WHERE username='admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync('Admin@1234', 10);
  db.prepare('INSERT INTO users (username,password_hash,full_name,role,company) VALUES (?,?,?,?,?)')
    .run('admin', hash, 'System Administrator', 'admin', 'Default');
  console.log('✓ Admin created  →  admin / Admin@1234');
}

// Seed cutting allowance chart
const caExists = db.prepare('SELECT id FROM cutting_allowance_chart LIMIT 1').get();
if (!caExists) {
  const ins = db.prepare('INSERT INTO cutting_allowance_chart (size_nominal,material,od_mm,cutting_method,allowance_mm,bevel_allowance_mm,total_mm,standard,notes) VALUES (?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  [
    ['1/2"','Carbon Steel',21.3,'Hacksaw/Disc',3,2,5,'ASME B31.3','Small bore — disc cut + bevel face'],
    ['3/4"','Carbon Steel',26.7,'Hacksaw/Disc',3,2,5,'ASME B31.3','Small bore'],
    ['1"','Carbon Steel',33.4,'Hacksaw/Disc',3,2,5,'ASME B31.3','Small bore'],
    ['1.5"','Carbon Steel',48.3,'Disc/Plasma',3,2,5,'ASME B31.3','Small bore'],
    ['2"','Carbon Steel',60.3,'Disc/Plasma',3,2,5,'ASME B31.3',''],
    ['3"','Carbon Steel',88.9,'Plasma/Oxy-fuel',4,3,7,'ASME B31.3','Medium bore'],
    ['4"','Carbon Steel',114.3,'Plasma/Oxy-fuel',4,3,7,'ASME B31.3',''],
    ['6"','Carbon Steel',168.3,'Plasma/Oxy-fuel',5,3,8,'ASME B31.3','Large bore'],
    ['8"','Carbon Steel',219.1,'Plasma/Oxy-fuel',5,3,8,'ASME B31.3',''],
    ['10"','Carbon Steel',273.1,'Plasma/Oxy-fuel',6,4,10,'ASME B31.3','Heavy wall'],
    ['12"','Carbon Steel',323.9,'Plasma/Oxy-fuel',6,4,10,'ASME B31.3',''],
    ['16"','Carbon Steel',406.4,'Plasma/Oxy-fuel',6,4,10,'ASME B31.3',''],
    ['1/2"','Stainless Steel',21.3,'Plasma/TIG Disc',3,2,5,'ASME B31.3','SS — plasma preferred'],
    ['2"','Stainless Steel',60.3,'Plasma/TIG Disc',3,2,5,'ASME B31.3',''],
    ['4"','Stainless Steel',114.3,'Plasma',4,3,7,'ASME B31.3',''],
    ['6"','Stainless Steel',168.3,'Plasma',5,3,8,'ASME B31.3',''],
    ['2"','HDPE',63.0,'Band Saw',2,0,2,'ISO 11922','No bevel allowance'],
    ['4"','HDPE',125.0,'Band Saw',3,0,3,'ISO 11922',''],
    ['6"','HDPE',180.0,'Band Saw',3,0,3,'ISO 11922',''],
    ['2"','GRE/GRP',73.0,'Diamond Disc',5,3,8,'AWWA C950','Extra allowance'],
    ['4"','GRE/GRP',128.0,'Diamond Disc',5,3,8,'AWWA C950',''],
    ['6"','GRE/GRP',182.0,'Diamond Disc',6,4,10,'AWWA C950',''],
    ['2"','Duplex/SS',60.3,'Plasma',4,3,7,'ASME B31.3','Harder material'],
    ['4"','Duplex/SS',114.3,'Plasma',5,3,8,'ASME B31.3',''],
    ['2"','Copper-Nickel',60.3,'Band Saw/Disc',3,2,5,'ASME B31.3','CuNi soft'],
    ['4"','Copper-Nickel',114.3,'Band Saw/Disc',4,2,6,'ASME B31.3',''],
  ].forEach(r => ins.run(...r));
  db.exec('COMMIT');
  console.log('✓ Cutting allowance chart seeded');
}

// Default project
const projExists = db.prepare("SELECT id FROM projects WHERE code='DEFAULT'").get();
if (!projExists) {
  db.prepare('INSERT INTO projects (code,name,location,client) VALUES (?,?,?,?)')
    .run('DEFAULT', 'Default Project', 'Site A', 'Internal');
  console.log('✓ Default project created');
}

console.log('✓ Database ready:', path.resolve(DB_DIR, 'ipcmo.db'));
