# IPCMO v2.4
### Integrated Pipe Cutting Management & Optimizer

> A server-based pipe cutting management system built for large-scale EPC piping projects. Tracks pipe stock, simulates optimal cut sequences, generates traceable cutting plans, and manages remnants — all without cloud dependency.

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Initialize database
npm run setup-db

# 3. Start server
npm start
```

Open browser → **http://localhost:3000**

| Field    | Default      |
|----------|-------------|
| Username | `admin`      |
| Password | `Admin@1234` |

> ⚠️ Change the default password immediately after first login.

---

## ✨ Features

### 📋 Pipe Master
- Centralised register of all pipe item codes
- Stores material, nominal size, OD, wall thickness, schedule, standard
- Per-item-code cutting allowance configuration
- Bulk upload via Excel (.xlsx) and export back to Excel

### 📦 Pipe Stock
- Full stock register with pipe tags, heat numbers, and current lengths
- Bulk upload support (3,000+ records via transactional insert)
- Consolidated summary view grouped by item code
- Tracks pipe status: `available`, `in-use`, `depleted`

### 🔧 Spool Input
- Spool and ISO drawing management per project
- Multi-part spool entries with item code, required length, and quantity
- Material-type filtering for focused simulation runs

### ⚙️ Run Simulation (Cutting Engine)
A four-phase Best-Fit Descending (BFD) allocation engine:

| Phase | Description |
|-------|-------------|
| 1 | Remnant-first BFD allocation |
| 2 | Fresh stock BFD allocation |
| 3 | Gap-fill pass |
| 3.5 | Pipe elimination / consolidation (dynamic round cap) |
| 4 | Remnant generation from pipe balances |

- Filters by material type before simulation
- Auto-detects material code from pipe master for plan numbering
- Handles 500+ pipe stock records without hanging

### 📄 Cutting Plans
- Auto-numbered plans: `{PROJECT}-{MATCODE}-CP-{YEAR}-{NNNN}`
- Full detail per cut: pipe tag, spool, part no., required length, cutting allowance, actual cut
- Traceable back to originating simulation
- Export to PDF and Excel

### 🗂️ Remnant Register
- Auto-generated remnants from pipe balances after each simulation
- Traceable to source pipe tag and source cutting plan
- Prevents full-length pipes from being incorrectly logged as remnants
- Export to Excel

### 📊 Master Stock Register
- Consolidated view across pipe stock and remnants
- Full export to Excel

### 📈 Dashboard
- Live project overview with material utilisation stats
- Slicers for material, nominal size, and schedule
- Works correctly with bulk-uploaded data (handles empty-string field normalisation)

### 🏗️ Projects
- Multi-project support
- Cutting plans and spools are scoped per project

### 👥 Users & Access Control
- Role-based access: Admin, Engineer, Viewer
- Session-based authentication
- Per-user audit trail

### 🔍 Audit Log
- Every action logged: who, what, when
- Immutable record for project closeout documentation

### 📐 Cutting Allowance Chart
- Configurable allowances per pipe size and material
- Seeded with standard defaults on first setup

---

## 🗃️ Database Schema (Key Tables)

| Table | Key Fields |
|-------|-----------|
| `pipe_master` | `item_code`, `material`, `size_nominal`, `size_od_mm`, `wall_thickness_mm`, `schedule`, `cutting_allowance_mm` |
| `pipe_stock` | `pipe_tag`, `item_code`, `heat_number`, `full_length_mm`, `current_length_mm`, `status` |
| `spools` | `id`, `spool_no`, `iso_no`, `status`, `project_id` |
| `spool_parts` | `spool_id`, `part_no`, `item_code`, `required_length_mm`, `qty` |
| `cutting_plans` | `id`, `plan_no`, `project_id`, `simulated_by`, `simulated_at` |
| `cutting_plan_details` | `plan_id`, `spool_id`, `part_no`, `pipe_tag`, `required_length_mm`, `cutting_allowance_mm`, `actual_cut_mm` |
| `remnants` | `rem_no`, `item_code`, `heat_number`, `theoretical_length_mm`, `actual_length_mm`, `source_pipe_tag`, `source_plan_id` |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js ≥ 22.5.0 |
| Framework | Express 4 |
| Database | SQLite via `node:sqlite` (built-in, no native addon) |
| Auth | express-session + bcryptjs |
| Excel Export | ExcelJS |
| PDF Export | PDFKit |
| File Upload | Multer |
| Frontend | Vanilla JS, single-file (`public/app.html`) — no framework |

---

## 📁 Project Structure

```
ipcmo_v2.4/
├── public/
│   ├── app.html          # Full single-page frontend
│   └── login.html        # Login page
├── src/
│   ├── db/
│   │   ├── index.js      # DatabaseSync wrapper & helpers
│   │   └── setup.js      # Schema creation & migrations
│   ├── middleware/
│   │   └── auth.js       # Session auth middleware
│   ├── routes/
│   │   └── api.js        # All REST API endpoints
│   ├── utils/
│   │   ├── cuttingEngine.js  # BFD simulation engine
│   │   └── exportUtils.js    # Excel & PDF export helpers
│   └── server.js         # Express app entry point
├── docs/
│   └── USER_MANUAL.txt   # Full setup & usage guide
├── data/                 # SQLite database (auto-created)
├── package.json
├── START_SERVER.bat      # Windows one-click launcher
└── INSTALL_WINDOWS.txt   # Windows installation guide
```

---

## 🖥️ Windows Deployment

1. Install **Node.js ≥ 22.5.0** from [nodejs.org](https://nodejs.org)
2. Run `install_db_driver.bat` (one-time setup)
3. Double-click `START_SERVER.bat` to launch
4. Open **http://localhost:3000** in any browser

> The app runs entirely on-site. No internet connection required after initial `npm install`.

---

## 🔄 Changelog — v2.4

- Fixed cutting engine Phase 3.5 hang on large stock files (553+ pipes) with `usedMap` cache and dynamic round cap
- Fixed full-length remnants (11,800mm) appearing in remnant register
- Fixed second batch simulation hang
- Fixed `renderSimResult` crash (`lenOrig` → `lenStart`)
- Fixed bulk pipe stock upload timeout (3,270 rows) with `BEGIN/COMMIT` transaction
- Fixed dashboard slicers broken by empty-string material/size/schedule fields
- Fixed material type filter not filtering spools in Run Simulation
- Fixed search box not showing selected item code
- Fixed `removeSimulatedSpools` partial deletion (sequential → parallel)
- Fixed cutting plan/remnant prefix missing material code
- Added Pipe Master Excel export (`/api/pipe-master/export/xlsx`)
- Added Pipe Stock consolidated summary (`/api/pipe-stock/consolidated`)
- Fixed Master Stock export pointing to wrong endpoint

---

## 📜 License

Private / Internal use. All rights reserved.

---

*Built for EPC piping execution teams where every metre of pipe matters.*
