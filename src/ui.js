// Small UI helpers shared by every screen.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const naira = v => (v < 0 ? '−' : '') + '₦' + Math.abs(Math.round(v || 0)).toLocaleString('en-NG');
export const num = v => (v === null || v === undefined || v === '') ? '' : Number(v).toLocaleString('en-NG', { maximumFractionDigits: 2 });
export const fmtT = ts => new Date(ts).toLocaleString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtD = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
export const lagosDate = (ts = Date.now()) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
export const yesterday = () => lagosDate(Date.now() - 864e5);
// <input type=datetime-local> value for "now" in Lagos time
export const nowLocalInput = () => {
  const d = new Date(Date.now() + 3600e3);   // Lagos is UTC+1 all year
  return d.toISOString().slice(0, 16);
};
// datetime-local (Lagos) → ISO with offset
export const localInputToIso = v => v ? v + ':00+01:00' : null;

let toastTimer = null;
export function toast(msg, bad) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, bad ? 6000 : 3500);
}

// ----- item line editor -----
// items: [{id,name,category,count_unit,...}]
function itemOptions(items, sel) {
  const cats = {};
  items.forEach(i => (cats[i.category] = cats[i.category] || []).push(i));
  return Object.entries(cats).map(([c, list]) => `<optgroup label="${esc(c)}">${list.map(i =>
    `<option value="${esc(i.id)}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>`).join('');
}
const unitOf = (items, code) => (items.find(i => i.id === code) || {}).count_unit || '';

export function lineRow(items, r = {}, opts = {}) {
  const code = r.code || '';
  const it = items.find(i => i.id === code);
  const sel = opts.blind
    ? `<span class="fixed" data-code="${esc(code)}">${esc(it ? it.name : code)}</span>`
    : `<select aria-label="Item"><option value="">Choose item…</option>${itemOptions(items, code)}</select>`;
  const extra = [];
  if (opts.purchaseUnits) {
    const pu = it && it.purchase_unit;
    extra.push(`<label class="mini"><input type="checkbox" class="in-pu" ${r.inPurchaseUnits ? 'checked' : ''} ${pu ? '' : 'disabled'}> in ${esc(pu || 'bulk units')}</label>`);
    extra.push(`<input type="number" class="price" inputmode="decimal" min="0" step="1" placeholder="Price ₦ each" aria-label="Unit price" value="${r.unitPrice ?? ''}">`);
  }
  if (opts.expiry && it && it.tracks_expiry) extra.push(`<label class="mini">Expiry <input type="date" class="expiry"></label>`);
  return `<div class="line"><div class="line-main">${sel}<input type="number" class="qty" inputmode="decimal" min="0" step="any" aria-label="Quantity" value="${r.qty ?? ''}" placeholder="0"><span class="unit">${esc(unitOf(items, code))}</span>${opts.blind ? '' : '<button type="button" class="x" aria-label="Remove line">×</button>'}</div>${extra.length ? `<div class="line-extra">${extra.join('')}</div>` : ''}</div>`;
}

export function lineEditor(id, items, preset, opts = {}) {
  const rows = preset && preset.length ? preset : [{}];
  return `<div class="lines" id="${id}" data-opts='${esc(JSON.stringify(opts))}'>${rows.map(r => lineRow(items, r, opts)).join('')}</div>
    ${opts.blind ? '' : `<button type="button" class="ghost add-line" data-for="${id}">Add item</button>`}`;
}

// requireAll: every row must have a number (0 allowed) — for blind counts.
export function readLines(id, { requireAll = false, allowZero = false } = {}) {
  const box = document.getElementById(id);
  if (!box) return [];
  const out = [];
  for (const row of box.querySelectorAll('.line')) {
    const code = row.querySelector('select') ? row.querySelector('select').value : row.querySelector('.fixed').dataset.code;
    const raw = row.querySelector('.qty').value;
    if (!code) { if (raw !== '') throw new Error('Choose the item for every line.'); continue; }
    if (raw === '') { if (requireAll) throw new Error('Enter a number for every item (0 if there is none).'); continue; }
    const qty = Number(raw);
    if (!(qty >= 0) || (!allowZero && !requireAll && qty === 0)) continue;
    const l = { code, qty };
    const pu = row.querySelector('.in-pu'); if (pu && pu.checked) l.inPurchaseUnits = true;
    const pr = row.querySelector('.price'); if (pr && pr.value !== '') l.unitPrice = Number(pr.value);
    const ex = row.querySelector('.expiry'); if (ex && ex.value) l.expiry = ex.value;
    out.push(l);
  }
  return out;
}

export function wireLineEditors(items) {
  document.addEventListener('click', ev => {
    const t = ev.target.closest('button'); if (!t) return;
    if (t.classList.contains('add-line')) {
      const box = document.getElementById(t.dataset.for);
      const opts = JSON.parse(box.dataset.opts || '{}');
      box.insertAdjacentHTML('beforeend', lineRow(items(), {}, opts));
    }
    if (t.classList.contains('x')) {
      const line = t.closest('.line'); const box = line.parentElement;
      if (box.children.length > 1) line.remove(); else line.querySelector('.qty').value = '';
    }
  });
  document.addEventListener('change', ev => {
    const s = ev.target;
    if (s.tagName === 'SELECT' && s.closest('.line')) {
      const box = s.closest('.lines'); const opts = JSON.parse(box.dataset.opts || '{}');
      const line = s.closest('.line'); const qty = line.querySelector('.qty').value;
      line.outerHTML = lineRow(items(), { code: s.value, qty }, opts);
    }
  });
}

export const staffSelect = (id, staff, { roles, exclude, label, branch } = {}) => {
  let list = staff.filter(s => !exclude || s.id !== exclude);
  if (roles) list = list.filter(s => s.roles.some(r => roles.includes(r)));
  if (branch) list.sort((a, b) => (b.branch_id === branch) - (a.branch_id === branch));
  return `<label>${esc(label || 'Person')}<select id="${id}"><option value="">Choose…</option>${list.map(s =>
    `<option value="${s.id}">${esc(s.full_name)}</option>`).join('')}</select></label>`;
};

export const photoField = (id, label, required) =>
  `<label>${esc(label)}${required ? '' : ' <small>(optional)</small>'}<input type="file" id="${id}" accept="image/*" capture="environment"></label>`;

export const paperFields = (pfx) => `<div class="paper"><label>Paper book page<input id="${pfx}-page" placeholder="e.g. 14"></label>
  <label>Date and time written on the paper<input type="datetime-local" id="${pfx}-when"></label></div>`;

export function downloadCsv(name, rows) {
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));   // BOM so Excel reads names correctly
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
