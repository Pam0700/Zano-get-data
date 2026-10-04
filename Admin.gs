/**
 * Trang quản trị Zalo Bot (thêm vào cùng project với Code.gs, không sửa Code.gs)
 *
 * Script properties cần thêm:
 *   ADMIN_PASSWORD = mật khẩu đăng nhập trang quản trị (ít nhất 8 ký tự)
 *
 * Mở trang: <WEB_APP_URL>?page=admin
 * LƯU Ý: nếu trước đó bạn đã tự thêm hàm doGet() ở Code.gs thì xoá đi, file này đã có doGet().
 */

const ADMIN_MAX_FAILS = 5;
const ADMIN_LOCK_SECONDS = 600;
// SHARE_PER_FILE = true : chia sẻ từng file ảnh (chắc chắn hoạt động, chậm hơn ~1-2 giây/ảnh)
// SHARE_PER_FILE = false: chỉ chia sẻ thư mục ảnh 1 lần, file mới thừa hưởng quyền (nhanh hơn; hãy thử gửi ảnh qua bot để chắc chắn)
const ADMIN_IMAGE = { SHARE_PER_FILE: true };

function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'admin') {
    return HtmlService.createTemplateFromFile('Admin').evaluate()
      .setTitle('Zalo Bot Admin')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  }
  if (e && e.parameter && e.parameter.page === 'approve') {
    const t = HtmlService.createTemplateFromFile('Approve');
    t.token = String(e.parameter.t || '').replace(/[^a-z0-9]/gi, '').substring(0, 64);
    return t.evaluate()
      .setTitle('Duyệt truy cập')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover');
  }
  return ContentService.createTextOutput('ok');
}

// Cho phép Admin.html nhúng các module giao diện: <?!= include('AdminLogs') ?>
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ===================== BẢO MẬT ===================== */

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Mọi hàm admin đều gọi hàm này đầu tiên
function adminAuth_(password) {
  const adminPw = getProp_('ADMIN_PASSWORD');
  if (!adminPw || adminPw.length < 8) {
    throw new Error('Chưa đặt ADMIN_PASSWORD (ít nhất 8 ký tự) trong Script properties.');
  }
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('admin_fails') || 0);
  if (fails >= ADMIN_MAX_FAILS) {
    throw new Error('Đăng nhập sai quá nhiều lần. Thử lại sau 10 phút.');
  }
  if (!safeEqual_(String(password || ''), adminPw)) {
    cache.put('admin_fails', String(fails + 1), ADMIN_LOCK_SECONDS);
    log_('warn', 'admin_login_failed');
    throw new Error('Sai mật khẩu.');
  }
  cache.remove('admin_fails');
}

function mask_(s) {
  if (!s) return '';
  return s.length <= 8 ? '••••' : s.substring(0, 4) + '••••' + s.substring(s.length - 4);
}

/* ===================== GỌI ZALO (token truyền vào) ===================== */

function adminZalo_(token, method, payload) {
  try {
    const res = UrlFetchApp.fetch(CONFIG.API_BASE + '/bot' + token + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    let data = null;
    try { data = JSON.parse(res.getContentText()); } catch (e) {}
    if (!data) return { ok: false, description: 'HTTP ' + res.getResponseCode() };
    return data;
  } catch (err) {
    return { ok: false, description: String(err) };
  }
}

// Địa chỉ Web App dùng để đăng ký webhook. Thứ tự ưu tiên:
// 1) địa chỉ đã lưu ở trang Admin  2) địa chỉ /exec của deployment đang chạy  3) CONFIG.WEB_APP_URL
function webAppBaseInfo_() {
  const saved = getProp_('WEB_APP_URL');
  if (saved) return { url: saved, source: 'đã lưu ở trang Admin' };
  let auto = '';
  try { auto = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  if (/\/exec$/.test(auto)) return { url: auto, source: 'tự nhận từ deployment đang chạy' };
  if (String(CONFIG.WEB_APP_URL).indexOf('https://') === 0) return { url: CONFIG.WEB_APP_URL, source: 'CONFIG.WEB_APP_URL' };
  throw new Error('Chưa xác định được địa chỉ Web App. Hãy nhập URL /exec ở mục "Địa chỉ Web App".');
}

function webAppBase_() {
  return webAppBaseInfo_().url;
}

function expectedWebhookUrlSafe_(secret) {
  try { return expectedWebhookUrl_(secret); } catch (e) { return ''; }
}

function expectedWebhookUrl_(secret) {
  return webAppBase_() + '?key=' + encodeURIComponent(secret);
}

function registerWebhook_(token, secret) {
  return adminZalo_(token, 'setWebhook', { url: expectedWebhookUrl_(secret), secret_token: secret });
}

/* ===================== API CHO TRANG ADMIN ===================== */

// Gọi nhiều API Zalo song song. calls: [{ method, payload }] -> mảng kết quả cùng thứ tự
function adminZaloAll_(token, calls) {
  try {
    const reqs = calls.map((c) => ({
      url: CONFIG.API_BASE + '/bot' + token + '/' + c.method,
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(c.payload || {}),
      muteHttpExceptions: true
    }));
    return UrlFetchApp.fetchAll(reqs).map((res) => {
      try { return JSON.parse(res.getContentText()); } catch (e) { return { ok: false, description: 'HTTP ' + res.getResponseCode() }; }
    });
  } catch (err) {
    return calls.map(() => ({ ok: false, description: String(err) }));
  }
}

function adminLogin(password) {
  adminAuth_(password);
  return true;
}

function adminGetStatus(password) {
  adminAuth_(password);
  const token = getProp_('ZALO_BOT_TOKEN');
  const secret = getProp_('WEBHOOK_SECRET');

  const out = {
    time: Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'dd/MM/yyyy HH:mm:ss'),
    token: { set: !!token, masked: mask_(token) },
    secret: { set: !!secret, masked: mask_(secret) },
    bot: { ok: false, name: '', error: token ? '' : 'Chưa có token' },
    webhook: { set: false, url: '', matches: false, error: '', base: '', source: '', baseError: '' },
    sheet: { ok: false, name: CONFIG.SHEET_NAME, rows: 0, error: '' }
  };

  try {
    const info = webAppBaseInfo_();
    out.webhook.base = info.url;
    out.webhook.source = info.source;
  } catch (e) {
    out.webhook.baseError = e.message;
  }

  if (token) {
    const both = adminZaloAll_(token, [{ method: 'getMe' }, { method: 'getWebhookInfo' }]);
    const me = both[0];
    const wh = both[1];
    if (me.ok) {
      const r = me.result || {};
      out.bot.ok = true;
      out.bot.name = r.display_name || r.account_name || r.name || String(r.id || '');
      out.bot.error = '';
    } else {
      out.bot.error = me.description || 'Lỗi không xác định';
    }

    if (wh.ok) {
      const url = (wh.result && wh.result.url) || '';
      out.webhook.set = !!url;
      out.webhook.url = url.replace(/(key=)[^&]*/, '$1***');
      out.webhook.matches = !!url && !!secret && url === expectedWebhookUrlSafe_(secret);
    } else {
      out.webhook.error = wh.description || 'Lỗi không xác định';
    }
  }

  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw new Error('Không tìm thấy sheet "' + CONFIG.SHEET_NAME + '"');
    out.sheet.ok = true;
    out.sheet.rows = Math.max(0, sheet.getLastRow() - CONFIG.HEADER_ROW);
  } catch (err) {
    out.sheet.error = String(err.message || err);
  }
  return out;
}

function adminSaveToken(password, newToken) {
  adminAuth_(password);
  const t = String(newToken || '').trim();
  if (t.length < 10 || /\s/.test(t)) throw new Error('Token không hợp lệ (quá ngắn hoặc có khoảng trắng).');

  const me = adminZalo_(t, 'getMe');           // kiểm tra token mới trước khi lưu
  if (!me.ok) throw new Error('Token bị Zalo từ chối: ' + (me.description || 'không rõ lý do'));

  PropertiesService.getScriptProperties().setProperty('ZALO_BOT_TOKEN', t);
  log_('info', 'admin_token_saved');

  const secret = getProp_('WEBHOOK_SECRET');
  if (!secret) return { message: 'Đã lưu token. Chưa có webhook secret nên chưa đăng ký webhook.' };

  const r = registerWebhook_(t, secret);
  return {
    message: r.ok
      ? 'Đã lưu token và đăng ký lại webhook.'
      : 'Đã lưu token nhưng đăng ký webhook lỗi: ' + (r.description || 'không rõ lý do')
  };
}

function adminSaveSecret(password, newSecret) {
  adminAuth_(password);
  const s = String(newSecret || '').trim();
  if (!/^[A-Za-z0-9]{8,256}$/.test(s)) throw new Error('Secret phải dài 8-256 ký tự, chỉ gồm chữ và số.');

  const token = getProp_('ZALO_BOT_TOKEN');
  if (!token) throw new Error('Chưa có token bot. Hãy lưu token trước.');

  const props = PropertiesService.getScriptProperties();
  const old = props.getProperty('WEBHOOK_SECRET');
  props.setProperty('WEBHOOK_SECRET', s);

  const r = registerWebhook_(token, s);   // bắt buộc đăng ký lại vì key trên URL webhook đã đổi
  if (!r.ok) {
    if (old) props.setProperty('WEBHOOK_SECRET', old); else props.deleteProperty('WEBHOOK_SECRET');
    throw new Error('Đăng ký webhook lỗi, đã giữ nguyên secret cũ: ' + (r.description || 'không rõ lý do'));
  }
  log_('info', 'admin_secret_saved');
  return { message: 'Đã lưu secret và đăng ký lại webhook.' };
}

function adminSetWebhook(password) {
  adminAuth_(password);
  const token = getProp_('ZALO_BOT_TOKEN');
  const secret = getProp_('WEBHOOK_SECRET');
  if (!token || !secret) throw new Error('Cần có cả token và secret.');
  const r = registerWebhook_(token, secret);
  if (!r.ok) throw new Error('Đăng ký webhook lỗi: ' + (r.description || 'không rõ lý do'));
  return { message: 'Đã đăng ký webhook tới: ' + webAppBase_() };
}

// url rỗng = xoá địa chỉ đã lưu (quay về tự nhận). Tự đăng ký lại webhook nếu đã có token và secret.
function adminSaveWebAppUrl(password, url) {
  adminAuth_(password);
  const u = String(url || '').trim();
  const props = PropertiesService.getScriptProperties();
  if (u && !/^https:\/\/script\.google\.com\/.+\/exec$/.test(u)) {
    throw new Error('Địa chỉ phải có dạng https://script.google.com/.../exec');
  }
  if (u) props.setProperty('WEB_APP_URL', u); else props.deleteProperty('WEB_APP_URL');
  log_('info', 'admin_webapp_url_saved');

  const token = getProp_('ZALO_BOT_TOKEN');
  const secret = getProp_('WEBHOOK_SECRET');
  if (!token || !secret) return { message: 'Đã lưu địa chỉ. Chưa đủ token/secret nên chưa đăng ký webhook.' };
  const r = registerWebhook_(token, secret);
  if (!r.ok) throw new Error('Đã lưu địa chỉ nhưng đăng ký webhook lỗi: ' + (r.description || 'không rõ lý do'));
  return { message: 'Đã đăng ký webhook tới: ' + webAppBase_() };
}

// Dùng địa chỉ /exec của deployment đang phục vụ trang Admin này (mở trang bằng URL deployment mới nhất)
function adminUseCurrentUrl(password) {
  adminAuth_(password);
  let auto = '';
  try { auto = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  if (!/\/exec$/.test(auto)) throw new Error('Không nhận được địa chỉ /exec. Hãy mở trang Admin bằng URL /exec của deployment, không phải từ trình soạn thảo.');
  return adminSaveWebAppUrl(password, auto);
}

function adminDeleteWebhook(password) {
  adminAuth_(password);
  const token = getProp_('ZALO_BOT_TOKEN');
  if (!token) throw new Error('Chưa có token bot.');
  const r = adminZalo_(token, 'deleteWebhook');
  if (!r.ok) throw new Error('Xoá webhook lỗi: ' + (r.description || 'không rõ lý do'));
  return { message: 'Đã xoá webhook. Bot sẽ không nhận tin nhắn cho đến khi đăng ký lại.' };
}

/* ===================== THÊM SẢN PHẨM (mã tự sinh + ảnh) ===================== */

// Chạy 1 lần trong trình soạn thảo để cấp quyền Google Drive (lưu ảnh)
function authorizeDrive() {
  console.log('Drive OK: ' + DriveApp.getRootFolder().getName());
}

// Số cột cần đọc/ghi (đủ cho cả cột Hình ảnh và Trạng thái)
function sheetWidth_(sheet) {
  return Math.max(sheet.getLastColumn(), CONFIG.IMAGE_COLUMN, CONFIG.STATUS_COLUMN);
}

// Đọc cả bảng 1 lần để dùng cho nhiều phép kiểm tra (mỗi lần gọi getRange tốn ~0,1-0,3 giây)
function readAll_(sheet) {
  return sheet.getDataRange().getDisplayValues();
}

function getProductSheet_() {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error('Không tìm thấy sheet "' + CONFIG.SHEET_NAME + '"');
  return sheet;
}

// Sinh `count` mã tiếp theo: PREFIX + số lớn nhất hiện có + 1, đảm bảo không trùng mã nào đang có
// values (tuỳ chọn): bảng đã đọc sẵn bằng readAll_()
function nextCodes_(sheet, count, values) {
  const last = sheet.getLastRow();
  const rows = values || (last > CONFIG.HEADER_ROW ? sheet.getRange(1, 1, last, CONFIG.CODE_COLUMN).getDisplayValues() : []);
  const used = {};
  let max = 0;
  const re = new RegExp('^' + CONFIG.CODE_PREFIX + '(\\d+)$', 'i');
  for (let i = CONFIG.HEADER_ROW; i < rows.length; i++) {
    const c = String(rows[i][CONFIG.CODE_COLUMN - 1] === undefined ? '' : rows[i][CONFIG.CODE_COLUMN - 1]).trim().toUpperCase();
    if (!c) continue;
    used[c] = true;
    const m = c.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const out = [];
  let n = max + 1;
  while (out.length < count) {
    const code = CONFIG.CODE_PREFIX + String(n).padStart(CONFIG.CODE_PAD, '0');
    n++;
    if (!used[code]) { used[code] = true; out.push(code); }
  }
  return out;
}

function nextCode_(sheet) {
  return nextCodes_(sheet, 1)[0];
}

function nameExists_(sheet, name, excludeRow, values) {
  const last = sheet.getLastRow();
  const rows = values || (last > CONFIG.HEADER_ROW ? sheet.getRange(1, 1, last, CONFIG.FUZZY.NAME_COLUMN).getDisplayValues() : []);
  const key = foldText_(name);
  for (let i = CONFIG.HEADER_ROW; i < rows.length; i++) {
    if (excludeRow && i + 1 === excludeRow) continue;
    if (foldText_(rows[i][CONFIG.FUZZY.NAME_COLUMN - 1]) === key) return true;
  }
  return false;
}

function getImageFolder_() {
  const props = PropertiesService.getScriptProperties();
  let folder = null;
  const id = props.getProperty('IMAGE_FOLDER_ID');
  if (id) {
    try { folder = DriveApp.getFolderById(id); } catch (e) { /* thư mục bị xoá: tạo lại */ }
  }
  if (!folder) {
    folder = DriveApp.createFolder(CONFIG.IMAGE_FOLDER_NAME);
    props.setProperty('IMAGE_FOLDER_ID', folder.getId());
    props.deleteProperty('IMAGE_FOLDER_SHARED');
  }
  if (!ADMIN_IMAGE.SHARE_PER_FILE && props.getProperty('IMAGE_FOLDER_SHARED') !== '1') {
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);   // chỉ làm 1 lần
    props.setProperty('IMAGE_FOLDER_SHARED', '1');
  }
  return folder;
}

// Lưu ảnh lên Drive, trả về link ảnh trực tiếp
function saveImage_(image) {
  const mime = String(image.mime || '');
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) throw new Error('Chỉ hỗ trợ ảnh JPG, PNG, WEBP hoặc GIF.');
  const bytes = Utilities.base64Decode(image.base64);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('Ảnh quá lớn (tối đa 4MB sau khi nén).');

  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const fileName = Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyyMMdd_HHmmss') +
    '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
  try {
    const file = getImageFolder_().createFile(Utilities.newBlob(bytes, mime, fileName));
    if (ADMIN_IMAGE.SHARE_PER_FILE) file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://lh3.googleusercontent.com/d/' + file.getId();
  } catch (err) {
    log_('error', 'save_image_failed', { message: String(err) });
    throw new Error('Không lưu được ảnh lên Drive: ' + (err.message || err) + ' (bạn đã chạy authorizeDrive() chưa?)');
  }
}

// Trang admin gọi để dựng form theo đúng tiêu đề cột của sheet
function adminGetFormSchema(password) {
  adminAuth_(password);
  const sheet = getProductSheet_();
  const width = sheetWidth_(sheet);
  const headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, width).getDisplayValues()[0];

  const fields = [];
  headers.forEach((h, i) => {
    const col = i + 1;
    if (!h || col === CONFIG.CODE_COLUMN || col === CONFIG.IMAGE_COLUMN || col === CONFIG.STATUS_COLUMN) return;
    const style = CONFIG.FIELD_STYLES[h] || {};
    fields.push({ col: col, header: h, numeric: style.type === 'money', required: col === CONFIG.FUZZY.NAME_COLUMN });
  });
  return { fields: fields, nextCode: nextCode_(sheet) };
}

// values: { "<số cột>": "giá trị" }, image: { mime, base64 } hoặc null
function adminAddProduct(password, values, image) {
  adminAuth_(password);
  values = values || {};
  const name = String(values[CONFIG.FUZZY.NAME_COLUMN] || '').trim();
  if (!name) throw new Error('Hãy nhập tên sản phẩm.');
  const DUP = 'Tên sản phẩm đã tồn tại. Hãy đặt tên khác để bot tìm đúng.';

  const sheet = getProductSheet_();
  if (nameExists_(sheet, name, 0, readAll_(sheet))) throw new Error(DUP);

  const imageUrl = image && image.base64 ? saveImage_(image) : '';

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const data = readAll_(sheet);                     // chỉ đọc sheet 1 lần trong khoá
    if (nameExists_(sheet, name, 0, data)) throw new Error(DUP);

    const width = Math.max((data[0] || []).length, CONFIG.IMAGE_COLUMN, CONFIG.STATUS_COLUMN);
    const headers = data[CONFIG.HEADER_ROW - 1] || [];
    const row = new Array(width).fill('');

    const code = nextCodes_(sheet, 1, data)[0];
    row[CONFIG.CODE_COLUMN - 1] = code;

    Object.keys(values).forEach((k) => {
      const col = Number(k);
      if (!(col >= 1 && col <= width) || col === CONFIG.CODE_COLUMN || col === CONFIG.IMAGE_COLUMN || col === CONFIG.STATUS_COLUMN) return;
      row[col - 1] = normalizeCellValue_(headers[col - 1], values[k]);
    });
    row[CONFIG.IMAGE_COLUMN - 1] = imageUrl;
    row[CONFIG.STATUS_COLUMN - 1] = CONFIG.STATUS_VISIBLE;

    if (!headers[CONFIG.IMAGE_COLUMN - 1]) sheet.getRange(CONFIG.HEADER_ROW, CONFIG.IMAGE_COLUMN).setValue('Hình ảnh');
    if (!headers[CONFIG.STATUS_COLUMN - 1]) sheet.getRange(CONFIG.HEADER_ROW, CONFIG.STATUS_COLUMN).setValue('Trạng thái');
    sheet.getRange(data.length + 1, 1, 1, width).setValues([row]);
    clearSheetCache_();

    log_('info', 'admin_product_added', { code: code, hasImage: !!imageUrl });
    return {
      message: 'Đã thêm sản phẩm ' + code + (imageUrl ? ' kèm ảnh.' : '.'),
      code: code,
      nextCode: nextCodes_(sheet, 1, data.concat([row.map(String)]))[0]   // để trang admin không phải tải lại form
    };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== SỬA SẢN PHẨM ===================== */

// Tìm số dòng trong sheet theo mã SP (mã là duy nhất và không đổi). Trả 0 nếu không thấy.
// values (tuỳ chọn): bảng đã đọc sẵn bằng readAll_()
function findRowNumberByCode_(sheet, code, values) {
  if (!code) return 0;
  const last = sheet.getLastRow();
  const rows = values || (last > CONFIG.HEADER_ROW ? sheet.getRange(1, 1, last, CONFIG.CODE_COLUMN).getDisplayValues() : []);
  for (let i = CONFIG.HEADER_ROW; i < rows.length; i++) {
    if (String(rows[i][CONFIG.CODE_COLUMN - 1]).trim() === code) return i + 1;
  }
  return 0;
}

// Chuẩn hoá giá trị trước khi ghi vào ô: cột tiền -> số, chặn công thức
function normalizeCellValue_(header, raw) {
  let v = String(raw === null || raw === undefined ? '' : raw).trim();
  const style = CONFIG.FIELD_STYLES[header];
  if (v && style && style.type === 'money') {
    const digits = v.replace(/[^\d]/g, '');
    if (digits) return Number(digits);
  }
  if (v.charAt(0) === '=') v = "'" + v;
  return v;
}

// Danh sách sản phẩm để chọn sửa. Để trống keyword = 30 sản phẩm mới nhất.
function adminSearchProducts(password, query) {
  adminAuth_(password);
  const sheet = getProductSheet_();
  const last = sheet.getLastRow();
  if (last <= CONFIG.HEADER_ROW) return [];

  const width = sheetWidth_(sheet);
  const data = sheet.getRange(CONFIG.HEADER_ROW + 1, 1, last - CONFIG.HEADER_ROW, width).getDisplayValues();
  const tokens = foldText_(query || '').split(' ').filter(Boolean);

  const out = [];
  data.forEach((r) => {
    const code = String(r[CONFIG.CODE_COLUMN - 1]).trim();
    const name = String(r[CONFIG.FUZZY.NAME_COLUMN - 1]).trim();
    if (!code) return;
    const hayName = ' ' + foldText_(name);
    const hayCode = foldText_(code);
    if (tokens.every((t) => hayName.indexOf(' ' + t) > -1 || hayCode.indexOf(t) === 0)) {
      out.push({ code: code, name: name, hidden: isHidden_(r) });
    }
  });
  if (!tokens.length) out.reverse();
  return out.slice(0, 30);
}

// Lấy dữ liệu 1 sản phẩm để đổ vào form sửa
function adminGetProduct(password, code) {
  adminAuth_(password);
  code = String(code || '').trim();
  const sheet = getProductSheet_();
  const rowNum = findRowNumberByCode_(sheet, code);
  if (!rowNum) throw new Error('Không tìm thấy sản phẩm ' + code + '.');

  const width = sheetWidth_(sheet);
  const row = sheet.getRange(rowNum, 1, 1, width).getDisplayValues()[0];
  const values = {};
  row.forEach((v, i) => {
    const col = i + 1;
    if (col !== CONFIG.CODE_COLUMN && col !== CONFIG.IMAGE_COLUMN && col !== CONFIG.STATUS_COLUMN) values[col] = v;
  });
  return { code: code, values: values, imageUrl: toDirectImageUrl_(row[CONFIG.IMAGE_COLUMN - 1]) };
}

// values: { "<số cột>": "giá trị" }. Ảnh: image mới > removeImage > giữ nguyên ảnh cũ.
function adminUpdateProduct(password, code, values, image, removeImage) {
  adminAuth_(password);
  code = String(code || '').trim();
  values = values || {};
  const name = String(values[CONFIG.FUZZY.NAME_COLUMN] || '').trim();
  if (!name) throw new Error('Hãy nhập tên sản phẩm.');
  const DUP = 'Tên sản phẩm đã tồn tại. Hãy đặt tên khác để bot tìm đúng.';

  const sheet = getProductSheet_();
  let data = readAll_(sheet);
  const pre = findRowNumberByCode_(sheet, code, data);
  if (!pre) throw new Error('Không tìm thấy sản phẩm ' + code + '.');
  if (nameExists_(sheet, name, pre, data)) throw new Error(DUP);

  const newImageUrl = image && image.base64 ? saveImage_(image) : '';

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    data = readAll_(sheet);                           // đọc lại 1 lần trong khoá
    const rowNum = findRowNumberByCode_(sheet, code, data);
    if (!rowNum) throw new Error('Không tìm thấy sản phẩm ' + code + '.');
    if (nameExists_(sheet, name, rowNum, data)) throw new Error(DUP);

    const width = Math.max((data[0] || []).length, CONFIG.IMAGE_COLUMN, CONFIG.STATUS_COLUMN);
    const headers = data[CONFIG.HEADER_ROW - 1] || [];
    const current = data[rowNum - 1];

    Object.keys(values).forEach((k) => {
      const col = Number(k);
      if (!(col >= 1 && col <= width) || col === CONFIG.CODE_COLUMN || col === CONFIG.IMAGE_COLUMN || col === CONFIG.STATUS_COLUMN) return;
      const nv = normalizeCellValue_(headers[col - 1], values[k]);
      const old = current[col - 1] === undefined ? '' : current[col - 1];
      if (String(nv) === String(old)) return;         // ô không đổi thì không ghi (đỡ tốn thời gian)
      sheet.getRange(rowNum, col).setValue(nv);
    });

    if (newImageUrl) {
      if (!headers[CONFIG.IMAGE_COLUMN - 1]) sheet.getRange(CONFIG.HEADER_ROW, CONFIG.IMAGE_COLUMN).setValue('Hình ảnh');
      sheet.getRange(rowNum, CONFIG.IMAGE_COLUMN).setValue(newImageUrl);
    } else if (removeImage) {
      sheet.getRange(rowNum, CONFIG.IMAGE_COLUMN).setValue('');
    }

    clearSheetCache_();
    log_('info', 'admin_product_updated', { code: code, imageChanged: !!newImageUrl, imageRemoved: !newImageUrl && !!removeImage });
    return { message: 'Đã cập nhật sản phẩm ' + code + '.', code: code };
  } finally {
    lock.releaseLock();
  }
}
