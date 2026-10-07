/**
 * MODULE: Chống spam theo từng người dùng
 *
 * Mỗi người tối đa RATE.MAX_PER_MINUTE tin nhắn trong 1 phút (tính theo phút đồng hồ).
 * Vượt giới hạn: nhắc đúng 1 lần, các tin còn lại trong phút đó bị bỏ qua IM LẶNG
 * (không phản hồi nên spam không làm tốn hạn mức UrlFetch / thời gian chạy của Apps Script).
 * Quản trị viên (đã liên kết bằng #lienket) được miễn. Tin nhắn Zalo gửi lại (trùng message_id) không bị tính.
 *
 * Code.gs gọi rateLimit_() trong doPost(). Muốn tắt: đặt ENABLED = false; muốn đổi giới hạn: sửa MAX_PER_MINUTE.
 */

const RATE = { ENABLED: true, MAX_PER_MINUTE: 10, WINDOW_MS: 60000 };

// Trả về null nếu được phép; ngược lại { text }: text rỗng nghĩa là bỏ qua im lặng
function rateLimit_(chatId) {
  if (!RATE.ENABLED) return null;

  const id = String(chatId);
  const now = Date.now();
  const bucket = Math.floor(now / RATE.WINDOW_MS);
  const key = 'rl_' + id + '_' + bucket;
  const cache = CacheService.getScriptCache();

  const count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), Math.ceil(RATE.WINDOW_MS / 1000) + 10);
  if (count <= RATE.MAX_PER_MINUTE) return null;

  if (typeof getAlertChatIds_ === 'function' && getAlertChatIds_().indexOf(id) > -1) return null;

  if (count === RATE.MAX_PER_MINUTE + 1) {
    const wait = Math.max(1, Math.ceil(((bucket + 1) * RATE.WINDOW_MS - now) / 1000));
    log_('warn', 'rate_limited', { userId: id });
    return { text: '⚠️ Bạn nhắn quá nhanh. Vui lòng chờ khoảng ' + wait + ' giây rồi thử lại.' };
  }
  return { text: '' };
}
