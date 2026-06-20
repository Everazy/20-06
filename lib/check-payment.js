// api/check-payment.js
// Cek status via SakuRupiah + pemenuhan otomatis:
//  - varian kirim-stok (autoPayment) -> ambil akun dari Firestore (FIFO)
//  - varian auto-topup Insider (insiderAuto) -> buat order ke insidertopup & polling status
import { insiderOrder, insiderStatus, mapInsiderStatus } from './_insider.js';
import { awardOrderPoints } from './_users.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { trxId, orderId } = req.query;

    if (!trxId || trxId === 'undefined' || trxId === 'null') {
      return res.status(200).json({ isPaid: false, status: 'pending', reason: 'trxId belum tersedia' });
    }

    const apiId  = process.env.SAKURUPIAH_MERCHANT_ID;
    const apiKey = process.env.SAKURUPIAH_API_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const fbApiKey  = process.env.FIREBASE_API_KEY;
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    // 1. Cek status ke SakuRupiah
    const formData = new URLSearchParams();
    formData.append('api_id', apiId);
    formData.append('method', 'status');
    formData.append('trx_id', trxId);

    const sakuResponse = await fetch('https://sakurupiah.id/api/status-transaction.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    const sakuText = await sakuResponse.text();
    console.log('SakuRupiah status response:', sakuText);

    let sakuData;
    try { sakuData = JSON.parse(sakuText); } catch (e) {
      return res.status(502).json({ error: 'Response tidak valid' });
    }

    // Handle nested data array dari SakuRupiah
    const dataObj = Array.isArray(sakuData.data) ? sakuData.data[0] : (sakuData.data || sakuData);
    const rawStatus = (dataObj?.status || sakuData.status || sakuData.payment_status || '').toLowerCase();
    const isPaid = rawStatus === 'berhasil' || rawStatus === 'success'
                || rawStatus === 'paid'     || rawStatus === '200';

    // 2. Jika belum bayar, return langsung
    if (!isPaid) {
      return res.status(200).json({ isPaid: false, status: rawStatus });
    }

    // 3. Jika sudah bayar, cek apakah order sudah pernah diproses
    if (!orderId || orderId === 'undefined') {
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null });
    }

    const orderUrl = `${baseUrl}/orders/${orderId}?key=${fbApiKey}`;
    const orderRes = await fetch(orderUrl);
    let existingOrderFields = null;

    if (orderRes.ok) {
      const orderDoc = await orderRes.json();
      const fields = orderDoc.fields || {};
      existingOrderFields = fields;

      // Sudah diproses sebelumnya (kirim-stok) - langsung return akun
      if (fields.stockDelivered?.booleanValue === true) {
        const deliveredAccounts = (fields.deliveredAccounts?.arrayValue?.values || [])
          .map(v => v.stringValue || '');
        console.log('Order sudah diproses sebelumnya:', orderId);
        return res.status(200).json({ isPaid: true, status: 'paid', fulfillment: 'stock', deliveredAccounts });
      }

      // Order Insider sudah pernah dibuat - cek status terkini ke insidertopup
      const existingTid = fields.insiderTid?.stringValue;
      if (existingTid) {
        return await pollInsider(res, orderUrl, fbApiKey, existingTid, fields);
      }
    }

    // 4. Belum diproses - ambil metadata dari pending_orders
    const pendingUrl = `${baseUrl}/pending_orders/${orderId}?key=${fbApiKey}`;
    const pendingRes = await fetch(pendingUrl);

    if (!pendingRes.ok) {
      console.error('Pending order tidak ditemukan:', orderId);
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'order_not_found' });
    }

    const pendingDoc = await pendingRes.json();
    const f = pendingDoc.fields || {};

    const productId   = f.productId?.stringValue;
    const variantCode = f.variantCode?.stringValue;
    const qty         = parseInt(f.qty?.integerValue || '1');

    if (!productId || !variantCode) {
      console.error('productId atau variantCode tidak ada');
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'missing_product_info' });
    }

    // 5. Ambil stok dari Firestore
    const safeVariantCode = variantCode.replace(/#/g, "HASH");
    const stockId = `${productId}_${safeVariantCode}`;
    const stockUrl = `${baseUrl}/stocks/${stockId}?key=${fbApiKey}`;
    const stockRes = await fetch(stockUrl);

    if (!stockRes.ok) {
      console.error('Stok tidak ditemukan:', stockId);
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'stock_not_found' });
    }

    const stockDoc    = await stockRes.json();
    const stockFields = stockDoc.fields || {};

    // === Cabang AUTO-TOPUP INSIDER (kategori Game) ===
    // Jika varian ditandai insiderAuto, proses topup ke insidertopup (bukan kirim akun stok).
    const isInsiderAuto = stockFields.insiderAuto?.booleanValue === true;
    if (isInsiderAuto) {
      const insiderSku = stockFields.insiderSku?.stringValue || '';
      const userId     = f.userId?.stringValue || '';
      const zone       = f.zone?.stringValue || '';

      if (!insiderSku || !userId) {
        console.error('Insider: SKU atau userId kosong', { insiderSku, userId });
        await markOrderManual(orderUrl, fbApiKey, { productId, variantCode, qty, buyerName: f.buyerName?.stringValue || '', buyerUid: f.buyerUid?.stringValue || '', productName: f.productName?.stringValue || '', reason: 'missing_insider_data' });
        return res.status(200).json({ isPaid: true, status: 'paid', fulfillment: 'insider', insiderStatus: 'failed', needsManualHandling: true, reason: 'missing_insider_data' });
      }

      // zone_id: untuk game >2 input gunakan separator '///' (user_id///server/...).
      const zoneId = zone || '';

      // Buat order ke insidertopup (order_id = orderId internal kita -> idempoten di sisi mereka).
      const orderResp = await insiderOrder({ product: insiderSku, userId, zoneId, orderId });
      if (!orderResp.ok) {
        console.error('Insider order gagal:', orderResp.error);
        await markOrderManual(orderUrl, fbApiKey, { productId, variantCode, qty, buyerName: f.buyerName?.stringValue || '', buyerUid: f.buyerUid?.stringValue || '', productName: f.productName?.stringValue || '', reason: 'insider_order_failed', insiderError: orderResp.error });
        return res.status(200).json({ isPaid: true, status: 'paid', fulfillment: 'insider', insiderStatus: 'failed', needsManualHandling: true, reason: 'insider_order_failed', error: orderResp.error });
      }

      const tid = orderResp.data?.tid || '';
      // Simpan tid + tandai processing di orders (sekaligus idempotency untuk polling berikutnya).
      await fetch(`${orderUrl}&updateMask.fieldPaths=insiderTid&updateMask.fieldPaths=insiderStatus&updateMask.fieldPaths=status&updateMask.fieldPaths=fulfillment&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=buyerUid&updateMask.fieldPaths=productName&updateMask.fieldPaths=insiderTarget&updateMask.fieldPaths=paidAt`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            insiderTid:    { stringValue: tid },
            insiderStatus: { stringValue: 'processing' },
            status:        { stringValue: 'processing' },
            fulfillment:   { stringValue: 'insider' },
            productId:     { stringValue: productId },
            variantCode:   { stringValue: variantCode },
            qty:           { integerValue: qty.toString() },
            buyerName: { stringValue: f.buyerName?.stringValue || '' }, buyerUid: { stringValue: f.buyerUid?.stringValue || '' }, productName: { stringValue: f.productName?.stringValue || '' },
            insiderTarget: { stringValue: zoneId ? `${userId}///${zoneId}` : userId },
            paidAt:        { stringValue: new Date().toISOString() }
          }
        })
      });

      console.log('✅ Insider order dibuat:', orderId, '-> tid', tid);
      await awardOrderPoints({ baseUrl, fbApiKey, buyerUid: f.buyerUid?.stringValue || '', amount: parseInt(f.amount?.integerValue || '0') });
      // Langsung cek status sekali (biasanya masih processing).
      return await pollInsider(res, orderUrl, fbApiKey, tid, null);
    }

    // CEK: apakah varian ini autoPayment = true?
    const isAutoPayment = stockFields.autoPayment?.booleanValue === true;
    if (!isAutoPayment) {
      console.log('Varian', variantCode, 'tidak aktif autoPayment — tidak kirim akun otomatis');
      return res.status(200).json({ isPaid: true, status: 'paid', fulfillment: 'stock', deliveredAccounts: null, reason: 'autopayment_disabled' });
    }

    const allAccounts = (stockFields.accounts?.arrayValue?.values || []).map(v => v.stringValue || '');

    if (allAccounts.length < qty) {
      console.error('Stok tidak cukup:', allAccounts.length, 'butuh:', qty);
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'insufficient_stock' });
    }

    // 6. Ambil akun (FIFO) dan update stok
    const deliveredAccounts = allAccounts.slice(0, qty);
    const remainingAccounts = allAccounts.slice(qty);
    const totalDelivered = parseInt(stockFields.totalDelivered?.integerValue || '0') + qty;

    await fetch(`${stockUrl}&updateMask.fieldPaths=accounts&updateMask.fieldPaths=totalDelivered&updateMask.fieldPaths=lastUpdated`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          accounts: { arrayValue: { values: remainingAccounts.map(a => ({ stringValue: a })) } },
          totalDelivered: { integerValue: totalDelivered.toString() },
          lastUpdated: { stringValue: new Date().toISOString() }
        }
      })
    });

    // 7. Simpan order sebagai selesai
    await fetch(`${orderUrl}&updateMask.fieldPaths=stockDelivered&updateMask.fieldPaths=deliveredAccounts&updateMask.fieldPaths=status&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=buyerUid&updateMask.fieldPaths=productName`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          stockDelivered:    { booleanValue: true },
          deliveredAccounts: { arrayValue: { values: deliveredAccounts.map(a => ({ stringValue: a })) } },
          status:            { stringValue: 'paid' },
          paidAt:            { stringValue: new Date().toISOString() },
          trxId:             { stringValue: trxId || '' },
          productId:         { stringValue: productId },
          variantCode:       { stringValue: variantCode },
          qty:               { integerValue: qty.toString() },
          buyerName: { stringValue: f.buyerName?.stringValue || '' }, buyerUid: { stringValue: f.buyerUid?.stringValue || '' }, productName: { stringValue: f.productName?.stringValue || '' }
        }
      })
    });

    console.log('✅ Order', orderId, 'selesai via check-payment -', qty, 'akun dikirim');
    await awardOrderPoints({ baseUrl, fbApiKey, buyerUid: f.buyerUid?.stringValue || '', amount: parseInt(f.amount?.integerValue || '0') });
    return res.status(200).json({
      isPaid: true,
      status: 'paid',
      fulfillment: 'stock',
      deliveredAccounts,
      amount: sakuData.amount || sakuData.nominal,
      paidAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Check payment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Cek status pesanan Insider berdasarkan tid, perbarui Firestore, dan balas ke frontend.
async function pollInsider(res, orderUrl, fbApiKey, tid, prevFields) {
  const r = await insiderStatus(tid);
  if (!r.ok) {
    // Gagal cek status (mis. IP belum whitelist). Anggap masih diproses; frontend polling lagi.
    console.warn('Insider status gagal:', r.error);
    return res.status(200).json({ isPaid: true, status: 'paid', fulfillment: 'insider', insiderStatus: 'processing', reason: 'status_check_failed', error: r.error });
  }

  const rawStatus = r.data?.status || '';
  const mapped = mapInsiderStatus(rawStatus);
  const note = r.data?.note || '';

  // Perbarui status tersimpan.
  await fetch(`${orderUrl}&updateMask.fieldPaths=insiderStatus&updateMask.fieldPaths=status&updateMask.fieldPaths=insiderNote${mapped === 'done' ? '&updateMask.fieldPaths=stockDelivered' : ''}${mapped === 'failed' ? '&updateMask.fieldPaths=needsManualHandling' : ''}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fields: {
        insiderStatus: { stringValue: mapped },
        insiderNote:   { stringValue: note },
        status:        { stringValue: mapped === 'done' ? 'paid' : (mapped === 'failed' ? 'failed' : 'processing') },
        ...(mapped === 'done'   ? { stockDelivered: { booleanValue: true } } : {}),
        ...(mapped === 'failed' ? { needsManualHandling: { booleanValue: true } } : {})
      }
    })
  });

  return res.status(200).json({
    isPaid: true,
    status: 'paid',
    fulfillment: 'insider',
    insiderStatus: mapped,        // 'done' | 'failed' | 'processing'
    insiderRawStatus: rawStatus,
    insiderNote: note,
    needsManualHandling: mapped === 'failed'
  });
}

// Tandai order butuh penanganan manual (mis. data insider kurang / order insider gagal dibuat).
async function markOrderManual(orderUrl, fbApiKey, info) {
  try {
    await fetch(`${orderUrl}&updateMask.fieldPaths=status&updateMask.fieldPaths=fulfillment&updateMask.fieldPaths=insiderStatus&updateMask.fieldPaths=needsManualHandling&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=buyerUid&updateMask.fieldPaths=productName&updateMask.fieldPaths=insiderNote&updateMask.fieldPaths=paidAt`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          status:              { stringValue: 'failed' },
          fulfillment:         { stringValue: 'insider' },
          insiderStatus:       { stringValue: 'failed' },
          needsManualHandling: { booleanValue: true },
          productId:           { stringValue: info.productId || '' },
          variantCode:         { stringValue: info.variantCode || '' },
          qty:                 { integerValue: (info.qty || 1).toString() },
          buyerName:           { stringValue: info.buyerName || '' },
          buyerUid:            { stringValue: info.buyerUid || '' },
          productName:         { stringValue: info.productName || '' },
          insiderNote:         { stringValue: info.insiderError || info.reason || '' },
          paidAt:              { stringValue: new Date().toISOString() }
        }
      })
    });
  } catch (e) {
    console.error('markOrderManual gagal:', e.message);
  }
}
