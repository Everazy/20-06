// api/_users.js
// Helper kecil untuk akun pembeli (users/{uid}) — dipakai saat order otomatis selesai,
// klaim referral, dan bonus login pertama.
// Pola mengikuti file API lain di project ini: akses Firestore via REST + FIREBASE_API_KEY,
// tanpa firebase-admin (lihat README bagian Firestore Rules).

const POINTS_PER_RUPIAH  = 1 / 1000; // 1 poin tiap Rp1.000 belanja (auto order saja)
const POINTS_FIRST_LOGIN = 1000;     // bonus login pertama kali
const POINTS_REFERRAL    = 1000;     // bonus untuk pemberi referral

// ── Tambah poin order (dipanggil dari check-payment.js / payment-callback.js) ──
export async function awardOrderPoints({ baseUrl, fbApiKey, buyerUid, amount }) {
  if (!buyerUid) return; // order tanpa akun (seharusnya tidak terjadi untuk auto order)

  try {
    const earned = Math.max(1, Math.round((amount || 0) * POINTS_PER_RUPIAH));
    await _incrementUser(baseUrl, fbApiKey, buyerUid, {
      pointsDelta: earned,
      totalOrdersDelta: 1,
      extraFields: { lastOrderAt: { stringValue: new Date().toISOString() } }
    });
  } catch (e) {
    console.warn('awardOrderPoints gagal (diabaikan, tidak menggagalkan order):', e.message);
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
