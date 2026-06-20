// api/_users.js
// Helper kecil untuk akun pembeli (users/{uid}) — dipakai saat order otomatis selesai.
// Pola mengikuti file API lain di project ini: akses Firestore via REST + FIREBASE_API_KEY,
// tanpa firebase-admin (lihat README bagian Firestore Rules).

const POINTS_PER_RUPIAH = 1 / 1000; // 1 poin tiap Rp1.000 belanja (auto order saja)

export async function awardOrderPoints({ baseUrl, fbApiKey, buyerUid, amount }) {
  if (!buyerUid) return; // order tanpa akun (seharusnya tidak terjadi untuk auto order)

  try {
    const earned = Math.max(1, Math.round((amount || 0) * POINTS_PER_RUPIAH));
    const userUrl = `${baseUrl}/users/${buyerUid}?key=${fbApiKey}`;

    const cur = await fetch(userUrl);
    let points = 0;
    let totalOrders = 0;
    if (cur.ok) {
      const doc = await cur.json();
      points = parseInt(doc.fields?.points?.integerValue || '0');
      totalOrders = parseInt(doc.fields?.totalOrders?.integerValue || '0');
    }

    await fetch(`${userUrl}&updateMask.fieldPaths=points&updateMask.fieldPaths=totalOrders&updateMask.fieldPaths=lastOrderAt`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          points:      { integerValue: (points + earned).toString() },
          totalOrders: { integerValue: (totalOrders + 1).toString() },
          lastOrderAt: { stringValue: new Date().toISOString() }
        }
      })
    });
  } catch (e) {
    console.warn('awardOrderPoints gagal (diabaikan, tidak menggagalkan order):', e.message);
  }
}
