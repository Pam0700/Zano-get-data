/**
 * MODULE: Nhập sản phẩm hàng loạt
 * Dán từ Excel/Google Sheets (phân tách bằng Tab) hoặc CSV (dấu phẩy / chấm phẩy).
 * Dòng đầu = tiêu đề cột trùng với tiêu đề trong sheet (không phân biệt dấu/hoa thường).
 * Mã SP và Trạng thái do hệ thống tự điền. Cột Hình ảnh chỉ nhận link http(s).
 */

const IMPORT = { MAX_ROWS: 200 };

// Tách văn bản thành mảng 2 chiều; tự nhận dấu phân cách; hỗ trợ giá trị đặt trong "..."
function parseDelimited_(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = first.indexOf('\t') > -1 ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');

  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// dryRun = true: chỉ kiểm tra và báo cáo, không ghi gì vào sheet
function adminImportProducts(password, text, dryRun) {
  adminAuth_(password);
  const table = parseDelimited_(text);
  if (table.length < 2) throw new Error('Cần ít nhất 1 dòng tiêu đề và 1 dòng dữ liệu.');
  if (table.length - 1 > IMPORT.MAX_ROWS) throw new Error('Tối đa ' + IMPORT.MAX_ROWS + ' dòng mỗi lần nhập.');

  const sheet = getProductSheet_();
  const width = sheetWidth_(sheet);
  const sheetHeaders = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, width).getDisplayValues()[0];

  // Ghép cột trong dữ liệu dán với cột trong sheet theo tiêu đề
  const colMap = {};
  const ignored = [];
  table[0].forEach((h, i) => {
    const idx = sheetHeaders.findIndex((sh) => sh && foldText_(sh) === foldText_(h));
    const col = idx + 1;
    if (idx < 0 || col === CONFIG.CODE_COLUMN || col === CONFIG.STATUS_COLUMN) ignored.push(String(h).trim());
    else colMap[i] = col;
  });
  const nameCol = CONFIG.FUZZY.NAME_COLUMN;
  if (Object.keys(colMap).every((i) => colMap[i] !== nameCol)) {
    throw new Error('Thiếu cột "' + sheetHeaders[nameCol - 1] + '" ở dòng tiêu đề.');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const existing = {};
    const last = sheet.getLastRow();
    if (last > CONFIG.HEADER_ROW) {
      sheet.getRange(CONFIG.HEADER_ROW + 1, nameCol, last - CONFIG.HEADER_ROW, 1).getDisplayValues()
        .forEach((r) => { existing[foldText_(r[0])] = true; });
    }

    const good = [], skipped = [];
    table.slice(1).forEach((r, k) => {
      const line = k + 2;
      const rec = {};
      Object.keys(colMap).forEach((i) => { rec[colMap[i]] = r[i] === undefined ? '' : String(r[i]).trim(); });
      const name = rec[nameCol] || '';
      if (!name) { skipped.push({ line: line, reason: 'Thiếu tên sản phẩm' }); return; }
      const key = foldText_(name);
      if (existing[key]) { skipped.push({ line: line, name: name, reason: 'Tên đã tồn tại (trong sheet hoặc trùng trong file)' }); return; }
      existing[key] = true;
      good.push(rec);
    });

    if (!dryRun && good.length) {
      const codes = nextCodes_(sheet, good.length);
      const out = good.map((rec, j) => {
        const row = new Array(width).fill('');
        Object.keys(rec).forEach((c) => {
          const col = Number(c);
          row[col - 1] = col === CONFIG.IMAGE_COLUMN
            ? (/^https?:\/\//i.test(rec[c]) ? toDirectImageUrl_(rec[c]) : '')
            : normalizeCellValue_(sheetHeaders[col - 1], rec[c]);
        });
        row[CONFIG.CODE_COLUMN - 1] = codes[j];
        row[CONFIG.STATUS_COLUMN - 1] = CONFIG.STATUS_VISIBLE;
        return row;
      });
      if (!sheetHeaders[CONFIG.IMAGE_COLUMN - 1]) sheet.getRange(CONFIG.HEADER_ROW, CONFIG.IMAGE_COLUMN).setValue('Hình ảnh');
      ensureStatusHeader_(sheet);
      sheet.getRange(sheet.getLastRow() + 1, 1, out.length, width).setValues(out);
      clearSheetCache_();
      log_('info', 'admin_import', { added: good.length, skipped: skipped.length });
    }

    return {
      dryRun: !!dryRun,
      added: good.length,
      skipped: skipped,
      ignoredColumns: ignored,
      sampleNames: good.slice(0, 5).map((rec) => rec[nameCol])
    };
  } finally {
    lock.releaseLock();
  }
}
