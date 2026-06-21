// api/rental-listing.js
// GET  — ambil semua listing aktif (publik)
// POST — buat/update listing (butuh auth token user)
// DELETE — hapus listing milik sendiri (butuh auth token)

import crypto from 'crypto';

const FB_BASE = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FB_KEY  = process.env.FIREBASE_API_KEY;

function toFSValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFSValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = toFSValue(val);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function toFSFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFSValue(v);
  return fields;
}
function fromFSValue(v) {
  if (!v) return null;
  if ('nullValue'    in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('stringValue'  in v) return v.stringValue;
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFSValue);
  if ('mapValue'     in v) {
    const obj = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = fromFSValue(val);
    return obj;
  }
  return null;
}
function fromFSDoc(doc) {
  if (!doc || !doc.fields) return null;
  const obj = { id: doc.name?.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields)) obj[k] = fromFSValue(v);
  return obj;
}

async function verifyToken(token) {
  // Verifikasi Firebase ID token via REST
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FB_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: token })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.users?.[0] || null;
}

function sanitize(str, max = 500) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"']/g, '').trim().substring(0, max);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Kalau env var server (Railway) belum diset, semua request akan gagal
  // dengan pesan 401 yang menyesatkan ("Token tidak valid") padahal
  // sebenarnya server tidak bisa menghubungi Firebase sama sekali.
  // Tangkap di sini supaya error-nya jelas.
  if (!FB_KEY || !process.env.FIREBASE_PROJECT_ID) {
    return res.status(500).json({
      error: 'Konfigurasi server belum lengkap: FIREBASE_API_KEY / FIREBASE_PROJECT_ID belum diset di environment variables (Railway).'
    });
  }

  // ── GET: daftar listing aktif ──────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const url = `${FB_BASE}/rental_listings?key=${FB_KEY}&pageSize=100`;
      const r = await fetch(url);
      if (!r.ok) return res.status(200).json({ listings: [] });
      const json = await r.json();
      const now = Date.now();
      const listings = (json.documents || [])
        .map(fromFSDoc)
        .filter(d => d && d.status === 'active' && new Date(d.expiresAt).getTime() > now)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.status(200).json({ listings });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST: buat/update listing ──────────────────────────────────────────────
  if (req.method === 'POST') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'Token wajib ada. Silakan login dulu.' });

    const user = await verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Token tidak valid.' });

    const uid = user.localId;

    const {
      action = 'create',
      listingId,
      productName, description, price, imageUrl, category,
      contactInfo
    } = req.body || {};

    if (action === 'delete') {
      if (!listingId) return res.status(400).json({ error: 'listingId wajib.' });
      // Cek ownership
      const docUrl = `${FB_BASE}/rental_listings/${listingId}?key=${FB_KEY}`;
      const existing = await fetch(docUrl);
      if (!existing.ok) return res.status(404).json({ error: 'Listing tidak ditemukan.' });
      const doc = fromFSDoc(await existing.json());
      if (doc.sellerUid !== uid) return res.status(403).json({ error: 'Bukan listing Anda.' });

      await fetch(docUrl, { method: 'DELETE' });
      return res.status(200).json({ success: true });
    }

    // create / update
    if (!productName || !description || price === undefined || price === null) {
      return res.status(400).json({ error: 'productName, description, dan price wajib diisi.' });
    }

    const id = listingId || `RNT-${uid.slice(0,6)}-${Date.now()}`;

    if (listingId) {
      // Update — cek ownership
      const docUrl = `${FB_BASE}/rental_listings/${listingId}?key=${FB_KEY}`;
      const existing = await fetch(docUrl);
      if (existing.ok) {
        const doc = fromFSDoc(await existing.json());
        if (doc.sellerUid !== uid) return res.status(403).json({ error: 'Bukan listing Anda.' });
      }
    }

    const data = {
      listingId: id,
      sellerUid: uid,
      sellerName: sanitize(user.displayName || user.email || 'Penjual'),
      sellerPhoto: user.photoUrl || '',
      productName: sanitize(productName, 100),
      description: sanitize(description, 1000),
      price: typeof price === 'number' ? price : parseFloat(price) || 0,
      imageUrl: sanitize(imageUrl || '', 500),
      category: sanitize(category || 'Lainnya', 50),
      contactInfo: sanitize(contactInfo || '', 200),
      status: listingId ? undefined : 'pending', // tetap pending sampai bayar
      updatedAt: new Date().toISOString(),
      ...(listingId ? {} : { createdAt: new Date().toISOString() })
    };

    // Hapus undefined
    Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);

    const patchUrl = `${FB_BASE}/rental_listings/${id}?key=${FB_KEY}`;
    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ fields: toFSFields(data) })
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      return res.status(500).json({ error: 'Gagal simpan listing: ' + errText.substring(0, 200) });
    }

    return res.status(200).json({ success: true, listingId: id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
