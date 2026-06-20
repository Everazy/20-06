// api/payment-callback.js
// Dipanggil SakuRupiah setelah pembayaran berhasil
// Header: X-Callback-Signature, X-Callback-Event
import { insiderOrder } from './_insider.js';
import { awardOrderPoints, maybePayoutPendingReferral } from './_users.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    console.log('Callback diterima:', JSON.stringify(payload));

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const fbApiKey  = process.env.FIREBASE_API_KEY;
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    // Ambil merchant_ref (= orderId kita) dan status dari payload
    const merchantRef   = payload.merchant_ref || payload.order_id || payload.reference_id;
    const paymentStatus = (payload.payment_status || payload.status || '').toLowerCase();
    const trxId         = payload.trx_id || payload.transaction_id;

    console.log('merchant_ref:', merchantRef, '| status:', paymentStatus, '| trxId:', trxId);

    const isPaid = paymentStatus === 'berhasil' || paymentStatus === 'success'
                || paymentStatus === 'paid'     || paymentStatus === 'settlement';

    if (!isPaid) {
      console.log('Status bukan paid, diabaikan:', paymentStatus);
      return res.status(200).json({ received: true, processed: false });
    }

    if (!merchantRef) {
      console.error('merchant_ref tidak ada di payload');
      return res.status(200).json({ received: true, processed: false, reason: 'no_merchant_ref' });
    }

    // Cek apakah sudah diproses sebelumnya
    const orderUrl = `${baseUrl}/orders/${merchantRef}?key=${fbApiKey}`;
    const orderRes = await fetch(orderUrl);
    if (orderRes.ok) {
      const orderDoc = await orderRes.json();
      if (orderDoc.fields?.stockDelivered?.booleanValue === true) {
        console.log('Order sudah diproses sebelumnya:', merchantRef);
        return res.status(200).json({ received: true, processed: false, reason: 'already_processed' });
      }
    }

    // Ambil metadata order dari pending_orders
    const pendingUrl = `${baseUrl}/pending_orders/${merchantRef}?key=${fbApiKey}`;
    const pendingRes = await fetch(pendingUrl);

    if (!pendingRes.ok) {
      console.error('Pending order tidak ditemukan:', merchantRef);
      return res.status(200).json({ received: true, processed: false, reason: 'order_not_found' });
    }

    const pendingDoc = await pendingRes.json();
    const f = pendingDoc.fields || {};

    const productId   = f.productId?.stringValue;
    const variantCode = f.variantCode?.stringValue;
    const qty         = parseInt(f.qty?.integerValue || '1');

    if (!productId || !variantCode) {
      console.error('productId atau variantCode tidak ada');
      return res.status(200).json({ received: true, processed: false, reason: 'missing_product_info' });
    }

    // Ambil stok dari Firestore
    const stockId  = `${productId}_${variantCode}`;
    const stockUrl = `${baseUrl}/stocks/${stockId}?key=${fbApiKey}`;
    const stockRes = await fetch(stockUrl);

    if (!stockRes.ok) {
      console.error('Stok tidak ditemukan:', stockId);
      return res.status(200).json({ received: true, processed: false, reason: 'stock_not_found' });
    }

    const stockDoc  = await stockRes.json();
    const stockFields = stockDoc.fields || {};

    // === Cabang AUTO-TOPUP INSIDER (kategori Game) ===
    const isInsiderAuto = stockFields.insiderAuto?.booleanValue === true;
    if (isInsiderAuto) {
      const insiderSku = stockFields.insiderSku?.stringValue || '';
      const userId     = f.userId?.stringValue || '';
      const zone       = f.zone?.stringValue || '';

      if (!insiderSku || !userId) {
        console.error('Callback Insider: SKU atau userId kosong');
        await fetch(`${orderUrl}&updateMask.fieldPaths=status&updateMask.fieldPaths=fulfillment&updateMask.fieldPaths=insiderStatus&updateMask.fieldPaths=needsManualHandling&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=buyerUid&updateMask.fieldPaths=productName&updateMask.fieldPaths=insiderNote&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            status: { stringValue: 'failed' }, fulfillment: { stringValue: 'insider' },
            insiderStatus: { stringValue: 'failed' }, needsManualHandling: { booleanValue: true },
            productId: { stringValue: productId }, variantCode: { stringValue: variantCode },
            qty: { integerValue: qty.toString() }, buyerName: { stringValue: f.buyerName?.stringValue || '' }, buyerUid: { stringValue: f.buyerUid?.stringValue || '' }, productName: { stringValue: f.productName?.stringValue || '' },
            insiderNote: { stringValue: 'missing_insider_data' }, paidAt: { stringValue: new Date().toISOString() },
            trxId: { stringValue: trxId || '' }
          }})
        });
        return res.status(200).json({ received: true, processed: false, reason: 'missing_insider_data' });
      }

      const zoneId = zone || '';
      const orderResp = await insiderOrder({ product: insiderSku, userId, zoneId, orderId: merchantRef });
      if (!orderResp.ok) {
        console.error('Callback Insider: order gagal', orderResp.error);
        await fetch(`${orderUrl}&updateMask.fieldPaths=status&updateMask.fieldPaths=fulfillment&updateMask.fieldPaths=insiderStatus&updateMask.fieldPaths=needsManualHandling&updateMask.fieldPaths=insiderNote&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=buyerUid&updateMask.fieldPaths=productName&updateMask.fieldPaths=insiderTarget`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            status: { stringValue: 'failed' }, fulfillment: { stringValue: 'insider' },
            insiderStatus: { stringValue: 'failed' }, needsManualHandling: { booleanValue: true },
            insiderNote: { stringValue: orderResp.error || 'insider_order_failed' },
            paidAt: { stringValue: new Date().toISOString() }, trxId: { stringValue: trxId || '' },
            productId: { stringValue: productId }, variantCode: { stringValue: variantCode },
            qty: { integerValue: qty.toString() }, buyerName: { stringValue: f.buyerName?.stringValue || '' }, buyerUid: { stringValue: f.buyerUid?.stringValue || '' }, productName: { stringValue: f.productName?.stringValue || '' },
            insiderTarget: { stringValue: zoneId ? `${userId}///${zoneId}` : userId }
          }})
        });
        return res.status(200).json({ received: true, processed: false, reason: 'insider_order_failed' });
      }

      const tid = orderResp.data?.tid || '';
      await fetch(`${orderUrl}&updateMask.fieldPaths=insiderTid&updateMask.fieldPaths=insiderStatus&updateMask.fieldPaths=status&updateMask.fieldPaths=fulfillment&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=buyerUid&updateMask.fieldPaths=productName&updateMask.fieldPaths=insiderTarget&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          insiderTid: { stringValue: tid }, insiderStatus: { stringValue: 'processing' },
          status: { stringValue: 'processing' }, fulfillment: { stringValue: 'insider' },
          productId: { stringValue: productId }, variantCode: { stringValue: variantCode },
          qty: { integerValue: qty.toString() }, buyerName: { stringValue: f.buyerName?.stringValue || '' }, buyerUid: { stringValue: f.buyerUid?.stringValue || '' }, productName: { stringValue: f.productName?.stringValue || '' },
          insiderTarget: { stringValue: zoneId ? `${userId}///${zoneId}` : userId },
          paidAt: { stringValue: new Date().toISOString() }, trxId: { stringValue: trxId || '' }
        }})
      });

      console.log('✅ Callback Insider order dibuat:', merchantRef, '-> tid', tid);
      await awardOrderPoints({ baseUrl, fbApiKey, buyerUid: f.buyerUid?.stringValue || '' });
      await maybePayoutPendingReferral({ baseUrl, fbApiKey, buyerUid: f.buyerUid?.stringValue || '' });
      return res.status(200).json({ received: true, processed: true, fulfillment: 'insider', tid });
    }

    // === Cabang KIRIM STOK (autoPayment) ===
    const allAccounts = (stockFields.accounts?.arrayValue?.values || []).map(v => v.stringValue || '');

    if (allAccounts.length < qty) {
      console.error('Stok tidak cukup:', allAccounts.length, 'butuh:', qty);
      return res.status(200).json({ received: true, processed: false, reason: 'insufficient_stock' });
    }

    // Ambil akun (FIFO)
    const deliveredAccounts = allAccounts.slice(0, qty);
    const remainingAccounts = allAccounts.slice(qty);
    const totalDelivered = parseInt(stockFields.totalDelivered?.integerValue || '0') + qty;

    // Update stok (kurangi)
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

    // Simpan order sebagai selesai
    await fetch(`${orderUrl}&updateMask.fieldPaths=stockDelivered&updateMask.fieldPaths=deliveredAccounts&updateMask.fieldPaths=status&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=buyerUid&updateMask.fieldPaths=productName`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          stockDelivered:   { booleanValue: true },
          deliveredAccounts: { arrayValue: { values: deliveredAccounts.map(a => ({ stringValue: a })) } },
          status:           { stringValue: 'paid' },
          paidAt:           { stringValue: new Date().toISOString() },
          trxId:            { stringValue: trxId || '' },
          productId:        { stringValue: productId },
          variantCode:      { stringValue: variantCode },
          qty:              { integerValue: qty.toString() },
          buyerName: { stringValue: f.buyerName?.stringValue || '' }, buyerUid: { stringValue: f.buyerUid?.stringValue || '' }, productName: { stringValue: f.productName?.stringValue || '' }
        }
      })
    });

    console.log('✅ Order', merchantRef, 'selesai -', qty, 'akun dikirim');
    await awardOrderPoints({ baseUrl, fbApiKey, buyerUid: f.buyerUid?.stringValue || '' });
    await maybePayoutPendingReferral({ baseUrl, fbApiKey, buyerUid: f.buyerUid?.stringValue || '' });
    return res.status(200).json({ received: true, processed: true, accountsDelivered: qty });

  } catch (err) {
    console.error('Callback error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
