/**
 * MODULE: Mật khẩu truy cập + quản trị viên duyệt người dùng mới
 *
 *  - Admin đặt/đổi mật khẩu ở trang Admin. Chưa đặt mật khẩu = ai cũng dùng được.
 *  - Người lạ nhắn đúng mật khẩu:
 *      * Chế độ "cần duyệt" (mặc định): ghi trạng thái "Chờ duyệt" vào tab Users và nhắn cho quản trị viên
 *        kèm link bấm duyệt (trang Approve.html) hoặc lệnh #duyet <mã> / #chan <mã>.
 *      * Tắt chế độ duyệt: cấp quyền ngay.
 *  - Mật khẩu chỉ lưu dạng băm. Sai quá 5 lần bị khoá 10 phút.
 *  - Quản trị viên = tài khoản đã liên kết bằng #lienket (Alerts.gs). Họ luôn được phép dùng bot.
 *  - Code.gs gọi gateAccess_() ở đầu buildReply_() (trước khi ghi log nên mật khẩu không lọt vào log).
 *
 * Tab Users: Zalo ID | Tên | Ngày | Trạng thái (Hoạt động / Chờ duyệt / Chặn) | Mã duyệt (token, tự xoá khi đã xử lý)
 */

const ACCESS = {
  SHEET_NAME: 'Users',
  HEADERS: ['Zalo ID', 'Tên', 'Ngày', 'Trạng thái', 'Mã duyệt'],
  ACTIVE: 'Hoạt động',
  BLOCKED: 'Chặn',
  PENDING: 'Chờ duyệt',
  MAX_FAILS: 5,
  LOCK_SECONDS: 600,
  CACHE_SECONDS: 600,
  PENDING_CACHE_SECONDS: 60,
  STATE_SECONDS: 21600,
  MAX_LIST: 100,
  CODE_LENGTH: 5,        // mã ngắn để gõ lệnh #duyet = 5 ký tự đầu của token
  TZ: 'Asia/Ho_Chi_Minh'
};

/* ===================== Trạng thái + cache ===================== */

// { on, approval, epoch }: epoch tăng lên là mọi cache quyền cũ mất hiệu lực
function accessState_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('acc_state');
  if (hit) return JSON.parse(hit);
  const st = {
    on: !!getProp_('ACCESS_PASS_HASH'),
    approval: getProp_('ACCESS_APPROVAL') !== '0',
    epoch: getProp_('ACCESS_EPOCH') || '0'
  };
  cache.put('acc_state', JSON.stringify(st), ACCESS.STATE_SECONDS);
  return st;
}

function resetAccessState_() {
  CacheService.getScriptCache().remove('acc_state');
}

function bumpAccessEpoch_() {
  PropertiesService.getScriptProperties().setProperty('ACCESS_EPOCH', String(Number(getProp_('ACCESS_EPOCH') || 0) + 1));
  resetAccessState_();
}

function hashPass_(pass, salt) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + '|' + pass));
}

function verifyAccessPass_(attempt) {
  const hash = getProp_('ACCESS_PASS_HASH');
  if (!hash || !attempt) return false;
  return safeEqual_(hashPass_(attempt, getProp_('ACCESS_PASS_SALT') || ''), hash);
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').substring(0, 24);   // 24 ký tự hex
}

/* ===================== Tab Users ===================== */

function getUsersSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(ACCESS.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ACCESS.SHEET_NAME);
    sheet.getRange(1, 1, 1, ACCESS.HEADERS.length).setValues([ACCESS.HEADERS]).setFontWeight('bold');
    sheet.getRange('A:B').setNumberFormat('@');
    sheet.getRange('E:E').setNumberFormat('@');     // token toàn chữ số không bị đổi thành số
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// 'blocked' | 'pending' | 'active'
function statusOf_(status) {
  const s = foldText_(status);
  if (s === 'chan' || s === 'block' || s === 'blocked') return 'blocked';
  if (s === 'cho duyet' || s === 'pending') return 'pending';
  return 'active';
}

function userRows_() {
  return getUsersSheet_().getDataRange().getDisplayValues().slice(1).map((r, i) => ({
    row: i + 2, id: String(r[0]).trim(), name: String(r[1]), time: String(r[2]),
    status: statusOf_(r[3]), token: String(r[4] || '').trim()
  })).filter((u) => u.id);
}

function findAccessUser_(id) {
  const list = userRows_();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function grantAccess_(id, name) {
  getUsersSheet_().appendRow([id, name || '', Utilities.formatDate(new Date(), ACCESS.TZ, 'dd/MM/yyyy HH:mm'), ACCESS.ACTIVE, '']);
  log_('info', 'access_granted', { userId: id });
}

function createPending_(id, name) {
  const sheet = getUsersSheet_();
  sheet.getRange(1, 5).setValue(ACCESS.HEADERS[4]);             // nâng cấp tab Users cũ (chưa có cột Mã duyệt)
  sheet.getRange('E:E').setNumberFormat('@');
  const when = Utilities.formatDate(new Date(), ACCESS.TZ, 'dd/MM/yyyy HH:mm');
  const pendingCodes = userRows_().filter((u) => u.status === 'pending').map((u) => u.token.substring(0, ACCESS.CODE_LENGTH));
  let token = newToken_();
  while (pendingCodes.indexOf(token.substring(0, ACCESS.CODE_LENGTH)) > -1) token = newToken_();   // mã ngắn không trùng
  sheet.appendRow([id, name || '', when, ACCESS.PENDING, token]);
  return { token: token, when: when };
}

/* ===================== Duyệt / chặn ===================== */

function applyDecision_(u, allow) {
  const sheet = getUsersSheet_();
  sheet.getRange(u.row, 4).setValue(allow ? ACCESS.ACTIVE : ACCESS.BLOCKED);
  sheet.getRange(u.row, 5).setValue('');                         // token chỉ dùng 1 lần
  bumpAccessEpoch_();
  log_('info', 'access_decision', { userId: u.id, allow: !!allow });
  try {
    callZalo_('sendMessage', {
      chat_id: u.id,
      text: allow ? '✅ Quản trị viên đã duyệt. Bạn có thể tra cứu sản phẩm ngay bây giờ.\n\n' + MSG.HELP
                  : '⛔ Yêu cầu truy cập của bạn không được chấp nhận.'
    });
  } catch (e) { /* người dùng chưa nhận được tin thì thôi */ }
}

function findPendingByToken_(token) {
  const t = String(token || '');
  if (t.length < 20) return null;
  const list = userRows_().filter((u) => u.status === 'pending' && u.token.length >= 20);
  for (let i = 0; i < list.length; i++) if (safeEqual_(list[i].token, t)) return list[i];
  return null;
}

function findPendingByCode_(code) {
  const matches = userRows_().filter((u) => u.status === 'pending' && u.token && u.token.indexOf(code) === 0);
  return matches.length === 1 ? matches[0] : null;
}

// Lệnh trong Zalo: #duyet <mã> / #chan <mã> (chỉ quản trị viên đã liên kết)
function accessDecisionCommand_(args, req, allow) {
  const admins = typeof getAlertChatIds_ === 'function' ? getAlertChatIds_() : [];
  if (admins.indexOf(String(req.chatId)) < 0) return 'Lệnh không tồn tại. Gõ #help để xem hướng dẫn.';
  const code = String(args || '').trim().toLowerCase();
  if (!/^[a-f0-9]{4,24}$/.test(code)) return 'Cú pháp: #duyet <mã> hoặc #chan <mã>';
  const u = findPendingByCode_(code);
  if (!u) return 'Không tìm thấy yêu cầu đang chờ với mã này (có thể đã được xử lý).';
  applyDecision_(u, allow);
  return (allow ? '✅ Đã cho phép ' : '⛔ Đã chặn ') + (u.name || u.id) + '.';
}

function notifyAccessRequest_(id, name, p) {
  let link = '';
  try { link = webAppBase_() + '?page=approve&t=' + p.token; } catch (e) { /* chưa xác định địa chỉ Web App */ }
  const code = p.token.substring(0, ACCESS.CODE_LENGTH);
  const text = '🔔 Yêu cầu truy cập bot\n• Tên: ' + (name || '(không rõ)') + '\n• Zalo ID: ' + id + '\n• Lúc: ' + p.when +
    (link ? '\n\n👉 Bấm để duyệt:\n' + link : '') +
    '\n\nHoặc nhắn:\n#duyet ' + code + '  (cho phép)\n#chan ' + code + '  (chặn)';
  if (typeof sendAlert_ !== 'function') return { zalo: 0, email: false };
  const r = sendAlert_(text);
  if (!r.zalo && !r.email) log_('warn', 'access_request_not_notified', { userId: id });
  return r;
}

/* Hai hàm công khai cho trang Approve.html (được bảo vệ bằng token 24 ký tự dùng 1 lần) */

function approvalInfo(token) {
  const u = findPendingByToken_(token);
  return u ? { found: true, name: u.name, id: u.id, time: u.time } : { found: false };
}

function approvalDecide(token, allow) {
  const u = findPendingByToken_(token);
  if (!u) return { ok: false, message: 'Yêu cầu không còn hiệu lực (đã được xử lý hoặc không tồn tại).' };
  applyDecision_(u, !!allow);
  return { ok: true, message: allow ? '✅ Đã cho phép ' + (u.name || u.id) + '.' : '⛔ Đã chặn ' + (u.name || u.id) + '.' };
}

/* ===================== Cổng kiểm tra: Code.gs gọi hàm này ===================== */

// Trả về null nếu được phép; ngược lại trả về chuỗi trả lời cho người dùng
function gateAccess_(req) {
  const st = accessState_();
  if (!st.on) return null;

  const id = String(req.chatId);
  const text = String(req.text || '').trim();
  if (/^#lienket\b/i.test(text)) return null;
  if (typeof getAlertChatIds_ === 'function' && getAlertChatIds_().indexOf(id) > -1) return null;

  const cache = CacheService.getScriptCache();
  const okKey = 'au_' + st.epoch + '_' + id;
  const blockKey = 'ab_' + st.epoch + '_' + id;
  const pendKey = 'ap_' + st.epoch + '_' + id;
  const failKey = 'af_' + id;
  const seenKey = 'as_' + id;
  const BLOCKED_MSG = '⛔ Tài khoản của bạn đã bị chặn. Vui lòng liên hệ quản trị viên.';
  const PENDING_MSG = '⏳ Yêu cầu truy cập của bạn đang chờ quản trị viên duyệt. Bạn sẽ nhận được tin nhắn khi được duyệt.';

  if (cache.get(okKey) === '1') return null;
  if (cache.get(blockKey) === '1') return BLOCKED_MSG;
  if (cache.get(pendKey) === '1') return PENDING_MSG;

  const fails = Number(cache.get(failKey) || 0);
  if (fails >= ACCESS.MAX_FAILS) return 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 10 phút.';

  const rec = findAccessUser_(id);
  if (rec) {
    if (rec.status === 'blocked') { cache.put(blockKey, '1', ACCESS.CACHE_SECONDS); return BLOCKED_MSG; }
    if (rec.status === 'pending') { cache.put(pendKey, '1', ACCESS.PENDING_CACHE_SECONDS); return PENDING_MSG; }
    cache.put(okKey, '1', ACCESS.CACHE_SECONDS);
    return null;
  }

  // Chưa có trong danh sách: tin nhắn này có phải mật khẩu không?
  const attempt = text.replace(/^[#\/](?:matkhau|mk|pass)\s+/i, '').trim();
  if (verifyAccessPass_(attempt)) {
    cache.remove(failKey);
    cache.remove(seenKey);
    if (st.approval) {
      const p = createPending_(id, req.userName);
      cache.put(pendKey, '1', ACCESS.PENDING_CACHE_SECONDS);
      notifyAccessRequest_(id, req.userName, p);
      log_('info', 'access_requested', { userId: id });
      return '✅ Mật khẩu đúng. Yêu cầu của bạn đã được gửi tới quản trị viên, vui lòng chờ duyệt. Bạn sẽ nhận được tin nhắn khi được duyệt.';
    }
    grantAccess_(id, req.userName);
    cache.put(okKey, '1', ACCESS.CACHE_SECONDS);
    return '✅ Xác thực thành công! Bạn đã có thể tra cứu sản phẩm.\n\n' + MSG.HELP;
  }

  log_('warn', 'access_denied', { userId: id });          // không ghi nội dung tin nhắn
  if (!cache.get(seenKey)) {                              // tin nhắn đầu tiên: chỉ nhắc, không tính là lần thử sai
    cache.put(seenKey, '1', ACCESS.LOCK_SECONDS);
    return '🔒 Bot này yêu cầu mật khẩu. Vui lòng nhắn mật khẩu để sử dụng.\n(Liên hệ quản trị viên nếu bạn chưa có mật khẩu.)';
  }
  cache.put(failKey, String(fails + 1), ACCESS.LOCK_SECONDS);
  const left = ACCESS.MAX_FAILS - (fails + 1);
  return left > 0 ? '❌ Mật khẩu chưa đúng. Bạn còn ' + left + ' lần thử.' : 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 10 phút.';
}

/* ===================== API cho trang Admin ===================== */

function adminGetAccessInfo(password) {
  adminAuth_(password);
  return {
    enabled: !!getProp_('ACCESS_PASS_HASH'),
    approval: getProp_('ACCESS_APPROVAL') !== '0',
    linked: typeof getAlertChatIds_ === 'function' ? getAlertChatIds_().length : 0
  };
}

function adminSetAccessApproval(password, on) {
  adminAuth_(password);
  PropertiesService.getScriptProperties().setProperty('ACCESS_APPROVAL', on ? '1' : '0');
  resetAccessState_();
  return { message: on ? 'Đã bật: người nhập đúng mật khẩu cần quản trị viên duyệt.' : 'Đã tắt: nhập đúng mật khẩu là dùng được ngay.' };
}

// revokeAll = true: mọi người (trừ người bị chặn) phải nhập lại mật khẩu mới; yêu cầu đang chờ cũng bị huỷ
function adminSetAccessPass(password, pass, revokeAll) {
  adminAuth_(password);
  const p = String(pass || '').trim();
  if (!/^\S{4,64}$/.test(p)) throw new Error('Mật khẩu dài 4-64 ký tự, không có dấu cách.');

  const salt = Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('ACCESS_PASS_SALT', salt);
  props.setProperty('ACCESS_PASS_HASH', hashPass_(p, salt));
  resetAccessState_();

  let removed = 0;
  if (revokeAll) removed = revokeAllActive_();
  log_('info', 'admin_access_pass_saved', { revokeAll: !!revokeAll });
  return { message: 'Đã lưu mật khẩu truy cập.' + (revokeAll ? ' Đã thu hồi ' + removed + ' người dùng/yêu cầu.' : '') };
}

function adminDisableAccess(password) {
  adminAuth_(password);
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('ACCESS_PASS_HASH');
  props.deleteProperty('ACCESS_PASS_SALT');
  resetAccessState_();
  return { message: 'Đã tắt bảo vệ. Ai có link bot cũng dùng được.' };
}

function adminListAccessUsers(password) {
  adminAuth_(password);
  const all = userRows_().reverse();                              // mới nhất trước
  const count = { active: 0, pending: 0, blocked: 0 };
  all.forEach((u) => { count[u.status]++; });
  const sorted = all.filter((u) => u.status === 'pending').concat(all.filter((u) => u.status !== 'pending'));   // chờ duyệt lên đầu
  return {
    enabled: !!getProp_('ACCESS_PASS_HASH'),
    active: count.active, pending: count.pending, blocked: count.blocked,
    users: sorted.slice(0, ACCESS.MAX_LIST).map((u) => ({ id: u.id, name: u.name, time: u.time, status: u.status }))
  };
}

// Duyệt hoặc từ chối một yêu cầu đang chờ (có nhắn lại cho người dùng)
function adminDecideAccess(password, id, allow) {
  adminAuth_(password);
  const u = findAccessUser_(String(id));
  if (!u || u.status !== 'pending') throw new Error('Yêu cầu không còn ở trạng thái chờ duyệt.');
  applyDecision_(u, !!allow);
  return { message: allow ? 'Đã cho phép người dùng.' : 'Đã chặn người dùng.' };
}

function adminSetAccessUserBlocked(password, id, blocked) {
  adminAuth_(password);
  const u = findAccessUser_(String(id));
  if (!u) throw new Error('Không tìm thấy người dùng.');
  const sheet = getUsersSheet_();
  sheet.getRange(u.row, 4).setValue(blocked ? ACCESS.BLOCKED : ACCESS.ACTIVE);
  sheet.getRange(u.row, 5).setValue('');
  bumpAccessEpoch_();
  return { message: blocked ? 'Đã chặn người dùng.' : 'Đã bỏ chặn.' };
}

// Xoá khỏi danh sách: lần sau người đó phải nhập lại mật khẩu
function adminRemoveAccessUser(password, id) {
  adminAuth_(password);
  const u = findAccessUser_(String(id));
  if (!u) throw new Error('Không tìm thấy người dùng.');
  getUsersSheet_().deleteRow(u.row);
  bumpAccessEpoch_();
  return { message: 'Đã xoá người dùng. Họ cần nhập lại mật khẩu để dùng bot.' };
}

function revokeAllActive_() {
  const sheet = getUsersSheet_();
  const rows = sheet.getDataRange().getDisplayValues();
  if (rows.length < 2) { bumpAccessEpoch_(); return 0; }
  const keep = rows.slice(1).filter((r) => String(r[0]).trim() && statusOf_(r[3]) === 'blocked');   // chỉ giữ người bị chặn
  const removed = rows.length - 1 - keep.length;
  sheet.getRange(2, 1, rows.length - 1, ACCESS.HEADERS.length).clearContent();
  if (keep.length) sheet.getRange(2, 1, keep.length, ACCESS.HEADERS.length).setValues(keep);
  bumpAccessEpoch_();
  return removed;
}

function adminRevokeAllAccess(password) {
  adminAuth_(password);
  return { message: 'Đã thu hồi ' + revokeAllActive_() + ' người dùng/yêu cầu.' };
}
