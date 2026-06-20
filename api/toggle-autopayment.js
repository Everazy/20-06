// api/toggle-autopayment.js
// Toggle autoPayment per varian via Firestore REST API

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || token.length < 32) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { productId, variantCode, autoPayment } = req.body || {};

    if (!productId || !variantCode || typeof autoPayment !== 'boolean') {
      return res.status(400).json({ error: 'productId, variantCode, dan autoPayment diperlukan' });
    }

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const apiKey    = process.env.FIREBASE_API_KEY;
    // Ganti # dengan HASH agar tidak konflik dengan URL fragment
    const safeVariantCode = variantCode.replace(/#/g, 'HASH');
    const stockId   = `${productId}_${safeVariantCode}`;
    const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const patchUrl  = `${baseUrl}/stocks/${stockId}?key=${apiKey}&updateMask.fieldPaths=autoPayment`;

    const patchRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          autoPayment: { booleanValue: autoPayment }
        }
      })
    });

    if (!patchRes.ok) {
      // Jika dokumen belum ada, buat baru
      const createUrl = `${baseUrl}/stocks/${stockId}?key=${apiKey}`;
      const createRes = await fetch(createUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            autoPayment:    { booleanValue: autoPayment },
            accounts:       { arrayValue: { values: [] } },
            totalDelivered: { integerValue: '0' },
            productId:      { stringValue: productId },
            variantCode:    { stringValue: variantCode },
            lastUpdated:    { stringValue: new Date().toISOString() }
          }
        })
      });

      if (!createRes.ok) {
        const err = await createRes.text();
        console.error('Firestore create error:', err);
        return res.status(500).json({ error: 'Gagal update autoPayment' });
      }
    }

    return res.status(200).json({
      success: true,
      autoPayment,
      message: `Payment otomatis ${autoPayment ? 'diaktifkan' : 'dinonaktifkan'}`
    });

  } catch (err) {
    console.error('Toggle autoPayment error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
