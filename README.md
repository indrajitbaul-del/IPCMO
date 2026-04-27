<div align="center">

# 🔧 IPCMO

### Integrated Pipe Cutting Management & Optimizer

**A browser-based pipe cutting optimisation system for offshore/onshore EPC fabrication yards**

[![Node.js](https://img.shields.io/badge/Node.js-22.5+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/SQLite-Built--in-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![License](https://img.shields.io/badge/license-Proprietary-red.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-Production-success.svg)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue.svg)]()

[Features](#-features) • [Demo](#-demo) • [Quick Start](#-quick-start) • [Architecture](#-architecture) • [Screenshots](#-screenshots)

</div>

---

## 📋 Overview

**IPCMO** maximises pipe stock utilisation by intelligently reusing leftover pieces (remnants) from previous cuts. Built for piping fabrication yards that work with hundreds of spools across multiple projects, IPCMO can save **15-25% of pipe material** on typical EPC projects by tracking every offcut and prioritising its reuse before opening fresh pipes.

### The Problem It Solves

Traditional pipe cutting workflow:
- Workshop cuts pipes for a spool → leftover scraps are discarded as waste
- Next spool needs cuts → fresh pipes are opened again, more waste
- No record of remnants → impossible to reuse them later
- Across hundreds of spools, this waste compounds into significant material cost

### The IPCMO Approach

```
For each cut required:
  1️⃣  Try shortest sufficient REMNANT first  (least waste)
  2️⃣  If no remnant fits → continue on CURRENT open pipe
  3️⃣  Only open a NEW pipe when nothing else fits
```

Every leftover gets a unique tracked ID (e.g. `PROJ-A-REM-000123`) and automatically appears in future simulations — **savings compound over time**.

---

## ✨ Features

### Core Modules
- 🔩 **Pipe Master** — Item codes with ASME B36.10/B36.19 auto-fill (OD, wall thickness)
- 📦 **Pipe Stock** — Physical inventory with heat numbers, locations, lengths
- 📐 **Spool Input** — Multi-part spools with bulk Excel upload
- ⚡ **Cutting Simulation** — 3-step optimisation engine with full traceability
- 📋 **Cutting Plans Register** — Browse, export (PDF/Excel), undo any plan
- ♻️ **Remnant Register** — Track every leftover with full chain of custody
- 📊 **Demo Mode** — Side-by-side comparison showing waste savings (great for presentations)
- 📈 **Master Reports** — Stock utilisation, remnant lifecycle analytics

### Technical Features
- ✅ **Offline-first** — runs on isolated yard PCs without internet
- ✅ **Zero build tools** — no webpack, no compilation, no Visual Studio Build Tools needed
- ✅ **Multi-project support** — all data scoped per project from day one
- ✅ **Role-based access** — Admin, Engineer, Site Supervisor, Site User, Viewer
- ✅ **Reversible operations** — every cutting plan can be undone with full state restore
- ✅ **Audit trail** — every write logged (who, what, when, where)
- ✅ **Auto-migrations** — schema upgrades happen automatically on startup
- ✅ **Single-file backup** — entire database is one SQLite file

---

## 🎬 Demo

### Demo Mode — See the Savings

The built-in Demo page runs **two parallel simulations** on the same input:

| Without Remnant Reuse | With Remnant Reuse |
|---|---|
| 4 fresh pipes consumed | 4 pipes consumed |
| 5.21m permanently discarded | Only 0.76m discarded |
| 0m tracked for reuse | **4.45m logged as reusable remnants** |

The Key Insight panel auto-detects when both approaches use the same pipe count (forced by a large cut) and explains *why* — perfect for management presentations.

---

## 🛠 Tech Stack

<table>
<tr><th align="left">Layer</th><th align="left">Technology</th><th align="left">Why This Choice</th></tr>
<tr><td><b>Runtime</b></td><td>Node.js 22.5+</td><td>Built-in <code>node:sqlite</code> — no native compilation</td></tr>
<tr><td><b>Web Server</b></td><td>Express 4</td><td>Mature, minimal, well-documented</td></tr>
<tr><td><b>Database</b></td><td>SQLite (built-in)</td><td>Zero-install, single-file DB, ACID transactions</td></tr>
<tr><td><b>Auth</b></td><td>express-session + bcryptjs</td><td>Session cookies, pure-JS password hashing</td></tr>
<tr><td><b>Excel I/O</b></td><td>ExcelJS</td><td>Pure JS, supports XLSX read/write/styling</td></tr>
<tr><td><b>PDF Export</b></td><td>PDFKit</td><td>Vector PDFs, no headless browser needed</td></tr>
<tr><td><b>Frontend</b></td><td>Vanilla JS + HTML + CSS</td><td>Single-file SPA, no build step, no framework</td></tr>
</table>

> **Why no React/Vue?** IPCMO deploys on isolated yard PCs without internet and limited IT support. Avoiding a build pipeline keeps deployment to "extract zip → run" — a critical operational advantage.

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 22.5 or higher** ([download](https://nodejs.org/))
- Windows / Linux / macOS

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/ipcmo.git
cd ipcmo

# Install dependencies (Express, ExcelJS, etc.)
npm install

# Initialise the database (creates tables, seeds default admin)
npm run setup-db

# Start the server
npm start
```

### First Login

Open `http://localhost:3000` in your browser.

```
Username: admin
Password: Admin@1234
```

⚠️ **You will be required to change the password on first login.**

### Windows Quick Start

For Windows users, simply double-click **`START_SERVER.bat`** — it auto-installs dependencies and starts the server.

---

## 📁 Project Structure

```
ipcmo/
├── package.json              ← Dependencies + npm scripts
├── START_SERVER.bat          ← Windows: auto-install + run
├── docs/
│   └── USER_MANUAL.txt       ← End-user documentation
├── data/
│   └── ipcmo.db              ← SQLite database (auto-created)
├── public/
│   ├── login.html            ← Login page
│   └── app.html              ← Single-page application (entire UI)
└── src/
    ├── server.js             ← Express bootstrap
    ├── db/
    │   ├── index.js          ← Database wrapper (singleton)
    │   └── setup.js          ← Schema + migrations + seed
    ├── middleware/
    │   └── auth.js           ← requireLogin, requireRole, auditLog
    ├── routes/
    │   └── api.js            ← All REST endpoints (~60)
    └── utils/
        ├── cuttingEngine.js  ← Allocation algorithm
        └── exportUtils.js    ← Excel + PDF export
```

---

## 🏗 Architecture

### Allocation Engine

The cutting engine implements a **3-step greedy allocation** prioritising waste minimisation:

```javascript
For each cut required:
  1. Filter remnants where remaining_length >= required + allowance
     Sort ascending by remaining length (smallest fit = least waste)
     If found → allocate, mark consumed if remaining < 1mm

  2. If no remnant fits → check current open pipe
     If it fits → cut from current pipe (packs cuts together)

  3. Otherwise → log current pipe's leftover as a new remnant
     Open the next pipe from stock
     Allocate this cut
```

This packs cuts efficiently onto pipes while always preferring to consume existing offcuts first.

### Database Schema

14 tables organised around three core entities:

```
projects (1) ──── (n) pipe_master      [item code definitions]
          (1) ──── (n) pipe_stock       [physical pipes]
          (1) ──── (n) spools           [spools to fabricate]

cutting_plans (1) ── (n) cutting_plan_details  ──→ refs spools, pipe_stock, remnants
remnants (1) ── (n) remnant_usage              [chain of custody]
users → audit_log                              [every write logged]
```

### API Conventions

All endpoints follow a consistent pattern:

```javascript
router.post("/pipe-master",
  requireRole("admin", "engineer"),       // ← role guard
  (req, res) => {
    const { item_code, ... } = req.body;
    if (!item_code) return res.status(400).json({ error: "Required" });

    try {
      const result = p(`INSERT INTO pipe_master ...`).run(...);
      auditLog(req, "CREATE", "pipe_master", item_code, JSON.stringify(req.body));
      res.json({ id: result.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);
```

### Migrations

No migration framework — `setup.js` is **idempotent** and runs on every startup. New columns are added via `addColumnIfMissing()`:

```javascript
addColumnIfMissing("cutting_plan_details", "iso_no_snapshot TEXT");
addColumnIfMissing("cutting_plan_details", "spool_no_snapshot TEXT");

// Backfill from existing relationships
db.prepare(`UPDATE cutting_plan_details
  SET iso_no_snapshot = (SELECT iso_no FROM spools WHERE spools.id = cutting_plan_details.spool_id)
  WHERE iso_no_snapshot IS NULL`).run();
```

---

## 📸 Screenshots

| Page | Description |
|---|---|
| **Dashboard** | Project KPIs: pipes in stock, pending spools, plans this month |
| **Pipe Master** | Item codes with ASME auto-fill — pick size + schedule, OD/WT populate automatically |
| **Cutting Simulation** | Select spools → engine generates plan in <1s with full breakdown |
| **Cutting Plans Register** | Browse, view BOM with ISO/Spool/Part hierarchy, export PDF/XLSX, undo |
| **Demo Mode** | Side-by-side comparison showing remnant savings |
| **Remnant Register** | Track every leftover with source pipe, generated plan, current location |

> Screenshots can be added to `/docs/screenshots/` and referenced here.

---

## 👥 User Roles

| Role | Capabilities |
|---|---|
| **Admin** | Everything — user management, projects, all data operations |
| **Engineer** | Pipe master, stock, spools, run simulations, view all reports |
| **Site Supervisor** | Spools, run simulations, mark cuts done on site |
| **Site User** | Update cut quantities on site, view cutting plans |
| **Viewer** | Read-only access to all reports |

---

## 🔒 Security

- Passwords hashed with **bcryptjs** (10 rounds)
- Session cookies with **8-hour expiry**
- All write operations logged to immutable audit table
- Role-based authorization on every endpoint
- SQL injection protected via prepared statements throughout
- HTTPS recommended for production deployments (use a reverse proxy like Nginx)

---

## 📊 Capacity & Performance

| Project Size | Database Size | Cold Start | Simulation Time |
|---|---|---|---|
| Small (<5,000 spools) | < 50 MB | < 1s | < 100ms |
| Medium (5K–20K spools) | 200–500 MB | < 1s | < 500ms |
| Large (>20K spools) | 1–2 GB | < 2s | 1–3s |

SQLite's theoretical limit is 281 TB — practical limit is your disk space.

---

## 💾 Backup Strategy

The entire database is a **single file**: `data/ipcmo.db`

```bash
# Manual backup (Windows)
copy data\ipcmo.db backups\ipcmo_%date%.db

# Atomic backup using SQLite VACUUM (recommended for hot backup)
sqlite3 data/ipcmo.db "VACUUM INTO 'backups/ipcmo_$(date +%Y%m%d).db'"
```

Recommended: Schedule daily backups via Windows Task Scheduler or cron.

---

## 🌐 Network Deployment

To share IPCMO across a yard LAN:

1. Run on a server PC (the server listens on `0.0.0.0:3000`)
2. Note its IP: `ipconfig` (e.g. `192.168.1.50`)
3. Open Windows Firewall for port 3000 (inbound TCP)
4. Other users access via `http://192.168.1.50:3000`

For internet exposure, use a reverse proxy (Nginx/Caddy) with SSL.

---

## 🤝 Contributing

This is a private fabrication yard tool, but architectural feedback is welcome.

**Architectural rules to preserve:**
- ❌ Don't add a frontend framework (React/Vue) — kills the no-build deployment story
- ❌ Don't replace SQLite unless data exceeds 5GB
- ❌ Don't add a build step (webpack/Vite/TypeScript transpilation)
- ✅ Do use the established `auditLog()` pattern on every write
- ✅ Do add migrations via `addColumnIfMissing()` not raw `ALTER TABLE`
- ✅ Do scope queries to `req.session.currentProject` for project isolation

---

## 📜 License

This project is proprietary software. All rights reserved.

For licensing enquiries, please contact the author.

---

## 👤 Author

Built by an EPC piping engineer who got tired of seeing pipe scraps in the dumpster.

- **Domain expertise:** Piping engineering, fabrication, ASME B31.3
- **Tech stack:** Node.js, SQLite, JavaScript

If this project interests you and you'd like to discuss it, feel free to reach out.

---

## 🙏 Acknowledgements

- ASME B36.10M / B36.19M for standard pipe dimensions
- The fabrication yard supervisors who explained why every metre of pipe matters
- The Node.js team for shipping `node:sqlite` — making zero-dependency SQLite finally practical

---

<div align="center">

**⭐ If this project demonstrates the kind of practical problem-solving you're looking for, let's talk.**

Built with ☕ and a healthy disrespect for waste.

</div>
