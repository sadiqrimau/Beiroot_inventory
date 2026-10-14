// Screens for staff roles. Every read and write goes through a secure database function,
// so staff never see expected quantities, other people's data or money totals.
import { rpc, uploadPhoto } from './api.js';
import { $, esc, num, fmtT, toast, lineEditor, readLines, staffSelect, photoField, paperFields,
  nowLocalInput, localInputToIso, lagosDate, yesterday, fmtD } from './ui.js';

const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const file = id => { const f = $('#' + id); return f && f.files && f.files[0]; };
const val = id => ($('#' + id) || {}).value?.trim?.() ?? '';
const paperArgs = (S, pfx) => {
  if (!S.paper) return { p_occurred: null, p_paper_page: null };
  const page = val(pfx + '-page'), when = val(pfx + '-when');
  need(page, 'Enter the paper book page number.');
  need(when, 'Enter the date and time written on the paper.');
  return { p_occurred: localInputToIso(when), p_paper_page: page };
};
const paperToggle = S => `<label class="check paper-toggle"><input type="checkbox" data-toggle="paper" ${S.paper ? 'checked' : ''}> Typing in entries from the paper book</label>`;
const branchesOf = S => S.locations.filter(l => l.kind === 'branch' && l.active);

function writeOffCard(S, loc, title) {
  return `<details class="card"><summary>${esc(title)}</summary>
    <p class="lede">Record spoiled or damaged stock. A second person must witness it, and a photo is required.</p>
    ${lineEditor('wo-lines', S.items)}
    <label>When it happened or was found<input type="datetime-local" id="wo-when" value="${nowLocalInput()}"></label>
    <label>Reason<input id="wo-reason" placeholder="e.g. tomatoes rotten, pack torn"></label>
    ${staffSelect('wo-witness', S.staff, { exclude: S.me.id, label: 'Witness (who saw it)' })}
    ${photoField('wo-photo', 'Photo of the spoiled stock', true)}
    <button class="primary" data-act="writeoff" data-loc="${esc(loc)}">Record write-off</button></details>`;
}
async function doWriteOff(S, btn) {
  const lines = readLines('wo-lines');
  need(lines.length, 'Add the items and quantities.');
  need(val('wo-when'), 'Give the date and time it happened.');
  need(val('wo-reason'), 'Give the reason.');
  need(val('wo-witness'), 'Choose the witness.');
  need(file('wo-photo'), 'Add a photo.');
  const photo = await uploadPhoto(file('wo-photo'), S.me.id);
  await rpc('record_write_off', { p_loc: btn.dataset.loc, p_occurred: localInputToIso(val('wo-when')), p_lines: lines,
    p_reason: val('wo-reason'), p_witness: val('wo-witness'), p_photo: photo });
  toast('Write-off recorded.');
}

// ---------------- Storekeeper ----------------
const store = {
  id: 'store', label: 'Store', roles: ['storekeeper'],
  async load() {
    const [status, purchases, requests] = await Promise.all([rpc('store_status'), rpc('pending_purchases'), rpc('open_requests')]);
    return { status, purchases, requests };
  },
  view(S, d) {
    const st = d.status;
    const session = st.open
      ? `<div class="card open"><h3>Store is open</h3><p>Opened ${fmtT(st.openedAt)} for “${esc(st.reason)}”. Present: ${esc((st.present || []).join(', '))}.</p>
         <button class="primary" data-act="close">Close and lock the store</button></div>`
      : `<div class="card"><h3>Store is locked</h3>
         <label>Reason for opening<input id="op-reason" placeholder="Morning dispatch, delivery, kitchen issue…"></label>
         <label>Who else is present<input id="op-present" placeholder="Names, separated by commas"></label>
         <button class="primary" data-act="open">Open store</button></div>`;
    const grn = d.purchases.length ? d.purchases.map(p => `<div class="card"><h3>${esc(p.poId)} <small>from ${esc(p.supplier || 'supplier')}, bought by ${esc(p.buyer)}</small></h3>
        <p class="lede">Count what actually arrived. The purchase quantities are hidden on purpose.</p>
        ${lineEditor('grn-' + p.poId, S.items, (p.items || []).map(i => ({ code: i.code })), { blind: true, expiry: true })}
        ${photoField('grn-ph-' + p.poId, 'Photo of the goods received', !S.paper)}
        ${S.paper ? paperFields('grn-' + p.poId) : ''}
        <button class="primary" data-act="grn" data-po="${esc(p.poId)}">Confirm goods received</button></div>`).join('')
      : '<p class="empty">No purchases waiting to be received.</p>';
    const drivers = S.staff.filter(s => s.roles.includes('driver'));
    const reqs = d.requests.length ? d.requests.map(q => `<div class="card"><h3>${esc(q.reqId)} · ${esc(q.destName)} <small>${esc(q.kind)}, raised by ${esc(q.by)} ${fmtT(q.at)}</small></h3>
        ${lineEditor('rel-' + q.reqId, S.items, q.lines)}
        ${q.dest === 'kitchen' ? `<p class="lede">Handed to ${esc(q.by)} in the kitchen.</p>`
          : `<label>Driver carrying it<select id="rel-drv-${esc(q.reqId)}"><option value="">Choose…</option>${drivers.filter(x => x.id !== q.byId).map(x => `<option value="${x.id}">${esc(x.full_name)}</option>`).join('')}</select></label>`}
        ${photoField('rel-ph-' + q.reqId, 'Photo of the stock being released', !S.paper)}
        ${S.paper ? paperFields('rel-' + q.reqId) : ''}
        <button class="primary" data-act="release" data-req="${esc(q.reqId)}" data-dest="${esc(q.dest)}">Release stock</button></div>`).join('')
      : '<p class="empty">No open requests.</p>';
    return `<section>${session}${paperToggle(S)}
      <h2>Deliveries to receive</h2>${grn}
      <h2>Requests to release</h2>${reqs}
      <details class="card"><summary>Emergency release without a request</summary>
        <p class="lede">Only when it truly cannot wait. Every emergency release goes on the admin's review list.</p>
        <label>Branch<select id="em-dest">${branchesOf(S).map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select></label>
        <label>Why it could not wait<input id="em-reason"></label>
        ${staffSelect('em-driver', S.staff, { roles: ['driver'], label: 'Driver' })}
        ${lineEditor('em-lines', S.items)}
        ${photoField('em-photo', 'Photo of the stock being released', true)}
        <button class="danger" data-act="emergency">Release as emergency</button></details>
      ${writeOffCard(S, 'store', 'Write off spoiled or damaged stock')}</section>`;
  },
  act: {
    async open(S) { need(val('op-reason'), 'Give a reason for opening the store.');
      await rpc('store_open', { p_reason: val('op-reason'), p_present: val('op-present').split(',').map(s => s.trim()).filter(Boolean) });
      toast('Store opened and logged.'); },
    async close() { await rpc('store_close'); toast('Store closed.'); },
    async grn(S, b) { const po = b.dataset.po; const lines = readLines('grn-' + po, { requireAll: true });
      const pa = paperArgs(S, 'grn-' + po), f = file('grn-ph-' + po);
      need(S.paper || S.data.store?.status?.open, 'Open the store first.');
      if (!S.paper) need(f, 'Add a photo of the goods received.');
      const photo = f ? await uploadPhoto(f, S.me.id) : null;
      await rpc('confirm_grn', { p_po: po, p_lines: lines, ...pa, p_photo: photo }); toast(po + ' received.'); },
    async release(S, b) { const rq = b.dataset.req; const lines = readLines('rel-' + rq); need(lines.length, 'Nothing to release.');
      let carrier = null;
      if (b.dataset.dest !== 'kitchen') { carrier = val('rel-drv-' + rq); need(carrier, 'Choose the driver.'); }
      const pa = paperArgs(S, 'rel-' + rq), f = file('rel-ph-' + rq);
      need(S.paper || S.data.store?.status?.open, 'Open the store first.');
      if (!S.paper) need(f, 'Add a photo of the stock being released.');
      const photo = f ? await uploadPhoto(f, S.me.id) : null;
      const mv = await rpc('release_stock', { p_req: rq, p_lines: lines, p_carrier: carrier, ...pa, p_photo: photo });
      toast(`Released as ${mv}. Write ${mv} in the paper book.`); },
    async emergency() { const lines = readLines('em-lines'); need(lines.length, 'Add the items.');
      need(val('em-reason'), 'Give the reason.'); need(val('em-driver'), 'Choose the driver.'); need(file('em-photo'), 'Add a photo of the stock being released.');
      const photo = await uploadPhoto(file('em-photo'), S.me.id);
      const mv = await rpc('emergency_release', { p_dest: val('em-dest'), p_reason: val('em-reason'), p_lines: lines, p_carrier: val('em-driver'), p_photo: photo });
      toast(`Emergency release ${mv} logged for the admin's review.`); },
    writeoff: doWriteOff,
  },
};

// ---------------- Procurement officer ----------------
const buy = {
  id: 'buy', label: 'Purchases', roles: ['buyer'],
  async load() { const [mine, low] = await Promise.all([rpc('my_purchases'), rpc('low_stock')]); return { mine, low }; },
  view(S, d) {
    const raw = S.items.filter(i => i.kind === 'raw');
    const low = d.low || [];
    const lowCard = low.length ? `<div class="card low"><h3>Low stock in the store <span class="tag bad">${low.length}</span></h3>
      <p class="lede">These items are at or below the level the admin set for reordering. Check with the storekeeper how much to buy.</p>
      <ul class="plain">${low.map(i => `<li><b>${esc(i.name)}</b> <small>${esc(i.category)} · reorder at ${num(i.reorderLevel)} ${esc(i.unit || '')}</small>
        ${i.ordered ? '<span class="tag ok">Bought, waiting for the storekeeper</span>' : ''}</li>`).join('')}</ul></div>`
      : `<p class="done">No items are low in the store.</p>`;
    return `<section>${lowCard}<div class="card"><h3>Log a purchase</h3>
      <label>Supplier<input id="po-supplier"></label>
      ${lineEditor('po-lines', raw, null, { purchaseUnits: true })}
      ${photoField('po-invoice', 'Photo of the invoice or receipt', false)}
      ${paperToggle(S)}${S.paper ? paperFields('po') : ''}
      <button class="primary" data-act="purchase">Log purchase</button></div>
      <h2>My purchases (last 30 days)</h2>
      <ul class="plain">${d.mine.map(p => `<li><b>${esc(p.poId)}</b> ${esc(p.supplier || '')} · ${fmtT(p.at)} ·
        ${p.received ? '<span class="tag ok">Received</span>' : '<span class="tag">Waiting for storekeeper</span>'}
        <br><small>${esc((p.items || []).join(', '))}</small></li>`).join('') || '<li class="empty">No purchases yet.</li>'}</ul></section>`;
  },
  act: {
    async purchase(S) { const lines = readLines('po-lines'); need(lines.length, 'Add at least one item with a quantity.');
      const inv = file('po-invoice') ? await uploadPhoto(file('po-invoice'), S.me.id) : null;
      const po = await rpc('log_purchase', { p_supplier: val('po-supplier'), p_lines: lines, p_invoice_photo: inv, ...paperArgs(S, 'po') });
      toast(`Logged as ${po}. The storekeeper confirms what arrives.`); },
  },
};

// ---------------- Driver ----------------
const runs = {
  id: 'runs', label: 'My runs', roles: ['driver'],
  async load() { return { runs: await rpc('my_runs') }; },
  view(S, d) {
    return `<section><h2>My runs</h2><p class="lede">The branch confirms what arrived. You can see your runs but not confirm them.</p>
      <ul class="plain">${d.runs.map(r => `<li><b>${esc(r.movId)}</b> to ${esc(r.dest)} · ${fmtT(r.at)} ·
        ${r.received ? '<span class="tag ok">Received</span>' : '<span class="tag">On the road</span>'}
        <br><small>${(r.lines || []).map(l => `${num(l.qty)} ${esc(l.unit || '')} ${esc(l.name)}`).join(', ')}</small></li>`).join('')
        || '<li class="empty">No runs in the last two weeks.</li>'}</ul></section>`;
  },
  act: {},
};

// ---------------- Central kitchen cook ----------------
const kitchen = {
  id: 'kitchen', label: 'Kitchen', roles: ['cook'],
  async load() { return { issues: await rpc('kitchen_open_issues') }; },
  view(S, d) {
    const raw = S.items.filter(i => i.kind === 'raw'), prepared = S.items.filter(i => i.kind === 'prepared');
    return `<section><div class="card"><h3>Request ingredients from the store</h3>${lineEditor('kr-lines', raw)}
      <button class="primary" data-act="kreq">Send request</button></div>
      <h2>Report yield</h2>${d.issues.length ? d.issues.map(r => `<div class="card"><h3>${esc(r.movId)} <small>issued ${fmtT(r.at)}</small></h3>
        <p class="lede">What went in</p>${lineEditor('yi-' + r.movId, raw, r.lines)}
        <p class="lede">What came out</p>${lineEditor('yo-' + r.movId, prepared)}
        <button class="primary" data-act="yield" data-mov="${esc(r.movId)}">Report yield</button></div>`).join('')
        : '<p class="empty">No ingredients waiting for a yield report.</p>'}
      ${writeOffCard(S, 'kitchen', 'Write off spoiled stock in the kitchen')}</section>`;
  },
  act: {
    async kreq() { const lines = readLines('kr-lines'); need(lines.length, 'Add the items.');
      const rq = await rpc('raise_request', { p_kind: 'production', p_lines: lines }); toast(`Request ${rq} sent to the store.`); },
    async yield(S, b) { const m = b.dataset.mov; const outputs = readLines('yo-' + m); need(outputs.length, 'Enter what came out.');
      const bt = await rpc('report_yield', { p_issue_ids: [m], p_inputs: readLines('yi-' + m, { allowZero: true }), p_outputs: outputs });
      toast(`Yield reported as ${bt}.`); },
    writeoff: doWriteOff,
  },
};

// ---------------- Branch manager ----------------
const branch = {
  id: 'branch', label: 'Branch', roles: ['branch_manager'],
  async load() { return { incoming: await rpc('incoming_deliveries') }; },
  view(S, d) {
    const inc = d.incoming.length ? d.incoming.map(t => `<div class="card open"><h3>Delivery ${esc(t.movId)} <small>with ${esc(t.carrier)}${t.emergency ? ' · emergency' : ''}</small></h3>
        <p class="lede">Count it at the door with the driver present. The quantities sent are hidden on purpose. Both of you sign the delivery book.</p>
        ${lineEditor('rc-' + t.movId, S.items, (t.items || []).map(i => ({ code: i.code })), { blind: true })}
        <label>Note<input id="rc-note-${esc(t.movId)}" placeholder="Damage, anything odd"></label>
        ${photoField('rc-photo-' + t.movId, 'Photo of the crates', !S.paper)}
        ${S.paper ? paperFields('rc-' + t.movId) : ''}
        <button class="primary" data-act="receive" data-mov="${esc(t.movId)}">Confirm received</button></div>`).join('')
      : '<p class="empty">No deliveries on the way.</p>';
    return `<section><h2>${esc(S.me.branch_name || 'Branch')}</h2>${paperToggle(S)}
      <h2>Incoming deliveries</h2>${inc}
      <div class="card"><h3>Request stock</h3>
        <label>Type<select id="br-kind"><option value="planned">Planned delivery</option><option value="topup">Top-up (urgent)</option></select></label>
        ${lineEditor('br-lines', S.items)}<button class="primary" data-act="breq">Send request</button></div>
      ${writeOffCard(S, S.me.branch_id, 'Write off spoiled stock at the branch')}</section>`;
  },
  act: {
    async receive(S, b) { const m = b.dataset.mov; const lines = readLines('rc-' + m, { requireAll: true });
      const f = file('rc-photo-' + m); if (!S.paper) need(f, 'Take a photo of the crates.');
      const photo = f ? await uploadPhoto(f, S.me.id) : null;
      await rpc('confirm_receipt', { p_mov: m, p_lines: lines, p_note: val('rc-note-' + m) || null, p_photo: photo, ...paperArgs(S, 'rc-' + m) });
      toast('Delivery confirmed.'); },
    async breq() { const lines = readLines('br-lines'); need(lines.length, 'Add the items.');
      const rq = await rpc('raise_request', { p_kind: val('br-kind'), p_lines: lines }); toast(`Request ${rq} sent to the store.`); },
    writeoff: doWriteOff,
  },
};

// ---------------- Kitchen lead (branch) ----------------
const kcount = {
  id: 'kcount', label: "Tonight's count", roles: ['kitchen_lead'],
  async load() { return { subs: await rpc('my_submissions') }; },
  view(S, d) {
    if (d.subs.kitchenCount) return `<section><h2>Tonight's count</h2><p class="done">Tonight's count is submitted. Thank you.</p></section>`;
    const daily = S.items.filter(i => i.count_frequency === 'daily');
    return `<section><h2>Tonight's count</h2><p class="lede">Count what is left in the kitchen right now and enter every item. Put 0 if there is none.</p>
      ${lineEditor('kc-daily', S.items, daily.map(i => ({ code: i.id })), { blind: true })}
      <details class="card"><summary>Other items</summary>${lineEditor('kc-other', S.items)}</details>
      <button class="primary" data-act="kcount">Submit count</button></section>`;
  },
  act: {
    async kcount(S) { const lines = readLines('kc-daily', { requireAll: true }).concat(readLines('kc-other', { allowZero: true }));
      const seen = new Set(); lines.forEach(l => { need(!seen.has(l.code), 'An item is listed twice.'); seen.add(l.code); });
      await rpc('submit_count', { p_loc: S.me.branch_id, p_lines: lines }); toast('Count submitted.'); },
  },
};

// ---------------- Cashier ----------------
const MONEY = [['cash', 'Cash (counted)', ''], ['transfer', 'Transfer (Moniepoint)', ''], ['card', 'Card / POS (Moniepoint)', ''],
  ['chowdeck', 'Chowdeck', 'full order value'], ['app', 'App', 'full order value']];
const rowHtml = (cls, fields) => `<div class="fee ${cls}">${fields}<button type="button" class="x" data-act="rmrow" aria-label="Remove">×</button></div>`;
const cash = {
  id: 'cash', label: 'End of day', roles: ['cashier'],
  async load() {
    const [t, y] = await Promise.all([rpc('my_submissions', { p_date: lagosDate() }), rpc('my_submissions', { p_date: yesterday() })]);
    return { t, y };
  },
  view(S, d) {
    const days = [[lagosDate(), 'Today, ' + fmtD(lagosDate()), d.t], [yesterday(), 'Yesterday, ' + fmtD(yesterday()), d.y]];
    const needMoney = days.filter(([, , x]) => !x.cashEod);
    const auto = d.t.aroniumAuto;
    const needAron = auto ? [] : days.filter(([, , x]) => x.cashEod && !x.aroniumTotal);
    if (auto && d.t.cashEod) return `<section><h2>End of day · ${esc(S.me.branch_name || '')}</h2><p class="done">Today's money received is saved. Thank you.</p>
      <p class="lede">Remember to close the register in Aronium. Its report is sent to the admin automatically; there is nothing to print.
      ${d.t.aroniumTotal ? '<br><span class="tag ok">Aronium report received</span>' : ''}</p></section>`;
    if (!needAron.length && d.t.cashEod) return `<section><h2>End of day · ${esc(S.me.branch_name || '')}</h2><p class="done">Today's end of day is complete. Thank you.</p></section>`;
    // Step 2 comes first on screen when step 1 is done for a day.
    if (needAron.length) return `<section><h2>End of day · ${esc(S.me.branch_name || '')}</h2>
      <p class="done">Step 1 done: the money received is saved.</p>
      <div class="card"><h3>Step 2 of 2: Aronium total</h3>
        <p class="lede">Now print or open the Aronium end-of-day report. Enter its total sales and take a photo of it.</p>
        <label>Date<select id="ar-date">${needAron.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label>Aronium total sales (₦)<input type="number" inputmode="decimal" min="0" id="ar-total"></label>
        ${photoField('ar-photo', 'Photo of the Aronium report', true)}
        <button class="primary" data-act="aronium">Submit Aronium total</button></div></section>`;
    return `<section><h2>End of day · ${esc(S.me.branch_name || '')}</h2>
      <div class="card"><h3>${auto ? 'Money received' : 'Step 1 of 2: money received'}</h3>
      <p class="lede">Count the cash with the branch manager watching. Enter each amount and add its photo or screenshot. You can't change it after submitting. ${auto
        ? 'Close the register in Aronium as usual: its report goes to the admin automatically, with no printing.' : 'You enter the Aronium total after this.'}</p>
      <label>Date<select id="ce-date">${needMoney.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label></div>
      ${MONEY.map(([k, l, hint]) => `<div class="card money"><label>${esc(l)} (₦)${hint ? ` <small>${esc(hint)}</small>` : ''}<input type="number" inputmode="decimal" min="0" id="ce-${k}" placeholder="0"></label>
        ${photoField('ce-ph-' + k, k === 'cash' ? 'Photo of the counted cash' : 'Screenshot (needed if the amount is more than 0)', true)}</div>`).join('')}
      ${staffSelect('ce-witness', S.staff, { exclude: S.me.id, roles: ['branch_manager', 'owner', 'admin'], label: 'Who watched the cash count', branch: S.me.branch_id })}
      <div class="card"><h3>Delivery fees</h3><p class="lede">One line per delivery order: the order number, the fee the customer paid, and how they paid it.</p>
        <div id="ce-fees"></div><button type="button" class="ghost" data-act="addfee">Add delivery</button></div>
      <div class="card"><h3>Refunds</h3><p class="lede">Money given back to a customer today: the order number, the amount and why. The admin is alerted for every refund.</p>
        <div id="ce-refunds"></div><button type="button" class="ghost" data-act="addrefund">Add refund</button></div>
      <label>Note for the admin <small>anything unusual today</small><textarea id="ce-note" rows="3" placeholder="e.g. POS was down for an hour, a customer paid the next day…"></textarea></label>
      <button class="primary" data-act="cashEod">Submit money received</button></section>`;
  },
  act: {
    addfee() { $('#ce-fees').insertAdjacentHTML('beforeend', rowHtml('', `<input placeholder="Order no." class="fee-ref"><input type="number" inputmode="decimal" min="0" placeholder="₦" class="fee-amt">
      <select class="fee-how" aria-label="Paid by"><option value="">Paid by…</option>${MONEY.map(([k, l]) => `<option value="${k}">${esc(l.replace(/ \(.*\)/, ''))}</option>`).join('')}</select>`)); return 'stay'; },
    addrefund() { $('#ce-refunds').insertAdjacentHTML('beforeend', rowHtml('refund', `<input placeholder="Order no." class="rf-ref"><input type="number" inputmode="decimal" min="0" placeholder="₦" class="rf-amt"><input placeholder="Reason" class="rf-why">`)); return 'stay'; },
    rmrow(S, b) { b.closest('.fee').remove(); return 'stay'; },
    rmfee(S, b) { b.closest('.fee').remove(); return 'stay'; },
    async cashEod(S) {
      const amt = {}; MONEY.forEach(([k]) => { amt[k] = Number(val('ce-' + k) || 0); need(amt[k] >= 0, 'Amounts cannot be negative.'); });
      need(val('ce-cash') !== '', 'Enter the cash amount (0 if none).');
      need(val('ce-witness'), 'Choose who watched the cash count.');
      const fees = [...document.querySelectorAll('#ce-fees .fee')].map(f => ({ ref: f.querySelector('.fee-ref').value.trim(), amount: Number(f.querySelector('.fee-amt').value || 0), method: f.querySelector('.fee-how').value || null })).filter(f => f.ref || f.amount);
      fees.forEach(f => { need(f.amount > 0, 'Each delivery needs its fee.'); need(f.method, 'Choose how each delivery fee was paid.'); });
      const refunds = [...document.querySelectorAll('#ce-refunds .fee')].map(f => ({ ref: f.querySelector('.rf-ref').value.trim(), amount: Number(f.querySelector('.rf-amt').value || 0), reason: f.querySelector('.rf-why').value.trim() })).filter(f => f.ref || f.amount || f.reason);
      refunds.forEach(f => { need(f.amount > 0, 'Each refund needs its amount.'); need(f.reason, 'Each refund needs a reason.'); });
      const photos = {};
      for (const [k] of MONEY) {
        const f = file('ce-ph-' + k);
        if (k === 'cash') need(f, 'Add the photo of the counted cash.');
        else if (amt[k] > 0) need(f, `Add the screenshot for ${k === 'app' ? 'the app' : k}.`);
        if (f) photos[k] = await uploadPhoto(f, S.me.id);
      }
      await rpc('submit_cash_eod', { p_date: val('ce-date'), p_cash: amt.cash, p_transfer: amt.transfer, p_card: amt.card,
        p_chowdeck: amt.chowdeck, p_app: amt.app, p_delivery_fees: fees, p_witness: val('ce-witness'), p_photos: photos,
        p_note: val('ce-note') || null, p_refunds: refunds });
      toast((await rpc('my_submissions')).aroniumAuto ? 'Money received saved. Close the register in Aronium as usual.' : 'Money received saved. Now enter the Aronium total.');
    },
    async aronium(S) {
      need(val('ar-total') !== '', 'Enter the Aronium total.'); need(file('ar-photo'), 'Add a photo of the Aronium report.');
      const photo = await uploadPhoto(file('ar-photo'), S.me.id);
      await rpc('submit_aronium_total', { p_date: val('ar-date'), p_total: Number(val('ar-total')), p_photo: photo });
      toast('Aronium total submitted. End of day complete.');
    },
  },
};

// ---------------- Blind count (owner, admin, counter) ----------------
export const countTab = {
  id: 'count', label: 'Blind count', roles: ['owner', 'admin', 'counter'],
  async load() { return {}; },
  view(S) {
    const loc = S.countLoc || 'store';
    const list = S.items.filter(i => i.count_frequency === 'daily' || S.countAll);
    return `<section><h2>Blind count</h2><p class="lede">Count what is physically there. Expected figures stay hidden; the admin sees the gaps afterwards. Leave an item blank if you did not count it.</p>
      <label>Location<select id="ct-loc" data-change="countLoc">${S.locations.filter(l => l.active).map(l => `<option value="${esc(l.id)}" ${l.id === loc ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" data-toggle="countAll" ${S.countAll ? 'checked' : ''}> Include weekly items</label>
      ${lineEditor('ct-lines', S.items, list.map(i => ({ code: i.id })), { blind: true })}
      <button class="primary" data-act="count">Submit count</button></section>`;
  },
  act: {
    async count(S) { const lines = readLines('ct-lines', { allowZero: true }); need(lines.length, 'Enter at least one counted item.');
      const r = await rpc('submit_count', { p_loc: val('ct-loc'), p_lines: lines });
      toast(r.held ? 'Count held: you look after this stock, so someone else must count it.' : 'Count saved. The admin will see any gaps.'); },
  },
};

export const STAFF_TABS = [store, buy, runs, kitchen, branch, kcount, cash];
