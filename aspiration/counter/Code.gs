/**
 * Счётчик посещений сайта «Мониторинг аспирационных установок».
 * Разворачивается как веб-приложение Google Apps Script, привязанное к Google-таблице.
 * Пишет каждое событие (открытие сайта, вход, неверный пароль) строкой на лист «visits»
 * и отдаёт статистику только по паролю администратора.
 *
 * Пароль администратора НЕ хранится в коде: задайте его в «Настройки проекта → Свойства скрипта»
 * как свойство ADMIN_PASSWORD.
 */
const SHEET = 'visits';
const HEAD = ['time', 'event', 'ip', 'country', 'country_code', 'city', 'region', 'org', 'ua', 'lang', 'tz', 'screen', 'page', 'ref'];

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) { sh = ss.insertSheet(SHEET); sh.appendRow(HEAD); sh.setFrozenRows(1); }
  return sh;
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
const clip_ = (v, n) => String(v == null ? '' : v).slice(0, n || 300);

function doPost(e) {
  let d = {};
  try { d = JSON.parse(e.postData.contents || '{}'); } catch (err) { return out_({ ok: false, error: 'bad json' }); }

  if (d.action === 'visit') {
    const ev = ['open', 'login', 'bad_password'].indexOf(d.event) >= 0 ? d.event : 'other';
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      sheet_().appendRow([new Date(), ev, clip_(d.ip, 64), clip_(d.country, 80), clip_(d.country_code, 4), clip_(d.city, 80), clip_(d.region, 80), clip_(d.org, 120),
        clip_(d.ua, 300), clip_(d.lang, 20), clip_(d.tz, 60), clip_(d.screen, 20), clip_(d.page, 120), clip_(d.ref, 200)]);
    } finally { lock.releaseLock(); }
    return out_({ ok: true });
  }

  if (d.action === 'stats') {
    const pass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
    if (!pass || String(d.key) !== String(pass)) { Utilities.sleep(800); return out_({ ok: false, error: 'auth' }); }
    const values = sheet_().getDataRange().getValues().slice(1);
    const rows = values.slice(-20000).map(function (r) { r[0] = r[0] instanceof Date ? r[0].toISOString() : r[0]; return r; });
    return out_({ ok: true, rows: rows });
  }
  return out_({ ok: false, error: 'unknown action' });
}

function doGet() {
  return out_({ ok: true, service: 'visit-counter' });
}
