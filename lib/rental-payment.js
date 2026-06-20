// api/rental-payment.js
// Buat invoice pembayaran sewa tempat jualan via SakuRupiah
// POST { listingId, plan: 'daily'|'weekly', buyerUid, buyerName, buyerPhone }

import crypto from 'crypto';

const FB_BASE = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FB_KEY  = process.env.FIREBASE_API_KEY;

const PLANS = {
  daily:  { label: 'Harian (1 Hari)',  price: 2000,  days: 1  },
  weekly: { label: 'Mingguan (7 Hari)', price: 10000, days: 7  }
};

function sanitize(str, max = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&]/g, '').trim().substring(0, max);
}
function sanitizePhone(phone) {
  let p = (phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) return p;
  if (p.startsWith('62')) return '0' + p.slice(2);
  return p;
}

async function verifyToken(token) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FB_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0] || null;
}

function toFSValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  return { stringValue: String(v) };
}
function toFSFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFSValue(v);
  return fields;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Silakan login dulu.' });

    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Token tidak valid.' });

    const { listingId, plan, buyerPhone } = req.body || {};

    if (!listingId) return res.status(400).json({ error: 'listingId wajib.' });
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plan tidak valid. Pilih daily atau weekly.' });
    if (!buyerPhone) return res.status(400).json({ error: 'Nomor HP wajib diisi.' });

    const planInfo = PLANS[plan];
    const uid      = user.localId;
    const buyerName = sanitize(user.displayName || user.email || 'Penjual');

    // Cek listing ada dan milik user ini
    const listingUrl = `${FB_BASE}/rental_listings/${listingId}?key=${FB_KEY}`;
    const listingRes = await fetch(listingUrl);
    if (!listingRes.ok) return res.status(404).json({ error: 'Listing tidak ditemukan.' });

    const listingDoc = await listingRes.json();
    const sellerUid = listingDoc.fields?.sellerUid?.stringValue;
    if (sellerUid !== uid) return res.status(403).json({ error: 'Bukan listing Anda.' });

    const apiId  = process.env.SAKURUPIAH_MERCHANT_ID;
    const apiKey = process.env.SAKURUPIAH_API_KEY;
    const paymentMethod = process.env.SAKURUPIAH_PAYMENT_METHOD || 'QRIS';
    const orderId = `RNT-${Date.now()}-${Math.random().toString(36).substr(2,5).toUpperCase()}`;

    const signatureRaw = `${apiId}${paymentMethod}${orderId}${planInfo.price}`;
    const signature = crypto.createHmac('sha256', apiKey).update(signatureRaw).digest('hex');

    const formData = new URLSearchParams();
    formData.append('api_id',        apiId);
    formData.append('method',        paymentMethod);
    formData.append('amount',        planInfo.price.toString());
    formData.append('phone',         sanitizePhone(buyerPhone));
    formData.append('signature',     signature);
    formData.append('name',          buyerName);
    formData.append('merchant_fee',  '2');
    formData.append('merchant_ref',  orderId);
    formData.append('callback_url',  'https://everastore.biz.id/api/rental-callback');
    formData.append('return_url',    'https://everastore.biz.id/sewa.html');
    formData.append('note',          `Sewa Tempat ${planInfo.label} | ${orderId}`);

    const sakuRes = await fetch('https://sakurupiah.id/api/create.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    const sakuText = await sakuRes.text();
    let sakuData;
    try { sakuData = JSON.parse(sakuText); } catch {
      return res.status(502).json({ error: 'Response tidak valid dari payment gateway.' });
    }

    if (!sakuData || sakuData.status == '400' || sakuData.error) {
      return res.status(502).json({ error: sakuData?.message || 'Gagal membuat invoice.' });
    }

    const d = Array.isArray(sakuData.data) ? sakuData.data[0] : sakuData.data;
    const trxId      = d?.trx_id || null;
    const paymentUrl = d?.checkout_url || d?.payment_url || d?.url || null;

    // Simpan pending rental order ke Firestore
    await fetch(`${FB_BASE}/pending_rental_orders/${orderId}?key=${FB_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFSFields({
          orderId, trxId: trxId || '', listingId, sellerUid: uid,
          plan, planDays: planInfo.days, amount: planInfo.price,
          buyerName, buyerPhone: sanitizePhone(buyerPhone),
          status: 'pending', createdAt: new Date().toISOString()
        })
      })
    });

    return res.status(200).json({ success: true, orderId, trxId, paymentUrl, amount: planInfo.price });

  } catch (err) {
    console.error('rental-payment error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
