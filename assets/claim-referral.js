// api/claim-referral.js
// POST /api/claim-referral
// Body: { referrerUid, newUserUid, newUserIdToken }
//
// PROTEKSI ANTI-ABUSE:
// 1. Self-referral diblokir
// 2. Akun penerima harus berumur minimal 24 jam (cegah akun throwaway)
// 3. Rate limit IP: 1 IP hanya bisa klaim referral 1x per 30 hari (simpan di Firestore referral_ip_log)
// 4. Pemberi referral maks 3 referral per 30 hari
// 5. Poin referral TIDAK langsung diberikan — ditandai "pending", baru cair setelah penerima order pertama
//    (lihat payment-callback.js yang memanggil maybePayoutPendingReferral)

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { referrerUid, newUserUid, newUserIdToken } = req.body || {};
  if (!referrerUid || !newUserUid) return res.status(400).json({ error: 'referrerUid & newUserUid wajib diisi' });
  if (referrerUid === newUserUid) return res.status(400).json({ error: 'Tidak bisa pakai kode referral sendiri' });

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const fbApiKey  = process.env.FIREBASE_API_KEY;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const authHeader = { 'Content-Type': 'application/json' };
  if (newUserIdToken) authHeader['Authorization'] = `Bearer ${newUserIdToken}`;

  // Ambil IP pengguna
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
          || req.headers['x-real-ip']
          || req.socket?.remoteAddress
          || 'unknown';

  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const ONE_DAY     = 24 * 60 * 60 * 1000;

  try {
    // ── 1. Cek user penerima sudah pernah klaim ──────────────────────────────
    const newUserUrl = `${baseUrl}/users/${newUserUid}?key=${fbApiKey}`;
    const newUserRes = await fetch(newUserUrl);
    if (!newUserRes.ok) return res.status(400).json({ error: 'Akun tidak ditemukan' });

    const newUserDoc = await newUserRes.json();
    const nf = newUserDoc.fields || {};

    if (nf.referralClaimed?.booleanValue === true) {
      return res.status(400).json({ error: 'Kamu sudah pernah menggunakan kode referral' });
    }

    // ── 2. Akun penerima minimal berumur 24 jam ───────────────────────────────
    const createdAt = nf.createdAt?.stringValue;
    if (createdAt) {
      const age = now - new Date(createdAt).getTime();
      if (age < ONE_DAY) {
        return res.status(400).json({ error: 'Akun harus berumur minimal 24 jam sebelum bisa menggunakan kode referral' });
      }
    }

    // ── 3. Rate limit IP ─────────────────────────────────────────────────────
    const ipKey  = ip.replace(/[.:]/g, '_'); // karakter aman untuk doc ID
    const ipUrl  = `${baseUrl}/referral_ip_log/${ipKey}?key=${fbApiKey}`;
    const ipRes  = await fetch(ipUrl);
    if (ipRes.ok) {
      const ipDoc  = await ipRes.json();
      const lastAt = ipDoc.fields?.lastClaimAt?.stringValue;
      if (lastAt && (now - new Date(lastAt).getTime()) < THIRTY_DAYS) {
        return res.status(429).json({ error: 'Satu perangkat hanya bisa menggunakan kode referral satu kali per 30 hari' });
      }
    }

    // ── 4. Cek pemberi referral: maks 3 referral per 30 hari ─────────────────
    const referrerUrl = `${baseUrl}/users/${referrerUid}?key=${fbApiKey}`;
    const referrerRes = await fetch(referrerUrl);
    if (!referrerRes.ok) return res.status(400).json({ error: 'Kode referral tidak valid' });

    const referrerDoc = await referrerRes.json();
    const rf = referrerDoc.fields || {};

    const lastRefAt    = rf.lastReferralAt?.stringValue;
    const referralCount = parseInt(rf.referralCount30d?.integerValue || '0');
    const isNewWindow  = !lastRefAt || (now - new Date(lastRefAt).getTime()) >= THIRTY_DAYS;
    const currentCount = isNewWindow ? 0 : referralCount;

    if (currentCount >= 3) {
      return res.status(429).json({ error: 'Kode referral ini sudah mencapai batas penggunaan bulan ini' });
    }

    // ── Semua cek lolos — tandai klaim & simpan pending referral ─────────────

    // Tandai IP sudah dipakai
    await fetch(`${ipUrl}&updateMask.fieldPaths=lastClaimAt&updateMask.fieldPaths=referrerUid`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        lastClaimAt: { stringValue: new Date().toISOString() },
        referrerUid: { stringValue: referrerUid }
      }})
    });

    // Tandai user penerima sudah klaim, simpan referredBy
    await fetch(`${newUserUrl}&updateMask.fieldPaths=referralClaimed&updateMask.fieldPaths=referredBy&updateMask.fieldPaths=referralPendingPayout`, {
      method: 'PATCH',
      headers: authHeader,
      body: JSON.stringify({ fields: {
        referralClaimed:       { booleanValue: true },
        referredBy:            { stringValue: referrerUid },
        referralPendingPayout: { booleanValue: true }  // poin belum cair, tunggu order pertama
      }})
    });

    // Update counter pemberi referral
    await fetch(`${referrerUrl}&updateMask.fieldPaths=lastReferralAt&updateMask.fieldPaths=referralCount30d`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        lastReferralAt:   { stringValue: new Date().toISOString() },
        referralCount30d: { integerValue: String(currentCount + 1) }
      }})
    });

    return res.status(200).json({
      success: true,
      message: 'Kode referral berhasil diklaim! Poin akan diberikan ke temanmu setelah kamu menyelesaikan order pertama.'
    });

  } catch (e) {
    console.error('claim-referral error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
