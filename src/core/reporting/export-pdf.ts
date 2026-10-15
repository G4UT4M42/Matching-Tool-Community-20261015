/**
 * PDF export for tax reports (USt-Bericht + Einkommensteuer E1a).
 */
import PDFDocument from 'pdfkit';

function fmtEur(minor: number): string {
  return (minor / 100).toFixed(2).replace('.', ',') + ' €';
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

// ============================================================
// USt-Bericht PDF
// ============================================================

export async function generateVatReportPdf(report: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const pw = doc.page.width - 80;
    const year = report.period_start?.slice(0, 4) ?? '';

    // Title
    doc.fontSize(18).font('Helvetica-Bold').text(`Umsatzsteuererklärung ${year}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#666').text(
      `Zeitraum: ${fmtDate(report.period_start)} — ${fmtDate(report.period_end)}  |  Erstellt: ${fmtDate(report.created_at)}`,
      { align: 'center' }
    );
    doc.moveDown(1);

    // === Summary table ===
    doc.fillColor('#000').fontSize(11).font('Helvetica-Bold').text('Zusammenfassung');
    doc.moveDown(0.4);

    const summaryRows = [
      ['000', 'Summe der Umsätze', fmtEur(report.revenue_total_net_minor ?? (report.revenue_at?.total_net_minor + report.revenue_non_eu?.total_net_minor))],
      [report.revenue_at?.code ?? '022', 'Umsätze Österreich', fmtEur(report.revenue_at?.total_net_minor)],
      [report.revenue_non_eu?.code ?? '011', 'Umsätze nicht-EU (0%)', fmtEur(report.revenue_non_eu?.total_net_minor)],
      ['', '', ''],
      ['072', 'IGL Erwerbe (Basis)', fmtEur(report.cat_072?.total_net_minor)],
      ['065', 'IGL Vorsteuerabzug', fmtEur(report.cat_065?.total_vat_minor)],
      ['076', 'Im Bestimmungsland besteuert', fmtEur(report.cat_076?.total_net_minor)],
      ['066', 'Reverse Charge Dienstleistungen', fmtEur(report.cat_066?.total_net_minor)],
      ['060', 'Vorsteuerabzug Österreich', fmtEur(report.cat_060?.total_vat_minor)],
    ];
    if (report.cat_061?.lines?.length > 0) {
      summaryRows.push(['061', 'Vorsteuerabzug EUSt', fmtEur(report.cat_061?.total_vat_minor)]);
    }

    drawTable(doc, 40, doc.y, pw, ['KZ', 'Bezeichnung', 'Betrag'], summaryRows, [40, pw - 140, 100]);
    doc.moveDown(1);

    // === Detail sections ===
    const sections = [
      { title: 'Umsätze Österreich (022)', lines: report.revenue_at?.lines, showCountry: false },
      { title: 'Umsätze nicht-EU (011)', lines: report.revenue_non_eu?.lines, showCountry: true },
      { title: 'IGL Erwerbe (072)', lines: report.cat_072?.lines, showCountry: true },
      { title: 'Im Bestimmungsland besteuert (076)', lines: report.cat_076?.lines, showCountry: true },
      { title: 'Reverse Charge (066)', lines: report.cat_066?.lines, showCountry: true },
      { title: 'Vorsteuerabzug Österreich (060)', lines: report.cat_060?.lines, showCountry: true },
    ];
    if (report.cat_061?.lines?.length > 0) {
      sections.push({ title: 'Vorsteuerabzug EUSt (061)', lines: report.cat_061?.lines, showCountry: true });
    }
    if (report.other_no_vat?.lines?.length > 0) {
      sections.push({ title: 'Sonstige Ausgaben (keine USt)', lines: report.other_no_vat?.lines, showCountry: true });
    }

    for (const section of sections) {
      if (!section.lines?.length) continue;
      checkPageBreak(doc, 60);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(section.title);
      doc.moveDown(0.3);

      const headers = section.showCountry ? ['Datum', 'Land', 'Lieferant', 'Netto', 'USt', 'Brutto'] : ['Datum', 'Lieferant', 'Netto', 'USt', 'Brutto'];
      const colWidths = section.showCountry ? [55, 30, pw - 255, 55, 55, 60] : [55, pw - 225, 55, 55, 60];
      const rows = section.lines.map((l: any) => {
        const base = [fmtDate(l.document_date), l.supplier_name?.slice(0, 30) ?? '—', fmtEur(Math.abs(l.net_minor)), fmtEur(Math.abs(l.vat_minor)), fmtEur(Math.abs(l.gross_minor))];
        return section.showCountry ? [base[0], l.country_code ?? '—', ...base.slice(1)] : base;
      });

      drawTable(doc, 40, doc.y, pw, headers, rows, colWidths);
      doc.moveDown(0.8);
    }

    // Footer
    doc.fontSize(7).fillColor('#888').text(
      'Fictional Business Demo  |  Mittermühlweg 12/8, 8073 Feldkirchen bei Graz  |  DEMO_INVALID_TAX_ID',
      40, doc.page.height - 30, { width: pw, align: 'center' }
    );

    doc.end();
  });
}

// ============================================================
// Einkommensteuer E1a PDF
// ============================================================

export async function generateIncomeTaxPdf(report: any): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const pw = doc.page.width - 80;
    const year = report.period_start?.slice(0, 4) ?? '';

    // Title
    doc.fontSize(18).font('Helvetica-Bold').text(`Einkommensteuer-Bericht (E1a) ${year}`, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(9).font('Helvetica').fillColor('#666').text(
      `Zeitraum: ${fmtDate(report.period_start)} — ${fmtDate(report.period_end)}  |  Erstellt: ${fmtDate(report.created_at)}`,
      { align: 'center' }
    );
    doc.moveDown(1);

    // === Summary table ===
    doc.fillColor('#000').fontSize(11).font('Helvetica-Bold').text('Zusammenfassung');
    doc.moveDown(0.4);

    const summaryRows: string[][] = [
      ['9040', 'Betriebseinnahmen', fmtEur(report.revenue_total_net_minor)],
    ];
    for (const cat of (report.categories ?? [])) {
      summaryRows.push([cat.kz, cat.title, fmtEur(cat.total_net_minor)]);
    }
    summaryRows.push(['', '', '']);
    summaryRows.push(['', 'Summe Ausgaben', fmtEur(report.expenses_total_net_minor)]);
    summaryRows.push(['', 'Gewinn / Verlust', (report.profit_minor >= 0 ? '+' : '-') + fmtEur(Math.abs(report.profit_minor))]);

    drawTable(doc, 40, doc.y, pw, ['KZ', 'Bezeichnung', 'Betrag'], summaryRows, [40, pw - 140, 100]);
    doc.moveDown(1);

    // === Revenue detail ===
    if (report.revenue_lines?.length > 0) {
      checkPageBreak(doc, 60);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text('9040 Betriebseinnahmen');
      doc.moveDown(0.3);

      const rows = report.revenue_lines.map((l: any) => [
        fmtDate(l.document_date), l.supplier_name?.slice(0, 30) ?? '—',
        fmtEur(l.net_minor), fmtEur(l.vat_minor), fmtEur(l.gross_minor),
      ]);
      drawTable(doc, 40, doc.y, pw, ['Datum', 'Kunde', 'Netto', 'USt', 'Brutto'], rows, [55, pw - 225, 55, 55, 60]);
      doc.moveDown(0.8);
    }

    // === Expense categories ===
    for (const cat of (report.categories ?? [])) {
      if (!cat.lines?.length) continue;
      checkPageBreak(doc, 60);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000').text(`${cat.kz} ${cat.title}`);
      doc.moveDown(0.3);

      const rows = cat.lines.map((l: any) => [
        fmtDate(l.document_date), l.supplier_name?.slice(0, 30) ?? '—',
        fmtEur(Math.abs(l.net_minor)), fmtEur(Math.abs(l.vat_minor)), fmtEur(Math.abs(l.gross_minor)),
      ]);
      drawTable(doc, 40, doc.y, pw, ['Datum', 'Lieferant', 'Netto', 'USt', 'Brutto'], rows, [55, pw - 225, 55, 55, 60]);
      doc.moveDown(0.8);
    }

    // === Unclassified ===
    if (report.unclassified?.length > 0) {
      checkPageBreak(doc, 60);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#c0392b').text(`Nicht zugeordnet (${report.unclassified.length})`);
      doc.moveDown(0.3);
      doc.fillColor('#000');

      const rows = report.unclassified.map((l: any) => [
        fmtDate(l.document_date), l.supplier_name?.slice(0, 30) ?? '—',
        fmtEur(Math.abs(l.net_minor)), fmtEur(Math.abs(l.vat_minor)), fmtEur(Math.abs(l.gross_minor)),
      ]);
      drawTable(doc, 40, doc.y, pw, ['Datum', 'Lieferant', 'Netto', 'USt', 'Brutto'], rows, [55, pw - 225, 55, 55, 60]);
      doc.moveDown(0.8);
    }

    // Footer
    doc.fontSize(7).fillColor('#888').text(
      'Fictional Business Demo  |  Mittermühlweg 12/8, 8073 Feldkirchen bei Graz  |  DEMO_INVALID_TAX_ID',
      40, doc.page.height - 30, { width: pw, align: 'center' }
    );

    doc.end();
  });
}

// ============================================================
// Helpers
// ============================================================

function checkPageBreak(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - 50) {
    doc.addPage();
  }
}

function drawTable(
  doc: PDFKit.PDFDocument,
  x: number, startY: number, tableWidth: number,
  headers: string[], rows: string[][],
  colWidths: number[],
) {
  const rowHeight = 14;
  const headerHeight = 16;
  const fontSize = 7;
  let y = startY;

  // Header
  doc.rect(x, y, tableWidth, headerHeight).fill('#f0f0f0');
  doc.fillColor('#333').fontSize(fontSize).font('Helvetica-Bold');
  let cx = x;
  for (let i = 0; i < headers.length; i++) {
    const align = i >= headers.length - 3 && headers.length > 3 ? 'right' : 'left';
    doc.text(headers[i], cx + 3, y + 3, { width: colWidths[i] - 6, align: align as any });
    cx += colWidths[i];
  }
  y += headerHeight;

  // Rows
  doc.font('Helvetica').fontSize(fontSize).fillColor('#000');
  for (const row of rows) {
    if (y + rowHeight > doc.page.height - 50) {
      doc.addPage();
      y = 40;
    }
    // Empty row = separator
    if (row.every(c => c === '')) { y += 4; continue; }

    // Alternating background
    cx = x;
    for (let i = 0; i < row.length; i++) {
      const align = i >= row.length - 3 && row.length > 3 ? 'right' : 'left';
      doc.text(row[i] ?? '', cx + 3, y + 2, { width: colWidths[i] - 6, align: align as any });
      cx += colWidths[i];
    }
    // Bottom border
    doc.moveTo(x, y + rowHeight - 1).lineTo(x + tableWidth, y + rowHeight - 1).strokeColor('#eee').lineWidth(0.3).stroke();
    y += rowHeight;
  }

  doc.y = y + 4;
}
