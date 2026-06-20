// api/create-payment.js
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      productId, productName, variantName, variantCode,
      price, qty = 1, buyerName, buyerEmail, buyerPhone, buyerUid,
      note = '', orderData = {}
    } = req.body || {};

    if (!productId || !productName || !price || !buyerName) {
      return res.status(400).json({ error: 'Data pesanan tidak lengkap' });
    }
    if (typeof price !== 'number' || price <= 0) {
      return res.status(400).json({ error: 'Harga tidak valid' });
    }
    if (!buyerPhone) {
      return res.status(400).json({ error: 'Nomor HP wajib diisi' });
    }
    // Order otomatis wajib pakai akun (login Google) — lihat assets/_store_original.js (buyerUser)
    if (!buyerUid) {
      return res.status(401).json({ error: 'Silakan login dengan akun Google dulu untuk order otomatis.' });
    }

    const apiId  = process.env.SAKURUPIAH_MERCHANT_ID;
    const apiKey = process.env.SAKURUPIAH_API_KEY;
    const totalAmount = Math.round(price * qty);
    const paymentMethod = process.env.SAKURUPIAH_PAYMENT_METHOD || 'QRIS';
    const orderId = `EVR-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // Signature: hash_hmac('sha256', api_id + method + merchant_ref + amount, apikey)
    const signatureRaw = `${apiId}${paymentMethod}${orderId}${totalAmount}`;
    const signature = crypto.createHmac('sha256', apiKey).update(signatureRaw).digest('hex');

    const formData = new URLSearchParams();
    formData.append('api_id',       apiId);
    formData.append('method',       paymentMethod);
    formData.append('amount',       totalAmount.toString());
    formData.append('phone',        sanitizePhone(buyerPhone));
    formData.append('signature',    signature);
    formData.append('name',         sanitizeInput(buyerName));
    formData.append('merchant_fee', '2');
    formData.append('merchant_ref', orderId);
formData.append('callback_url', 'https://everastore.biz.id/api/payment-callback');
formData.append('return_url',   'https://everastore.biz.id/payment-success.html');
    if (buyerEmail) formData.append('email', sanitizeInput(buyerEmail));

    const noteText = `${productName} - ${variantName || variantCode} | Ref:${orderId}${note ? ' | ' + note : ''}`;
    formData.append('note', noteText.substring(0, 500));

    const sakuResponse = await fetch('https://sakurupiah.id/api/create.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    const sakuText = await sakuResponse.text();
    console.log('SakuRupiah response:', sakuText);

    let sakuData;
    try { sakuData = JSON.parse(sakuText); } catch (e) {
      return res.status(502).json({ error: 'Response tidak valid: ' + sakuText.substring(0, 200) });
    }

    if (!sakuData || sakuData.status == '400' || sakuData.status === false || sakuData.error) {
      return res.status(502).json({ error: sakuData?.message || 'Gagal membuat invoice' });
    }

    const d = Array.isArray(sakuData.data) ? sakuData.data[0] : sakuData.data;
    const trxId      = d?.trx_id || null;
    const paymentUrl = d?.checkout_url || d?.payment_url || d?.url || null;

    console.log('Invoice berhasil - trxId:', trxId, 'orderId:', orderId);

    // Data tujuan topup (untuk auto-topup Insider di kategori Game).
    const insiderUserId = sanitizeInput(orderData?.userId || '');
    const insiderZone   = sanitizeInput(orderData?.server || '');

    // Simpan metadata order ke Firestore agar callback bisa ambil info produk
    try {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const fbApiKey  = process.env.FIREBASE_API_KEY;
      const docUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/pending_orders/${orderId}?key=${fbApiKey}`;

      await fetch(docUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            orderId:      { stringValue: orderId },
            trxId:        { stringValue: trxId || '' },
            productId:    { stringValue: productId },
            productName:  { stringValue: productName },
            variantName:  { stringValue: variantName || '' },
            variantCode:  { stringValue: variantCode || '' },
            qty:          { integerValue: qty.toString() },
            amount:       { integerValue: totalAmount.toString() },
            buyerName:    { stringValue: buyerName },
            buyerEmail:   { stringValue: buyerEmail || '' },
            buyerPhone:   { stringValue: buyerPhone || '' },
            buyerUid:     { stringValue: buyerUid || '' },
            userId:       { stringValue: insiderUserId },
            zone:         { stringValue: insiderZone },
            note:         { stringValue: note || '' },
            status:       { stringValue: 'pending' },
            createdAt:    { stringValue: new Date().toISOString() }
          }
        })
      });
      console.log('Metadata order tersimpan ke Firestore');
    } catch (fbErr) {
      console.warn('Gagal simpan metadata ke Firestore:', fbErr.message);
      // Tidak gagalkan request utama
    }

    return res.status(200).json({
      success: true, orderId, trxId, paymentUrl,
      amount: totalAmount,
      expiredAt: d?.expired,
      status: 'pending'
    });

  } catch (err) {
    console.error('Create payment error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}

function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&]/g, '').trim().substring(0, 500);
}

function sanitizePhone(phone) {
  let p = (phone || '').replace(/\D/g, '');
  if (p.startsWith('0')) return p;
  if (p.startsWith('62')) return '0' + p.slice(2);
  return p;
}
