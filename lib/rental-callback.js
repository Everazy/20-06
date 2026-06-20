// api/rental-callback.js
// Dipanggil SakuRupiah setelah pembayaran sewa berhasil
// Mengaktifkan listing dan mengatur expiresAt

const FB_BASE = `https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const FB_KEY  = process.env.FIREBASE_API_KEY;

function toFSValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  return { stringValue: String(v) };
}
function toFSFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = toFSValue(v);
  return fields;
}
function fromFSValue(v) {
  if (!v) return null;
  if ('nullValue'    in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return parseInt(v.integerValue);
  if ('doubleValue'  in v) return v.doubleValue;
  if ('stringValue'  in v) return v.stringValue;
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    console.log('rental-callback payload:', JSON.stringify(payload));

    const merchantRef   = payload.merchant_ref || payload.order_id || payload.reference_id;
    const paymentStatus = (payload.payment_status || payload.status || '').toLowerCase();

    const isPaid = ['berhasil','success','paid','settlement'].includes(paymentStatus);
    if (!isPaid) return res.status(200).json({ received: true, processed: false });
    if (!merchantRef) return res.status(200).json({ received: true, processed: false, reason: 'no_merchant_ref' });

    // Cek idempotency
    const doneUrl = `${FB_BASE}/rental_orders/${merchantRef}?key=${FB_KEY}`;
    const doneRes = await fetch(doneUrl);
    if (doneRes.ok) {
      const doneDoc = await doneRes.json();
      if (doneDoc.fields?.activated?.booleanValue === true) {
        console.log('Sudah diproses:', merchantRef);
        return res.status(200).json({ received: true, processed: false, reason: 'already_processed' });
      }
    }

    // Ambil pending order
    const pendingUrl = `${FB_BASE}/pending_rental_orders/${merchantRef}?key=${FB_KEY}`;
    const pendingRes = await fetch(pendingUrl);
    if (!pendingRes.ok) return res.status(200).json({ received: true, processed: false, reason: 'order_not_found' });

    const pendingDoc = await pendingRes.json();
    const f = pendingDoc.fields || {};

    const listingId = fromFSValue(f.listingId);
    const planDays  = parseInt(fromFSValue(f.planDays) || '1');
    const plan      = fromFSValue(f.plan) || 'daily';

    if (!listingId) return res.status(200).json({ received: true, processed: false, reason: 'no_listing_id' });

    // Cek listing ada — kalau sudah aktif, perpanjang dari expiresAt yang ada
    const listingUrl = `${FB_BASE}/rental_listings/${listingId}?key=${FB_KEY}`;
    const listingRes = await fetch(listingUrl);
    if (!listingRes.ok) return res.status(200).json({ received: true, processed: false, reason: 'listing_not_found' });

    const listingDoc   = await listingRes.json();
    const currentExpiry = listingDoc.fields?.expiresAt?.stringValue;
    const now = Date.now();

    // Kalau masih aktif, perpanjang dari waktu expiry saat ini; kalau sudah habis, dari sekarang
    const baseTime = (currentExpiry && new Date(currentExpiry).getTime() > now)
      ? new Date(currentExpiry).getTime()
      : now;

    const newExpiry = new Date(baseTime + planDays * 24 * 60 * 60 * 1000).toISOString();

    // Aktifkan / perpanjang listing
    await fetch(`${listingUrl}&updateMask.fieldPaths=status&updateMask.fieldPaths=expiresAt&updateMask.fieldPaths=activatedAt`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFSFields({
          status: 'active',
          expiresAt: newExpiry,
          activatedAt: new Date().toISOString()
        })
      })
    });

    // Simpan rental_orders sebagai catatan (idempotency guard)
    await fetch(`${FB_BASE}/rental_orders/${merchantRef}?key=${FB_KEY}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: toFSFields({
          orderId: merchantRef,
          listingId,
          plan,
          planDays,
          expiresAt: newExpiry,
          activated: true,
          paidAt: new Date().toISOString()
        })
      })
    });

    console.log(`Listing ${listingId} aktif sampai ${newExpiry}`);
    return res.status(200).json({ received: true, processed: true, listingId, expiresAt: newExpiry });

  } catch (err) {
    console.error('rental-callback error:', err);
    return res.status(500).json({ error: err.message });
  }
}
