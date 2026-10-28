/*****************************************************************
 * AL-IRAQI — الـ Backend الكامل (Google Apps Script)
 * قاعدة البيانات = Google Sheets
 *
 * التركيب (مرة واحدة):
 * 1) افتح الشيت → Extensions → Apps Script → امسح أي كود وحط الملف ده.
 *    (لو الشيت فيه سكريبت تاني شغال اعمل مشروع جديد من script.google.com
 *     وحط ID الشيت في SHEET_ID تحت عشان ما يحصلش تعارض)
 * 2) Project Settings (⚙️) → Script properties → Add:
 *      ADMIN_PASSWORD   = باسورد المدير الأول   (المستخدم: admin)
 *      ADMIN_PASSWORD_2 = باسورد المدير التاني  (المستخدم: admin2)   [اختياري]
 *      ADMIN_PASSWORD_3 = باسورد المدير التالت  (المستخدم: admin3)   [اختياري]
 * 3) شغّل دالة setup مرة واحدة ووافق على الصلاحيات (بتعمل تبويبي Customers و Orders).
 * 4) في تبويب المنتجات ضيف عمود اسمه  stock_cartons  (رصيد الكراتين).
 * 5) Deploy → New deployment → Web app → Execute as: Me | Who has access: Anyone
 *    وانسخ الرابط حطه في apiUrl (script.js للموقعين) وفي API_URL (لوحة المدير).
 * 6) أوقف نشر الشيت على الويب: File → Share → Publish to web → Stop.
 * أي تعديل بعد كده: Deploy → Manage deployments → Edit → New version.
 *****************************************************************/

const SHEET_ID = '';               // فاضي = السكريبت جوه الشيت. غير كده حط ID الشيت (من الرابط بين /d/ و /edit)
const PRODUCTS_GID = 1444421128;   // gid تبويب المنتجات
const TOKEN_DAYS = 30;             // مدة بقاء العميل مسجّل دخول
const ADMIN_HOURS = 12;            // مدة جلسة المدير
const RETAIL_MARKUP = 15;          // نسبة زيادة القطاعي % (لازم تطابق CONFIG.retailMarkupPercent)
const PUBLIC_SITES = [];           // موقع بدون دخول: ['retail']
const SITES = ['wholesale', 'retail'];
const TZ = 'Africa/Cairo';
const MAX_FAILS = 5;               // محاولات غلط قبل القفل 15 دقيقة
const TEST_STOCK_HEADER = 'stock_test';
const REAL_STOCK_HEADER = 'stock_cartons';
// حسابات الإدارة: اسم المستخدم → اسم الـ Script Property اللي فيها الباسورد (مفيش ربط أجهزة)
const ADMINS = { admin: 'ADMIN_PASSWORD', admin2: 'ADMIN_PASSWORD_2', admin3: 'ADMIN_PASSWORD_3' };

const ALIASES = {
  id: ['id', 'code', 'item_id', 'sku', 'كود', 'كود الصنف', 'كود المنتج'],
  name: ['name', 'product_name', 'title', 'اسم', 'اسم الصنف', 'اسم المنتج'],
  category: ['category', 'type', 'القسم', 'التصنيف', 'قسم'],
  image: ['image', 'img', 'photo', 'image_url', 'صورة', 'رابط الصورة', 'الصورة'],
  pcs: ['pcs_per_carton', 'carton_qty', 'pcs', 'pieces_per_carton', 'عدد القطع بالكرتونة', 'عدد القطع في الكرتونة', 'عدد القطعة بالكرتونة'],
  piece_price: ['piece_price', 'price_piece', 'base_price', 'baseprice', 'base price', 'بيس برايس', 'البيس برايس', 'سعر القطعة', 'سعر_القطعة'],
  carton_price: ['carton_price', 'price_carton', 'سعر الكرتونة', 'سعر_الكرتونة'],
  carton_unit_price: ['carton_unit_price', 'carton unit price', 'cartonunitprice', 'carton-unit-price', 'كرتون يونت برايس', 'كرتون يونيت برايس', 'كارتون يونت برايس', 'unit_price', 'سعر القطعة في الكرتونة', 'سعر القطعة اللي في الكرتونة', 'سعر الوحدة', 'سعر وحدة الكرتونة'],
  availability: ['availability', 'status', 'التوفر', 'الحالة', 'متوفر'],
  description: ['description', 'desc', 'details', 'الوصف', 'تفاصيل'],
  badge: ['badge', 'badges', 'label', 'tag', 'شارة', 'بادج', 'ملصق'],
  featured: ['featured', 'مميز', 'منتج مميز'],
  stock: ['stock_cartons', 'stock', 'عدد الكراتين', 'رصيد الكراتين', 'المخزون'],
};
const AVAILABLE_VALUES = ['available', 'متوفر', 'yes', '1', 'true', 'نعم'];

const CUST_HEADERS = ['username', 'password_hash', 'salt', 'site', 'device_id', 'active', 'created', 'last_login', 'note'];
const CUST = { username: 1, password_hash: 2, salt: 3, site: 4, device_id: 5, active: 6, created: 7, last_login: 8, note: 9 };
const ORDER_HEADERS = ['order_number', 'time', 'username', 'site', 'mode', 'customer_name', 'customer_phone', 'lines_json', 'total', 'status', 'request_id', 'edited_by', 'edited_at', 'original_total', 'edit_note'];
const ORD = { number: 1, time: 2, user: 3, site: 4, mode: 5, name: 6, phone: 7, lines: 8, total: 9, status: 10, request: 11, edBy: 12, edAt: 13, origTotal: 14, edNote: 15 };
// حالات الطلب: ACTIVE (مُرسل) | EDITED (معدّل من الإدارة) | CANCELLED (ملغي)

/* ======================= أدوات عامة ======================= */
function fail_(code, msg) {
  const e = new Error(code);
  e.code = code;
  e.msg = msg || '';
  throw e;
}
function props_() { return PropertiesService.getScriptProperties(); }
function ss_() { return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet(); }
function norm_(h) { return String(h == null ? '' : h).replace(/^\uFEFF/, '').trim().replace(/\s+/g, ' ').toLowerCase(); }
function num_(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return isFinite(n) && n >= 0 ? n : null;
}
function round2_(n) { return Math.round(n * 100) / 100; }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function safeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function secret_() {
  let s = props_().getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props_().setProperty('SECRET', s); }
  return s;
}
function sign_(msg) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, secret_()));
}
function makeToken_(obj) {
  const p = Utilities.base64EncodeWebSafe(JSON.stringify(obj), Utilities.Charset.UTF_8);
  return p + '.' + sign_(p);
}
function readToken_(t) {
  const parts = String(t || '').split('.');
  if (parts.length !== 2 || !safeEq_(sign_(parts[0]), parts[1])) fail_('TOKEN');
  let p;
  try { p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); } catch (e) { fail_('TOKEN'); }
  if (!p.e || p.e < Date.now()) fail_('TOKEN');
  return p;
}

/* ======================= الشيتات ======================= */
function tab_(name, headers) {
  let sh = ss_().getSheetByName(name);
  if (!sh) {
    sh = ss_().insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}
let ORD_READY_ = false;
function custSheet_() { return tab_('Customers', CUST_HEADERS); }
function ordSheet_() {
  const sh = tab_('Orders', ORDER_HEADERS);
  if (!ORD_READY_) { // يضيف أعمدة التعديل لو الشيت قديم
    const cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    ORDER_HEADERS.forEach(function (h, i) { if (!cur[i]) sh.getRange(1, i + 1).setValue(h); });
    ORD_READY_ = true;
  }
  return sh;
}
function productsSheet_() {
  const sh = ss_().getSheets().filter(function (s) { return s.getSheetId() === PRODUCTS_GID; })[0];
  if (!sh) fail_('SERVER', 'تبويب المنتجات مش موجود (PRODUCTS_GID)');
  return sh;
}
function headerIdx_(headers, aliases) {
  const set = {};
  aliases.forEach(function (a) { set[norm_(a)] = true; });
  for (let i = 0; i < headers.length; i++) if (set[norm_(headers[i])]) return i;
  return -1;
}
function setup() {
  custSheet_(); ordSheet_(); secret_();
  if (!props_().getProperty('ADMIN_PASSWORD')) throw new Error('ضيف ADMIN_PASSWORD في Project Settings → Script properties الأول');
  Logger.log('تمام ✅ — كمّل باقي الخطوات (Deploy)');
}

/* ======================= العملاء + الدخول ======================= */
function readCustomers_() {
  const v = custSheet_().getDataRange().getValues();
  const out = [];
  for (let r = 1; r < v.length; r++) {
    if (!v[r][0]) continue;
    out.push({
      row: r + 1, username: String(v[r][0]).trim(), password_hash: v[r][1], salt: String(v[r][2]),
      site: String(v[r][3]), device_id: String(v[r][4] || ''), active: isTrue_(v[r][5]),
      created: v[r][6], last_login: v[r][7], note: v[r][8],
    });
  }
  return out;
}
function findCustomer_(username) {
  const u = String(username).trim().toLowerCase();
  const all = readCustomers_();
  for (let i = 0; i < all.length; i++) if (all[i].username.toLowerCase() === u) return all[i];
  return null;
}

function login_(req) {
  const u = String(req.username || '').trim();
  const pw = String(req.password || '');
  if (!u || !pw) fail_('AUTH');
  const cache = CacheService.getScriptCache();
  const lockKey = 'fail_' + u.toLowerCase().slice(0, 60);
  if (Number(cache.get(lockKey) || 0) >= MAX_FAILS) fail_('LOCKED');
  const bad = function () {
    cache.put(lockKey, String(Number(cache.get(lockKey) || 0) + 1), 900);
    fail_('AUTH');
  };

  const adminKey = ADMINS[u.toLowerCase()];
  if (adminKey) { // مدير: بدون ربط جهاز، من أي جهاز وأي وقت
    const ap = props_().getProperty(adminKey);
    if (!ap || !safeEq_(pw, ap)) bad();
    cache.remove(lockKey);
    const name = u.toLowerCase();
    return { ok: true, role: 'admin', name: name, token: makeToken_({ r: 'admin', a: name, e: Date.now() + ADMIN_HOURS * 3600000 }) };
  }

  if (SITES.indexOf(req.site) < 0) fail_('SITE');
  const c = findCustomer_(u);
  if (!c || c.site !== req.site) bad();
  if (sha_(c.salt + pw) !== String(c.password_hash)) bad();
  if (!c.active) fail_('INACTIVE');
  const dev = String(req.deviceId || '');
  if (dev.length < 16) fail_('DEVICE_ID');
  if (c.device_id && c.device_id !== dev) fail_('DEVICE');

  const sh = custSheet_();
  if (!c.device_id) sh.getRange(c.row, CUST.device_id).setValue(dev); // أول دخول = ربط الجهاز
  sh.getRange(c.row, CUST.last_login).setValue(new Date());
  cache.remove(lockKey);
  return {
    ok: true, role: 'customer', name: c.username,
    token: makeToken_({ u: c.username, d: dev, s: c.site, r: 'customer', e: Date.now() + TOKEN_DAYS * 86400000 }),
  };
}

/** يتحقق من التوكن + الجهاز + إن الحساب لسه شغال. بيرجّع { user, role } */
function auth_(req) {
  if (!req.token && PUBLIC_SITES.indexOf(req.site) >= 0) return { user: 'public', role: 'public' };
  const p = readToken_(req.token);
  if (p.r === 'admin') return { user: p.a || 'admin', role: 'admin' };
  if (SITES.indexOf(req.site) < 0 || p.s !== req.site) fail_('SITE');
  if (!req.deviceId || p.d !== String(req.deviceId)) fail_('DEVICE');
  const c = findCustomer_(p.u);
  if (!c || !c.active) fail_('INACTIVE');
  if (c.site !== req.site) fail_('SITE');
  if (c.device_id !== p.d) fail_('DEVICE');
  return { user: c.username, role: 'customer' };
}

/* ======================= المنتجات والمخزون ======================= */
/** كل موقع بياخد أعمدته بس: الجملة (كرتونة + سعر القطعة بالكرتونة) / القطاعي (Base Price) */
function keepIndexes_(headers, site) {
  const keys = ['id', 'name', 'category', 'image', 'pcs', 'availability', 'description', 'badge', 'featured']
    .concat(site === 'retail' ? ['piece_price'] : ['carton_price', 'carton_unit_price']);
  const set = {};
  keys.forEach(function (k) { ALIASES[k].forEach(function (a) { set[norm_(a)] = true; }); });
  const imgRe = /^(image|img|photo|صورة|الصورة)[\s_-]*\d+$/i;
  const out = [];
  headers.forEach(function (h, i) {
    const n = norm_(h);
    if (n && (set[n] || imgRe.test(n))) out.push(i);
  });
  return out;
}

/** يضمن وجود عمود المخزون. عمود التجربة بيتنسخ من الحقيقي أول مرة */
function ensureStockCol_(sh, test) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idx = headerIdx_(headers, test ? [TEST_STOCK_HEADER] : ALIASES.stock);
  if (idx >= 0) return idx;
  const col = sh.getLastColumn() + 1;
  sh.getRange(1, col).setValue(test ? TEST_STOCK_HEADER : REAL_STOCK_HEADER);
  if (test) {
    const real = headerIdx_(headers, ALIASES.stock);
    const n = sh.getLastRow() - 1;
    if (real >= 0 && n > 0) sh.getRange(2, col, n, 1).setValues(sh.getRange(2, real + 1, n, 1).getValues());
  }
  return col - 1;
}

function products_(req, who) {
  const test = who.role === 'admin';
  const sh = productsSheet_();
  if (test) ensureStockCol_(sh, true);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const keep = keepIndexes_(headers, req.site);
  const stockIdx = headerIdx_(headers, test ? [TEST_STOCK_HEADER] : ALIASES.stock);
  const out = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (row.join('').trim() === '') continue;
    const o = {};
    keep.forEach(function (i) { o[headers[i]] = row[i]; });
    o.__row = r + 1;
    if (stockIdx >= 0 && row[stockIdx] !== '' && row[stockIdx] != null) o.__stock = Number(row[stockIdx]);
    out.push(o);
  }
  return { ok: true, products: out, testMode: test };
}

function isAvailable_(v) {
  return AVAILABLE_VALUES.indexOf(String(v == null ? '' : v).trim().toLowerCase()) >= 0;
}

/** أسعار صف المنتج حسب الموقع (نفس قواعد الواجهة) */
function priceFor_(rv, H, site) {
  if (site === 'retail') {
    const b = num_(rv[headerIdx_(H, ALIASES.piece_price)]);
    return { cp: null, pp: b === null ? null : Math.round(b * (1 + RETAIL_MARKUP / 100)) };
  }
  return { cp: num_(rv[headerIdx_(H, ALIASES.carton_price)]), pp: num_(rv[headerIdx_(H, ALIASES.carton_unit_price)]) };
}

function orderNumber_(site, test) {
  const prefix = (test ? 'TEST-' : '') + (site === 'retail' ? 'ALR-R' : 'ALR');
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  const sh = ordSheet_();
  const last = sh.getLastRow();
  let seq = 0;
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
      if (String(r[0]).indexOf(prefix + '-' + stamp + '-') === 0) seq++;
    });
  }
  return prefix + '-' + stamp + '-' + ('000' + (seq + 1)).slice(-4);
}

/* ======================= حفظ الطلب (فاتورة) ======================= */
function placeOrder_(req, who) {
  const test = who.role === 'admin';
  const lines = req.lines;
  if (!Array.isArray(lines) || !lines.length || lines.length > 300) fail_('BAD_REQUEST', 'الطلب فاضي');
  const customer = req.customer || {};
  const requestId = String(req.requestId || '').slice(0, 200);

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    // إعادة المحاولة بنفس الطلب = نفس الرقم من غير خصم تاني
    const osh = ordSheet_();
    if (requestId && osh.getLastRow() > 1) {
      const ov = osh.getRange(2, 1, osh.getLastRow() - 1, ORDER_HEADERS.length).getValues();
      for (let i = ov.length - 1; i >= 0; i--) {
        if (String(ov[i][ORD.request - 1]) === requestId && String(ov[i][ORD.user - 1]) === who.user && ov[i][ORD.status - 1] !== 'CANCELLED') {
          return { ok: true, orderNumber: ov[i][0], duplicate: true };
        }
      }
    }

    const sh = productsSheet_();
    if (test) ensureStockCol_(sh, true);
    const data = sh.getDataRange().getValues();
    const H = data[0];
    const iId = headerIdx_(H, ALIASES.id), iName = headerIdx_(H, ALIASES.name), iPcs = headerIdx_(H, ALIASES.pcs);
    const iAv = headerIdx_(H, ALIASES.availability);
    const iStock = headerIdx_(H, test ? [TEST_STOCK_HEADER] : ALIASES.stock);
    const retail = req.site === 'retail';

    const seen = {};
    const shortages = [];
    const writes = [];
    const saved = [];
    let total = 0;

    lines.forEach(function (l) {
      const row = Number(l.row), cartons = Math.trunc(Number(l.cartons) || 0), pieces = Math.trunc(Number(l.pieces) || 0);
      if (!(row >= 2 && row <= data.length) || seen[row] || cartons < 0 || pieces < 0 || cartons + pieces <= 0 || cartons > 9999 || pieces > 9999) fail_('PRICE');
      seen[row] = true;
      const rv = data[row - 1];
      if (String(rv[iId]).trim() !== String(l.id).trim()) fail_('PRICE');
      const name = String(rv[iName]);

      if (!isAvailable_(rv[iAv])) { shortages.push({ name: name, available: 0 }); return; }
      if (retail && cartons > 0) fail_('PRICE');

      const pr = priceFor_(rv, H, req.site);
      if ((cartons > 0 && pr.cp === null) || (pieces > 0 && pr.pp === null)) fail_('PRICE');
      const lineTotal = round2_(round2_(cartons * (pr.cp || 0)) + round2_(pieces * (pr.pp || 0)));
      total = round2_(total + lineTotal);

      const pcs = num_(rv[iPcs]);
      const tracked = iStock >= 0 && rv[iStock] !== '' && rv[iStock] != null;
      let equiv = cartons;
      if (pieces > 0) {
        if (tracked && !(pcs > 0)) fail_('CONFIG', 'عدد القطع بالكرتونة غير محدد للصنف: ' + name);
        if (pcs > 0) equiv += pieces / pcs;
      }
      if (tracked) {
        const have = Number(rv[iStock]);
        if (have - equiv < -1e-9) { shortages.push({ name: name, available: Math.floor(have * 100) / 100 }); return; }
        writes.push({ row: row, value: Math.round((have - equiv) * 1e6) / 1e6 });
      }
      saved.push({ row: row, id: String(l.id), name: name, cartons: cartons, pieces: pieces, pcs: pcs, cp: pr.cp, pp: pr.pp, lineTotal: lineTotal, equiv: equiv, tracked: tracked });
    });

    if (shortages.length) return { ok: false, code: 'STOCK', items: shortages };
    if (Math.abs(total - Number(req.clientTotal)) > 0.5) return { ok: false, code: 'PRICE', serverTotal: total };

    writes.forEach(function (w) { sh.getRange(w.row, iStock + 1).setValue(w.value); });
    const number = orderNumber_(req.site, test);
    osh.appendRow([number, new Date(), who.user, req.site, test ? 'TEST' : 'REAL', String(customer.name || '').slice(0, 80),
      "'" + String(customer.phone || '').slice(0, 20), JSON.stringify(saved), total, 'ACTIVE', requestId, '', '', '', '']);
    return { ok: true, orderNumber: number, total: total };
  } finally {
    lock.releaseLock();
  }
}

/* ======================= سجل العميل ======================= */
function myOrders_(req, who) {
  if (who.role === 'public') return { ok: true, orders: [] };
  const mode = who.role === 'admin' ? 'TEST' : 'REAL';
  const sh = ordSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, orders: [] };
  const v = sh.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
  const me = String(who.user).toLowerCase();
  const out = [];
  for (let i = v.length - 1; i >= 0 && out.length < 60; i--) {
    const r = v[i];
    if (String(r[ORD.user - 1]).toLowerCase() !== me || r[ORD.site - 1] !== req.site || r[ORD.mode - 1] !== mode) continue;
    let lines = [];
    try {
      lines = JSON.parse(r[ORD.lines - 1]).map(function (l) {
        return { id: l.id, name: l.name, cartons: l.cartons, pieces: l.pieces, cp: l.cp, pp: l.pp, lineTotal: l.lineTotal };
      });
    } catch (e) { /* سطر تالف */ }
    out.push({
      number: r[0], time: r[ORD.time - 1], status: r[ORD.status - 1], total: r[ORD.total - 1],
      originalTotal: r[ORD.origTotal - 1] || '', note: r[ORD.edNote - 1] || '', lines: lines,
    });
  }
  return { ok: true, orders: out };
}

/* ======================= لوحة المدير ======================= */
function admin_(req, who) {
  const a = req.action;
  if (a === 'adm_customers') {
    return {
      ok: true,
      customers: readCustomers_().map(function (c) {
        return { username: c.username, site: c.site, active: c.active, hasDevice: !!c.device_id, created: c.created, last_login: c.last_login, note: c.note };
      }),
    };
  }
  if (a === 'adm_saveCustomer') return adminSaveCustomer_(req);
  if (a === 'adm_resetDevice') {
    const c = findCustomer_(req.username);
    if (!c) fail_('NOT_FOUND', 'العميل مش موجود');
    custSheet_().getRange(c.row, CUST.device_id).setValue('');
    return { ok: true };
  }
  if (a === 'adm_orders') return adminOrders_(req);
  if (a === 'adm_cancelOrder') return adminCancelOrder_(req);
  if (a === 'adm_editOrder') return adminEditOrder_(req, who);
  if (a === 'adm_stock') {
    const sh = productsSheet_();
    const data = sh.getDataRange().getValues();
    const H = data[0];
    const iId = headerIdx_(H, ALIASES.id), iName = headerIdx_(H, ALIASES.name), iAv = headerIdx_(H, ALIASES.availability);
    const iR = headerIdx_(H, ALIASES.stock), iT = headerIdx_(H, [TEST_STOCK_HEADER]);
    const items = [];
    for (let r = 1; r < data.length; r++) {
      if (!data[r][iId]) continue;
      items.push({ row: r + 1, id: String(data[r][iId]), name: String(data[r][iName]), available: isAvailable_(data[r][iAv]), real: iR >= 0 ? data[r][iR] : '', test: iT >= 0 ? data[r][iT] : '' });
    }
    return { ok: true, items: items };
  }
  if (a === 'adm_setStock') {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sh = productsSheet_();
      const idx = ensureStockCol_(sh, req.which === 'test');
      const row = Number(req.row);
      if (!(row >= 2 && row <= sh.getLastRow())) fail_('BAD_REQUEST');
      const v = String(req.value).trim() === '' ? '' : Number(req.value);
      if (v !== '' && !(isFinite(v) && v >= 0)) fail_('BAD_REQUEST', 'رقم غير صالح');
      sh.getRange(row, idx + 1).setValue(v);
      return { ok: true };
    } finally { lock.releaseLock(); }
  }
  if (a === 'adm_resetTest') {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sh = productsSheet_();
      const t = ensureStockCol_(sh, true);
      const H = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      const real = headerIdx_(H, ALIASES.stock);
      const n = sh.getLastRow() - 1;
      if (n > 0) {
        const vals = real >= 0 ? sh.getRange(2, real + 1, n, 1).getValues() : sh.getRange(2, t + 1, n, 1).getValues().map(function () { return ['']; });
        sh.getRange(2, t + 1, n, 1).setValues(vals);
      }
      return { ok: true };
    } finally { lock.releaseLock(); }
  }
  fail_('BAD_REQUEST');
}

function adminOrders_(req) {
  const sh = ordSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, orders: [] };
  const limit = Math.min(Number(req.limit) || 300, 1000);
  const start = Math.max(2, last - limit + 1);
  const v = sh.getRange(start, 1, last - start + 1, ORDER_HEADERS.length).getValues();
  const userF = req.user ? String(req.user).toLowerCase() : '';
  const out = [];
  for (let i = v.length - 1; i >= 0; i--) {
    const r = v[i];
    if (userF && String(r[ORD.user - 1]).toLowerCase() !== userF) continue;
    out.push({
      number: r[0], time: r[1], user: r[2], site: r[3], mode: r[4], name: r[5], phone: String(r[6]).replace(/^'/, ''),
      lines: r[7], total: r[8], status: r[9], editedBy: r[ORD.edBy - 1], editedAt: r[ORD.edAt - 1],
      originalTotal: r[ORD.origTotal - 1], editNote: r[ORD.edNote - 1],
    });
  }
  return { ok: true, orders: out };
}

function adminSaveCustomer_(req) {
  const u = String(req.username || '').trim();
  if (!/^[A-Za-z0-9_.\-\u0600-\u06FF ]{2,40}$/.test(u) || ADMINS[u.toLowerCase()]) fail_('BAD_REQUEST', 'اسم المستخدم غير صالح أو محجوز');
  if (SITES.indexOf(req.site) < 0) fail_('BAD_REQUEST', 'الموقع غير صالح');
  const pw = String(req.password || '');
  const sh = custSheet_();
  const c = findCustomer_(u);
  if (c) {
    sh.getRange(c.row, CUST.site).setValue(req.site);
    sh.getRange(c.row, CUST.active).setValue(!!req.active);
    sh.getRange(c.row, CUST.note).setValue(String(req.note || ''));
    if (pw) {
      if (pw.length < 6) fail_('BAD_REQUEST', 'الباسورد لازم 6 حروف على الأقل');
      const salt = Utilities.getUuid();
      sh.getRange(c.row, CUST.password_hash, 1, 2).setValues([[sha_(salt + pw), salt]]);
    }
    return { ok: true, updated: true };
  }
  if (pw.length < 6) fail_('BAD_REQUEST', 'الباسورد لازم 6 حروف على الأقل');
  const salt = Utilities.getUuid();
  sh.appendRow([u, sha_(salt + pw), salt, req.site, '', req.active !== false, new Date(), '', String(req.note || '')]);
  return { ok: true, created: true };
}

/** إلغاء الطلب وإرجاع الكميات للمخزون تلقائيًا (الحقيقي أو التجريبي حسب نوع الطلب) */
function adminCancelOrder_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const osh = ordSheet_();
    const last = osh.getLastRow();
    if (last < 2) fail_('NOT_FOUND', 'الطلب مش موجود');
    const v = osh.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
    for (let i = 0; i < v.length; i++) {
      if (String(v[i][0]) !== String(req.number)) continue;
      if (v[i][ORD.status - 1] === 'CANCELLED') fail_('BAD_REQUEST', 'الطلب ملغي بالفعل');
      const test = v[i][ORD.mode - 1] === 'TEST';
      const sh = productsSheet_();
      const idx = ensureStockCol_(sh, test);
      JSON.parse(v[i][ORD.lines - 1]).forEach(function (l) {
        if (!l.tracked) return;
        const cell = sh.getRange(l.row, idx + 1);
        const cur = Number(cell.getValue()) || 0;
        cell.setValue(Math.round((cur + l.equiv) * 1e6) / 1e6);
      });
      osh.getRange(i + 2, ORD.status).setValue('CANCELLED');
      osh.getRange(i + 2, ORD.edBy, 1, 1).setValue(req.__by || '');
      osh.getRange(i + 2, ORD.edAt, 1, 1).setValue(new Date());
      if (req.note) osh.getRange(i + 2, ORD.edNote).setValue(String(req.note).slice(0, 300));
      return { ok: true };
    }
    fail_('NOT_FOUND', 'الطلب مش موجود');
  } finally { lock.releaseLock(); }
}

/**
 * تعديل فاتورة: req.lines = قائمة الأسطر النهائية [{row, cartons, pieces}]
 * - السطر اللي كميته صفر أو مش موجود بيتشال. أي سطر جديد بياخد السعر الحالي من الشيت.
 * - السطور القديمة بتحتفظ بسعرها وقت الطلب.
 * - المخزون: بيرجّع القديم الأول ثم يخصم الجديد (ولو ناقص بيرفض من غير أي تغيير).
 */
function adminEditOrder_(req, who) {
  if (!Array.isArray(req.lines)) fail_('BAD_REQUEST');
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const osh = ordSheet_();
    const last = osh.getLastRow();
    if (last < 2) fail_('NOT_FOUND', 'الطلب مش موجود');
    const v = osh.getRange(2, 1, last - 1, ORDER_HEADERS.length).getValues();
    let oi = -1;
    for (let i = 0; i < v.length; i++) if (String(v[i][0]) === String(req.number)) { oi = i; break; }
    if (oi < 0) fail_('NOT_FOUND', 'الطلب مش موجود');
    const o = v[oi];
    if (o[ORD.status - 1] === 'CANCELLED') fail_('BAD_REQUEST', 'الطلب ملغي — مينفعش يتعدّل');
    const test = o[ORD.mode - 1] === 'TEST';
    const site = o[ORD.site - 1];
    const old = JSON.parse(o[ORD.lines - 1]);
    const oldByRow = {};
    old.forEach(function (l) { oldByRow[l.row] = l; });

    const sh = productsSheet_();
    if (test) ensureStockCol_(sh, true);
    const data = sh.getDataRange().getValues();
    const H = data[0];
    const iName = headerIdx_(H, ALIASES.name), iId = headerIdx_(H, ALIASES.id), iPcs = headerIdx_(H, ALIASES.pcs), iAv = headerIdx_(H, ALIASES.availability);
    const iStock = headerIdx_(H, test ? [TEST_STOCK_HEADER] : ALIASES.stock);

    const cur = {};      // الرصيد الحالي بعد إرجاع القديم (null = غير متتبّع)
    const touched = {};
    const curStock = function (row) {
      if (cur[row] === undefined) {
        const c = iStock >= 0 ? data[row - 1][iStock] : '';
        cur[row] = (c === '' || c == null) ? null : Number(c);
      }
      return cur[row];
    };
    old.forEach(function (l) {
      const s = curStock(l.row);
      if (s !== null && l.tracked) cur[l.row] = s + l.equiv;
      touched[l.row] = true;
    });

    const seen = {}, saved = [], shortages = [];
    let total = 0;
    req.lines.forEach(function (nl) {
      const row = Number(nl.row), cartons = Math.trunc(Number(nl.cartons) || 0), pieces = Math.trunc(Number(nl.pieces) || 0);
      if (!(row >= 2 && row <= data.length) || seen[row] || cartons < 0 || pieces < 0 || cartons > 9999 || pieces > 9999) fail_('BAD_REQUEST', 'بيانات صنف غير صالحة');
      seen[row] = true;
      if (cartons + pieces === 0) return; // حذف السطر
      if (site === 'retail' && cartons > 0) fail_('BAD_REQUEST', 'القطاعي بالقطعة فقط');
      const rv = data[row - 1];
      const name = String(rv[iName]);
      const ol = oldByRow[row];
      let cp = ol && ol.cp != null ? ol.cp : null;
      let pp = ol && ol.pp != null ? ol.pp : null;
      if (!ol && !isAvailable_(rv[iAv])) fail_('BAD_REQUEST', 'الصنف "' + name + '" غير متوفر');
      if ((cartons > 0 && cp === null) || (pieces > 0 && pp === null)) {
        const pr = priceFor_(rv, H, site); // سعر حالي للوحدة اللي ما كانتش في الطلب
        if (cp === null) cp = pr.cp;
        if (pp === null) pp = pr.pp;
      }
      if ((cartons > 0 && cp === null) || (pieces > 0 && pp === null)) fail_('BAD_REQUEST', 'سعر غير متاح للصنف "' + name + '"');
      const lineTotal = round2_(round2_(cartons * (cp || 0)) + round2_(pieces * (pp || 0)));
      total = round2_(total + lineTotal);

      const pcs = num_(rv[iPcs]);
      const s0 = curStock(row);
      const tracked = s0 !== null;
      let equiv = cartons;
      if (pieces > 0) {
        if (tracked && !(pcs > 0)) fail_('CONFIG', 'عدد القطع بالكرتونة غير محدد للصنف: ' + name);
        if (pcs > 0) equiv += pieces / pcs;
      }
      if (tracked) {
        if (s0 - equiv < -1e-9) { shortages.push({ name: name, available: Math.floor(s0 * 100) / 100 }); return; }
        cur[row] = s0 - equiv;
      }
      touched[row] = true;
      saved.push({ row: row, id: String(rv[iId]), name: name, cartons: cartons, pieces: pieces, pcs: pcs, cp: cp, pp: pp, lineTotal: lineTotal, equiv: equiv, tracked: tracked });
    });

    if (shortages.length) return { ok: false, code: 'STOCK', items: shortages };
    if (!saved.length) fail_('BAD_REQUEST', 'الطلب لازم فيه صنف واحد على الأقل — لو عايز تشيله كله استخدم «إلغاء الطلب»');

    Object.keys(touched).forEach(function (r) {
      const row = Number(r);
      if (cur[row] !== null && cur[row] !== undefined && iStock >= 0) sh.getRange(row, iStock + 1).setValue(Math.round(cur[row] * 1e6) / 1e6);
    });
    const orig = o[ORD.origTotal - 1] || o[ORD.total - 1];
    osh.getRange(oi + 2, ORD.lines, 1, 2).setValues([[JSON.stringify(saved), total]]);
    osh.getRange(oi + 2, ORD.status).setValue('EDITED');
    osh.getRange(oi + 2, ORD.edBy, 1, 4).setValues([[who.user, new Date(), orig, String(req.note || '').slice(0, 300)]]);
    return { ok: true, total: total };
  } finally { lock.releaseLock(); }
}

/* ======================= نقطة الدخول ======================= */
function route_(req) {
  switch (req.action) {
    case 'login': return login_(req);
    case 'products': return products_(req, auth_(req));
    case 'placeOrder': return placeOrder_(req, auth_(req));
    case 'myOrders': return myOrders_(req, auth_(req));
    default:
      if (String(req.action).indexOf('adm_') === 0) {
        const who = auth_({ token: req.token, site: 'wholesale', deviceId: '' });
        if (who.role !== 'admin') fail_('FORBIDDEN');
        req.__by = who.user;
        return admin_(req, who);
      }
      fail_('BAD_REQUEST');
  }
}

function doPost(e) {
  let out;
  try {
    out = route_(JSON.parse(e.postData.contents));
  } catch (err) {
    if (err && err.code) out = { ok: false, code: err.code, message: err.msg || '' };
    else { console.error(err && err.stack ? err.stack : err); out = { ok: false, code: 'SERVER', message: 'خطأ في السيرفر' }; }
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput('AL-IRAQI API OK');
}
