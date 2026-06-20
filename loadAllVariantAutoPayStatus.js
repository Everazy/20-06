// Tambahkan fungsi ini ke assets/store.js
// Letakkan sebelum baris: initHeroBanner();

async function loadAllVariantAutoPayStatus(pid) {
    const token = getAdminToken();
    if (!token) return;

    const rows = document.querySelectorAll('.item-row');
    for (const row of rows) {
        try {
            const fullCode = getVariantFullCodeFromRow(row);
            if (!fullCode) continue;

            const res = await fetch(
                `/api/manage-stock?productId=${encodeURIComponent(pid)}&variantCode=${encodeURIComponent(fullCode)}`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            const data = await res.json();

            // Update tombol autopay
            const btn = row.querySelector('.v-autopay-btn');
            const label = row.querySelector('.v-autopay-label');
            if (btn && label) {
                if (data.autoPayment === true) {
                    btn.classList.remove('bg-slate-100', 'text-slate-400', 'border-slate-200');
                    btn.classList.add('bg-violet-100', 'text-violet-600', 'border-violet-200');
                    label.textContent = 'ON';
                } else {
                    btn.classList.remove('bg-violet-100', 'text-violet-600', 'border-violet-200');
                    btn.classList.add('bg-slate-100', 'text-slate-400', 'border-slate-200');
                    label.textContent = 'OFF';
                }
            }

            // Update insider toggle jika kategori topup
            if (currentEditId && currentEditId.cat === 'topup') {
                const panel = row.querySelector('.v-stock-panel');
                if (!panel) continue;
                const insiderSection = panel.querySelector('.v-insider-section');
                if (insiderSection) insiderSection.classList.remove('hidden');
                const toggleBtn = panel.querySelector('.v-insider-toggle');
                const skuVal = panel.querySelector('.v-insider-sku-value');
                if (toggleBtn) {
                    if (data.insiderAuto) {
                        toggleBtn.textContent = 'ON';
                        toggleBtn.classList.remove('bg-slate-100', 'text-slate-400', 'border-slate-200');
                        toggleBtn.classList.add('bg-violet-100', 'text-violet-600', 'border-violet-200');
                    } else {
                        toggleBtn.textContent = 'OFF';
                    }
                }
                if (skuVal) skuVal.textContent = data.insiderSku || '—';
            }
        } catch (e) {
            console.warn('loadAllVariantAutoPayStatus error:', e);
        }
    }
}
