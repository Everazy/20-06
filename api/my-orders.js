// api/my-orders.js
// Dipakai oleh dashboard pembeli (modal "Akun Saya") untuk menampilkan poin & riwayat order.
// GET /api/my-orders?uid=<firebase_uid>

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'uid wajib diisi' });

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const fbApiKey  = process.env.FIREBASE_API_KEY;
    const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    // 1. Profil & poin
    const userRes = await fetch(`${baseUrl}/users/${uid}?key=${fbApiKey}`);
    let points = 0, totalOrders = 0;
    if (userRes.ok) {
      const userDoc = await userRes.json();
      points      = parseInt(userDoc.fields?.points?.integerValue || '0');
      totalOrders = parseInt(userDoc.fields?.totalOrders?.integerValue || '0');
    }

    // 2. Riwayat order (structured query: orders where buyerUid == uid, urut terbaru)
    const queryRes = await fetch(`${baseUrl.replace(/\/documents$/, '')}:runQuery?key=${fbApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'orders' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'buyerUid' },
              op: 'EQUAL',
              value: { stringValue: uid }
            }
          },
          orderBy: [{ field: { fieldPath: 'paidAt' }, direction: 'DESCENDING' }],
          limit: 50
        }
      })
    });

    let orders = [];
    if (queryRes.ok) {
      const rows = await queryRes.json();
      orders = (rows || [])
        .filter(r => r.document)
        .map(r => {
          const f = r.document.fields || {};
          return {
            orderId:     r.document.name?.split('/').pop() || '',
            productId:   f.productId?.stringValue || '',
            productName: f.productName?.stringValue || '',
            variantCode: f.variantCode?.stringValue || '',
            qty:         parseInt(f.qty?.integerValue || '1'),
            status:      f.status?.stringValue || '',
            paidAt:      f.paidAt?.stringValue || ''
          };
        });
    }

    return res.status(200).json({ success: true, points, totalOrders, orders });
  } catch (err) {
    console.error('my-orders error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
