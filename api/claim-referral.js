// api/claim-referral.js
// POST /api/claim-referral
// Body: { referrerUid, newUserUid, newUserIdToken }
// Dipanggil sekali saat user baru selesai register & punya referral code.

import { awardReferralPoints } from './_users.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { referrerUid, newUserUid, newUserIdToken } = req.body || {};
  if (!referrerUid || !newUserUid) return res.status(400).json({ error: 'referrerUid & newUserUid wajib diisi' });
  if (referrerUid === newUserUid) return res.status(400).json({ error: 'Tidak bisa refer diri sendiri' });

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const fbApiKey  = process.env.FIREBASE_API_KEY;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  try {
    // Cek apakah user baru sudah pernah klaim referral
    const newUserUrl = `${baseUrl}/users/${newUserUid}?key=${fbApiKey}`;
    const headers = { 'Content-Type': 'application/json' };
    if (newUserIdToken) headers['Authorization'] = `Bearer ${newUserIdToken}`;

    const cur = await fetch(newUserUrl);
    if (cur.ok) {
      const doc = await cur.json();
      if (doc.fields?.referralClaimed?.booleanValue === true) {
        return res.status(400).json({ error: 'Referral sudah pernah diklaim' });
      }
    }

    // Tandai user baru sudah klaim referral
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

    // Beri poin ke pemberi referral
    await awardReferralPoints({ baseUrl, fbApiKey, referrerUid });

    return res.status(200).json({ success: true, message: 'Referral berhasil diklaim' });
  } catch (e) {
    console.error('claim-referral error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
