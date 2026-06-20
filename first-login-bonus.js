// api/first-login-bonus.js
// POST /api/first-login-bonus
// Body: { uid, idToken }
// Cek & beri bonus 1.000 poin untuk login pertama kali.

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, idToken } = req.body || {};
  if (!uid || !idToken) return res.status(400).json({ error: 'uid & idToken wajib diisi' });

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const fbApiKey  = process.env.FIREBASE_API_KEY;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const userUrl   = `${baseUrl}/users/${uid}?key=${fbApiKey}`;
  const authHeader = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` };

  try {
    // Cek apakah sudah dapat bonus
    const cur = await fetch(userUrl);
    let points = 0;
    if (cur.ok) {
      const doc = await cur.json();
      if (doc.fields?.firstLoginBonusGiven?.booleanValue === true) {
        return res.status(200).json({ awarded: false, reason: 'already_given' });
      }
      points = parseInt(doc.fields?.points?.integerValue || '0');
    }

    const BONUS = 1000;
    await fetch(`${userUrl}&updateMask.fieldPaths=points&updateMask.fieldPaths=firstLoginBonusGiven`, {
      method: 'PATCH',
      headers: authHeader,
      body: JSON.stringify({
        fields: {
          points:               { integerValue: String(points + BONUS) },
          firstLoginBonusGiven: { booleanValue: true }
        }
      })
    });

    return res.status(200).json({ awarded: true, bonus: BONUS });
  } catch (e) {
    console.error('first-login-bonus error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
