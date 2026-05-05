// src/utils/exportUtils.js
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// ─── EXCEL: Cutting Plan ─────────────────────────────────────────────────────
async function exportCuttingPlanXLS(plan, details, remnants, res) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IPCMO v2.1'; wb.created = new Date();

  // ── Sheet 1: Cutting Plan ──────────────────────────────────────────────────
  const ws = wb.addWorksheet('Cutting Plan', { pageSetup: { orientation: 'landscape' } });
  ws.columns = [
    { header: 'Plan No',        key: 'plan_no',    width: 22 },
    { header: 'ISO No',         key: 'iso_no',     width: 22 },
    { header: 'Spool No',       key: 'spool_no',   width: 14 },
    { header: 'Part No',        key: 'part_no',    width: 12 },
    { header: 'Item Code',      key: 'item_code',  width: 18 },
    { header: 'Pipe Tag',       key: 'pipe_tag',   width: 22 },
    { header: 'Required (mm)',  key: 'req_mm',     width: 15 },
    { header: 'Required (m)',   key: 'req_m',      width: 13 },
    { header: 'Cut Allow (mm)', key: 'allow_mm',   width: 14 },
    { header: 'Total Cut (mm)', key: 'total_mm',   width: 15 },
    { header: 'Total Cut (m)',  key: 'total_m',    width: 13 },
    { header: 'Source',         key: 'source',     width: 12 },
    { header: 'Entry Type',     key: 'entry_type', width: 13 },
  ];

  ws.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0C0F' } };
    cell.font = { bold: true, color: { argb: 'FFF5F2EB' }, size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFC94B1A' } } };
  });
  ws.getRow(1).height = 22;

  details.forEach((d, i) => {
    const row = ws.addRow({
      plan_no:    plan.plan_no,
      iso_no:     d.iso_no || d.iso_no_snapshot || '—',
      spool_no:   d.spool_no || d.spool_no_snapshot || '—',
      part_no:    d.part_no,
      item_code:  d.item_code,
      pipe_tag:   d.pipe_tag,
      req_mm:     d.required_length_mm,
      req_m:      +(d.required_length_mm / 1000).toFixed(3),
      allow_mm:   d.cutting_allowance_mm,
      total_mm:   d.actual_cut_mm,
      total_m:    +(d.actual_cut_mm / 1000).toFixed(3),
      source:     d.cut_from,
      entry_type: d.entry_type || 'auto',
    });
    const baseColor = d.cut_from === 'remnant' ? 'FFE8F5E9' : (i % 2 === 0 ? 'FFF5F2EB' : 'FFFFFFFF');
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: baseColor } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFC8C4B8' } } };
      cell.font = { size: 10, italic: d.entry_type === 'manual' };
    });
    if (d.cut_from === 'remnant') {
      row.getCell('source').font = { bold: true, color: { argb: 'FF1E8449' }, size: 10 };
    }
    if (d.entry_type === 'manual') {
      row.getCell('entry_type').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
      row.getCell('entry_type').font = { bold: true, color: { argb: 'FF856404' }, size: 10 };
    }
  });
  ws.autoFilter = 'A1:M1';

  // ── Sheet 2: Remnants Generated ──────────────────────────────────────────
  const ws2 = wb.addWorksheet('Remnants Generated');
  ws2.columns = [
    { header: 'Remnant No',          key: 'rem_no',    width: 20 },
    { header: 'Item Code',           key: 'item_code', width: 18 },
    { header: 'Description',         key: 'desc',      width: 36 },
    { header: 'Size',                key: 'size',      width: 8  },
    { header: 'Heat No',             key: 'heat',      width: 14 },
    { header: 'Theoretical L (mm)',  key: 'theo_mm',   width: 18 },
    { header: 'Theoretical L (m)',   key: 'theo_m',    width: 16 },
    { header: 'Source Pipe/Remnant', key: 'src',       width: 22 },
    { header: 'Status',              key: 'status',    width: 12 },
  ];
  ws2.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8960A' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { horizontal: 'center' };
  });
  (remnants || []).forEach((r, i) => {
    const row = ws2.addRow({
      rem_no:   r.rem_no,
      item_code:r.item_code,
      desc:     r.description || '',
      size:     r.size_nominal || '',
      heat:     r.heat_number || '',
      theo_mm:  r.theoretical_length_mm,
      theo_m:   +(r.theoretical_length_mm / 1000).toFixed(3),
      src:      r.source_pipe_tag || '',
      status:   r.status || 'available',
    });
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFFFF8E0' : 'FFFFFFFF' } };
      cell.font = { size: 10 };
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="CuttingPlan_${plan.plan_no}.xlsx"`);
  await wb.xlsx.write(res);
}

// ─── EXCEL: Remnant Register ─────────────────────────────────────────────────
async function exportRemnantRegisterXLS(remnants, res) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Remnant Register', { pageSetup: { orientation: 'landscape' } });

  ws.columns = [
    { header: 'Remnant No', key: 'rem_no', width: 16 },
    { header: 'Item Code', key: 'item_code', width: 14 },
    { header: 'Description', key: 'description', width: 26 },
    { header: 'Size', key: 'size_nominal', width: 10 },
    { header: 'Material', key: 'material', width: 16 },
    { header: 'Heat No', key: 'heat_number', width: 14 },
    { header: 'Source Pipe', key: 'source_pipe_tag', width: 14 },
    { header: 'Source Plan', key: 'source_plan', width: 14 },
    { header: 'Theoretical L (mm)', key: 'theoretical_length_mm', width: 18 },
    { header: 'Actual L (mm)', key: 'actual_length_mm', width: 14 },
    { header: 'Theoretical Qty', key: 'theoretical_qty', width: 14 },
    { header: 'Actual Qty', key: 'actual_qty', width: 12 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Location', key: 'location', width: 16 },
    { header: 'Last Updated', key: 'last_updated_at', width: 18 },
  ];

  ws.getRow(1).eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8960A' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  ws.getRow(1).height = 28;

  remnants.forEach((r, i) => {
    const row = ws.addRow(r);
    if (i % 2 === 0) row.eachCell(c => c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8E0' } });
    row.eachCell(c => { c.border = { bottom: { style: 'thin', color: { argb: 'FFC8C4B8' } } }; c.font = { size: 10 }; });
  });

  ws.autoFilter = 'A1:O1';

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="RemnantRegister_${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
}

// ─── EXCEL: Site Update Template ─────────────────────────────────────────────
async function exportSiteUpdateTemplate(remnants, res) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Site Update');

  // Instructions sheet
  const wi = wb.addWorksheet('INSTRUCTIONS');
  wi.getCell('A1').value = 'SITE REMNANT UPDATE TEMPLATE';
  wi.getCell('A1').font = { bold: true, size: 14 };
  wi.getCell('A3').value = 'INSTRUCTIONS:';
  wi.getCell('A3').font = { bold: true };
  wi.getCell('A4').value = '1. Only update columns: actual_length_mm, actual_qty, heat_number, location, notes';
  wi.getCell('A5').value = '2. Do NOT change rem_no column — it is the key field';
  wi.getCell('A6').value = '3. Do NOT add or delete rows';
  wi.getCell('A7').value = '4. Save as .xlsx and upload via the system';
  wi.getCell('A8').value = '5. Upload by end of day for master register sync';

  ws.columns = [
    { header: 'rem_no', key: 'rem_no', width: 16 },
    { header: 'item_code', key: 'item_code', width: 14 },
    { header: 'size_nominal', key: 'size_nominal', width: 10 },
    { header: 'heat_number', key: 'heat_number', width: 14 },
    { header: 'theoretical_length_mm', key: 'theoretical_length_mm', width: 20 },
    { header: 'actual_length_mm', key: 'actual_length_mm', width: 18 },
    { header: 'theoretical_qty', key: 'theoretical_qty', width: 15 },
    { header: 'actual_qty', key: 'actual_qty', width: 12 },
    { header: 'location', key: 'location', width: 16 },
    { header: 'status', key: 'status', width: 14 },
    { header: 'notes', key: 'notes', width: 24 },
  ];

  // Editable columns highlighted
  const editableCols = ['D', 'F', 'H', 'I', 'K'];
  ws.getRow(1).eachCell((cell, colNum) => {
    const col = ws.getColumn(colNum).letter;
    const isEdit = editableCols.includes(col);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEdit ? 'FF2A6E3F' : 'FF0A0C0F' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.alignment = { horizontal: 'center' };
  });
  ws.getRow(1).height = 22;

  remnants.forEach((r, i) => {
    const row = ws.addRow({
      rem_no: r.rem_no,
      item_code: r.item_code,
      size_nominal: r.size_nominal || '',
      heat_number: r.heat_number || '',
      theoretical_length_mm: r.theoretical_length_mm,
      actual_length_mm: r.actual_length_mm || '',
      theoretical_qty: r.theoretical_qty,
      actual_qty: r.actual_qty || '',
      location: r.location || '',
      status: r.status,
      notes: '',
    });
    // Lock non-editable cols
    ['A','B','C','E','G','J'].forEach(col => {
      const cell = row.getCell(col);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
      cell.font = { color: { argb: 'FF888888' }, size: 10 };
    });
    editableCols.forEach(col => {
      row.getCell(col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? 'FFFFF8E0' : 'FFFFFFFF' } };
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="SiteUpdate_${new Date().toISOString().split('T')[0]}.xlsx"`);
  await wb.xlsx.write(res);
}

// ─── PDF: Cutting Plan ───────────────────────────────────────────────────────
function exportCuttingPlanPDF(plan, details, spoolGroups, res) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="CuttingPlan_${plan.plan_no}.pdf"`);
  doc.pipe(res);

  // Header
  doc.rect(0, 0, doc.page.width, 70).fill('#0a0c0f');
  doc.fillColor('#f5f2eb').fontSize(18).font('Helvetica-Bold')
    .text('INTEGRATED PIPE CUTTING MANAGEMENT & OPTIMIZER', 40, 15, { width: doc.page.width - 80 });
  doc.fillColor('#c94b1a').fontSize(11)
    .text(`CUTTING PLAN: ${plan.plan_no}`, 40, 40);
  doc.fillColor('#8b90a0').fontSize(9)
    .text(`Generated: ${new Date(plan.simulated_at).toLocaleString()}   Status: ${plan.status.toUpperCase()}`, 40, 55);

  doc.y = 85;
  doc.fillColor('#0a0c0f');

  // Group by spool — spoolGroups is now {key: {iso, spool, cuts}}
  for (const [, group] of Object.entries(spoolGroups)) {
    if (doc.y > doc.page.height - 120) doc.addPage();

    // Header band — show ISO + SPOOL on the same row
    doc.rect(40, doc.y, doc.page.width - 80, 22).fill('#2d4a6e');
    doc.fillColor('#d4a017').fontSize(9).font('Helvetica-Bold')
      .text(`ISO: `, 48, doc.y + 6, { continued: true })
      .fillColor('#ffffff').text(`${group.iso}`, { continued: true })
      .fillColor('#d4a017').text(`     SPOOL: `, { continued: true })
      .fillColor('#ffffff').text(`${group.spool}`, { continued: true })
      .fillColor('#8b90a0').fontSize(8).text(`     (${group.cuts.length} cut${group.cuts.length!==1?'s':''})`);
    doc.y += 26;

    // Table header — wider Part column to fit ISO/SPOOL/PART label
    const cols = [180, 70, 80, 70, 70, 70, 70];
    const hdrs = ['ISO / Spool / Part', 'Item Code', 'Pipe Tag', 'Req (mm)', 'Allow', 'Total (mm)', 'Source'];
    doc.rect(40, doc.y, doc.page.width - 80, 16).fill('#f5f2eb');
    let x = 40;
    hdrs.forEach((h, i) => {
      doc.fillColor('#555b6e').fontSize(8).font('Helvetica-Bold').text(h, x + 2, doc.y + 4, { width: cols[i] - 4 });
      x += cols[i];
    });
    doc.y += 18;

    group.cuts.forEach((d, idx) => {
      if (doc.y > doc.page.height - 60) doc.addPage();
      if (idx % 2 === 0) doc.rect(40, doc.y, doc.page.width - 80, 14).fill('#faf9f5');
      let x2 = 40;
      // First column = ISO / Spool / Part No combined
      const partLabel = `${d.iso_no || '—'} / ${d.spool_no} / ${d.part_no}`;
      const vals = [partLabel, d.item_code, d.pipe_tag, d.required_length_mm, d.cutting_allowance_mm, d.actual_cut_mm, d.cut_from];
      vals.forEach((v, i) => {
        doc.fillColor('#0a0c0f').fontSize(7).font(i===0 ? 'Helvetica-Bold' : 'Helvetica').text(String(v), x2 + 2, doc.y + 3, { width: cols[i] - 4 });
        x2 += cols[i];
      });
      doc.y += 16;
    });
    doc.y += 8;
  }

  // Footer
  doc.fontSize(7).fillColor('#8b90a0')
    .text('IPCMO — Confidential — For internal use only', 40, doc.page.height - 30);

  doc.end();
}

// ─── PDF: Remnant Register ───────────────────────────────────────────────────
function exportRemnantPDF(remnants, res) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="RemnantRegister_${Date.now()}.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 60).fill('#c8960a');
  doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold').text('REMNANT REGISTER', 40, 15);
  doc.fontSize(9).text(`Exported: ${new Date().toLocaleString()}   Total: ${remnants.length} remnants`, 40, 40);
  doc.y = 75;

  const cols = [90, 70, 70, 60, 80, 90, 80, 60, 60, 80];
  const hdrs = ['Remnant No', 'Item Code', 'Size', 'Heat No', 'Description', 'Theo L (mm)', 'Actual L (mm)', 'Theo Qty', 'Act Qty', 'Status'];

  doc.rect(40, doc.y, doc.page.width - 80, 18).fill('#0a0c0f');
  let x = 40;
  hdrs.forEach((h, i) => {
    doc.fillColor('#f5f2eb').fontSize(8).font('Helvetica-Bold').text(h, x + 2, doc.y + 5, { width: cols[i] - 4 });
    x += cols[i];
  });
  doc.y += 20;

  remnants.forEach((r, idx) => {
    if (doc.y > doc.page.height - 60) { doc.addPage(); doc.y = 40; }
    if (idx % 2 === 0) doc.rect(40, doc.y, doc.page.width - 80, 14).fill('#fffbf0');
    let x2 = 40;
    const vals = [r.rem_no, r.item_code, r.size_nominal||'', r.heat_number||'—', r.description||'', r.theoretical_length_mm, r.actual_length_mm||'—', r.theoretical_qty, r.actual_qty||'—', r.status];
    vals.forEach((v, i) => {
      doc.fillColor('#0a0c0f').fontSize(8).font('Helvetica').text(String(v), x2 + 2, doc.y + 3, { width: cols[i] - 4 });
      x2 += cols[i];
    });
    doc.y += 16;
  });

  doc.fontSize(7).fillColor('#8b90a0').text('IPCMO — Remnant Register', 40, doc.page.height - 30);
  doc.end();
}

module.exports = { exportCuttingPlanXLS, exportCuttingPlanPDF, exportRemnantRegisterXLS, exportSiteUpdateTemplate, exportRemnantPDF };
