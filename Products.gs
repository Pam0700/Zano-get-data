/**
 * MODULE: Ẩn / hiện / xoá sản phẩm
 * Dùng cột Trạng thái (CONFIG.STATUS_COLUMN). Trống hoặc "Hiện" = bot tìm thấy, "Ẩn" = bot bỏ qua.
 * Danh sách hiển thị dùng adminSearchProducts() trong Admin.gs.
 */

function ensureStatusHeader_(sheet) {
  if (!sheet.getRange(CONFIG.HEADER_ROW, CONFIG.STATUS_COLUMN).getDisplayValue()) {
    sheet.getRange(CONFIG.HEADER_ROW, CONFIG.STATUS_COLUMN).setValue('Trạng thái');
  }
}

function adminSetProductVisibility(password, code, hidden) {
  adminAuth_(password);
  code = String(code || '').trim();
  const sheet = getProductSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const rowNum = findRowNumberByCode_(sheet, code);
    if (!rowNum) throw new Error('Không tìm thấy sản phẩm ' + code + '.');
    ensureStatusHeader_(sheet);
    sheet.getRange(rowNum, CONFIG.STATUS_COLUMN).setValue(hidden ? CONFIG.STATUS_HIDDEN : CONFIG.STATUS_VISIBLE);
    clearSheetCache_();
    log_('info', 'admin_product_visibility', { code: code, hidden: !!hidden });
    return { message: hidden ? 'Đã ẩn ' + code + ' khỏi bot.' : 'Đã hiện lại ' + code + '.' };
  } finally {
    lock.releaseLock();
  }
}

function adminDeleteProduct(password, code) {
  adminAuth_(password);
  code = String(code || '').trim();
  const sheet = getProductSheet_();
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const rowNum = findRowNumberByCode_(sheet, code);
    if (!rowNum) throw new Error('Không tìm thấy sản phẩm ' + code + '.');
    sheet.deleteRow(rowNum);
    clearSheetCache_();
    log_('info', 'admin_product_deleted', { code: code });
    return { message: 'Đã xoá ' + code + ' khỏi sheet.' };
  } finally {
    lock.releaseLock();
  }
}
