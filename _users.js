// api/_users.js
// Helper untuk akun pembeli (users/{uid}) — poin, referral, login pertama.

const POINTS_PER_ORDER   = 10;    // poin per order berhasil (flat)
const POINTS_FIRST_LOGIN = 1000;  // bonus login pertama kali
const POINTS_REFERRAL    = 1000;  // bonus untuk pemberi referral

// ── Tambah poin order (dipanggil dari payment-callback.js) ──────────────────
export async function awardOrderPoints({ baseUrl, fbApiKey, buyerUid }) {
  if (!buyerUid) return;
  try {
    await _incrementUser(baseUrl, fbApiKey, buyerUid, {
      pointsDelta: POINTS_PER_ORDER,
      totalOrdersDelta: 1,
      extraFields: { lastOrderAt: { stringValue: new Date().toISOString() } }
    });
  } catch (e) {
    console.warn('awardOrderPoints gagal (diabaikan):', e.message);
  }
}

// ── Bonus login pertama (dipanggil dari finishBuyerEmailAuth / handleGoogleCredential) ──
// Mengembalikan true jika ini memang login pertama dan poin diberikan.
export async function maybeAwardFirstLoginBonus({ baseUrl, fbApiKey, uid, idToken }) {
  if (!uid) return false;
  try {
    const userUrl = `${baseUrl}/users/${uid}?key=${fbApiKey}`;
    const res = await fetch(userUrl);
    if (res.ok) {
      const doc = await res.json();
      if (doc.fields?.firstLoginBonusGiven?.booleanValue === true) return false; // sudah pernah
    }
    // Berikan bonus
    await _incrementUser(baseUrl, fbApiKey, uid, {
      pointsDelta: POINTS_FIRST_LOGIN,
      totalOrdersDelta: 0,
      extraFields: { firstLoginBonusGiven: { booleanValue: true } }
    }, idToken);
    return true;
  } catch (e) {
    console.warn('firstLoginBonus gagal (diabaikan):', e.message);
    return false;
  }
}

// ── Bonus referral (dipanggil dari API endpoint /api/claim-referral) ──────────
export async function awardReferralPoints({ baseUrl, fbApiKey, referrerUid }) {
  if (!referrerUid) return;
  try {
    await _incrementUser(baseUrl, fbApiKey, referrerUid, {
      pointsDelta: POINTS_REFERRAL,
      totalOrdersDelta: 0,
      extraFields: { lastReferralAt: { stringValue: new Date().toISOString() } }
    });
  } catch (e) {
    console.warn('awardReferralPoints gagal (diabaikan):', e.message);
  }
}

// ── Internal: baca-tambah-tulis user doc ─────────────────────────────────────
async function _incrementUser(baseUrl, fbApiKey, uid, { pointsDelta, totalOrdersDelta, extraFields }, idToken) {
  const userUrl = `${baseUrl}/users/${uid}?key=${fbApiKey}`;
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

  const cur = await fetch(userUrl);
  let points = 0, totalOrders = 0;
  if (cur.ok) {
    const doc = await cur.json();
    points      = parseInt(doc.fields?.points?.integerValue      || '0');
    totalOrders = parseInt(doc.fields?.totalOrders?.integerValue || '0');
  }

  const maskFields = ['points', 'totalOrders', ...Object.keys(extraFields || {})];
  const maskQuery  = maskFields.map(f => `updateMask.fieldPaths=${f}`).join('&');

  await fetch(`${userUrl}&${maskQuery}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      fields: {
        points:      { integerValue: String(points + pointsDelta) },
        totalOrders: { integerValue: String(totalOrders + totalOrdersDelta) },
        ...(extraFields || {})
      }
    })
  });
}
