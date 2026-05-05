// src/routes/api.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const { requireLogin, requireRole, auditLog } = require('../middleware/auth');
const { getDb } = require('../db/index');
const { runCuttingEngine } = require('../utils/cuttingEngine');
const {
  exportCuttingPlanXLS, exportCuttingPlanPDF,
  exportRemnantRegisterXLS, exportSiteUpdateTemplate, exportRemnantPDF
} = require('../utils/exportUtils');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(requireLogin);

// shorthand
const db = () => getDb();
const p = (sql) => db().prepare(sql);

// ─── AUTH ─────────────────────────────────────────────────────────────────────
router.get('/me', (req, res) => res.json(req.session.user));

router.post('/auth/change-password', (req, res) => {
  const { current, newPass } = req.body;
  if (!newPass || newPass.length < 8)
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const user = p('SELECT * FROM users WHERE id=?').get(req.session.user?.id);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  if (!bcrypt.compareSync(current, user.password_hash))
    return res.status(400).json({ error: 'Current password incorrect' });
  p('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPass, 10), user.id);
  auditLog(db(), req.session.user.id, 'CHANGE_PASSWORD', 'users', user.id, {}, req.ip);
  res.json({ ok: true });
});

// Admin reset any user password
router.post('/users/:id/reset-password', requireRole('admin'), (req, res) => {
  const { newPass } = req.body;
  if (!newPass || newPass.length < 6) return res.status(400).json({ error: 'Password too short' });
  const user = p('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  p('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPass, 10), req.params.id);
  auditLog(db(), req.session.user.id, 'ADMIN_RESET_PASSWORD', 'users', req.params.id, {}, req.ip);
  res.json({ ok: true });
});

// ─── USERS ────────────────────────────────────────────────────────────────────
router.get('/users', requireRole('admin'), (req, res) => {
  res.json(p('SELECT id,username,full_name,role,company,location,active,created_at,last_login FROM users').all());
});

router.post('/users', requireRole('admin'), (req, res) => {
  const { username, password, full_name, role, company, location } = req.body;
  if (!username || !password || !full_name || !role)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const r = p('INSERT INTO users (username,password_hash,full_name,role,company,location) VALUES (?,?,?,?,?,?)')
      .run(username, hash, full_name, role, company || '', location || '');
    auditLog(db(), req.session.user.id, 'CREATE_USER', 'users', r.lastInsertRowid, { username }, req.ip);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'Username already exists' }); }
});

router.put('/users/:id', requireRole('admin'), (req, res) => {
  const { full_name, role, company, location, active } = req.body;
  p('UPDATE users SET full_name=?,role=?,company=?,location=?,active=? WHERE id=?')
    .run(full_name, role, company, location, active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ─── PROJECTS ─────────────────────────────────────────────────────────────────
router.get('/projects', (req, res) =>
  res.json(p('SELECT * FROM projects ORDER BY created_at DESC').all()));

router.post('/projects', requireRole('admin', 'engineer'), (req, res) => {
  const { code, name, location, client } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'Project code and name are required' });
  // Validate code: uppercase letters, numbers, hyphens only, max 12 chars
  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 12);
  if (!cleanCode) return res.status(400).json({ error: 'Invalid project code — use letters, numbers and hyphens only' });
  try {
    const r = p('INSERT INTO projects (code,name,location,client,created_by) VALUES (?,?,?,?,?)')
      .run(cleanCode, name.trim(), location || '', client || '', req.session.user.id);
    auditLog(db(), req.session.user.id, 'CREATE_PROJECT', 'projects', r.lastInsertRowid, { code: cleanCode, name }, req.ip);
    res.json({ id: r.lastInsertRowid, code: cleanCode });
  } catch(e) {
    res.status(400).json({ error: 'Project code already exists: ' + cleanCode });
  }
});

router.put('/projects/:id', requireRole('admin', 'engineer'), (req, res) => {
  const { name, location, client, active } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const proj = p('SELECT code FROM projects WHERE id=?').get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (proj.code === 'DEFAULT' && active === false) return res.status(400).json({ error: 'Cannot deactivate the Default project' });
  p('UPDATE projects SET name=?,location=?,client=?,active=? WHERE id=?')
    .run(name.trim(), location || '', client || '', active === false ? 0 : 1, req.params.id);
  auditLog(db(), req.session.user.id, 'EDIT_PROJECT', 'projects', req.params.id, req.body, req.ip);
  res.json({ ok: true });
});

router.delete('/projects/:id', requireRole('admin'), (req, res) => {
  const proj = p('SELECT * FROM projects WHERE id=?').get(req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (proj.code === 'DEFAULT') return res.status(400).json({ error: 'Cannot delete the Default project' });
  const inUse = p('SELECT COUNT(*) as c FROM pipe_stock WHERE project_id=?').get(req.params.id)?.c || 0;
  const inPlans = p('SELECT COUNT(*) as c FROM cutting_plans WHERE project_id=?').get(req.params.id)?.c || 0;
  if (inUse + inPlans > 0) return res.status(400).json({ error: `Cannot delete: project has ${inUse} stock record(s) and ${inPlans} cutting plan(s). Deactivate instead.` });
  p('DELETE FROM projects WHERE id=?').run(req.params.id);
  auditLog(db(), req.session.user.id, 'DELETE_PROJECT', 'projects', req.params.id, { code: proj.code }, req.ip);
  res.json({ ok: true });
});

// ─── PIPE MASTER ──────────────────────────────────────────────────────────────
router.get('/pipe-master', (req, res) => {
  const { project_id } = req.query;
  let sql = 'SELECT pm.*, p.code as project_code FROM pipe_master pm LEFT JOIN projects p ON pm.project_id=p.id';
  const params = [];
  if (project_id) { sql += ' WHERE pm.project_id=?'; params.push(project_id); }
  sql += ' ORDER BY pm.item_code';
  res.json(p(sql).all(...params));
});

// Distinct values for dashboard slicers
router.get('/pipe-master/slicer-options', (req, res) => {
  const { project_id } = req.query;
  const pf = project_id ? 'WHERE project_id=?' : '';
  const pa = project_id ? [project_id] : [];
  // FIX-SLICER: filter out empty strings as well as NULLs — bulk-uploaded rows
  // often have material/size/schedule='' which broke the slicer match downstream
  const materials = p(`SELECT DISTINCT material FROM pipe_master ${pf} ORDER BY material`).all(...pa).map(r=>r.material).filter(v=>v&&v.trim());
  const sizes     = p(`SELECT DISTINCT size_nominal FROM pipe_master ${pf} ORDER BY size_nominal`).all(...pa).map(r=>r.size_nominal).filter(v=>v&&v.trim());
  const schedules = p(`SELECT DISTINCT schedule FROM pipe_master ${pf} ORDER BY schedule`).all(...pa).map(r=>r.schedule).filter(v=>v&&v.trim());
  res.json({ materials, sizes, schedules });
});

// Feature 3 & 4: return distinct materials with their short material codes for simulation batching
router.get('/pipe-master/material-codes', (req, res) => {
  const { project_id } = req.query;
  const pa = project_id ? [project_id] : [];
  const mats = p(`SELECT DISTINCT material FROM pipe_master ${project_id ? 'WHERE project_id=?' : ''} ORDER BY material`).all(...pa).map(r => r.material).filter(Boolean);
  // Map full material name → short code
  const CODE_MAP = {
    'Carbon Steel': 'CS',
    'Low Temp Carbon Steel': 'LTCS',
    'Stainless Steel 316/316L': 'SS316',
    'Stainless Steel 316L': 'SS316',
    'Stainless Steel 304': 'SS304',
    'Stainless Steel': 'SS',
    'Super Duplex SS': 'SDSS',
    'Duplex SS': 'DSS',
    'Nickel Alloy': 'NI',
    'Copper-Nickel 90/10': 'CUNI',
    'Carbon Steel Galvanised': 'GALV',
    'GRE/FRP': 'GRE',
    'HDPE': 'HDPE',
    'Alloy Steel': 'ALLOY',
  };
  const result = mats.map(mat => ({
    material: mat,
    code: CODE_MAP[mat] || mat.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0, 8)
  }));
  res.json(result);
});

// Parse item code and return auto-populated fields
// Convention: MATERIAL-SIZEin-SCHEDULE e.g. CS-4IN-SCH40, SS316-2IN-XS, LTCS-6IN-SCH80S
router.get('/pipe-master/parse-code', (req, res) => {
  const { code } = req.query;
  if (!code) return res.json({});
  const upper = code.toUpperCase().trim();

  // Material patterns (check longest first)
  const MAT_MAP = [
    { pat: /^SS316L?/,  mat: 'Stainless Steel 316/316L', std: 'ASME B36.19' },
    { pat: /^SS304L?/,  mat: 'Stainless Steel 304/304L', std: 'ASME B36.19' },
    { pat: /^SDSS/,     mat: 'Super Duplex SS',           std: 'ASME B36.19' },
    { pat: /^DSS/,      mat: 'Duplex SS',                 std: 'ASME B36.19' },
    { pat: /^SS/,       mat: 'Stainless Steel',           std: 'ASME B36.19' },
    { pat: /^LTCS/,     mat: 'Low Temp Carbon Steel',     std: 'ASME B36.10' },
    { pat: /^CS/,       mat: 'Carbon Steel',              std: 'ASME B36.10' },
    { pat: /^GRE/,      mat: 'GRE/FRP',                  std: 'ASME B31.3'  },
    { pat: /^HDPE/,     mat: 'HDPE',                      std: 'ISO 4427'    },
    { pat: /^CUNI/,     mat: 'Copper-Nickel 90/10',       std: 'ASME B36.10' },
    { pat: /^NI/,       mat: 'Nickel Alloy',              std: 'ASME B36.10' },
    { pat: /^ALLOY/,    mat: 'Alloy Steel',               std: 'ASME B36.10' },
    { pat: /^GALV/,     mat: 'Carbon Steel Galvanised',   std: 'ASME B36.10' },
    { pat: /^AH/,       mat: 'Carbon Steel',              std: 'ASME B36.10' }, // ADNOC codes start with AH
  ];

  let material = null, standard = null;
  for (const { pat, mat, std } of MAT_MAP) {
    if (pat.test(upper)) { material = mat; standard = std; break; }
  }

  // Size patterns: 4IN → 4", 2IN → 2", 12IN → 12", 1-1-2IN → 1.1/2"
  let size_nominal = null;
  const sizeMatch = upper.match(/(\d+)-?(\d+)?-?(\d+)?IN/);
  if (sizeMatch) {
    const [, a, b, c] = sizeMatch;
    if (b && c) size_nominal = `${a}.${b}/${c}"`;       // e.g. 1-1-2 → 1.1/2"
    else if (b) size_nominal = `${a}.${b}"`;            // e.g. 1-2 → 1.2"
    else size_nominal = `${a}"`;                         // e.g. 4 → 4"
  }

  // Schedule patterns
  let schedule = null;
  const SCH_MAP = [
    [/SCH160|SCH-160|S160/, 'Sch 160'], [/SCH140|SCH-140/, 'Sch 140'],
    [/SCH120|SCH-120|S120/, 'Sch 120'], [/SCH100|SCH-100/, 'Sch 100'],
    [/SCH80S|SCH-80S|S80S/, 'Sch 80S'],[/SCH80|SCH-80|S80(?!S)/, 'Sch 80'],
    [/SCH60|SCH-60/, 'Sch 60'],
    [/SCH40S|SCH-40S|S40S/, 'Sch 40S'],[/SCH40|SCH-40|S40(?!S)/, 'Sch 40'],
    [/SCH30|SCH-30/, 'Sch 30'], [/SCH20|SCH-20/, 'Sch 20'],
    [/SCH10S|SCH-10S|S10S/, 'Sch 10S'],[/SCH10|SCH-10|S10(?!S)/, 'Sch 10'],
    [/SCH5S|SCH-5S|S5S/, 'Sch 5S'],
    [/XXS|DBLXS/, 'XXS'], [/XS(?!$)/, 'XS'], [/STD/, 'Std'],
  ];
  for (const [pat, sch] of SCH_MAP) {
    if (pat.test(upper)) { schedule = sch; break; }
  }

  // Default cutting allowance by material
  const cutting_allowance_mm = (material || '').includes('GRE') ? 3 : 5;

  res.json({ material, size_nominal, schedule, standard, cutting_allowance_mm });
});

// ── Shared description parser (used by parse-desc endpoint AND bulk upload) ──
// Handles real material list formats e.g.:
//   "4in  Pipe Sch80  BE  CS  A106 Gr B  Smls  ASME B36.10 Non-Sour"
//   "1in  Pipe 2.5mm WT  BE  CU Alloy 20 Bar  90/10 UNS C7060X  Smls EEMUA 234"
//   "10in  Pipe 31.75mm WT  BE  HYCS API 5L Gr X60 PSL-2 Impact Tested ..."
//   "4in  Cont Filament Pipe  Cont Filament Wound ... GRE"
//   "4in  Pipe  17.5mm WT  BE  SS  A312 TP316/316L Dual Cert. ..."
function parseDescription(desc) {
  if (!desc) return {};
  const d = String(desc).trim();
  const u = d.toUpperCase();

  // ── MATERIAL — ordered most-specific first; CS is absolute last resort ──
  // Critical ordering rules:
  //   1. GRE/Cont Filament before everything (contains no steel keywords)
  //   2. CuNi before CS (descriptions contain "CU" not "CS")
  //   3. LTCS before SS — "LTCS" contains no "SS" but "SMLS" does contain "S"
  //   4. SS/stainless before plain CS catch-all
  //   5. HYCS / API 5L before plain CS (already Carbon Steel, but explicit)
  //   6. Plain CS / A106 / HDG absolutely last
  // Strip CLAD specifications before material matching so clad alloy specs
  // don't override the base material (e.g. "CS A106 + CLAD SS316L" → base is CS)
  const dForMat = d.replace(/\+\s*(?:\d+\s*mm\s*)?CLAD\s+[\w\s\/]+/gi, '');

  const MAT_RULES = [
    // GRE / FRP — Cont Filament Wound pipe
    [/cont[\s-]*filament|\bGRE\b|\bFRP\b|\bGRP\b|\bGRV\b/i, 'GRE/FRP', 'ISO 14692'],
    // Nickel Alloy — B423, NI ALLOY only (UNS N-numbers excluded: appear in CLAD specs on CS pipes)
    [/\bB423\b|\bNI\s+ALLOY\b/i, 'Nickel Alloy', 'ASME B36.19'],
    // Super Duplex — SDSS, A790, UNS S32760
    [/\bSDSS\b|\bA790\b|UNS\s*S327/i, 'Super Duplex SS', 'ASME B36.19'],
    // Copper-Nickel — before CS (CU ALLOY / 90/10 / C7060X / EEMUA 234)
    [/90\/10|UNS\s*C7060|\bCU\s+ALLOY\b|EEMUA\s*234|\bCUNI\b|copper[\s-]*nickel/i, 'Copper-Nickel 90/10', 'EEMUA 234'],
    // LTCS — before SS to avoid SMLS matching \bSS\b
    [/\bLTCS\b|\bA333\b|A671.*CC65|A672.*C65|\bCC65\b/i, 'Low Temp Carbon Steel', 'ASME B36.10'],
    // Stainless — A312, A358, TP316, Dual Cert, \bSS\b — but NOT when SS appears only after CLAD
    [/\bA312\b|\bA358\b|\bTP316\b|316L|316\/316L|\bSS\b|stainless/i, 'Stainless Steel 316/316L', 'ASME B36.19'],
    // High-yield CS — HYCS, API 5L
    [/\bHYCS\b|\bAPI\s*5L\b/i, 'Carbon Steel', 'ASME B36.10'],
    // Plain CS — A106, \bCS\b, HDG, FBE, CLAD (last resort)
    [/\bA106\b|\bCS\b|\bHDG\b|\bFBE\b|\bCLAD\b|carbon\s+steel/i, 'Carbon Steel', 'ASME B36.10'],
  ];
  let material = null, standard = null;
  for (const [pat, mat, std] of MAT_RULES) {
    if (pat.test(dForMat)) { material = mat; standard = std; break; }
  }
  // Use explicitly-stated ASME standard from description when present
  if (/ASME\s+B36\.19/i.test(d) && material && !['GRE/FRP','Copper-Nickel 90/10'].includes(material)) standard = 'ASME B36.19';
  else if (/ASME\s+B36\.10/i.test(d)) standard = 'ASME B36.10';
  else if (/EEMUA\s+234/i.test(d)) standard = 'EEMUA 234';
  else if (/ISO\s+14692/i.test(d)) standard = 'ISO 14692';

  // ── SIZE ─────────────────────────────────────────────────────────────────
  const DN_MAP = {
    '15':'1/2"','20':'3/4"','25':'1"','32':'1.1/4"','40':'1.1/2"',
    '50':'2"','65':'2.1/2"','80':'3"','100':'4"','125':'5"','150':'6"',
    '200':'8"','250':'10"','300':'12"','350':'14"','400':'16"','450':'18"',
    '500':'20"','600':'24"','700':'28"','750':'30"','800':'32"','900':'36"',
    '1050':'42"','1200':'48"',
  };
  let size_nominal = null, m;
  // Compound fraction: 0.5in 0.75in 1.5in 2.5in at start or with "in"
  m = u.match(/^([\d.]+)\s*IN\b/);
  if (m) {
    const n = parseFloat(m[1]);
    if (n === 0.5) size_nominal = '1/2"';
    else if (n === 0.75) size_nominal = '3/4"';
    else if (n === 1.25) size_nominal = '1.1/4"';
    else if (n === 1.5) size_nominal = '1.1/2"';
    else if (n === 2.5) size_nominal = '2.1/2"';
    else size_nominal = `${n}"`;
  }
  if (!size_nominal) { m = u.match(/(\d+)[.\-](\d+)\/(\d+)\s*["\']?/); if (m) size_nominal = `${m[1]}.${m[2]}/${m[3]}"`; }
  if (!size_nominal) { m = u.match(/(\d+)\/(\d+)\s*["\']?\s*(?:INCH\b)?/); if (m) size_nominal = `${m[1]}/${m[2]}"`; }
  if (!size_nominal) { m = u.match(/\bDN\s*(\d+)\b/); if (m) size_nominal = DN_MAP[m[1]] || null; }
  if (!size_nominal) { m = u.match(/\b(\d+)\s*(?:"|INCH\b|\bIN\b)/); if (m) size_nominal = m[1] + '"'; }

  // ── SCHEDULE ─────────────────────────────────────────────────────────────
  const SCH_MAP = [
    [/SCH[\s\-]?160|SCHEDULE\s*160/, 'Sch 160'],
    [/SCH[\s\-]?140/, 'Sch 140'],
    [/SCH[\s\-]?120|SCHEDULE\s*120/, 'Sch 120'],
    [/SCH[\s\-]?100/, 'Sch 100'],
    [/SCH[\s\-]?80\s*S/, 'Sch 80S'],
    [/SCH[\s\-]?80(?!\s*S)|SCHEDULE\s*80/, 'Sch 80'],
    [/SCH[\s\-]?60/, 'Sch 60'],
    [/SCH[\s\-]?40\s*S/, 'Sch 40S'],
    [/SCH[\s\-]?40(?!\s*S)|SCHEDULE\s*40/, 'Sch 40'],
    [/SCH[\s\-]?30/, 'Sch 30'],
    [/SCH[\s\-]?20/, 'Sch 20'],
    [/SCH[\s\-]?10\s*S/, 'Sch 10S'],
    [/SCH[\s\-]?10(?!\s*S)|SCHEDULE\s*10/, 'Sch 10'],
    [/SCH[\s\-]?5\s*S/, 'Sch 5S'],
    [/\bXXS\b|\bDOUBLE\s*EXTRA\s*STRONG/, 'XXS'],
    [/\bXS\b|\bEXTRA\s*STRONG/, 'XS'],
    [/\bSTD\b|\bSTANDARD\s*(?:WEIGHT)?/, 'Std'],
  ];
  let schedule = null;
  for (const [pat, sch] of SCH_MAP) { if (pat.test(u)) { schedule = sch; break; } }

  // ── WALL THICKNESS — extract from description if no schedule matched ─────
  // Formats: "2.5mm WT", "31.75mm WT", "8.7 mm WT", "34.40mm WT", "17.5mm WT"
  let wall_thickness_mm = null;
  const wtMatch = u.match(/([\d]+\.?[\d]*)\s*MM\s*WT\b/);
  if (wtMatch) wall_thickness_mm = parseFloat(wtMatch[1]);

  // ── OD from ASME table ────────────────────────────────────────────────────
  const PIPE_DIMS = {
    '1/2"':{'od':21.3,'sch':{'Sch 40':2.77,'Sch 80':3.73,'Sch 160':4.78,'XXS':7.47,'Sch 80S':3.73,'Std':2.77,'XS':3.73}},
    '3/4"':{'od':26.7,'sch':{'Sch 40':2.87,'Sch 80':3.91,'Sch 160':5.56,'Std':2.87,'XS':3.91,'Sch 80S':3.91}},
    '1"':  {'od':33.4,'sch':{'Sch 40':3.38,'Sch 80':4.55,'Sch 160':6.35,'XXS':9.09,'Std':3.38,'XS':4.55,'Sch 80S':4.55,'Sch 40S':3.38,'Sch 160':6.35}},
    '1.1/4"':{'od':42.2,'sch':{'Sch 40':3.56,'Sch 80':4.85,'Sch 160':6.35,'Std':3.56,'XS':4.85}},
    '1.1/2"':{'od':48.3,'sch':{'Sch 40':3.68,'Sch 80':5.08,'Sch 160':7.14,'XXS':10.16,'Std':3.68,'XS':5.08,'Sch 80S':5.08}},
    '2"':  {'od':60.3,'sch':{'Sch 40':3.91,'Sch 40S':3.91,'Sch 80':5.54,'Sch 80S':5.54,'Sch 160':8.74,'XXS':11.07,'Std':3.91,'XS':5.54}},
    '3"':  {'od':88.9,'sch':{'Sch 40':5.49,'Sch 40S':5.49,'Sch 80':7.62,'Sch 80S':7.62,'Sch 160':11.13,'XXS':15.24,'Std':5.49,'XS':7.62,'Sch 10S':3.05}},
    '4"':  {'od':114.3,'sch':{'Sch 40':6.02,'Sch 40S':6.02,'Sch 80':8.56,'Sch 80S':8.56,'Sch 120':11.13,'Sch 160':13.49,'XXS':17.12,'Std':6.02,'XS':8.56,'Sch 10S':3.05}},
    '6"':  {'od':168.3,'sch':{'Sch 40':7.11,'Sch 40S':7.11,'Sch 80':10.97,'Sch 80S':10.97,'Sch 120':14.27,'Sch 160':18.26,'XXS':21.95,'Std':7.11,'XS':10.97,'Sch 10S':3.40}},
    '8"':  {'od':219.1,'sch':{'Sch 40':8.18,'Sch 40S':8.18,'Sch 80':12.70,'Sch 80S':12.70,'Sch 120':18.26,'Sch 140':20.62,'Sch 160':23.01,'XXS':22.23,'Std':8.18,'XS':12.70,'Sch 10S':3.76,'Sch 20':6.35,'Sch 30':7.04,'Sch 60':15.09}},
    '10"': {'od':273.1,'sch':{'Sch 20':6.35,'Sch 30':7.80,'Sch 40':9.27,'Sch 60':12.70,'Sch 80':15.09,'Sch 100':18.26,'Sch 120':21.44,'Sch 140':25.40,'Sch 160':28.58,'XXS':25.40,'Std':9.27,'XS':12.70,'Sch 10S':4.19}},
    '12"': {'od':323.9,'sch':{'Sch 20':6.35,'Sch 30':8.38,'Sch 40':10.31,'Sch 60':14.27,'Sch 80':17.48,'Sch 100':21.44,'Sch 120':25.40,'Sch 140':28.58,'Sch 160':33.32,'XXS':25.40,'Std':9.53,'XS':12.70,'Sch 10S':4.57}},
    '14"': {'od':355.6,'sch':{'Sch 10':6.35,'Sch 20':7.92,'Sch 30':9.53,'Sch 40':11.13,'Sch 60':15.09,'Sch 80':19.05,'Sch 100':23.83,'Sch 120':27.79,'Sch 140':31.75,'Sch 160':35.71,'Std':9.53,'XS':12.70,'Sch 10S':6.35}},
    '16"': {'od':406.4,'sch':{'Sch 10':6.35,'Sch 20':7.92,'Sch 30':9.53,'Sch 40':12.70,'Sch 60':16.66,'Sch 80':21.44,'Sch 100':26.19,'Sch 120':30.96,'Sch 140':36.53,'Sch 160':40.49,'Std':9.53,'XS':12.70,'Sch 10S':6.35}},
    '18"': {'od':457.2,'sch':{'Sch 10':6.35,'Sch 20':7.92,'Sch 30':11.13,'Sch 40':14.27,'Sch 60':19.05,'Sch 80':23.83,'Sch 100':29.36,'Sch 120':34.93,'Sch 140':39.67,'Sch 160':45.24,'Std':9.53,'XS':12.70}},
    '20"': {'od':508.0,'sch':{'Sch 10':6.35,'Sch 20':9.53,'Sch 30':12.70,'Sch 40':15.09,'Sch 60':20.62,'Sch 80':26.19,'Std':9.53,'XS':12.70}},
    '24"': {'od':609.6,'sch':{'Sch 10':6.35,'Sch 20':9.53,'Sch 30':14.27,'Sch 40':17.48,'Sch 60':24.61,'Sch 80':30.96,'Sch 140':52.37,'Sch 160':59.54,'Std':9.53,'XS':12.70}},
    '28"': {'od':711.2,'sch':{'Sch 10':7.92,'Sch 20':12.70,'Sch 30':15.88,'Std':9.53,'XS':12.70}},
  };

  let od = null, wt = null;
  if (size_nominal && schedule && PIPE_DIMS[size_nominal]) {
    od = PIPE_DIMS[size_nominal].od;
    wt = PIPE_DIMS[size_nominal].sch[schedule] || null;
  } else if (size_nominal && PIPE_DIMS[size_nominal]) {
    od = PIPE_DIMS[size_nominal].od;
  }
  // If WT from description AND schedule not in table → use description WT
  if (!wt && wall_thickness_mm) wt = wall_thickness_mm;

  const cutting_allowance_mm = (material || '').includes('GRE') ? 3 : 5;
  return { material, size_nominal, schedule, standard, od, wt, wall_thickness_mm, cutting_allowance_mm };
}

// Parse free-text description → material, size, schedule, standard, wall thickness
router.get('/pipe-master/parse-desc', (req, res) => {
  const { desc } = req.query;
  if (!desc) return res.json({});
  res.json(parseDescription(desc));
});

router.post('/pipe-master', requireRole('admin', 'engineer'), (req, res) => {
  const { item_code, description, material, size_nominal, size_od_mm, wall_thickness_mm, schedule, standard, cutting_allowance_mm, project_id } = req.body;
  if (!item_code || !description || !material || !size_nominal)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const r = p('INSERT INTO pipe_master (item_code,description,material,size_nominal,size_od_mm,wall_thickness_mm,schedule,standard,cutting_allowance_mm,project_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(item_code.toUpperCase(), description, material, size_nominal, size_od_mm || null, wall_thickness_mm || null, schedule || null, standard || null, cutting_allowance_mm || 5, project_id || null, req.session.user.id);
    auditLog(db(), req.session.user.id, 'CREATE', 'pipe_master', item_code, req.body, req.ip);
    res.json({ id: r.lastInsertRowid, item_code });
  } catch (e) { res.status(400).json({ error: 'Item code already exists: ' + e.message }); }
});

router.put('/pipe-master/:code', requireRole('admin', 'engineer'), (req, res) => {
  const { description, material, size_nominal, size_od_mm, wall_thickness_mm, schedule, standard, cutting_allowance_mm } = req.body;
  if (!description || !material || !size_nominal) return res.status(400).json({ error: 'Description, material and size are required' });
  p('UPDATE pipe_master SET description=?,material=?,size_nominal=?,size_od_mm=?,wall_thickness_mm=?,schedule=?,standard=?,cutting_allowance_mm=? WHERE item_code=?')
    .run(description, material, size_nominal, size_od_mm || null, wall_thickness_mm || null, schedule || null, standard || null, cutting_allowance_mm || 5, req.params.code);
  auditLog(db(), req.session.user.id, 'EDIT', 'pipe_master', req.params.code, req.body, req.ip);
  res.json({ ok: true });
});

router.delete('/pipe-master/:code', requireRole('admin'), (req, res) => {
  const code = req.params.code;
  const inUse = p('SELECT COUNT(*) as c FROM pipe_stock WHERE item_code=?').get(code);
  if (inUse && inUse.c > 0) return res.status(400).json({ error: `Cannot delete: ${inUse.c} pipe(s) in stock use this item code. Remove the stock first.` });
  p('DELETE FROM pipe_master WHERE item_code=?').run(code);
  auditLog(db(), req.session.user.id, 'DELETE', 'pipe_master', code, {}, req.ip);
  res.json({ ok: true });
});

// ── Export full pipe master as Excel (all columns filled) ─────────────────────
router.get('/pipe-master/export/xlsx', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { project_id } = req.query;
  let sql = `SELECT pm.item_code, pm.description, pm.material, pm.size_nominal,
    pm.size_od_mm, pm.wall_thickness_mm, pm.schedule, pm.standard, pm.cutting_allowance_mm,
    p.code as project_code,
    (SELECT COUNT(*) FROM pipe_stock ps WHERE ps.item_code=pm.item_code) as stock_count,
    (SELECT COALESCE(SUM(ps.current_length_mm),0) FROM pipe_stock ps WHERE ps.item_code=pm.item_code AND ps.status!='consumed') as stock_avail_mm,
    (SELECT COUNT(*) FROM remnants r WHERE r.item_code=pm.item_code AND r.status='available') as remnant_count
    FROM pipe_master pm LEFT JOIN projects p ON pm.project_id=p.id WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND pm.project_id=?'; params.push(project_id); }
  sql += ' ORDER BY pm.item_code';
  const rows = p(sql).all(...params);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
    'Item Code':          r.item_code,
    'Description':        r.description || '',
    'Material':           r.material || '',
    'Size (Nominal)':     r.size_nominal || '',
    'OD (mm)':            r.size_od_mm || '',
    'Wall Thickness (mm)':r.wall_thickness_mm || '',
    'Schedule':           r.schedule || '',
    'Standard':           r.standard || '',
    'Cut Allowance (mm)': r.cutting_allowance_mm || 5,
    'Project':            r.project_code || '',
    'Stock Pipes':        r.stock_count || 0,
    'Stock Avail (mm)':   r.stock_avail_mm || 0,
    'Stock Avail (m)':    r.stock_avail_mm ? (r.stock_avail_mm/1000).toFixed(2) : '0.00',
    'Remnants Available': r.remnant_count || 0,
  })));
  ws['!cols'] = [16,36,22,12,10,16,10,14,14,12,10,14,12,14].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb, ws, 'Pipe Master');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="PipeMaster_Export.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Bulk upload pipe master — with auto-parse from item code + XLS error log
router.post('/pipe-master/bulk', requireRole('admin', 'engineer'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  let added = 0; const errors = []; const errorRows = [];

  function parseFromCode(code) {
    const u = code.toUpperCase();
    let material=null,standard=null,size_nominal=null,schedule=null;
    const MAT=[
      [/^SS316L?/,'Stainless Steel 316L','ASME B36.19'],[/^SS304L?/,'Stainless Steel 304','ASME B36.19'],
      [/^SDSS/,'Super Duplex SS','ASME B36.19'],[/^DSS/,'Duplex SS','ASME B36.19'],
      [/^SS/,'Stainless Steel','ASME B36.19'],[/^LTCS/,'Low Temp Carbon Steel','ASME B36.10'],
      [/^CS/,'Carbon Steel','ASME B36.10'],[/^AH/,'Carbon Steel','ASME B36.10'],
      [/^GRE/,'GRE/FRP','ISO 14692'],[/^HDPE/,'HDPE','ISO 4427'],
      [/^CUNI/,'Copper-Nickel 90/10','EEMUA 234'],[/^NI/,'Nickel Alloy','ASME B36.19'],
    ];
    for(const[p,m,s] of MAT){if(p.test(u)){material=m;standard=s;break;}}
    const sm=u.match(/(\d+)-?(\d+)?-?(\d+)?IN/);
    if(sm){const[,a,b,c]=sm;size_nominal=c?`${a}.${b}/${c}"`:b?`${a}.${b}"`:a+'"';}
    const SCH=[
      [/SCH160/,'Sch 160'],[/SCH140/,'Sch 140'],[/SCH120/,'Sch 120'],[/SCH100/,'Sch 100'],
      [/SCH80S/,'Sch 80S'],[/SCH80/,'Sch 80'],[/SCH60/,'Sch 60'],
      [/SCH40S/,'Sch 40S'],[/SCH40/,'Sch 40'],[/SCH30/,'Sch 30'],[/SCH20/,'Sch 20'],
      [/SCH10S/,'Sch 10S'],[/SCH10/,'Sch 10'],[/SCH5S/,'Sch 5S'],
      [/XXS/,'XXS'],[/\bXS\b/,'XS'],[/STD/,'Std'],
    ];
    for(const[p,s] of SCH){if(p.test(u)){schedule=s;break;}}
    return{material,standard,size_nominal,schedule,od:null,wt:null};
  }

  rows.forEach((r, i) => {
    const code = String(r.item_code || '').trim().toUpperCase();
    const desc = String(r.description || '').trim();
    if (!code || !desc) {
      const msg = `Row ${i+2}: item_code and description are required`;
      errors.push(msg); errorRows.push({ row: i+2, ...r, error: msg }); return;
    }
    // Auto-parse: try from item code first, then fall back to enhanced description parser
    const fromCode = parseFromCode(code);
    const fromDesc = parseDescription(desc);
    // Description is authoritative for material and standard — item code is only a fallback
    const mat   = String(r.material   || '').trim() || fromDesc.material   || fromCode.material   || '';
    const size  = String(r.size_nominal || r.size || '').trim() || fromDesc.size_nominal || fromCode.size_nominal || '';
    const sch   = String(r.schedule   || '').trim() || fromDesc.schedule   || fromCode.schedule   || '';
    const std   = String(r.standard   || '').trim() || fromDesc.standard   || fromCode.standard   || '';
    const od    = parseFloat(r.size_od_mm) || fromDesc.od || fromCode.od || null;
    // wt: explicit column > ASME table lookup > WT mentioned in description itself
    const wt    = parseFloat(r.wall_thickness_mm) || fromCode.wt || fromDesc.wt || fromDesc.wall_thickness_mm || null;
    const ca    = parseFloat(r.cutting_allowance_mm) || fromDesc.cutting_allowance_mm || 5;
    try {
      const result = p('INSERT OR IGNORE INTO pipe_master (item_code,description,material,size_nominal,size_od_mm,wall_thickness_mm,schedule,standard,cutting_allowance_mm,project_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(code, desc, mat, size, od, wt, sch, std, ca, req.body.project_id || null, req.session.user.id);
      if (result.changes) added++;
      else { const msg=`Row ${i+2}: item_code "${code}" already exists (skipped)`; errors.push(msg); errorRows.push({row:i+2,...r,error:msg}); }
    } catch (e) { const msg=`Row ${i+2}: ${e.message}`; errors.push(msg); errorRows.push({row:i+2,...r,error:msg}); }
  });

  // Generate XLS error log if there are errors
  let errorXls = null;
  if (errorRows.length > 0) {
    const ewb = XLSX.utils.book_new();
    const ews = XLSX.utils.json_to_sheet(errorRows.map(r=>({
      'Row #': r.row,
      'item_code': r.item_code||'',
      'description': r.description||'',
      'material': r.material||'',
      'size_nominal': r.size_nominal||'',
      'schedule': r.schedule||'',
      'Error': r.error
    })));
    XLSX.utils.book_append_sheet(ewb, ews, 'Upload Errors');
    const buf = XLSX.write(ewb, {type:'base64',bookType:'xlsx'});
    errorXls = buf;
  }

  res.json({ added, errors, total: rows.length, errorXls });
});

// ─── PIPE STOCK ───────────────────────────────────────────────────────────────
router.get('/pipe-stock', (req, res) => {
  const { project_id, item_code, status } = req.query;
  let sql = `SELECT ps.*, pm.description, pm.material, pm.size_nominal, pm.schedule, pm.cutting_allowance_mm
             FROM pipe_stock ps LEFT JOIN pipe_master pm ON ps.item_code=pm.item_code WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND ps.project_id=?'; params.push(project_id); }
  if (item_code)  { sql += ' AND ps.item_code=?';  params.push(item_code); }
  if (status)     { sql += ' AND ps.status=?';     params.push(status); }
  sql += ' ORDER BY ps.item_code, ps.pipe_tag';
  res.json(p(sql).all(...params));
});

router.post('/pipe-stock', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { item_code, heat_number, full_length_mm, quantity, tag_prefix, location, received_date, remarks, project_id } = req.body;
  if (!item_code || !full_length_mm || !quantity)
    return res.status(400).json({ error: 'Missing required fields' });
  const master = p('SELECT item_code FROM pipe_master WHERE item_code=?').get(item_code);
  if (!master) return res.status(400).json({ error: `Item code ${item_code} not in master` });
  const prefix = (tag_prefix || 'P').toUpperCase();
  const count  = p('SELECT COUNT(*) as c FROM pipe_stock WHERE item_code=?').get(item_code)?.c || 0;
  const added  = [];
  const ins    = p('INSERT INTO pipe_stock (pipe_tag,item_code,heat_number,full_length_mm,current_length_mm,status,location,received_date,remarks,project_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < parseInt(quantity); i++) {
    const tag = `${prefix}-${item_code}-${String(count + i + 1).padStart(4, '0')}`;
    ins.run(tag, item_code, heat_number || null, parseFloat(full_length_mm), parseFloat(full_length_mm), 'available', location || null, received_date || null, remarks || null, project_id || null, req.session.user.id);
    added.push(tag);
  }
  auditLog(db(), req.session.user.id, 'ADD_STOCK', 'pipe_stock', item_code, { quantity, full_length_mm }, req.ip);
  res.json({ added, count: added.length });
});

// Edit pipe stock record
router.put('/pipe-stock/:tag', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { heat_number, location, full_length_mm, current_length_mm, status, received_date, remarks } = req.body;
  const tag = req.params.tag;
  const existing = p('SELECT * FROM pipe_stock WHERE pipe_tag=?').get(tag);
  if (!existing) return res.status(404).json({ error: 'Pipe not found: ' + tag });
  p(`UPDATE pipe_stock SET heat_number=?,location=?,full_length_mm=?,current_length_mm=?,status=?,received_date=?,remarks=? WHERE pipe_tag=?`)
    .run(heat_number||null, location||null, full_length_mm||existing.full_length_mm, current_length_mm??existing.current_length_mm, status||existing.status, received_date||null, remarks||null, tag);
  auditLog(db(), req.session.user.id, 'EDIT_STOCK', 'pipe_stock', tag, req.body, req.ip);
  res.json({ ok: true });
});

router.delete('/pipe-stock/:tag', requireRole('admin', 'engineer'), (req, res) => {
  const tag = req.params.tag;
  const existing = p('SELECT pipe_tag FROM pipe_stock WHERE pipe_tag=?').get(tag);
  if (!existing) return res.status(404).json({ error: 'Pipe not found' });
  p('DELETE FROM pipe_stock WHERE pipe_tag=?').run(tag);
  auditLog(db(), req.session.user.id, 'DELETE_STOCK', 'pipe_stock', tag, {}, req.ip);
  res.json({ ok: true });
});

// ── Feature 2: Bulk delete pipe stock ─────────────────────────────────────────
router.post('/pipe-stock/bulk-delete', requireRole('admin', 'engineer'), (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags) || !tags.length) return res.status(400).json({ error: 'No tags provided' });
  let deleted = 0; const errors = [];
  tags.forEach(tag => {
    const existing = p('SELECT pipe_tag FROM pipe_stock WHERE pipe_tag=?').get(tag);
    if (!existing) { errors.push(`"${tag}" not found`); return; }
    p('DELETE FROM pipe_stock WHERE pipe_tag=?').run(tag);
    auditLog(db(), req.session.user.id, 'DELETE_STOCK', 'pipe_stock', tag, {}, req.ip);
    deleted++;
  });
  res.json({ deleted, errors });
});

// ── Feature 2: Export full pipe stock as Excel ─────────────────────────────────
router.get('/pipe-stock/export/xlsx', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { project_id } = req.query;
  let sql = `SELECT ps.pipe_tag, ps.item_code, pm.description, pm.material, pm.size_nominal, pm.schedule,
    pm.wall_thickness_mm, pm.size_od_mm, pm.standard, pm.cutting_allowance_mm,
    ps.heat_number, ps.full_length_mm, ps.current_length_mm,
    (ps.full_length_mm - ps.current_length_mm) as used_mm,
    ps.status, ps.location, ps.received_date, ps.remarks, ps.created_at
    FROM pipe_stock ps LEFT JOIN pipe_master pm ON ps.item_code=pm.item_code WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND ps.project_id=?'; params.push(project_id); }
  sql += ' ORDER BY ps.item_code, ps.pipe_tag';
  const rows = p(sql).all(...params);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
    'Pipe Tag': r.pipe_tag, 'Item Code': r.item_code, 'Description': r.description || '',
    'Material': r.material || '', 'Size': r.size_nominal || '', 'Schedule': r.schedule || '',
    'Wall Thickness (mm)': r.wall_thickness_mm || '', 'OD (mm)': r.size_od_mm || '',
    'Standard': r.standard || '', 'Cut Allowance (mm)': r.cutting_allowance_mm || 5,
    'Heat/Lot No': r.heat_number || '', 'Full Length (mm)': r.full_length_mm,
    'Current Length (mm)': r.current_length_mm, 'Used (mm)': r.used_mm,
    'Status': r.status, 'Location': r.location || '',
    'Received Date': r.received_date || '', 'Remarks': r.remarks || '',
    'Created': (r.created_at || '').split('T')[0]
  })));
  ws['!cols'] = [14,16,30,22,8,10,14,10,14,14,14,14,14,10,10,14,12,20,12].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb, ws, 'Pipe Stock');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="PipeStock_Export.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Feature 2: Export pipe stock PDF summary grouped by material & size ────────
router.get('/pipe-stock/export/pdf', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { project_id } = req.query;
  let sql = `SELECT pm.material, pm.size_nominal, pm.schedule, COUNT(ps.pipe_tag) as count,
    SUM(ps.full_length_mm) as total_full_mm, SUM(ps.current_length_mm) as total_current_mm,
    SUM(CASE WHEN ps.status='available' THEN 1 ELSE 0 END) as available,
    SUM(CASE WHEN ps.status='partial' THEN 1 ELSE 0 END) as partial,
    SUM(CASE WHEN ps.status='consumed' THEN 1 ELSE 0 END) as consumed
    FROM pipe_stock ps LEFT JOIN pipe_master pm ON ps.item_code=pm.item_code WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND ps.project_id=?'; params.push(project_id); }
  sql += ' GROUP BY pm.material, pm.size_nominal, pm.schedule ORDER BY pm.material, pm.size_nominal';
  const grouped = p(sql).all(...params);
  const totals  = p(`SELECT COUNT(*) as total_pipes,
    SUM(full_length_mm) as total_full_mm, SUM(current_length_mm) as total_current_mm
    FROM pipe_stock ps ${project_id ? 'WHERE ps.project_id=?' : ''}`).get(...params);

  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Disposition', 'attachment; filename="PipeStock_Summary.pdf"');
  res.setHeader('Content-Type', 'application/pdf');
  doc.pipe(res);

  const now = new Date().toLocaleDateString('en-GB');
  doc.fontSize(16).font('Helvetica-Bold').text('IPCMO — Pipe Stock Summary', { align: 'center' });
  doc.fontSize(9).font('Helvetica').text(`Generated: ${now}`, { align: 'center' });
  doc.moveDown(0.8);

  // Summary totals box
  const tm = totals || {};
  doc.fontSize(10).font('Helvetica-Bold')
    .text(`Total Pipes: ${tm.total_pipes || 0}   |   Total Full Length: ${((tm.total_full_mm||0)/1000).toFixed(1)} m   |   Total Current Length: ${((tm.total_current_mm||0)/1000).toFixed(1)} m`);
  doc.moveDown(0.5);

  // Table header
  const cols = [140, 55, 65, 50, 75, 75, 52, 48, 60];
  const headers = ['Material','Size','Schedule','Count','Full Len (m)','Curr Len (m)','Available','Partial','Consumed'];
  let y = doc.y;
  doc.rect(40, y, 762, 16).fill('#2A4A7F');
  doc.fillColor('white').fontSize(8).font('Helvetica-Bold');
  let x = 40;
  headers.forEach((h, i) => { doc.text(h, x+2, y+4, { width: cols[i]-2, align: 'center' }); x += cols[i]; });
  doc.fillColor('black'); y += 16;

  let lastMat = null; let rowIdx = 0;
  grouped.forEach(r => {
    if (r.material !== lastMat) {
      doc.rect(40, y, 762, 14).fill('#E8EEF7');
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#1A2F5A')
        .text(r.material || '—', 42, y+3, { width: 760 });
      y += 14; lastMat = r.material; rowIdx = 0;
    }
    doc.rect(40, y, 762, 13).fill(rowIdx % 2 ? '#F7F9FC' : 'white');
    doc.fillColor('black').font('Helvetica').fontSize(7.5);
    x = 40;
    const vals = ['', r.size_nominal||'—', r.schedule||'—', r.count,
      ((r.total_full_mm||0)/1000).toFixed(2), ((r.total_current_mm||0)/1000).toFixed(2),
      r.available||0, r.partial||0, r.consumed||0];
    vals.forEach((v, i) => { doc.text(String(v), x+2, y+3, { width: cols[i]-2, align: i >= 3 ? 'right' : 'left' }); x += cols[i]; });
    y += 13; rowIdx++;
    if (y > 530) { doc.addPage({ layout: 'landscape' }); y = 40; lastMat = null; }
  });

  doc.end();
});

// Bulk stock upload
router.post('/pipe-stock/bulk', requireRole('admin', 'engineer', 'site_supervisor'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  let added = 0; const errors = [];

  // FIX-1: Pre-validate all rows before touching DB
  const validRows = [];
  rows.forEach((r, i) => {
    const code = String(r.item_code || '').trim().toUpperCase();
    const len  = parseFloat(r.pipe_length_mm || r.full_length_mm || 0);
    const qty  = parseInt(r.quantity || r.qty || 1);
    if (!code || !len) { errors.push(`Row ${i + 2}: missing item_code or pipe_length_mm`); return; }
    const master = p('SELECT item_code FROM pipe_master WHERE item_code=?').get(code);
    if (!master) { errors.push(`Row ${i + 2}: item_code "${code}" not in master`); return; }
    validRows.push({ r, code, len, qty, rowIdx: i });
  });

  // FIX-2: Use setImmediate + single transaction for all 3270 inserts.
  // Without a transaction every INSERT is a separate disk fsync — this is why
  // large files (553 qty rows) caused the upload to hang/not respond.
  setImmediate(() => {
    try {
      db().exec('BEGIN');

      // FIX-3: Build running count map per item_code ONCE before the loop.
      // Previously count was re-fetched per row — same item_code on multiple rows
      // would get the same base count, generating duplicate tags that INSERT OR IGNORE
      // silently skips, causing pipes to appear not loaded.
      const countMap = {};
      validRows.forEach(({ code }) => {
        if (countMap[code] === undefined)
          countMap[code] = p('SELECT COUNT(*) as c FROM pipe_stock WHERE item_code=?').get(code)?.c || 0;
      });

      const ins = p('INSERT OR IGNORE INTO pipe_stock (pipe_tag,item_code,heat_number,full_length_mm,current_length_mm,status,location,received_date,project_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)');

      validRows.forEach(({ r, code, len, qty, rowIdx }) => {
        const prefix = String(r.tag_prefix || 'P').toUpperCase();
        for (let j = 0; j < qty; j++) {
          countMap[code]++;
          const tag = `${prefix}-${code}-${String(countMap[code]).padStart(4, '0')}`;
          try {
            const result = ins.run(tag, code, String(r.heat_number || ''), len, len, 'available', String(r.location || ''), String(r.received_date || ''), req.body.project_id || null, req.session.user.id);
            if (result.changes) added++;
          } catch (e) { errors.push(`Row ${rowIdx + 2}: ${e.message}`); }
        }
      });

      db().exec('COMMIT');
      res.json({ added, errors, total: rows.length });
    } catch (e) {
      try { db().exec('ROLLBACK'); } catch (_) {}
      console.error('Bulk stock upload error:', e);
      res.status(500).json({ error: e.message });
    }
  });
});

// Templates
router.get('/templates/pipe-master', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['item_code','description','material','size_nominal','size_od_mm','wall_thickness_mm','schedule','standard','cutting_allowance_mm'],
    ['CS-4IN-SCH40','CS Pipe 4" Sch40','Carbon Steel','4"',114.3,6.02,'Sch 40','ASME B36.10',5],
    ['SS316-2IN','SS316L Pipe 2"','Stainless Steel 316L','2"',60.3,3.91,'Sch 40S','ASME B36.19',5],
    ['HDPE-6IN','HDPE Pipe 6"','HDPE','6"',180,10.7,'SDR17','ISO 4427',3],
  ]);
  ws['!cols'] = [16,26,20,12,10,16,10,14,18].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Pipe Master Template');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="PipeMasterTemplate.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/templates/pipe-stock', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['item_code','pipe_length_mm','quantity','tag_prefix','heat_number','location','received_date'],
    ['CS-4IN-SCH40',6000,10,'P','HT-2025-001','Yard B-2','2025-01-15'],
    ['SS316-2IN',6000,5,'SS','HT-2025-002','Rack C-1','2025-01-15'],
  ]);
  ws['!cols'] = [16,16,10,12,14,16,14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Template');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="PipeStockTemplate.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/templates/spool', (req, res) => {
  const wb = XLSX.utils.book_new();
  // IMPORTANT: iso_no FIRST, then spool_no — this matches the unique identity rule
  // The system creates ONE spool per unique ISO+Spool combination.
  // Different ISOs can have spools with the same spool number (e.g. SPL-001) — they are DIFFERENT spools.
  const ws = XLSX.utils.aoa_to_sheet([
    // Row 1: Column headers (iso_no FIRST per v2.1 standard)
    ['iso_no','spool_no','description','part_no','item_code','cut_length_mm','qty'],
    // Row 2-4: Example data showing correct multi-ISO multi-spool usage
    ['ISO-101-A','SPL-001','Inlet Header Spool','[1.1]','CS-4IN-SCH40',1850,1],
    ['ISO-101-A','SPL-001','Inlet Header Spool','[1.2]','CS-4IN-SCH40',950,1],
    ['ISO-101-A','SPL-002','Bypass Spool',      '[1.1]','CS-4IN-SCH40',3200,1],
    ['ISO-102-B','SPL-001','Outlet Spool',       '[1.1]','CS-4IN-SCH40',2100,1],
    ['ISO-102-B','SPL-001','Outlet Spool',       '[1.2]','CS-4IN-SCH40',1400,1],
  ]);
  ws['!cols'] = [16,12,22,10,16,14,6].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Spool Template');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="SpoolTemplate.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── SPOOLS ───────────────────────────────────────────────────────────────────

// ── Feature 4: Cutting Plan Batch XLS — template download ─────────────────────
router.get('/templates/cutting-batch', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['material_code','material_filter','notes'],
    ['CS','Carbon Steel','Run Carbon Steel spools only'],
    ['CUNI','Copper-Nickel 90/10','Run Cu-Ni spools only'],
    ['','','Leave material_filter blank to run ALL pending spools'],
  ]);
  ws['!cols'] = [15, 28, 38].map(w => ({ wch: w }));
  // Add a second sheet explaining codes
  const ws2 = XLSX.utils.aoa_to_sheet([
    ['material_code','Full Material Name'],
    ['CS','Carbon Steel'],
    ['LTCS','Low Temp Carbon Steel'],
    ['SS316','Stainless Steel 316/316L'],
    ['SS304','Stainless Steel 304'],
    ['SS','Stainless Steel (generic)'],
    ['SDSS','Super Duplex SS'],
    ['DSS','Duplex SS'],
    ['CUNI','Copper-Nickel 90/10'],
    ['NI','Nickel Alloy'],
    ['GRE','GRE/FRP'],
    ['HDPE','HDPE'],
    ['GALV','Carbon Steel Galvanised'],
  ]);
  ws2['!cols'] = [15, 28].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Batch Config');
  XLSX.utils.book_append_sheet(wb, ws2, 'Material Codes');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="CuttingBatchTemplate.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Feature 4: Parse cutting batch config XLS ──────────────────────────────────
// Returns { material_code, material_filter, notes } rows — front-end then calls /api/simulate
router.post('/simulate/batch-upload', requireRole('admin', 'engineer', 'site_supervisor'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const batches = rows
    .map(r => ({
      material_code:   String(r.material_code   || '').trim().toUpperCase().replace(/[^A-Z0-9]/g,''),
      material_filter: String(r.material_filter || '').trim(),
      notes:           String(r.notes           || '').trim(),
    }))
    .filter(r => r.material_code || r.material_filter);
  res.json({ batches });
});

router.get('/spools', (req, res) => {
  const { project_id, status } = req.query;
  let sql = `SELECT s.*, u.full_name as created_by_name,
    (SELECT COUNT(*) FROM spool_parts sp WHERE sp.spool_id=s.id) as part_count
    FROM spools s LEFT JOIN users u ON s.created_by=u.id WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND s.project_id=?'; params.push(project_id); }
  if (status)     { sql += ' AND s.status=?';     params.push(status); }
  sql += ' ORDER BY s.created_at DESC';
  const spools = p(sql).all(...params);
  // FIX-BUG3: attach item_codes per spool so the frontend material filter
  // can accurately match spools to their material types without an extra API call.
  const icStmt = p('SELECT DISTINCT item_code FROM spool_parts WHERE spool_id=?');
  spools.forEach(s => {
    s.item_codes = icStmt.all(s.id).map(r => r.item_code);
  });
  res.json(spools);
});

router.get('/spools/:id/parts', (req, res) =>
  res.json(p('SELECT * FROM spool_parts WHERE spool_id=? ORDER BY id').all(req.params.id)));

router.post('/spools', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { spool_no, iso_no, description, project_id, parts } = req.body;
  if (!spool_no || !iso_no || !parts || !parts.length)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const r = p('INSERT INTO spools (spool_no,iso_no,description,project_id,created_by) VALUES (?,?,?,?,?)')
      .run(spool_no.toUpperCase(), iso_no.toUpperCase(), description || '', project_id || null, req.session.user.id);
    const spoolId = r.lastInsertRowid;
    const ins = p('INSERT INTO spool_parts (spool_id,part_no,item_code,required_length_mm,qty) VALUES (?,?,?,?,?)');
    parts.forEach(pt => ins.run(spoolId, pt.part_no, pt.item_code, parseFloat(pt.required_length_mm), parseInt(pt.qty) || 1));
    res.json({ id: spoolId, spool_no });
  } catch (e) { res.status(400).json({ error: 'Spool already exists or error: ' + e.message }); }
});

router.delete('/spools/:id', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  p('DELETE FROM spool_parts WHERE spool_id=?').run(req.params.id);
  p('DELETE FROM spools WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Bulk spool upload
router.post('/spools/bulk', requireRole('admin', 'engineer', 'site_supervisor'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  let spoolsAdded = 0, partsAdded = 0; const errors = [];

  // KEY FIX: spoolMap keyed by ISO+SPOOL combination (not spool_no alone)
  // SPL-001 under ISO-7902 is a DIFFERENT spool from SPL-001 under ISO-7903
  const spoolMap = {};

  rows.forEach((r, i) => {
    const sno  = String(r.spool_no  || '').trim().toUpperCase();
    const iso  = String(r.iso_no || r.iso || '').trim().toUpperCase();
    const part = String(r.part_no   || '').trim();
    const code = String(r.item_code || '').trim().toUpperCase();
    const len  = parseFloat(r.cut_length_mm || r.required_length_mm || 0);
    const qty  = parseInt(r.qty || r.quantity || 1);
    if (!sno || !iso || !part || !code || !len) { errors.push(`Row ${i + 2}: missing required field`); return; }
    if (!p('SELECT item_code FROM pipe_master WHERE item_code=?').get(code)) { errors.push(`Row ${i + 2}: item_code "${code}" not in master`); return; }
    // FIX: composite key = ISO + SPOOL
    const key = `${iso}||${sno}`;
    if (!spoolMap[key]) spoolMap[key] = { sno, iso, desc: String(r.description || ''), parts: [] };
    spoolMap[key].parts.push({ part_no: part, item_code: code, required_length_mm: len, qty });
  });

  Object.entries(spoolMap).forEach(([key, sp]) => {
    try {
      // FIX: uniqueness check uses BOTH iso_no AND spool_no
      const existing = p('SELECT id FROM spools WHERE spool_no=? AND iso_no=?').get(sp.sno, sp.iso);
      let spoolId;
      if (existing) {
        spoolId = existing.id;
      } else {
        const r = p('INSERT INTO spools (spool_no,iso_no,description,project_id,created_by) VALUES (?,?,?,?,?)')
          .run(sp.sno, sp.iso, sp.desc, req.body.project_id || null, req.session.user.id);
        spoolId = r.lastInsertRowid; spoolsAdded++;
      }
      const ins = p('INSERT INTO spool_parts (spool_id,part_no,item_code,required_length_mm,qty) VALUES (?,?,?,?,?)');
      sp.parts.forEach(pt => { ins.run(spoolId, pt.part_no, pt.item_code, pt.required_length_mm, pt.qty); partsAdded++; });
    } catch (e) { errors.push(`Spool ${sp.iso}+${sp.sno}: ${e.message}`); }
  });
  let errorXls = null;
  if (errors.length > 0) {
    const ewb = XLSX.utils.book_new();
    const ews = XLSX.utils.json_to_sheet(errors.map((e,i)=>({'Error':e})));
    XLSX.utils.book_append_sheet(ewb, ews, 'Spool Upload Errors');
    errorXls = XLSX.write(ewb, {type:'base64',bookType:'xlsx'});
  }
  res.json({ spoolsAdded, partsAdded, errors, total: rows.length, errorXls });
});

// ─── SIMULATION ───────────────────────────────────────────────────────────────
// Feature 3: material_code = short code e.g. "CS","LTCS","SS","CUNI" embedded in plan/remnant numbers
// Plan no: PROJCODE-CS-CP-2026-0001   Remnant follows same prefix
router.post('/simulate', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { spool_ids, project_id, notes, material_code } = req.body;
  if (!spool_ids || !spool_ids.length) return res.status(400).json({ error: 'No spools selected' });

  // FIX-PERF: Defer heavy engine work to next event loop tick so the HTTP
  // response pipeline stays unblocked and the browser doesn't perceive a hang.
  setImmediate(() => {
  try {
    // Get project code for prefix
    const proj = project_id ? p('SELECT code FROM projects WHERE id=?').get(project_id) : null;
    const projPrefix = proj ? proj.code.toUpperCase() : 'IPCMO';
    // If material_code provided, embed: PROJCODE-MATCODE-CP-YYYY-NNNN
    const matCode = material_code ? String(material_code).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8) : null;
    const prefix  = matCode ? `${projPrefix}-${matCode}` : projPrefix;

    const result = runCuttingEngine(db(), spool_ids.map(Number), project_id, prefix);

    // FIX-PERF: wrap ALL writes in a single transaction — eliminates per-row
    // fsync overhead which was the main cause of buffering on large spool uploads.
    db().exec('BEGIN');
    try {
      // Generate plan number unique within the prefix
      const planCount = (p('SELECT COUNT(*) as c FROM cutting_plans WHERE plan_no LIKE ?').get(`${prefix}-CP-%`)?.c || 0) + 1;
      const planNo    = `${prefix}-CP-${new Date().getFullYear()}-${String(planCount).padStart(4, '0')}`;
      const planId    = p('INSERT INTO cutting_plans (plan_no,project_id,simulated_by,notes) VALUES (?,?,?,?)')
        .run(planNo, project_id || null, req.session.user.id, notes || '').lastInsertRowid;

      // Save cut details
      const ins = p('INSERT INTO cutting_plan_details (plan_id,spool_id,part_no,item_code,pipe_tag,required_length_mm,cutting_allowance_mm,actual_cut_mm,cut_from,sequence_on_pipe,iso_no_snapshot,spool_no_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
      // Pre-fetch spool ISO/Spool numbers for snapshot
      const spoolInfo = {};
      [...new Set(result.cutResults.filter(c => !c.failed).map(c => c.spoolId))].forEach(sid => {
        const sp = p('SELECT iso_no, spool_no FROM spools WHERE id=?').get(sid);
        if (sp) spoolInfo[sid] = sp;
      });
      result.cutResults.filter(c => !c.failed).forEach(c => {
        const si = spoolInfo[c.spoolId] || { iso_no: null, spool_no: null };
        ins.run(planId, c.spoolId, c.partNo, c.itemCode, c.pipeTag, c.reqLen, c.allowance, c.totalRequired, c.isRemnant ? 'remnant' : 'full_pipe', 0, si.iso_no, si.spool_no);
      });

      // Save new remnants
      const remIns = p('INSERT INTO remnants (rem_no,item_code,heat_number,size_nominal,description,source_pipe_tag,source_plan_id,theoretical_length_mm,theoretical_qty,status,project_id) VALUES (?,?,?,?,?,?,?,?,1,?,?)');
      result.newRemnants.forEach(r => {
        const master = p('SELECT size_nominal,description FROM pipe_master WHERE item_code=?').get(r.itemCode);
        const pipeRow = p('SELECT heat_number FROM pipe_stock WHERE pipe_tag=?').get(r.sourcePipeTag);
        const remRow  = pipeRow ? null : p('SELECT heat_number FROM remnants WHERE rem_no=?').get(r.sourcePipeTag);
        const heatNo  = pipeRow?.heat_number || remRow?.heat_number || r.heatNo || null;
        remIns.run(r.remNo, r.itemCode, heatNo, master?.size_nominal || null, master?.description || null, r.sourcePipeTag, planId, r.theoreticalLen, 'available', project_id || null);
      });

      // Update stock lengths
      for (const [, pa] of Object.entries(result.pipeAlloc)) {
        const used   = pa.cuts.reduce((a, c) => a + c.totalRequired, 0);
        const newLen = Math.max(0, parseFloat((pa.lenStart - used).toFixed(2)));
        if (!pa.isRemnant) {
          p('UPDATE pipe_stock SET current_length_mm=?,status=? WHERE pipe_tag=?')
            .run(newLen, newLen < 1 ? 'consumed' : 'partial', pa.pipeTag);
        } else {
          p('UPDATE remnants SET theoretical_length_mm=?,status=? WHERE rem_no=?')
            .run(newLen, newLen < 1 ? 'consumed' : 'available', pa.remNo);
        }
      }

      // Mark spools simulated
      spool_ids.forEach(id => p("UPDATE spools SET status='simulated' WHERE id=?").run(id));
      db().exec('COMMIT');
      auditLog(db(), req.session.user.id, 'RUN_SIMULATION', 'cutting_plans', planId, { planNo, spoolCount: spool_ids.length }, req.ip);
      res.json({ planId, planNo, result });
    } catch (writeErr) {
      try { db().exec('ROLLBACK'); } catch (_) {}
      throw writeErr;
    }
  } catch (e) {
    console.error('Simulation error:', e);
    res.status(500).json({ error: e.message });
  }
  }); // end setImmediate — event loop unblocked
});

// ─── CUTTING PLANS ────────────────────────────────────────────────────────────

// Manual cutting plan entry (for failed cuts or manual workshop decisions)
router.post('/cutting-plans/manual', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { project_id, pipe_tag, item_code, cuts } = req.body;
  // cuts: [{spool_no, iso_no, part_no, required_length_mm, cutting_allowance_mm}]
  if (!pipe_tag || !item_code || !cuts?.length)
    return res.status(400).json({ error: 'pipe_tag, item_code, and cuts are required' });

  const stock = p(`SELECT * FROM pipe_stock WHERE pipe_tag=?`).get(pipe_tag);
  const remnant = !stock ? p(`SELECT * FROM remnants WHERE rem_no=?`).get(pipe_tag) : null;
  if (!stock && !remnant) return res.status(404).json({ error: `Pipe/remnant tag "${pipe_tag}" not found` });

  const prefix = p(`SELECT code FROM projects WHERE id=?`).get(project_id)?.code || 'IPCMO';

  // Validate total cuts vs available length
  const availLen = stock ? stock.current_length_mm : parseFloat((remnant.actual_length_mm || remnant.theoretical_length_mm));
  const totalNeeded = cuts.reduce((s, c) => s + (parseFloat(c.required_length_mm) || 0) + (parseFloat(c.cutting_allowance_mm) || 5), 0);

  // Determine plan number
  const lastPlan = p(`SELECT plan_no FROM cutting_plans WHERE project_id=? ORDER BY id DESC LIMIT 1`).get(project_id);
  let nextSeq = 1;
  if (lastPlan) {
    const m = lastPlan.plan_no.match(/(\d+)$/);
    if (m) nextSeq = parseInt(m[1]) + 1;
  }
  const planNo = `${prefix}-CP-${new Date().getFullYear()}-${String(nextSeq).padStart(4,'0')}`;

  db().exec('BEGIN');
  try {
    const planId = p(`INSERT INTO cutting_plans (plan_no,project_id,simulated_by,notes) VALUES (?,?,?,?)`)
      .run(planNo, project_id, req.session.user.id, 'Manual entry').lastInsertRowid;

    const ins = p(`INSERT INTO cutting_plan_details
      (plan_id,spool_id,part_no,item_code,pipe_tag,required_length_mm,cutting_allowance_mm,actual_cut_mm,cut_from,sequence_on_pipe,iso_no_snapshot,spool_no_snapshot,entry_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'manual')`);

    cuts.forEach((c, i) => {
      const allowance = parseFloat(c.cutting_allowance_mm) || 5;
      const reqLen    = parseFloat(c.required_length_mm) || 0;
      const totalCut  = reqLen + allowance;
      const isRemnant = !!remnant;
      ins.run(planId, c.spool_id || null, c.part_no, item_code, pipe_tag, reqLen, allowance, totalCut, isRemnant ? 'remnant' : 'full_pipe', i + 1, c.iso_no || null, c.spool_no || null);
    });

    // Deduct from pipe stock or remnant
    const newLen = Math.max(0, availLen - totalNeeded);
    if (stock) {
      p(`UPDATE pipe_stock SET current_length_mm=?,status=? WHERE pipe_tag=?`)
        .run(newLen, newLen < 1 ? 'consumed' : 'partial', pipe_tag);
    } else {
      p(`UPDATE remnants SET theoretical_length_mm=?,status=? WHERE rem_no=?`)
        .run(newLen, newLen < 1 ? 'consumed' : 'available', pipe_tag);
    }

    // Auto-generate remnant if significant balance remains
    if (newLen >= 1) {
      let remSeq = (p('SELECT COUNT(*) as c FROM remnants').get()?.c || 0) + 1;
      const remNo = `${prefix}-REM-${String(remSeq).padStart(6,'0')}`;
      const master = p('SELECT size_nominal, description FROM pipe_master WHERE item_code=?').get(item_code);
      p(`INSERT INTO remnants (rem_no,item_code,heat_number,size_nominal,description,source_pipe_tag,source_plan_id,theoretical_length_mm,theoretical_qty,status,project_id)
         VALUES (?,?,?,?,?,?,?,?,1,'available',?)`)
        .run(remNo, item_code, stock?.heat_number || remnant?.heat_number || null,
          master?.size_nominal || null, master?.description || null,
          pipe_tag, planId, newLen, project_id);
    }

    db().exec('COMMIT');
    auditLog(db(), req.session.user.id, 'MANUAL_CUTTING_PLAN', 'cutting_plans', planId, { planNo, pipe_tag, cuts: cuts.length }, req.ip);
    res.json({ planId, planNo, newBalance: newLen });
  } catch (e) {
    db().exec('ROLLBACK');
    res.status(500).json({ error: e.message });
  }
});

// ADNOC Scrap auto-update endpoint (runs scrap check per ADNOC weld girth philosophy)
router.post('/remnants/adnoc-scrap-check', requireRole('admin', 'engineer'), (req, res) => {
  const { multiplier = 4, project_id } = req.body;
  // multiplier: 2 = 2× wall thk, 4 = 4× wall thk (ADNOC default = 4×)
  const rems = p(`SELECT r.*, pm.wall_thickness_mm
    FROM remnants r LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    WHERE r.status='available' ${project_id ? 'AND r.project_id=?' : ''}`)
    .all(...(project_id ? [project_id] : []));

  let scrapped = 0;
  const scrappedList = [];
  rems.forEach(r => {
    if (!r.wall_thickness_mm) return; // no spec data, skip
    const minUsable = multiplier * r.wall_thickness_mm;
    const availLen = parseFloat(r.actual_length_mm || r.theoretical_length_mm || 0);
    if (availLen < minUsable) {
      p(`UPDATE remnants SET status='scrap', notes=? WHERE id=?`)
        .run(`Auto-scrapped: ${availLen}mm < ${multiplier}× wall thk (${r.wall_thickness_mm}mm = ${minUsable}mm min per ADNOC)`, r.id);
      scrapped++;
      scrappedList.push({ rem_no: r.rem_no, length: availLen, min_required: minUsable });
    }
  });
  auditLog(db(), req.session.user.id, 'ADNOC_SCRAP_CHECK', 'remnants', null, { scrapped, multiplier }, req.ip);
  res.json({ scrapped, scrappedList });
});

router.get('/cutting-plans', (req, res) => {
  const { project_id } = req.query;
  let sql = `SELECT cp.*, u.full_name as by_name, pr.name as project_name,
    (SELECT COUNT(*) FROM cutting_plan_details WHERE plan_id=cp.id) as detail_count,
    (SELECT COUNT(*) FROM remnants WHERE source_plan_id=cp.id) as rem_count
    FROM cutting_plans cp
    LEFT JOIN users u  ON cp.simulated_by=u.id
    LEFT JOIN projects pr ON cp.project_id=pr.id
    WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND cp.project_id=?'; params.push(project_id); }
  sql += ' ORDER BY cp.simulated_at DESC';
  res.json(p(sql).all(...params));
});

router.get('/cutting-plans/:id', (req, res) => {
  const plan = p(`SELECT cp.*, u.full_name as by_name, pr.name as project_name
    FROM cutting_plans cp
    LEFT JOIN users u  ON cp.simulated_by=u.id
    LEFT JOIN projects pr ON cp.project_id=pr.id
    WHERE cp.id=?`).get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const details  = p(`SELECT cpd.*,
      COALESCE(s.spool_no, cpd.spool_no_snapshot) as spool_no,
      COALESCE(s.iso_no,   cpd.iso_no_snapshot)   as iso_no,
      pm.description, pm.size_nominal, pm.material
    FROM cutting_plan_details cpd
    LEFT JOIN spools s ON cpd.spool_id=s.id
    LEFT JOIN pipe_master pm ON cpd.item_code=pm.item_code
    WHERE cpd.plan_id=? ORDER BY cpd.pipe_tag, cpd.id`).all(req.params.id);
  const remnants = p(`SELECT r.*, pm.description, pm.size_nominal, pm.material
    FROM remnants r
    LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    WHERE r.source_plan_id=? ORDER BY r.rem_no`).all(req.params.id);
  res.json({ plan, details, remnants });
});

// Export cutting plan
router.get('/cutting-plans/:id/export/xlsx', async (req, res) => {
  const { plan, details } = getPlanData(req.params.id);
  const remnants = p(`SELECT r.*, pm.size_nominal, pm.description
    FROM remnants r LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    WHERE r.source_plan_id=?`).all(req.params.id);
  await exportCuttingPlanXLS(plan, details, remnants, res);
});

router.get('/cutting-plans/:id/export/pdf', (req, res) => {
  const { plan, details } = getPlanData(req.params.id);
  const spoolGroups = {};
  details.forEach(d => {
    const key = `${d.iso_no || '—'}||${d.spool_no}`;
    if (!spoolGroups[key]) spoolGroups[key] = { iso: d.iso_no || '—', spool: d.spool_no, cuts: [] };
    spoolGroups[key].cuts.push(d);
  });
  exportCuttingPlanPDF(plan, details, spoolGroups, res);
});

function getPlanData(id) {
  const plan    = p(`SELECT cp.*, u.full_name as by_name FROM cutting_plans cp LEFT JOIN users u ON cp.simulated_by=u.id WHERE cp.id=?`).get(id);
  const details = p(`SELECT cpd.*,
      COALESCE(s.spool_no, cpd.spool_no_snapshot) as spool_no,
      COALESCE(s.iso_no,   cpd.iso_no_snapshot)   as iso_no,
      pm.description, pm.size_nominal, pm.material
    FROM cutting_plan_details cpd
    LEFT JOIN spools s ON cpd.spool_id=s.id
    LEFT JOIN pipe_master pm ON cpd.item_code=pm.item_code
    WHERE cpd.plan_id=? ORDER BY cpd.spool_id, cpd.pipe_tag`).all(id);
  return { plan, details };
}

// ─── UNDO CUTTING PLAN ───────────────────────────────────────────────────────
// Dry-run: show what will be reversed before committing
router.get('/cutting-plans/:id/undo-preview', requireRole('admin', 'engineer'), (req, res) => {
  const id = req.params.id;
  const plan = p('SELECT * FROM cutting_plans WHERE id=?').get(id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  // Check if any remnant from this plan has already been USED in another plan
  const usedRemnants = p(`
    SELECT r.rem_no, r.item_code, r.theoretical_length_mm,
      (SELECT COUNT(*) FROM cutting_plan_details cpd2
        WHERE cpd2.pipe_tag = r.rem_no AND cpd2.plan_id != ?) as times_used
    FROM remnants r
    WHERE r.source_plan_id = ? AND r.status != 'available'
  `).all(id, id).filter(r => r.times_used > 0);

  // Get what pipes were used and by how much
  const details = p(`SELECT cpd.pipe_tag, cpd.item_code, cpd.cut_from,
    cpd.actual_cut_mm, cpd.required_length_mm, cpd.cutting_allowance_mm,
    s.spool_no, s.iso_no
    FROM cutting_plan_details cpd
    LEFT JOIN spools s ON cpd.spool_id=s.id
    WHERE cpd.plan_id=? ORDER BY cpd.pipe_tag`).all(id);

  // Group cuts by pipe tag to show total restoration per pipe
  const pipeRestoration = {};
  details.forEach(d => {
    if (!pipeRestoration[d.pipe_tag]) {
      pipeRestoration[d.pipe_tag] = { pipe_tag: d.pipe_tag, item_code: d.item_code, cut_from: d.cut_from, total_to_restore: 0, cuts: 0 };
    }
    pipeRestoration[d.pipe_tag].total_to_restore += d.actual_cut_mm;
    pipeRestoration[d.pipe_tag].cuts++;
  });

  const remnantsToDelete = p('SELECT rem_no, item_code, theoretical_length_mm, status FROM remnants WHERE source_plan_id=?').all(id);
  const spoolsToReset    = p(`SELECT DISTINCT s.id, s.spool_no, s.iso_no, s.status
    FROM spools s
    INNER JOIN cutting_plan_details cpd ON cpd.spool_id=s.id
    WHERE cpd.plan_id=?`).all(id);

  res.json({
    plan,
    canUndo: usedRemnants.length === 0,
    blockers: usedRemnants,
    pipeRestorations: Object.values(pipeRestoration),
    remnantsToDelete,
    spoolsToReset,
    summary: {
      pipesAffected: Object.keys(pipeRestoration).length,
      remnantsToRemove: remnantsToDelete.length,
      spoolsToReset: spoolsToReset.length,
    }
  });
});

// Commit the undo
router.post('/cutting-plans/:id/undo', requireRole('admin', 'engineer'), (req, res) => {
  const id = req.params.id;
  const plan = p('SELECT * FROM cutting_plans WHERE id=?').get(id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  // Block if any remnant from this plan was already re-used
  const usedRemnants = p(`
    SELECT r.rem_no FROM remnants r
    WHERE r.source_plan_id = ?
    AND EXISTS (
      SELECT 1 FROM cutting_plan_details cpd2
      WHERE cpd2.pipe_tag = r.rem_no AND cpd2.plan_id != ?
    )
  `).all(id, id);

  if (usedRemnants.length > 0) {
    return res.status(400).json({
      error: `Cannot undo: ${usedRemnants.length} remnant(s) from this plan have already been used in other cutting plans. Undo those plans first.`,
      blockers: usedRemnants.map(r => r.rem_no)
    });
  }

  try {
    db().exec('BEGIN');

    // 1. Restore pipe lengths for FULL PIPES used in this plan
    const fullPipeCuts = p(`
      SELECT pipe_tag, SUM(actual_cut_mm) as total_cut
      FROM cutting_plan_details
      WHERE plan_id=? AND cut_from='full_pipe'
      GROUP BY pipe_tag
    `).all(id);

    fullPipeCuts.forEach(c => {
      const pipe = p('SELECT current_length_mm, full_length_mm FROM pipe_stock WHERE pipe_tag=?').get(c.pipe_tag);
      if (pipe) {
        const restored = Math.min(pipe.current_length_mm + c.total_cut, pipe.full_length_mm);
        const newStatus = restored >= pipe.full_length_mm ? 'available' : 'partial';
        p('UPDATE pipe_stock SET current_length_mm=?, status=? WHERE pipe_tag=?')
          .run(parseFloat(restored.toFixed(2)), newStatus, c.pipe_tag);
      }
    });

    // 2. Restore remnants that were used as source in this plan
    const remnantCuts = p(`
      SELECT pipe_tag, SUM(actual_cut_mm) as total_cut
      FROM cutting_plan_details
      WHERE plan_id=? AND cut_from='remnant'
      GROUP BY pipe_tag
    `).all(id);

    remnantCuts.forEach(c => {
      const rem = p('SELECT theoretical_length_mm FROM remnants WHERE rem_no=?').get(c.pipe_tag);
      if (rem) {
        const restored = parseFloat((rem.theoretical_length_mm + c.total_cut).toFixed(2));
        p("UPDATE remnants SET theoretical_length_mm=?, status='available' WHERE rem_no=?")
          .run(restored, c.pipe_tag);
      }
    });

    // 3. Delete remnants generated BY this plan
    p('DELETE FROM remnants WHERE source_plan_id=?').run(id);

    // 4. Reset spool statuses back to 'pending'
    const spoolIds = p('SELECT DISTINCT spool_id FROM cutting_plan_details WHERE plan_id=?').all(id).map(r => r.spool_id);
    spoolIds.forEach(sid => p("UPDATE spools SET status='pending' WHERE id=?").run(sid));

    // 5. Delete cutting plan details and the plan itself
    p('DELETE FROM cutting_plan_details WHERE plan_id=?').run(id);
    p("UPDATE cutting_plans SET status='voided' WHERE id=?").run(id);

    db().exec('COMMIT');

    auditLog(db(), req.session.user.id, 'UNDO_PLAN', 'cutting_plans', id, {
      planNo: plan.plan_no,
      fullPipesRestored: fullPipeCuts.length,
      remnantSourcesRestored: remnantCuts.length,
      spoolsReset: spoolIds.length,
    }, req.ip);

    res.json({
      ok: true,
      planNo: plan.plan_no,
      fullPipesRestored: fullPipeCuts.length,
      remnantSourcesRestored: remnantCuts.length,
      remnantsDeleted: p('SELECT changes() as c').get()?.c || 0,
      spoolsReset: spoolIds.length,
    });
  } catch (e) {
    try { db().exec('ROLLBACK'); } catch (_) {}
    console.error('Undo error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Delete a remnant manually
router.delete('/remnants/:id', requireRole('admin', 'engineer'), (req, res) => {
  const rem = p('SELECT * FROM remnants WHERE id=?').get(req.params.id);
  if (!rem) return res.status(404).json({ error: 'Remnant not found' });
  const inUse = p('SELECT COUNT(*) as c FROM cutting_plan_details WHERE pipe_tag=?').get(rem.rem_no);
  if (inUse && inUse.c > 0) return res.status(400).json({ error: `Cannot delete: this remnant has been allocated in ${inUse.c} cutting plan cut(s).` });
  p('DELETE FROM remnants WHERE id=?').run(req.params.id);
  auditLog(db(), req.session.user.id, 'DELETE_REMNANT', 'remnants', rem.rem_no, {}, req.ip);
  res.json({ ok: true });
});
router.get('/remnants', (req, res) => {
  const { project_id, status, item_code } = req.query;
  let sql = `SELECT r.*, pm.description, pm.size_nominal, pm.material, pm.schedule,
    cp.plan_no as source_plan_no
    FROM remnants r
    LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    LEFT JOIN cutting_plans cp ON r.source_plan_id=cp.id
    WHERE 1=1`;
  const params = [];
  if (project_id) { sql += ' AND (r.project_id=? OR r.project_id IS NULL)'; params.push(project_id); }
  if (status)     { sql += ' AND r.status=?';     params.push(status); }
  if (item_code)  { sql += ' AND r.item_code=?';  params.push(item_code); }
  sql += ' ORDER BY r.created_at DESC';
  res.json(p(sql).all(...params));
});

router.put('/remnants/:id', (req, res) => {
  const { actual_length_mm, actual_qty, heat_number, location, status } = req.body;
  p(`UPDATE remnants SET actual_length_mm=?,actual_qty=?,heat_number=?,location=?,status=?,last_updated_by=?,last_updated_at=datetime('now') WHERE id=?`)
    .run(actual_length_mm || null, actual_qty || null, heat_number || null, location || null, status || 'available', req.session.user.id, req.params.id);
  auditLog(db(), req.session.user.id, 'UPDATE_REMNANT', 'remnants', req.params.id, req.body, req.ip);
  res.json({ ok: true });
});

router.put('/remnants/bulk/manual', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { updates } = req.body;
  let updated = 0;
  const stmt = p(`UPDATE remnants SET actual_length_mm=?,actual_qty=?,heat_number=?,location=?,status=?,last_updated_by=?,last_updated_at=datetime('now') WHERE id=?`);
  updates.forEach(u => { stmt.run(u.actual_length_mm || null, u.actual_qty || null, u.heat_number || null, u.location || null, u.status || 'available', req.session.user.id, u.id); updated++; });
  res.json({ updated });
});

// Site XLS upload
router.post('/remnants/site-upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  let updated = 0, failed = 0; const details = [];
  const uploadNo = `RUP-${Date.now()}`;
  rows.forEach(r => {
    const remNo = String(r.rem_no || '').trim();
    if (!remNo) { failed++; return; }
    const existing = p('SELECT * FROM remnants WHERE rem_no=?').get(remNo);
    if (!existing) { failed++; details.push({ rem_no: remNo, status: 'NOT_FOUND', old_value: '', new_value: '' }); return; }
    const newActLen = r.actual_length_mm !== '' ? parseFloat(r.actual_length_mm) : existing.actual_length_mm;
    const newActQty = r.actual_qty !== ''       ? parseInt(r.actual_qty)         : existing.actual_qty;
    const newHeat   = r.heat_number !== ''       ? String(r.heat_number)          : existing.heat_number;
    const newLoc    = r.location !== ''          ? String(r.location)             : existing.location;
    p(`UPDATE remnants SET actual_length_mm=?,actual_qty=?,heat_number=?,location=?,last_updated_by=?,last_updated_at=datetime('now') WHERE rem_no=?`)
      .run(newActLen || null, newActQty || null, newHeat || null, newLoc || null, req.session.user?.id || 0, remNo);
    updated++;
    details.push({ rem_no: remNo, status: 'UPDATED', old_value: `L:${existing.actual_length_mm},Q:${existing.actual_qty}`, new_value: `L:${newActLen},Q:${newActQty}` });
  });
  const upId = p('INSERT INTO remnant_upload_history (upload_no,uploaded_by,filename,rows_processed,rows_updated,rows_failed) VALUES (?,?,?,?,?,?)')
    .run(uploadNo, req.session.user?.id || 0, req.file.originalname, rows.length, updated, failed).lastInsertRowid;
  const dIns = p('INSERT INTO remnant_upload_detail (upload_id,rem_no,field_updated,old_value,new_value,status) VALUES (?,?,?,?,?,?)');
  details.forEach(d => dIns.run(upId, d.rem_no, 'actual_length_mm,actual_qty,heat_number,location', d.old_value, d.new_value, d.status));
  res.json({ uploadNo, updated, failed, total: rows.length, details });
});

// Remnant exports
router.get('/remnants/export/xlsx', async (req, res) => {
  const rems = p(`SELECT r.*, pm.description, pm.size_nominal, pm.material, cp.plan_no as source_plan_no
    FROM remnants r
    LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    LEFT JOIN cutting_plans cp ON r.source_plan_id=cp.id
    ORDER BY r.created_at DESC`).all();
  await exportRemnantRegisterXLS(rems, res);
});

router.get('/remnants/export/pdf', (req, res) => {
  const rems = p(`SELECT r.*, pm.description, pm.size_nominal, pm.material
    FROM remnants r LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    ORDER BY r.created_at DESC`).all();
  exportRemnantPDF(rems, res);
});

router.get('/remnants/export/site-template', async (req, res) => {
  const rems = p(`SELECT r.*, pm.size_nominal FROM remnants r
    LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    WHERE r.status='available' ORDER BY r.rem_no`).all();
  await exportSiteUpdateTemplate(rems, res);
});

router.get('/remnants/upload-history', (req, res) => {
  res.json(p(`SELECT ruh.*, u.full_name as uploaded_by_name
    FROM remnant_upload_history ruh
    LEFT JOIN users u ON ruh.uploaded_by=u.id
    ORDER BY ruh.uploaded_at DESC`).all());
});

router.get('/remnants/upload-history/:id/details', (req, res) =>
  res.json(p('SELECT * FROM remnant_upload_detail WHERE upload_id=?').all(req.params.id)));

// ─── CUTTING ALLOWANCE CHART ──────────────────────────────────────────────────
router.get('/cutting-allowance-chart', (req, res) =>
  res.json(p('SELECT * FROM cutting_allowance_chart ORDER BY material, od_mm').all()));

// ─── MASTER REGISTERS ─────────────────────────────────────────────────────────
// ── Consolidated pipe stock summary (grouped by item_code) ───────────────────
router.get('/pipe-stock/consolidated', (req, res) => {
  const { project_id } = req.query;
  const pf = project_id ? 'AND ps.project_id=?' : '';
  const pa = project_id ? [project_id] : [];
  const rows = p(`
    SELECT
      ps.item_code,
      pm.description,
      pm.material,
      pm.size_nominal,
      pm.schedule,
      pm.size_od_mm,
      pm.wall_thickness_mm,
      COUNT(ps.pipe_tag)                                           AS pipe_count,
      COALESCE(SUM(ps.full_length_mm),0)                          AS total_full_mm,
      COALESCE(SUM(ps.current_length_mm),0)                       AS total_avail_mm,
      COALESCE(SUM(ps.full_length_mm - ps.current_length_mm),0)   AS total_used_mm,
      SUM(CASE WHEN ps.status='available' THEN 1 ELSE 0 END)      AS available_count,
      SUM(CASE WHEN ps.status='partial'   THEN 1 ELSE 0 END)      AS partial_count,
      SUM(CASE WHEN ps.status='consumed'  THEN 1 ELSE 0 END)      AS consumed_count,
      (SELECT COUNT(*) FROM remnants r WHERE r.item_code=ps.item_code AND r.status='available' ${pf ? "AND r.project_id=?" : ""}) AS remnant_count,
      (SELECT COALESCE(SUM(COALESCE(r.actual_length_mm,r.theoretical_length_mm)),0)
        FROM remnants r WHERE r.item_code=ps.item_code AND r.status='available' ${pf ? "AND r.project_id=?" : ""}) AS remnant_total_mm,
      (SELECT COUNT(*) FROM cutting_plan_details cpd WHERE cpd.item_code=ps.item_code) AS total_cuts
    FROM pipe_stock ps
    LEFT JOIN pipe_master pm ON ps.item_code=pm.item_code
    WHERE 1=1 ${pf}
    GROUP BY ps.item_code
    ORDER BY ps.item_code
  `).all(...pa, ...(project_id ? [project_id, project_id] : []));
  res.json(rows);
});

// ── Export consolidated stock summary as Excel ─────────────────────────────────
router.get('/pipe-stock/consolidated/export/xlsx', requireRole('admin', 'engineer', 'site_supervisor'), (req, res) => {
  const { project_id } = req.query;
  const pf = project_id ? 'AND ps.project_id=?' : '';
  const pa = project_id ? [project_id] : [];
  const rows = p(`
    SELECT ps.item_code, pm.description, pm.material, pm.size_nominal, pm.schedule,
      pm.size_od_mm, pm.wall_thickness_mm,
      COUNT(ps.pipe_tag) AS pipe_count,
      COALESCE(SUM(ps.full_length_mm),0) AS total_full_mm,
      COALESCE(SUM(ps.current_length_mm),0) AS total_avail_mm,
      COALESCE(SUM(ps.full_length_mm - ps.current_length_mm),0) AS total_used_mm,
      SUM(CASE WHEN ps.status='available' THEN 1 ELSE 0 END) AS available_count,
      SUM(CASE WHEN ps.status='partial'   THEN 1 ELSE 0 END) AS partial_count,
      SUM(CASE WHEN ps.status='consumed'  THEN 1 ELSE 0 END) AS consumed_count,
      (SELECT COUNT(*) FROM remnants r WHERE r.item_code=ps.item_code AND r.status='available' ${pf ? "AND r.project_id=?" : ""}) AS remnant_count,
      (SELECT COALESCE(SUM(COALESCE(r.actual_length_mm,r.theoretical_length_mm)),0)
        FROM remnants r WHERE r.item_code=ps.item_code AND r.status='available' ${pf ? "AND r.project_id=?" : ""}) AS remnant_total_mm,
      (SELECT COUNT(*) FROM cutting_plan_details cpd WHERE cpd.item_code=ps.item_code) AS total_cuts
    FROM pipe_stock ps LEFT JOIN pipe_master pm ON ps.item_code=pm.item_code
    WHERE 1=1 ${pf} GROUP BY ps.item_code ORDER BY ps.item_code
  `).all(...pa, ...(project_id ? [project_id, project_id] : []));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.map(r=>({
    'Item Code': r.item_code, 'Description': r.description||'', 'Material': r.material||'',
    'Size': r.size_nominal||'', 'Schedule': r.schedule||'', 'OD (mm)': r.size_od_mm||'',
    'Wall Thk (mm)': r.wall_thickness_mm||'',
    'No. of Pipes': r.pipe_count, 'Total Full Length (mm)': r.total_full_mm,
    'Total Full Length (m)': (r.total_full_mm/1000).toFixed(2),
    'Total Available (mm)': r.total_avail_mm, 'Total Available (m)': (r.total_avail_mm/1000).toFixed(2),
    'Total Used (mm)': r.total_used_mm, 'Total Used (m)': (r.total_used_mm/1000).toFixed(2),
    'Available Pipes': r.available_count, 'Partial Pipes': r.partial_count, 'Consumed Pipes': r.consumed_count,
    'Remnants (count)': r.remnant_count, 'Remnants Total (mm)': r.remnant_total_mm,
    'Remnants Total (m)': (r.remnant_total_mm/1000).toFixed(2), 'Total Cuts Made': r.total_cuts,
  })));
  ws['!cols'] = [16,34,20,10,10,9,11,12,18,16,18,16,14,12,14,12,14,14,18,16,14].map(w=>({wch:w}));
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Summary');
  const buf = XLSX.write(wb, {type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Disposition','attachment; filename="PipeStock_Consolidated.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/master-stock', (req, res) => {
  res.json(p(`SELECT ps.pipe_tag, ps.item_code, pm.description, pm.size_nominal, pm.material, pm.schedule,
    ps.heat_number, ps.full_length_mm, ps.current_length_mm,
    (ps.full_length_mm - ps.current_length_mm) as total_used_mm,
    ps.status, ps.location, ps.received_date,
    (SELECT GROUP_CONCAT(DISTINCT cp.plan_no) FROM cutting_plan_details cpd
      LEFT JOIN cutting_plans cp ON cpd.plan_id=cp.id WHERE cpd.pipe_tag=ps.pipe_tag) as plan_nos,
    (SELECT COUNT(*) FROM cutting_plan_details WHERE pipe_tag=ps.pipe_tag) as cut_count,
    (SELECT rem_no FROM remnants WHERE source_pipe_tag=ps.pipe_tag ORDER BY id DESC LIMIT 1) as latest_rem_no
    FROM pipe_stock ps
    LEFT JOIN pipe_master pm ON ps.item_code=pm.item_code
    ORDER BY ps.item_code, ps.pipe_tag`).all());
});

router.get('/master-remnant-log', (req, res) => {
  res.json(p(`SELECT r.rem_no, r.item_code, pm.description, pm.size_nominal, pm.material,
    r.heat_number, r.source_pipe_tag, cp_src.plan_no as generated_in_plan,
    r.theoretical_length_mm, r.actual_length_mm, r.theoretical_qty, r.actual_qty, r.status,
    (SELECT GROUP_CONCAT(DISTINCT cpd2.pipe_tag) FROM cutting_plan_details cpd2
      WHERE cpd2.pipe_tag=r.rem_no) as used_in_plans,
    (SELECT GROUP_CONCAT(DISTINCT s.spool_no) FROM cutting_plan_details cpd3
      LEFT JOIN spools s ON cpd3.spool_id=s.id WHERE cpd3.pipe_tag=r.rem_no) as allocated_to_spools
    FROM remnants r
    LEFT JOIN pipe_master pm ON r.item_code=pm.item_code
    LEFT JOIN cutting_plans cp_src ON r.source_plan_id=cp_src.id
    ORDER BY r.created_at DESC`).all());
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const { project_id, material, size_nominal, schedule } = req.query;
  // Build item_code filter for slicers (filters stock and remnants by pipe spec)
  let itemCodes = null;
  if (material || size_nominal || schedule) {
    let pmSql = 'SELECT item_code FROM pipe_master WHERE 1=1';
    const pmP = [];
    if (project_id) { pmSql += ' AND project_id=?'; pmP.push(project_id); }
    // FIX-DASH: use NULLIF so rows with empty-string material/size/schedule
    // are treated as unset rather than non-matching — bulk-uploaded pipe master
    // rows often land with '' in these columns, causing the filter to return
    // zero item_codes even when stock exists for that pipe spec.
    if (material)     { pmSql += ' AND COALESCE(NULLIF(material,\'\'),material)=?';     pmP.push(material); }
    if (size_nominal) { pmSql += ' AND COALESCE(NULLIF(size_nominal,\'\'),size_nominal)=?'; pmP.push(size_nominal); }
    if (schedule)     { pmSql += ' AND COALESCE(NULLIF(schedule,\'\'),schedule)=?';     pmP.push(schedule); }
    itemCodes = p(pmSql).all(...pmP).map(r=>r.item_code);
    if (!itemCodes.length) itemCodes = ['__NONE__']; // force empty result
  }

  const pf  = project_id ? ' AND project_id=?' : '';
  const pa  = project_id ? [project_id] : [];
  const icf = itemCodes ? ` AND item_code IN (${itemCodes.map(()=>'?').join(',')})` : '';
  const ica = itemCodes || [];

  const totalStock  = p(`SELECT COUNT(*) as c, COALESCE(SUM(current_length_mm),0) as total, COALESCE(SUM(full_length_mm),0) as full_total FROM pipe_stock WHERE status!='consumed'${pf}${icf}`).get(...pa,...ica);
  const totalRem    = p(`SELECT COUNT(*) as c, COALESCE(SUM(COALESCE(actual_length_mm,theoretical_length_mm)),0) as total_len FROM remnants WHERE status='available'${pf}${icf}`).get(...pa,...ica);
  const totalPlans  = p(`SELECT COUNT(*) as c FROM cutting_plans${project_id?' WHERE project_id=?':''}`).get(...pa);
  const totalSpools = p(`SELECT COUNT(*) as c, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN status='simulated' THEN 1 ELSE 0 END) as simulated FROM spools${project_id?' WHERE project_id=?':''}`).get(...pa);
  const recentPlans = p(`SELECT cp.plan_no, cp.simulated_at, cp.id, u.full_name as by,
    (SELECT COUNT(*) FROM cutting_plan_details WHERE plan_id=cp.id) as cut_count,
    (SELECT COUNT(*) FROM remnants WHERE source_plan_id=cp.id) as rem_generated,
    (SELECT COALESCE(SUM(actual_cut_mm),0) FROM cutting_plan_details WHERE plan_id=cp.id AND cut_from='remnant') as from_remnant_mm,
    (SELECT COALESCE(SUM(actual_cut_mm),0) FROM cutting_plan_details WHERE plan_id=cp.id) as total_cut_mm
    FROM cutting_plans cp LEFT JOIN users u ON cp.simulated_by=u.id
    ${project_id?'WHERE cp.project_id=?':''} ORDER BY cp.simulated_at DESC LIMIT 8`).all(...pa);
  const savingsData = p(`SELECT
    COALESCE(SUM(CASE WHEN cut_from='remnant' THEN actual_cut_mm ELSE 0 END),0) as rem_used_mm,
    COALESCE(SUM(actual_cut_mm),0) as total_cut_mm
    FROM cutting_plan_details cpd
    JOIN cutting_plans cp ON cpd.plan_id=cp.id
    ${project_id?'WHERE cp.project_id=?':''}`).get(...pa);
  res.json({ totalStock, totalRem, totalPlans, totalSpools, recentPlans, savingsData });
});

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────
router.get('/audit-log', requireRole('admin'), (req, res) =>
  res.json(p(`SELECT al.*, u.full_name FROM audit_log al LEFT JOIN users u ON al.user_id=u.id ORDER BY al.timestamp DESC LIMIT 200`).all()));

module.exports = router;
