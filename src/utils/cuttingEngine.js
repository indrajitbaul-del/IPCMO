// src/utils/cuttingEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// IPCMO Cutting Engine v2.2 — Intelligent Pipe Cutting Management & Optimizer
// Algorithm: Remnant-First (BF) → BFD on Stock → Gap-Fill → Pipe-Elimination
//
// BUGFIXES from v2.0:
//   FIX-1: lenStart now correctly captures the ORIGINAL available length before
//           any deductions (was using already-decremented value → wrong remnant calc)
//   FIX-2: Multiple cuts per remnant now correctly tracked via pipeAlloc
//           (remnant pipeTag == remNo, so allocations accumulate correctly)
//   FIX-3: Remnant pool loaded with COALESCE(actual_length_mm, theoretical_length_mm)
//           so remnants with actual_length_mm=NULL are still correctly evaluated
//   FIX-4: ADNOC scrap threshold applied at load time to exclude sub-minimum remnants
// ─────────────────────────────────────────────────────────────────────────────

function runCuttingEngine(db, spoolIds, projectId, projectPrefix) {
  const p      = (sql) => db.prepare(sql);
  const prefix = (projectPrefix || 'IPCMO').toUpperCase();

  // ── Load pipe master data (for allowance and ADNOC scrap threshold) ────────
  const masterMap = {};
  p('SELECT item_code, cutting_allowance_mm, size_nominal, material, description, wall_thickness_mm FROM pipe_master')
    .all()
    .forEach(m => { masterMap[m.item_code] = m; });

  // ── Load available remnants (per item_code, shortest→longest) ─────────────
  // FIX-2: Use COALESCE so actual_length_mm=NULL falls back to theoretical
  // FIX-3: Filter out sub-minimum lengths per ADNOC standard (2× wall thk)
  const remnantPool = {};
  p(`SELECT r.id, r.rem_no, r.item_code,
            COALESCE(r.actual_length_mm, r.theoretical_length_mm) as avail_len,
            r.heat_number, r.theoretical_length_mm, r.actual_length_mm
     FROM remnants r
     WHERE r.status = 'available'
     ORDER BY avail_len ASC`)
    .all()
    .forEach(r => {
      // ADNOC scrap check: skip remnants shorter than 2× wall thickness
      const master = masterMap[r.item_code];
      if (master && master.wall_thickness_mm) {
        const minUsable = 4 * master.wall_thickness_mm; // 4× wt per ADNOC
        if (r.avail_len < minUsable) return; // too short, will be scrapped
      }
      if (!remnantPool[r.item_code]) remnantPool[r.item_code] = [];
      remnantPool[r.item_code].push({
        remId: r.id, remNo: r.rem_no,
        lenOrig: r.avail_len,          // FIX-1: store original BEFORE any deduction
        lenAvail: r.avail_len,
        heatNo: r.heat_number,
        used: false,
      });
    });

  // ── Load available stock pipes (per item_code) ────────────────────────────
  const stockPool = {};
  p(`SELECT ps.pipe_tag, ps.item_code, ps.heat_number,
            ps.current_length_mm   as len_avail,
            ps.full_length_mm      as len_orig
     FROM pipe_stock ps
     WHERE ps.status IN ('available', 'partial')
     ORDER BY ps.current_length_mm DESC`)
    .all()
    .forEach(pipe => {
      if (!stockPool[pipe.item_code]) stockPool[pipe.item_code] = [];
      stockPool[pipe.item_code].push({
        pipeTag: pipe.pipe_tag, heatNo: pipe.heat_number,
        lenOrig: pipe.len_orig,
        lenAvail: pipe.len_avail,
        used: false,
      });
    });

  // ── Flatten spool parts → individual cuts ─────────────────────────────────
  const allCuts = [];
  for (const spoolId of spoolIds) {
    const spool = p('SELECT * FROM spools WHERE id=?').get(spoolId);
    if (!spool) continue;
    const parts = p('SELECT * FROM spool_parts WHERE spool_id=? ORDER BY id').all(spoolId);
    parts.forEach(pt => {
      const qty = pt.qty || 1;
      for (let q = 0; q < qty; q++) {
        const master    = masterMap[pt.item_code] || {};
        const allowance = master.cutting_allowance_mm || 5;
        allCuts.push({
          spoolId,
          spoolNo:  spool.spool_no,
          isoNo:    spool.iso_no,
          partNo:   pt.part_no,
          itemCode: pt.item_code,
          reqLen:   pt.required_length_mm,
          allowance,
          needed:   pt.required_length_mm + allowance,
        });
      }
    });
  }

  // Sort cuts DESCENDING by needed length (BFD pre-sort — order-independent)
  allCuts.sort((a, b) => b.needed - a.needed);

  // ── Allocation state ──────────────────────────────────────────────────────
  const pipeAlloc   = {}; // pipeTag/remNo → allocation record
  const cutResults  = [];
  const newRemnants = [];
  const failedCuts  = [];
  let remSeqBase = (p('SELECT COUNT(*) as c FROM remnants').get()?.c || 0) + 1;
  const genRemNo = () => `${prefix}-REM-${String(remSeqBase++).padStart(6, '0')}`;

  // Record a successful allocation
  const recordCut = (cut, pipeTag, isRemnant, remNo, heatNo, lenOrigForThisSource) => {
    if (!pipeAlloc[pipeTag]) {
      pipeAlloc[pipeTag] = {
        pipeTag, itemCode: cut.itemCode, isRemnant, remNo, heatNo,
        lenStart: lenOrigForThisSource, // FIX-1: true original length
        cuts: [],
      };
    }
    const usedSoFar = pipeAlloc[pipeTag].cuts.reduce((s,c)=>s+c.totalRequired,0);
    pipeAlloc[pipeTag].cuts.push({
      spoolId: cut.spoolId, spoolNo: cut.spoolNo, isoNo: cut.isoNo,
      partNo: cut.partNo, itemCode: cut.itemCode,
      reqLen: cut.reqLen, allowance: cut.allowance,
      totalRequired: cut.needed,
      cumulativeUsed: usedSoFar + cut.needed,
    });
    cutResults.push({
      ...cut, pipeTag, isRemnant, failed: false,
      totalRequired: cut.needed,
    });
  };

  // ── PHASE 1: REMNANT-FIRST (BEST-FIT ON REMNANTS) ────────────────────────
  const unplacedAfterRemnants = [];

  for (const cut of allCuts) {
    const rems = (remnantPool[cut.itemCode] || []).filter(r => !r.used);
    let bestRem = null, bestDiff = Infinity;
    for (const r of rems) {
      if (r.lenAvail >= cut.needed) {
        const diff = r.lenAvail - cut.needed;
        if (diff < bestDiff) { bestDiff = diff; bestRem = r; }
      }
    }
    if (bestRem) {
      const origLen = bestRem.lenOrig; // FIX-1: capture before deduction
      bestRem.lenAvail -= cut.needed;
      bestRem.used = (bestRem.lenAvail < 1);
      recordCut(cut, bestRem.remNo, true, bestRem.remNo, bestRem.heatNo, origLen);
    } else {
      unplacedAfterRemnants.push(cut);
    }
  }

  // ── PHASE 2: STOCK BFD ────────────────────────────────────────────────────
  const unplacedAfterStock = [];

  for (const cut of unplacedAfterRemnants) {
    const pipes = stockPool[cut.itemCode] || [];
    let bestPipe = null, bestDiff = Infinity;
    for (const pipe of pipes) {
      if (pipe.lenAvail >= cut.needed) {
        const diff = pipe.lenAvail - cut.needed;
        if (diff < bestDiff) { bestDiff = diff; bestPipe = pipe; }
      }
    }
    if (bestPipe) {
      const origLen = bestPipe.lenOrig; // FIX-1
      bestPipe.lenAvail -= cut.needed;
      bestPipe.used = (bestPipe.lenAvail < 1);
      recordCut(cut, bestPipe.pipeTag, false, null, bestPipe.heatNo, origLen);
    } else {
      unplacedAfterStock.push(cut);
    }
  }

  // ── PHASE 3: GAP-FILL PASS ───────────────────────────────────────────────
  for (const cut of unplacedAfterStock) {
    const pipes = stockPool[cut.itemCode] || [];
    let placed = false;
    for (const pipe of pipes) {
      if (pipe.lenAvail >= cut.needed) {
        const origLen = bestPipeOrig(pipe, pipeAlloc); // get true original
        pipe.lenAvail -= cut.needed;
        pipe.used = (pipe.lenAvail < 1);
        recordCut(cut, pipe.pipeTag, false, null, pipe.heatNo, pipe.lenOrig);
        placed = true;
        break;
      }
    }
    if (!placed) {
      failedCuts.push(cut);
      cutResults.push({ ...cut, pipeTag: null, isRemnant: false, failed: true, totalRequired: cut.needed });
    }
  }

  // Helper for gap-fill (lenOrig already stored on pipe object)
  function bestPipeOrig(pipe, pa) { return pipe.lenOrig; }

  // ── PHASE 3.5: TARGETED PIPE-ELIMINATION PASS ────────────────────────────
  // After BFD + gap-fill, some pipes may carry only 1–2 small cuts.
  // If ALL cuts on a lightly-loaded pipe can be redistributed into
  // remaining space on other already-opened pipes, eliminate that pipe.
  // FIX-ELIM: three performance fixes for large stock files (500+ pipes):
  //   1. Cache usedMap per round — no more O(n) reduce() inside every inner loop
  //   2. Cap unallocated pipe scan — only scan enough untouched pipes to cover
  //      the victim's total cut length, not all 500+ pipes every candidate
  //   3. MAX_ELIM_ROUNDS guard — hard cap prevents infinite loops on edge cases
  {
    // FIX-HANG: cap rounds to pipeAlloc size — each successful round removes one pipe
    const MAX_ELIM_ROUNDS = Math.max(10, Object.keys(pipeAlloc).length);
    let eliminationRound = true;
    let elimRounds = 0;

    while (eliminationRound && elimRounds < MAX_ELIM_ROUNDS) {
      eliminationRound = false;
      elimRounds++;

      // FIX-1: cache used amounts once per round — was re-reducing cuts[] on every inner iteration
      const usedMap = {};
      for (const [tag, pa] of Object.entries(pipeAlloc)) {
        usedMap[tag] = pa.cuts.reduce((s, c) => s + c.totalRequired, 0);
      }

      // Candidate pipes: stock only, fewest cuts first (easiest to empty)
      const candidates = Object.entries(pipeAlloc)
        .filter(([, pa]) => !pa.isRemnant)
        .sort(([, a], [, b]) => a.cuts.length - b.cuts.length);

      for (const [victimTag, victimPa] of candidates) {
        const victimCuts = victimPa.cuts
          .map(c => c.totalRequired)
          .sort((a, b) => b - a);

        // Build simulated available space from already-allocated pipes (use cache)
        const simAvail = {};
        for (const [tag2, pa2] of Object.entries(pipeAlloc)) {
          if (tag2 === victimTag || pa2.isRemnant || pa2.itemCode !== victimPa.itemCode) continue;
          simAvail[tag2] = Math.max(0, pa2.lenStart - (usedMap[tag2] || 0));
        }

        // FIX-2: only scan enough unallocated pipes to cover victim's total need
        // Previously scanned ALL unallocated pipes — O(n) per candidate per round
        const victimTotal = victimCuts.reduce((s, v) => s + v, 0);
        const unallocWindow = [];
        let accumulated = 0;
        for (const sp of (stockPool[victimPa.itemCode] || [])) {
          if (sp.pipeTag === victimTag || pipeAlloc[sp.pipeTag]) continue;
          simAvail[sp.pipeTag] = sp.lenAvail;
          unallocWindow.push(sp);
          accumulated += sp.lenAvail;
          if (accumulated >= victimTotal) break;
        }

        // BFD-simulate placement of all victim cuts
        let canEliminate = victimCuts.length > 0;
        for (const cutLen of victimCuts) {
          let bestTag = null, bestDiff = Infinity;
          for (const [tag, avail] of Object.entries(simAvail)) {
            if (avail >= cutLen && avail - cutLen < bestDiff) {
              bestDiff = avail - cutLen;
              bestTag  = tag;
            }
          }
          if (bestTag) {
            simAvail[bestTag] -= cutLen;
          } else {
            canEliminate = false;
            break;
          }
        }

        if (canEliminate) {
          // Apply elimination: move each victim cut to real pipes using BFD
          for (const victimCut of victimPa.cuts) {
            const eligibles = [];
            for (const [tag2, pa2] of Object.entries(pipeAlloc)) {
              if (tag2 === victimTag || pa2.isRemnant || pa2.itemCode !== victimPa.itemCode) continue;
              const rem2 = Math.max(0, pa2.lenStart - (usedMap[tag2] || 0));
              if (rem2 >= victimCut.totalRequired) eligibles.push({ tag: tag2, pa: pa2, rem: rem2, isNew: false });
            }
            // FIX-ZERO-CUT: collect unalloc pipes as CANDIDATES only — do NOT open them
            // in pipeAlloc yet. Only open the winner AFTER BFD sort picks it.
            // Previously, ALL unalloc pipes were opened speculatively then only one got
            // the cut — the rest stayed in pipeAlloc with 0 cuts → full-length remnants.
            for (const sp of unallocWindow) {
              if (!pipeAlloc[sp.pipeTag] && sp.lenAvail >= victimCut.totalRequired) {
                eligibles.push({ tag: sp.pipeTag, pa: null, rem: sp.lenAvail, isNew: true, sp });
              }
            }
            if (eligibles.length > 0) {
              const target = eligibles.sort((a, b) => (a.rem - victimCut.totalRequired) - (b.rem - victimCut.totalRequired))[0];
              // Open the pipe in pipeAlloc NOW only if it's the winner
              if (target.isNew) {
                pipeAlloc[target.tag] = {
                  pipeTag: target.tag, itemCode: victimPa.itemCode, isRemnant: false,
                  remNo: null, heatNo: target.sp.heatNo, lenStart: target.sp.lenOrig, cuts: []
                };
                usedMap[target.tag] = 0;
                target.pa = pipeAlloc[target.tag];
              }
              target.pa.cuts.push({ ...victimCut });
              usedMap[target.tag] = (usedMap[target.tag] || 0) + victimCut.totalRequired;
            }
          }

          // Restore victim pipe to stock
          const vs = (stockPool[victimPa.itemCode] || []).find(p => p.pipeTag === victimTag);
          if (vs) { vs.lenAvail = vs.lenOrig; vs.used = false; }
          delete pipeAlloc[victimTag];
          delete usedMap[victimTag];
          // Safety: purge any zero-cut pipes that may have been opened speculatively
          for (const [t, pa] of Object.entries(pipeAlloc)) {
            if (pa.cuts.length === 0 && !pa.isRemnant) {
              const sv2 = (stockPool[pa.itemCode] || []).find(p => p.pipeTag === t);
              if (sv2) { sv2.lenAvail = sv2.lenOrig; sv2.used = false; }
              delete pipeAlloc[t];
              delete usedMap[t];
            }
          }

          eliminationRound = true;
          break;
        }
      }
    }
  }
  // ── PHASE 4: GENERATE REMNANTS ───────────────────────────────────────────
  for (const [pipeTag, pa] of Object.entries(pipeAlloc)) {
    const used    = pa.cuts.reduce((s,c)=>s+c.totalRequired, 0);
    const balance = parseFloat((pa.lenStart - used).toFixed(2));
    if (balance >= 1) {
      const remNo = genRemNo();
      pa.remnant = { remNo, len: balance };
      newRemnants.push({
        remNo, itemCode: pa.itemCode,
        sourcePipeTag: pipeTag, heatNo: pa.heatNo,
        theoreticalLen: balance,
        fromRemnant: pa.isRemnant, srcRemId: pa.remId || null,
      });
    }
  }

  // ── BALANCE POOL (untouched stock/remnants) ───────────────────────────────
  const balancePool = [];
  for (const [code, pipes] of Object.entries(stockPool)) {
    pipes.filter(p => !Object.keys(pipeAlloc).includes(p.pipeTag))
         .forEach(pp => balancePool.push({ pipeTag: pp.pipeTag, itemCode: code, lenAvail: pp.lenAvail, isRemnant: false }));
  }
  for (const [code, rems] of Object.entries(remnantPool)) {
    rems.filter(r => !r.used && !Object.keys(pipeAlloc).includes(r.remNo))
        .forEach(r => balancePool.push({ pipeTag: r.remNo, itemCode: code, lenAvail: r.lenAvail, isRemnant: true }));
  }

  return { cutResults, pipeAlloc, newRemnants, balancePool, allCuts, failedCuts };
}

module.exports = { runCuttingEngine };
