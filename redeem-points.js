// api/redeem-points.js
// POST /api/redeem-points
// Body: { uid, idToken, pointsToUse }
// Kurangi poin user dan kembalikan nilai diskon dalam rupiah (1 poin = Rp1)

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { uid, idToken, pointsToUse } = req.body || {};
  if (!uid || !idToken) return res.status(401).json({ error: 'uid & idToken wajib diisi' });
  if (!pointsToUse || pointsToUse < 1) return res.status(400).json({ error: 'pointsToUse minimal 1' });

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const fbApiKey  = process.env.FIREBASE_API_KEY;
  const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const userUrl   = `${baseUrl}/users/${uid}?key=${fbApiKey}`;

  try {
    const cur = await fetch(userUrl, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!cur.ok) return res.status(403).json({ error: 'Tidak bisa membaca data user' });

    const doc = await cur.json();
    const currentPoints = parseInt(doc.fields?.points?.integerValue || '0');

    if (pointsToUse > currentPoints) {
      return res.status(400).json({ error: `Poin tidak cukup (punya ${currentPoints}, minta ${pointsToUse})` });
    }

    const discount = pointsToUse; // 1 poin = Rp1

    // Kurangi poin
    await fetch(`${userUrl}&updateMask.fieldPaths=points`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: { points: { integerValue: String(currentPoints - pointsToUse) } }
      })
    });

    return res.status(200).json({ success: true, discount, remainingPoints: currentPoints - pointsToUse });
  } catch (e) {
    console.error('redeem-points error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
