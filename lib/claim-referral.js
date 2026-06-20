// api/claim-referral.js
// POST /api/claim-referral
// Body: { referrerCode, newUserUid, newUserIdToken }
//
// PENTING: referrerCode adalah KODE REFERRAL (8 karakter, hasil substring UID pemberi),
// BUKAN uid lengkap. Backend wajib mencari dulu siapa pemilik kode ini (lookup di field
// `referralCode` pada koleksi users) untuk mendapatkan UID lengkapnya, baru dibandingkan/
// diproses. Sebelumnya kode ini salah membandingkan kode 8 karakter langsung dengan UID
// lengkap (newUserUid), sehingga pengecekan "tidak bisa refer diri sendiri" gagal total
// (dua string itu tidak akan pernah sama panjang/format), dan poin referral juga salah
// tersimpan (ditulis ke uid palsu = kode 8 karakter, bukan uid asli pemberi).

import { awardReferralPoints } from './_users.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { referrerCode, newUserUid, newUserIdToken } = req.body || {};
  if (!referrerCode || !newUserUid) {
    return res.status(400).json({ error: 'referrerCode & newUserUid wajib diisi' });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const fbApiKey  = process.env.FIREBASE_API_KEY;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  try {
    // ── 0. Cari pemilik kode referral ini (lookup berdasarkan field referralCode) ──────
    const queryRes = await fetch(`${baseUrl.replace(/\/documents$/, '')}:runQuery?key=${fbApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'users' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'referralCode' },
              op: 'EQUAL',
              value: { stringValue: referrerCode }
            }
          },
          limit: 1
        }
      })
    });

    let referrerUid = null;
    if (queryRes.ok) {
      const rows = await queryRes.json();
      const match = (rows || []).find(r => r.document);
      if (match) referrerUid = match.document.name.split('/').pop();
    }

    if (!referrerUid) {
      return res.status(400).json({ error: 'Kode referral tidak valid atau tidak ditemukan' });
    }

    // ── 1. Baru sekarang perbandingan UID lengkap vs UID lengkap, ini benar ───────────
    if (referrerUid === newUserUid) {
      return res.status(400).json({ error: 'Tidak bisa pakai kode referral milikmu sendiri' });
    }

    // ── 2. Cek apakah user baru sudah pernah klaim referral ───────────────────────────
    const newUserUrl = `${baseUrl}/users/${newUserUid}?key=${fbApiKey}`;
    const headers = { 'Content-Type': 'application/json' };
    if (newUserIdToken) headers['Authorization'] = `Bearer ${newUserIdToken}`;

    const cur = await fetch(newUserUrl);
    if (cur.ok) {
      const doc = await cur.json();
      if (doc.fields?.referralClaimed?.booleanValue === true) {
        return res.status(400).json({ error: 'Kamu sudah pernah menggunakan kode referral' });
      }
    }

    // ── 3. Tandai user baru sudah klaim referral, simpan UID asli pemberi ─────────────
    await fetch(`${newUserUrl}&updateMask.fieldPaths=referralClaimed&updateMask.fieldPaths=referredBy`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        fields: {
          referralClaimed: { booleanValue: true },
          referredBy:      { stringValue: referrerUid }
        }
      })
    });

    // ── 4. Beri poin ke pemberi referral (pakai UID asli, bukan kode 8 karakter) ──────
    await awardReferralPoints({ baseUrl, fbApiKey, referrerUid });

    return res.status(200).json({ success: true, message: 'Referral berhasil diklaim' });
  } catch (e) {
    console.error('claim-referral error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
