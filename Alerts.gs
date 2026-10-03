/**
 * MODULE: Cảnh báo lỗi cho admin
 *  - log_() trong Code.gs tự gọi notifyAdmin_() mỗi khi có lỗi (level 'error').
 *  - Gửi tin nhắn Zalo tới người đã liên kết (lệnh #lienket <mã>), nếu không được thì gửi email (ALERT_EMAIL).
 *  - Cùng một loại lỗi chỉ báo 1 lần / THROTTLE_SECONDS để không bị spam.
 *  - healthCheck(): kiểm tra token, webhook, sheet theo lịch (bật trong trang Admin).
 *
 * Script properties: ADMIN_CHAT_IDS (tự quản lý), ALERT_EMAIL (tuỳ chọn)
 * Chạy authorizeAlerts() một lần trong trình soạn thảo để cấp quyền gửi mail và tạo trigger.
 */

const ALERTS = { THROTTLE_SECONDS: 1800, LINK_SECONDS: 600, MAX_LINK_FAILS: 5, TZ: 'Asia/Ho_Chi_Minh' };
let alertBusy_ = false;

function authorizeAlerts() {
  console.log('Mail quota: ' + MailApp.getRemainingDailyQuota() + ', triggers: ' + ScriptApp.getProjectTriggers().length);
}

function getAlertChatIds_() {
  return (getProp_('ADMIN_CHAT_IDS') || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Gửi cho admin. Trả về { zalo: số người nhận được, email: true/false }
function sendAlert_(text) {
  let zalo = 0, email = false;
  getAlertChatIds_().forEach((id) => {
    try { if (callZalo_('sendMessage', { chat_id: id, text: text }).ok) zalo++; } catch (e) {}
  });
  const to = getProp_('ALERT_EMAIL');
  if (to && zalo === 0) {                       // dự phòng khi Zalo không gửi được (VD token hết hạn)
    try { MailApp.sendEmail(to, 'Zalo Bot cảnh báo', text); email = true; } catch (e) { console.error('Gửi mail lỗi: ' + e); }
  }
  return { zalo: zalo, email: email };
}

function notifyAdmin_(event, data) {
  if (alertBusy_) return;                       // chống vòng lặp: gửi cảnh báo lỗi lại sinh ra cảnh báo
  if (!getAlertChatIds_().length && !getProp_('ALERT_EMAIL')) return;   // chưa có nơi nhận
  const cache = CacheService.getScriptCache();
  const key = 'alert_' + event;
  if (cache.get(key)) return;
  cache.put(key, '1', ALERTS.THROTTLE_SECONDS);
  alertBusy_ = true;
  try {
    const detail = String((data && (data.message || data.body || data.error)) || '').substring(0, 300);
    const when = Utilities.formatDate(new Date(), ALERTS.TZ, 'dd/MM/yyyy HH:mm:ss');
    sendAlert_('⚠️ Zalo Bot gặp lỗi\n• Sự kiện: ' + event + (detail ? '\n• Chi tiết: ' + detail : '') + '\n• Lúc: ' + when);
  } catch (e) {
    console.error('notifyAdmin_ lỗi: ' + e);
  } finally {
    alertBusy_ = false;
  }
}

/* ===== Liên kết người nhận cảnh báo: admin lấy mã trên trang Admin, rồi nhắn "#lienket <mã>" cho bot ===== */

function linkAdminCommand_(args, req) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('link_fails') || 0);
  if (fails >= ALERTS.MAX_LINK_FAILS) return 'Nhập sai quá nhiều lần, thử lại sau 10 phút.';

  const code = String(args || '').trim();
  if (!/^\d{6}$/.test(code) || !cache.get('link_' + code)) {
    cache.put('link_fails', String(fails + 1), ALERTS.LINK_SECONDS);
    return 'Mã liên kết không hợp lệ hoặc đã hết hạn.';
  }
  cache.remove('link_' + code);
  const ids = getAlertChatIds_();
  if (ids.indexOf(String(req.chatId)) === -1) ids.push(String(req.chatId));
  PropertiesService.getScriptProperties().setProperty('ADMIN_CHAT_IDS', ids.join(','));
  return '✅ Đã liên kết. Bạn sẽ nhận cảnh báo lỗi của bot qua cuộc trò chuyện này.';
}

/* ===== Kiểm tra sức khoẻ theo lịch ===== */

function healthCheck() {
  const problems = [];
  const token = getProp_('ZALO_BOT_TOKEN');
  if (!token) {
    problems.push('Chưa có token bot');
  } else {
    const me = adminZalo_(token, 'getMe');
    if (!me.ok) {
      problems.push('Token lỗi: ' + (me.description || 'không rõ'));
    } else {
      const wh = adminZalo_(token, 'getWebhookInfo');
      const secret = getProp_('WEBHOOK_SECRET');
      const url = wh.ok && wh.result && wh.result.url;
      if (wh.ok && !url) problems.push('Webhook chưa được đăng ký');
      else if (wh.ok && secret && url !== expectedWebhookUrl_(secret)) problems.push('Webhook không khớp secret/URL');
    }
  }
  try { getProductSheet_(); } catch (e) { problems.push(String(e.message || e)); }

  if (problems.length) notifyAdmin_('health_check', { message: problems.join('; ') });
  return problems;
}

function hasHealthTrigger_() {
  return ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'healthCheck');
}

/* ===== API cho trang Admin ===== */

function adminGetAlertInfo(password) {
  adminAuth_(password);
  const email = getProp_('ALERT_EMAIL') || '';
  let health = null;
  try { health = hasHealthTrigger_(); } catch (e) { /* chưa cấp quyền */ }
  return { linked: getAlertChatIds_().length, email: email, health: health };
}

function adminCreateLinkCode(password) {
  adminAuth_(password);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  CacheService.getScriptCache().put('link_' + code, '1', ALERTS.LINK_SECONDS);
  return { code: code, minutes: ALERTS.LINK_SECONDS / 60 };
}

function adminSendTestAlert(password) {
  adminAuth_(password);
  const r = sendAlert_('✅ Tin nhắn thử từ trang Admin: cảnh báo hoạt động bình thường.');
  if (!r.zalo && !r.email) throw new Error('Chưa gửi được. Hãy liên kết tài khoản Zalo hoặc lưu email nhận cảnh báo.');
  return { message: r.zalo ? 'Đã gửi tin thử qua Zalo (' + r.zalo + ' người).' : 'Zalo không gửi được, đã gửi qua email.' };
}

function adminClearAlertTargets(password) {
  adminAuth_(password);
  PropertiesService.getScriptProperties().deleteProperty('ADMIN_CHAT_IDS');
  return { message: 'Đã xoá toàn bộ người nhận cảnh báo qua Zalo.' };
}

function adminSaveAlertEmail(password, email) {
  adminAuth_(password);
  const e = String(email || '').trim();
  const props = PropertiesService.getScriptProperties();
  if (!e) { props.deleteProperty('ALERT_EMAIL'); return { message: 'Đã xoá email nhận cảnh báo.' }; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Email không hợp lệ.');
  props.setProperty('ALERT_EMAIL', e);
  return { message: 'Đã lưu email nhận cảnh báo.' };
}

function adminSetHealthCheck(password, on) {
  adminAuth_(password);
  try {
    ScriptApp.getProjectTriggers().forEach((t) => { if (t.getHandlerFunction() === 'healthCheck') ScriptApp.deleteTrigger(t); });
    if (on) ScriptApp.newTrigger('healthCheck').timeBased().everyDays(1).atHour(8).inTimezone(ALERTS.TZ).create();
  } catch (err) {
    throw new Error('Chưa có quyền tạo trigger. Hãy chạy authorizeAlerts() trong trình soạn thảo rồi thử lại. (' + err.message + ')');
  }
  return { message: on ? 'Đã bật kiểm tra hằng ngày lúc 8h sáng.' : 'Đã tắt kiểm tra hằng ngày.' };
}
