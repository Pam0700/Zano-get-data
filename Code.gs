/**
 * Zalo Bot -> Google Apps Script -> Google Sheets
 * Tìm sản phẩm theo TÊN, trả về văn bản kèm hình ảnh. Mã SP do hệ thống tự sinh (thêm qua trang Admin).
 *
 * Script properties (Project Settings > Script properties):
 *   ZALO_BOT_TOKEN  = token bot (BẮT BUỘC)
 *   WEBHOOK_SECRET  = chuỗi bí mật 8-256 ký tự, chữ và số (BẮT BUỘC)
 *   ADMIN_PASSWORD  = mật khẩu trang Admin (xem Admin.gs)
 *   IMAGE_FOLDER_ID = tự tạo khi upload ảnh đầu tiên
 *
 * Cấu trúc sheet: A Mã SP (tự sinh) | B Tên SP | C Giá | D Hoa hồng | E Link | F Hình ảnh | G Trạng thái (Hiện/Ẩn)
 * Module: Products.gs (ẩn/xoá), Import.gs (nhập hàng loạt), Logs.gs (thống kê), Alerts.gs (cảnh báo lỗi), Access.gs + Approve.html (mật khẩu truy cập, quản trị viên duyệt)
 */

const CONFIG = {
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',
  SHEET_NAME: 'Products',
  HEADER_ROW: 1,
  CODE_COLUMN: 1,                // cột Mã SP (tự sinh, không dùng để tìm kiếm)
  IMAGE_COLUMN: 6,               // cột Hình ảnh (URL ảnh)
  STATUS_COLUMN: 7,              // cột Trạng thái; trống hoặc 'Hiện' = bot tìm thấy, 'Ẩn' = bot bỏ qua
  STATUS_VISIBLE: 'Hiện',
  STATUS_HIDDEN: 'Ẩn',
  CODE_PREFIX: 'SP',
  CODE_PAD: 3,                   // SP001, SP002, ...
  IMAGE_FOLDER_NAME: 'ZaloBot Images',
  CACHE_SECONDS: 60,             // cache dữ liệu sheet; 0 = tắt cache
  SELECTION_SECONDS: 600,        // nhớ danh sách gợi ý để người dùng chọn theo số
  WEB_APP_URL: 'YOUR_WEB_APP_URL',   // URL /exec sau khi deploy
  API_BASE: 'https://bot-api.zaloplatforms.com',
  FUZZY: {
    NAME_COLUMN: 2,              // cột tên sản phẩm (2 = cột B)
    SUGGEST_COLUMNS: [2, 3],     // các cột hiện trong danh sách gợi ý (B, C)
    MAX_SUGGESTIONS: 5,
    MIN_QUERY_LENGTH: 2
  },
  // Định dạng hiển thị theo tên cột ở dòng tiêu đề. Cột không khai báo sẽ hiển thị "• Tên cột: giá trị".
  FIELD_STYLES: {
    'Mã SP':     { icon: '🏷', label: 'Mã' },
    'Tên SP':    { icon: '📦', label: 'Tên' },
    'Giá':       { icon: '💰', label: 'Giá', type: 'money' },
    'Hoa hồng':  { icon: '💵', label: 'Hoa hồng' },
    'Link':      { icon: '🔗', label: 'Link' }
  },
  RESULT_TITLE: '🔎 THÔNG TIN SẢN PHẨM'
};

const MSG = {
  EMPTY: 'Bạn chưa nhập nội dung. Gõ #help để xem hướng dẫn.',
  NOT_TEXT: 'Bot hiện chỉ hỗ trợ tin nhắn dạng văn bản.',
  NOT_FOUND: (k) => 'Không tìm thấy sản phẩm cho "' + k + '".',
  QUERY_TOO_SHORT: 'Từ khoá quá ngắn, vui lòng nhập thêm.',
  SUGGEST_FOOT: 'Gửi số thứ tự (VD: 1) để xem chi tiết.',
  BAD_CHOICE: (n) => 'Vui lòng chọn số từ 1 đến ' + n + '.',
  ERROR: 'Hệ thống đang gặp lỗi, vui lòng thử lại sau.',
  HELP: 'Hướng dẫn:\n• Gửi tên sản phẩm (VD: máy xay) để tra cứu\n• Nếu có nhiều kết quả, gửi số thứ tự (1, 2, ...) để xem chi tiết\n• #ten máy xay : tìm theo tên\n• #help : xem hướng dẫn'
};

/* ===================== LOG ===================== */

function log_(level, event, data) {
  // Không bao giờ truyền token/secret vào đây
  console.log(JSON.stringify({ t: new Date().toISOString(), level: level, event: event, data: data || {} }));
  // [Alerts.gs] báo admin khi có lỗi
  if (level === 'error' && typeof notifyAdmin_ === 'function') {
    try { notifyAdmin_(event, data); } catch (e) {}
  }
}

// Hàm KHÔNG có dấu _ ở cuối có thể bị gọi từ trình duyệt qua google.script.run bởi bất kỳ ai mở được trang Web App.
// Các hàm cài đặt/test bên dưới gọi requireOwner_() để chỉ chủ project (chạy trong trình soạn thảo) dùng được.
function requireOwner_() {
  const active = Session.getActiveUser().getEmail();
  if (!active || active !== Session.getEffectiveUser().getEmail()) {
    throw new Error('Chỉ chủ project mới chạy được hàm này.');
  }
}

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/* ===================== WEBHOOK ===================== */

function doPost(e) {
  let chatId = null;
  try {
    // Apps Script không đọc được header X-Bot-Api-Secret-Token,
    // nên kiểm tra bí mật qua tham số ?key= trên URL webhook.
    if (!e || !e.parameter || e.parameter.key !== getProp_('WEBHOOK_SECRET')) {
      log_('warn', 'forbidden');
      return ok_();
    }

    const req = parseRequest_(e);
    chatId = req.chatId;
    if (req.error) {
      log_('warn', 'parse_error', { error: req.error });
      if (chatId) sendZaloMessage_(chatId, req.userMessage || MSG.ERROR);
      return ok_();
    }

    if (isDuplicate_(req.messageId)) {
      log_('info', 'duplicate_skipped', { messageId: req.messageId });
      return ok_();
    }

    sendReply_(req.chatId, buildReply_(req));
  } catch (err) {
    log_('error', 'doPost_exception', { message: String(err), stack: err && err.stack });
    try { if (chatId) sendZaloMessage_(chatId, MSG.ERROR); } catch (e2) {}
  }
  return ok_();
}

function ok_() {
  return ContentService.createTextOutput('ok');
}

// Tách dữ liệu từ request Zalo. Trả về {userId, chatId, text, messageId} hoặc {error, userMessage}
function parseRequest_(e) {
  if (!e.postData || !e.postData.contents) return { error: 'no_body' };

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return { error: 'invalid_json' };
  }

  const update = body.result || body;
  const msg = update.message;
  if (!msg) return { error: 'no_message' };

  const chatId = msg.chat && msg.chat.id;
  const userId = (msg.from && msg.from.id) || chatId;
  if (!chatId) return { error: 'no_user_id' };

  if (typeof msg.text !== 'string') {
    return { error: 'not_text', chatId: chatId, userMessage: MSG.NOT_TEXT };
  }

  const userName = (msg.from && (msg.from.display_name || msg.from.name || msg.from.first_name)) || '';
  return { userId: userId, chatId: chatId, userName: userName, text: msg.text, messageId: msg.message_id || null };
}

// Zalo có thể gửi lại webhook: bỏ qua message đã xử lý
function isDuplicate_(messageId) {
  if (!messageId) return false;
  const cache = CacheService.getScriptCache();
  const key = 'msg_' + messageId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 600);
  return false;
}

/* ===================== COMMAND ===================== */

// Handler trả về chuỗi hoặc { text, photo }. Thêm lệnh mới: khai báo thêm vào đây
const COMMANDS = {
  tim: (args, req) => searchByName_(args, req.chatId),
  ten: (args, req) => searchByName_(args, req.chatId),
  lienket: (args, req) => linkAdminCommand_(args, req),   // [Alerts.gs] liên kết admin nhận cảnh báo
  duyet: (args, req) => accessDecisionCommand_(args, req, true),    // [Access.gs] quản trị viên cho phép người dùng mới
  chan: (args, req) => accessDecisionCommand_(args, req, false),    // [Access.gs] quản trị viên chặn người dùng mới
  help: () => MSG.HELP,
  start: () => MSG.HELP
};
const DEFAULT_COMMAND = 'tim';

function parseCommand_(text) {
  const t = text.trim();
  const m = t.match(/^[#\/](\w+)(?:@\S+)?\s*([\s\S]*)$/);
  if (m) return { name: m[1].toLowerCase(), args: m[2].trim(), explicit: true };
  return { name: DEFAULT_COMMAND, args: t, explicit: false };
}

function toReply_(r) {
  return typeof r === 'string' ? { text: r, photo: '' } : r;
}

// Trả về { text, photo }. Hàm này không gọi Zalo nên test được độc lập.
function buildReply_(req) {
  // [Access.gs] người chưa nhập mật khẩu bị chặn tại đây, trước khi ghi log (tránh lộ mật khẩu trong log)
  if (typeof gateAccess_ === 'function') {
    const gate = gateAccess_(req);
    if (gate) return toReply_(gate);
  }

  const cmd = parseCommand_(req.text);
  log_('info', 'message_received', { userId: req.userId, message: req.text, command: cmd.name, keyword: cmd.args });

  // Người dùng gửi số để chọn trong danh sách gợi ý gần nhất
  if (!cmd.explicit && /^\d{1,2}$/.test(cmd.args)) {
    const picked = pickFromSelection_(req.chatId, Number(cmd.args));
    if (picked) return toReply_(picked);
  }

  const handler = COMMANDS[cmd.name];
  if (!handler) return toReply_('Lệnh không tồn tại. Gõ #help để xem hướng dẫn.');
  return toReply_(handler(cmd.args, req));
}

// [Logs.gs] ghi lịch sử tra cứu; bỏ qua nếu chưa cài module
function track_(chatId, keyword, outcome, count) {
  if (typeof recordSearch_ === 'function') recordSearch_(chatId, keyword, outcome, count);
}

/* ===================== TÌM THEO TÊN ===================== */

// Bỏ dấu tiếng Việt, hạ chữ thường: "Máy Xay" -> "may xay"
function foldText_(v) {
  return String(v === null || v === undefined ? '' : v)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

// Đọc toàn bộ sheet 1 lần (có cache). Dùng getDisplayValues để giữ đúng định dạng ô (VD 10%).
function getSheetData_() {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'sheet_' + CONFIG.SHEET_NAME;
  if (CONFIG.CACHE_SECONDS > 0) {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('Không tìm thấy sheet "' + CONFIG.SHEET_NAME + '"');

  const values = sheet.getDataRange().getDisplayValues();
  if (CONFIG.CACHE_SECONDS > 0) {
    try { cache.put(cacheKey, JSON.stringify(values), CONFIG.CACHE_SECONDS); } catch (e) { /* >100KB thì bỏ cache */ }
  }
  return values;
}

function clearSheetCache_() {
  CacheService.getScriptCache().remove('sheet_' + CONFIG.SHEET_NAME);
}

function isHidden_(row) {
  return foldText_(row[CONFIG.STATUS_COLUMN - 1]) === foldText_(CONFIG.STATUS_HIDDEN);
}

// Mỗi từ của keyword phải là phần đầu của một từ trong tên (không phân biệt dấu/hoa thường).
// Xếp hạng: trùng hoàn toàn > bắt đầu bằng > chứa cụm > khớp từng từ.
function findRowsByName_(query) {
  const values = getSheetData_();
  const headers = values[CONFIG.HEADER_ROW - 1] || [];
  const col = CONFIG.FUZZY.NAME_COLUMN - 1;
  const phrase = foldText_(query);
  const tokens = phrase.split(' ').filter(Boolean);

  const scored = [];
  for (let i = CONFIG.HEADER_ROW; i < values.length; i++) {
    const name = foldText_(values[i][col]);
    if (!name || isHidden_(values[i])) continue;
    const padded = ' ' + name;
    if (!tokens.every((t) => padded.indexOf(' ' + t) > -1)) continue;

    let score = 1;
    if (name === phrase) score = 4;
    else if (name.indexOf(phrase) === 0) score = 3;
    else if (padded.indexOf(' ' + phrase) > -1) score = 2;
    scored.push({ row: values[i], score: score, order: i });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return {
    headers: headers,
    rows: scored.map((s) => s.row),
    exactRows: scored.filter((s) => s.score === 4).map((s) => s.row)
  };
}

// Dùng nội bộ để mở lại sản phẩm đã chọn từ danh sách gợi ý
function findRowByCode_(code) {
  const values = getSheetData_();
  const col = CONFIG.CODE_COLUMN - 1;
  for (let i = CONFIG.HEADER_ROW; i < values.length; i++) {
    if (String(values[i][col]).trim() === code && !isHidden_(values[i])) return { headers: values[CONFIG.HEADER_ROW - 1] || [], row: values[i] };
  }
  return null;
}

function searchByName_(query, chatId) {
  if (!query) return MSG.EMPTY;
  if (foldText_(query).length < CONFIG.FUZZY.MIN_QUERY_LENGTH) return MSG.QUERY_TOO_SHORT;

  try {
    const r = findRowsByName_(query);
    log_('info', 'name_search', { keyword: query, count: r.rows.length });
    track_(chatId, query, r.rows.length === 0 ? 'not_found' : (r.rows.length === 1 || r.exactRows.length === 1 ? 'found' : 'multiple'), r.rows.length);

    if (r.rows.length === 0) return MSG.NOT_FOUND(query);
    if (r.rows.length === 1) return productReply_(r.rows[0], r.headers);
    if (r.exactRows.length === 1) return productReply_(r.exactRows[0], r.headers);

    const shown = r.rows.slice(0, CONFIG.FUZZY.MAX_SUGGESTIONS);
    saveSelection_(chatId, shown.map((row) => String(row[CONFIG.CODE_COLUMN - 1]).trim()));
    return formatSuggestions_(r.rows, shown, r.headers, query);
  } catch (err) {
    log_('error', 'search_error', { keyword: query, message: String(err) });
    track_(chatId, query, 'error', 0);
    return MSG.ERROR;
  }
}

/* ===== Nhớ danh sách gợi ý theo từng người dùng ===== */

function saveSelection_(chatId, codes) {
  CacheService.getScriptCache().put('sel_' + chatId, JSON.stringify(codes), CONFIG.SELECTION_SECONDS);
}

// Trả về phản hồi nếu người dùng đang có danh sách gợi ý, ngược lại trả null
function pickFromSelection_(chatId, n) {
  const raw = CacheService.getScriptCache().get('sel_' + chatId);
  if (!raw) return null;
  const codes = JSON.parse(raw);
  if (n < 1 || n > codes.length) return MSG.BAD_CHOICE(codes.length);
  const found = findRowByCode_(codes[n - 1]);
  if (!found) return null;
  track_(chatId, found.row[CONFIG.FUZZY.NAME_COLUMN - 1], 'selected', 1);
  return productReply_(found.row, found.headers);
}

/* ===================== FORMAT ===================== */

function formatMoney_(v) {
  const digits = String(v).replace(/[^\d]/g, '');
  if (!digits) return String(v);
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
}

function formatCell_(header, raw) {
  if (raw === '' || raw === null || raw === undefined) return '';
  const style = CONFIG.FIELD_STYLES[header];
  return style && style.type === 'money' ? formatMoney_(raw) : String(raw);
}

// Không hiển thị cột hình ảnh trong văn bản (ảnh được gửi riêng)
function formatResult_(rowData, headers) {
  const lines = [CONFIG.RESULT_TITLE];
  for (let c = 0; c < headers.length; c++) {
    if (c === CONFIG.IMAGE_COLUMN - 1 || c === CONFIG.STATUS_COLUMN - 1) continue;
    const header = headers[c];
    const raw = rowData[c];
    if (!header || raw === '' || raw === null || raw === undefined) continue;

    const style = CONFIG.FIELD_STYLES[header];
    if (style) {
      const value = style.type === 'money' ? formatMoney_(raw) : raw;
      lines.push(style.icon + ' ' + style.label + ': ' + value);
    } else {
      lines.push('• ' + header + ': ' + raw);
    }
  }
  return lines.join('\n');
}

function formatSuggestions_(rows, shown, headers, query) {
  const lines = shown.map((r, i) =>
    (i + 1) + '. ' + CONFIG.FUZZY.SUGGEST_COLUMNS
      .map((c) => formatCell_(headers[c - 1], r[c - 1]))
      .filter(Boolean)
      .join(' - ')
  );
  const note = rows.length > shown.length ? ' (hiển thị ' + shown.length + ' đầu tiên)' : '';
  return 'Tìm thấy ' + rows.length + ' sản phẩm phù hợp với "' + query + '"' + note + ':\n' +
    lines.join('\n') + '\n\n' + MSG.SUGGEST_FOOT;
}

// Cho phép dán link Drive dạng chia sẻ; tự đổi sang link ảnh trực tiếp
function toDirectImageUrl_(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const m = v.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]+)/) ||
            v.match(/lh3\.googleusercontent\.com\/d\/([\w-]+)/);
  return m ? 'https://lh3.googleusercontent.com/d/' + m[1] : v;
}

function productReply_(row, headers) {
  return {
    text: formatResult_(row, headers),
    photo: toDirectImageUrl_(row[CONFIG.IMAGE_COLUMN - 1])
  };
}

/* ===================== ZALO API ===================== */

function callZalo_(method, payload) {
  const token = getProp_('ZALO_BOT_TOKEN');
  if (!token) throw new Error('Thiếu Script property ZALO_BOT_TOKEN');

  const res = UrlFetchApp.fetch(CONFIG.API_BASE + '/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  let data = null;
  try { data = JSON.parse(res.getContentText()); } catch (e) {}

  if (code >= 300 || (data && data.ok === false)) {
    log_('error', 'zalo_api_error', { method: method, http: code, body: res.getContentText().substring(0, 300) });
    return { ok: false, http: code, data: data };
  }
  return { ok: true, http: code, data: data };
}

// Zalo giới hạn 2000 ký tự/tin nhắn
function sendZaloMessage_(userId, message) {
  let allOk = true;
  for (let i = 0; i < message.length; i += 2000) {
    const r = callZalo_('sendMessage', { chat_id: userId, text: message.substring(i, i + 2000) });
    if (!r.ok) allOk = false;
  }
  return allOk;
}

// Gửi ảnh kèm caption; nếu gửi ảnh lỗi thì tự chuyển sang gửi văn bản
function sendReply_(chatId, reply) {
  if (reply.photo) {
    const r = callZalo_('sendPhoto', { chat_id: chatId, photo: reply.photo, caption: reply.text });
    if (r.ok) return true;
    log_('warn', 'send_photo_failed_fallback_text', { photo: reply.photo });
  }
  return sendZaloMessage_(chatId, reply.text);
}

/* ===================== CÀI ĐẶT / TEST (chạy thủ công) ===================== */

function setWebhook() {
  requireOwner_();
  const secret = getProp_('WEBHOOK_SECRET');
  const url = expectedWebhookUrl_(secret);   // Admin.gs: ưu tiên địa chỉ đã lưu / deployment hiện tại / CONFIG
  console.log(JSON.stringify(callZalo_('setWebhook', { url: url, secret_token: secret })));
}
function getWebhookInfo() { requireOwner_(); console.log(JSON.stringify(callZalo_('getWebhookInfo'))); }
function deleteWebhook() { requireOwner_(); console.log(JSON.stringify(callZalo_('deleteWebhook'))); }
function testGetMe() { requireOwner_(); console.log(JSON.stringify(callZalo_('getMe'))); }

// Tạo sheet Products với dữ liệu mẫu (xoá dữ liệu cũ của tab này!)
function seedSampleData() {
  requireOwner_();
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);
  sheet.clear();
  sheet.getRange(1, 1, 4, 7).setValues([
    ['Mã SP', 'Tên SP', 'Giá', 'Hoa hồng', 'Link', 'Hình ảnh', 'Trạng thái'],
    ['SP001', 'Nồi chiên không dầu', 1200000, '10%', 'https://shopee.vn/sp001', '', 'Hiện'],
    ['SP002', 'Máy xay sinh tố', 800000, '8%', 'https://shopee.vn/sp002', '', 'Hiện'],
    ['SP003', 'Máy ép trái cây', 1500000, '12%', 'https://shopee.vn/sp003', '', 'Hiện']
  ]);
  clearSheetCache_();
}

// Test logic tìm kiếm + format mà KHÔNG gọi Zalo; xem kết quả ở Execution log
function testReply() {
  requireOwner_();
  ['máy xay', 'noi chien', 'máy', '1', 'xyz', 'm', '#help', ''].forEach((text) => {
    const r = buildReply_({ userId: 'test', chatId: 'test', text: text });
    console.log('>>> "' + text + '"\n' + r.text + (r.photo ? '\n[ẢNH] ' + r.photo : ''));
  });
}
