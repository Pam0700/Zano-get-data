/**
 * MODULE: Lịch sử tra cứu + thống kê
 * Tab "Logs" tự tạo. Code.gs gọi recordSearch_() qua track_().
 * outcome: found | multiple | not_found | selected | error
 */

const LOGS = {
  SHEET_NAME: 'Logs',
  HEADERS: ['Thời gian', 'Zalo ID', 'Từ khoá', 'Kết quả', 'Số lượng'],
  MAX_ROWS: 5000,        // vượt quá thì xoá bớt 500 dòng cũ nhất
  TZ: 'Asia/Ho_Chi_Minh'
};

function getLogSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(LOGS.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOGS.SHEET_NAME);
    sheet.getRange(1, 1, 1, LOGS.HEADERS.length).setValues([LOGS.HEADERS]).setFontWeight('bold');
    sheet.getRange('B:C').setNumberFormat('@');     // văn bản thuần: tránh biến "=..." thành công thức
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Không bao giờ làm hỏng luồng trả lời của bot
function recordSearch_(chatId, keyword, outcome, count) {
  try {
    const sheet = getLogSheet_();
    sheet.appendRow([new Date(), String(chatId), String(keyword || ''), outcome, count || 0]);
    if (sheet.getLastRow() > LOGS.MAX_ROWS) sheet.deleteRows(2, 500);
  } catch (err) {
    console.error('recordSearch_ lỗi: ' + err);
  }
}

function topN_(map, n) {
  return Object.keys(map)
    .map((k) => ({ keyword: map[k].label, count: map[k].count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

function adminGetLogStats(password, days) {
  adminAuth_(password);
  days = Math.min(Math.max(Number(days) || 7, 1), 90);
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  const rows = last > 1 ? sheet.getRange(2, 1, last - 1, LOGS.HEADERS.length).getValues() : [];
  const since = Date.now() - days * 86400000;

  const s = { days: days, total: 0, users: 0, found: 0, multiple: 0, not_found: 0, selected: 0, error: 0,
              topKeywords: [], topNotFound: [], recent: [] };
  const all = {}, miss = {}, users = {};
  const inRange = [];

  rows.forEach((r) => {
    const t = r[0] instanceof Date ? r[0].getTime() : 0;
    if (t < since) return;
    inRange.push(r);
    const outcome = String(r[3]);
    s.total++;
    if (s[outcome] !== undefined) s[outcome]++;
    users[r[1]] = true;

    if (outcome === 'found' || outcome === 'multiple' || outcome === 'not_found') {
      const key = foldText_(r[2]);
      if (!key) return;
      (all[key] = all[key] || { label: String(r[2]), count: 0 }).count++;
      if (outcome === 'not_found') (miss[key] = miss[key] || { label: String(r[2]), count: 0 }).count++;
    }
  });

  s.users = Object.keys(users).length;
  s.topKeywords = topN_(all, 10);
  s.topNotFound = topN_(miss, 10);
  s.recent = inRange.slice(-20).reverse().map((r) => ({
    time: Utilities.formatDate(r[0], LOGS.TZ, 'dd/MM HH:mm'),
    keyword: String(r[2]),
    outcome: String(r[3])
  }));
  return s;
}
