// Zalo Bot truy vấn thông tin - Node.js 18+ (không cần cài thư viện)
// Chạy: ZALO_BOT_TOKEN=xxx node bot.js
// Tuỳ chọn: ALLOWED_IDS=id1,id2 (chỉ cho những người này dùng bot)

const TOKEN = process.env.ZALO_BOT_TOKEN;
const BASE = process.env.ZALO_BOT_BASE_URL || "https://bot-api.zaloplatforms.com";
const ALLOWED = (process.env.ALLOWED_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error("Thiếu ZALO_BOT_TOKEN");
  process.exit(1);
}

async function call(method, body = {}, timeoutMs = 40000) {
  const res = await fetch(`${BASE}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json();
  if (data.ok === false) throw new Error(`${method}: ${data.description || JSON.stringify(data)}`);
  return data.result;
}

// Zalo giới hạn 2000 ký tự mỗi tin nhắn
async function send(chatId, text) {
  for (let i = 0; i < text.length; i += 2000) {
    await call("sendMessage", { chat_id: chatId, text: text.slice(i, i + 2000) });
  }
}

// ====== KHAI BÁO CÁC LỆNH TRUY VẤN Ở ĐÂY ======
// Mỗi lệnh nhận (args, ctx) và trả về chuỗi văn bản.
const commands = {
  start: async () => "Xin chào! Gõ /help để xem các lệnh.",

  help: async () =>
    Object.keys(commands).map(c => `/${c}`).join("\n"),

  ping: async () => "pong",

  // Ví dụ: /tim <từ khoá>  -> thay phần thân bằng nguồn dữ liệu thật
  // (gọi API Shopee, truy vấn database, đọc Google Sheet...)
  tim: async (args) => {
    if (!args) return "Cú pháp: /tim <từ khoá>";
    const data = await fakeLookup(args);
    return data.length ? data.join("\n") : "Không tìm thấy kết quả.";
  },
};

async function fakeLookup(keyword) {
  // TODO: thay bằng truy vấn thật
  return [`(demo) Kết quả cho: ${keyword}`];
}
// ================================================

async function handle(update) {
  // Zalo trả về update có dạng { event_name, message: { chat, from, text } }
  const msg = update?.message;
  if (!msg?.text) return;

  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (ALLOWED.length && !ALLOWED.includes(String(userId))) {
    console.log("Bỏ qua người lạ:", userId);
    return;
  }

  const text = msg.text.trim();
  const m = text.match(/^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/);
  if (!m) return send(chatId, "Gõ /help để xem các lệnh.");

  const [, name, args] = m;
  const cmd = commands[name.toLowerCase()];
  if (!cmd) return send(chatId, "Lệnh không tồn tại. Gõ /help.");

  try {
    await send(chatId, await cmd(args.trim(), { chatId, userId }));
  } catch (e) {
    console.error(e);
    await send(chatId, "Có lỗi khi xử lý, thử lại sau.");
  }
}

async function main() {
  const me = await call("getMe");
  console.log("Bot đang chạy:", me?.account_name || me?.id || "OK");

  // Long-polling. Lưu ý: getUpdates và webhook không dùng cùng lúc được.
  while (true) {
    try {
      const result = await call("getUpdates", { timeout: 30 });
      const updates = Array.isArray(result) ? result : result ? [result] : [];
      for (const u of updates) await handle(u);
    } catch (e) {
      console.error("Polling lỗi:", e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

main();
