# Fitur Sewa Tempat Jualan — File yang Perlu Diupdate

## File Baru (upload ke project):
- `api/rental-listing.js`   → CRUD listing
- `api/rental-payment.js`   → Buat invoice sewa via SakuRupiah
- `api/rental-callback.js`  → Webhook aktivasi listing setelah bayar
- `sewa.html`               → Halaman marketplace

## File yang Diupdate:
- `index.html`                        → Tambah tombol "Sewa Tempat Jualan"
- `assets/partials/main-home.html`    → Sama (untuk build system)

## Firestore Rules — Tambahkan rules ini:
```
// Rental listings — publik baca, login untuk write
match /rental_listings/{doc} {
  allow read: if true;
  allow write: if request.auth != null && request.auth.uid == resource.data.sellerUid
               || request.auth != null && !exists(/databases/$(database)/documents/rental_listings/$(doc));
}
// Pending rental orders & rental orders — hanya server
match /pending_rental_orders/{doc} { allow read, write: if false; }
match /rental_orders/{doc}          { allow read, write: if false; }
```

## Update callback_url di SakuRupiah Dashboard:
Tambahkan juga: `https://everastore.biz.id/api/rental-callback`

## Cara Kerja:
1. User login Google → buka /sewa.html
2. Tab "Listing Saya" → Buat Listing Baru → isi form
3. Pilih paket (Harian Rp2.000 / Mingguan Rp10.000) → masukkan nomor HP
4. Bayar via SakuRupiah QRIS
5. Callback otomatis aktifkan listing → tampil di marketplace
6. Pembeli bisa lihat listing → hubungi penjual langsung
