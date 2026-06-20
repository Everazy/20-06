// api/_insider.js
// Helper terpusat untuk memanggil API insidertopup.com.
// Endpoint tunggal: POST {BASE}/api/v1-alpha  (body form-urlencoded, field `action`).
// Auth: api_key + IP whitelist (whitelist diatur di dashboard insidertopup).
//
// Env yang dipakai:
//   INSIDER_BASE_URL  -> default "https://insidertopup.com"
//   INSIDER_API_KEY   -> API key merchant (WAJIB; simpan di Vercel env, jangan di kode)
//
// Catatan: insidertopup memakai IP whitelist sedangkan Vercel ber-IP dinamis.
// Jika belum di-whitelist, panggilan bisa gagal (ditangani pemanggil sebagai error).

const DEFAULT_BASE = 'https://insidertopup.com';

function getConfig() {
  const base = (process.env.INSIDER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = process.env.INSIDER_API_KEY || '';
  return { url: `${base}/api/v1-alpha`, apiKey };
}

// Panggil satu action ke insidertopup. `fields` = pasangan tambahan (product, user_id, dst).
async function insiderCall(action, fields = {}, { timeoutMs = 15000 } = {}) {
  const { url, apiKey } = getConfig();
  if (!apiKey) {
    return { ok: false, error: 'INSIDER_API_KEY belum diset di environment', raw: null };
  }

  const body = new URLSearchParams();
  body.append('action', action);
  body.append('api_key', apiKey);
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await res.text();

// Tambahkan logging sementara
console.log('[Insider] Status HTTP:', res.status);
console.log('[Insider] Raw response (200 char):', text.slice(0, 200));

let json;
try { json = JSON.parse(text); }
catch (e) {
  return { 
    ok: false, 
    error: 'Response insider bukan JSON: ' + text.slice(0, 200), 
    raw: text 
  };
}
    if (json && json.success === false) {
      return { ok: false, error: json.message || 'Permintaan insider gagal', raw: json };
    }
    return { ok: true, data: json?.data, message: json?.message, raw: json };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Timeout menghubungi insidertopup' : err.message;
    return { ok: false, error: msg, raw: null };
  } finally {
    clearTimeout(timer);
  }
}

// --- Wrapper per-action ---
export function insiderProfile() {
  return insiderCall('profile');
}
export function insiderGames() {
  return insiderCall('games');
}
export function insiderProducts(gameCode) {
  return insiderCall('products', { code: gameCode });
}
export function insiderAllProducts() {
  return insiderCall('all_products', {}, { timeoutMs: 25000 });
}
// Buat pesanan topup. zoneId opsional; untuk >2 input gunakan separator '///'
// (contoh: "user_id///server///nickname"). orderId harus unik (pakai orderId internal kita).
export function insiderOrder({ product, userId, zoneId = '', orderId }) {
  return insiderCall('order', {
    product,
    user_id: userId,
    zone_id: zoneId,
    order_id: orderId,
  });
}
// Cek status pesanan berdasarkan tid hasil order.
export function insiderStatus(tid) {
  return insiderCall('status', { tid });
}

// Normalisasi status insider -> status internal.
// Insider: Pending | Processing | Success | Canceled | Refunded
export function mapInsiderStatus(raw) {
  const s = (raw || '').toString().toLowerCase();
  if (s === 'success') return 'done';
  if (s === 'canceled' || s === 'cancelled' || s === 'refunded') return 'failed';
  return 'processing'; // pending/processing/unknown -> masih diproses
}

export { insiderCall };
