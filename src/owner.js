// Owner and admin screens: everything is computed from the full ledger by the shared rules engine.
import { sb, rpc, loadOwnerData, toEngineEvent, staffApi, photoUrl, cleanError, newDeviceKey, normName } from './api.js';
import * as Rep from './reports.js';
import { $, esc, naira, num, fmtT, fmtD, toast, lineEditor, readLines, lagosDate, yesterday, downloadCsv } from './ui.js';

const need = (c, m) => { if (!c) throw new Error(m); };
const val = id => ($('#' + id) || {}).value?.trim?.() ?? '';
const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', storekeeper: 'Storekeeper', buyer: 'Procurement officer', driver: 'Driver',
  cook: 'Central kitchen cook', branch_manager: 'Branch manager', kitchen_lead: 'Kitchen lead', cashier: 'Cashier', counter: 'Counter' };
const BRANCH_ROLES = ['branch_manager', 'kitchen_lead', 'cashier'];
const EV_LABEL = { PURCHASE: 'Purchase logged', GRN: 'Goods received', REQUEST: 'Request', RELEASE: 'Released', RECEIPT: 'Received at branch',
  YIELD: 'Yield reported', WASTE: 'Write-off', COUNT: 'Blind count', KITCHEN_COUNT: 'Kitchen count', STORE_OPEN: 'Store opened',
  STORE_CLOSE: 'Store closed', CORRECTION: 'Correction', CASH_EOD: 'Money end of day', ARONIUM_TOTAL: 'Aronium total', USE: 'Usage',
  ARONIUM_ZREPORT: 'Aronium report (automatic)', SYNC_ALERT: 'Aronium report sent again, changed' };
const SRC_LABEL = { cash: 'Cash', transfer: 'Transfer', card: 'Card / POS', chowdeck: 'Chowdeck', app: 'App', other: 'Other' };

let cache = null, cacheAt = 0;
export async function ownerData(force) {
  if (!force && cache && Date.now() - cacheAt < 20000) return cache;
  const raw = await loadOwnerData();
  const ctx = Rep.buildContext(raw, toEngineEvent);
  const R = Rep.run(ctx);
  const alerts = R.alerts.concat(Rep.extraAlerts(ctx, Date.now(), R)).sort((a, b) => b.ts - a.ts);
  cache = { raw, ctx, R, alerts }; cacheAt = Date.now();
  return cache;
}
export const invalidate = () => { cache = null; };

const iname = (ctx, c) => ctx.items[c]?.name || c;
const iunit = (ctx, c) => ctx.items[c]?.unit || '';
const sevDot = s => `<span class="sev sev-${s}" aria-label="${s} priority"></span>`;
const alertList = arr => arr.length ? `<ul class="alerts">${arr.map(a => `<li>${sevDot(a.sev)}<div><b>${esc(a.title)}</b><span>${esc(a.detail)}</span>
  <small>${fmtT(a.ts)}${a.accountable ? ' · check with ' + esc(a.accountable) : ''}</small></div>${a.value ? `<em>${naira(a.value)}</em>` : ''}</li>`).join('')}</ul>`
  : '<p class="empty">Nothing here.</p>';
const photoBtn = (path, label = 'Photo') => path ? `<button class="ghost" data-act="photo" data-path="${esc(path)}">${esc(label)}</button>` : '';

// ---------------- Today ----------------
const today = {
  id: 'today', label: 'Today', roles: ['owner', 'admin'],
  load: () => ownerData(),
  view(S, d) {
    const hi = d.alerts.filter(a => a.sev === 'high');
    const atRisk = hi.reduce((s, a) => s + (a.value || 0), 0);
    const t = lagosDate(), y = yesterday();
    const miss = Rep.missing(d.ctx, t);
    const moneyRow = br => [y, t].map(day => { const m = Rep.money(d.ctx, br.id, day);
      if (!m) return `<td><span class="tag">Not in</span></td>`;
      if (m.diff === null) return `<td><span class="tag">Waiting for ${m.cash ? 'Aronium' : 'cashier'}</span>${m.missingDocs ? ' <span class="tag bad">receipts missing</span>' : ''}</td>`;
      return `<td><span class="tag ${m.status === 'negative' && m.beyond ? 'bad' : m.beyond ? 'warn' : 'ok'}">${m.diff > 0 ? '+' : ''}${naira(m.diff)}</span>${m.missingDocs ? ' <span class="tag bad">receipts missing</span>' : ''}</td>`; }).join('');
    const syncCell = br => { const ds = d.ctx.devices.filter(x => x.branch_id === br.id && x.active);
      if (!ds.length) return '<span class="tag">Entered by cashier</span>';
      return ds.map(x => { const seen = x.last_seen_at ? Date.parse(x.last_seen_at) : 0, ok = seen && Date.now() - seen < 3 * 3600e3 && !(x.last_status || {}).error;
        return `<span class="tag ${ok ? 'ok' : 'warn'}">${esc(x.name)}: ${seen ? 'seen ' + fmtT(seen) : 'never connected'}</span>`; }).join(' '); };
    return `<section>
      <div class="headline"><div><span class="big">${hi.length}</span><span>problems to act on</span></div>
        <div><span class="big">${naira(atRisk)}</span><span>value at risk</span></div>
        <div><span class="big">${Object.keys(d.R.transit).length}</span><span>deliveries on the road</span></div></div>
      <h2>Money difference by branch</h2>
      <div class="scroll"><table><thead><tr><th>Branch</th><th>Yesterday</th><th>Today</th></tr></thead>
        <tbody>${d.ctx.branches.map(br => `<tr><td>${esc(br.name)}</td>${moneyRow(br)}</tr>`).join('')}</tbody></table></div>
      <h2>Aronium reports</h2>
      <ul class="plain">${d.ctx.branches.map(br => `<li>${esc(br.name)}: ${syncCell(br)}</li>`).join('')}</ul>
      <h2>Still to come in today</h2>
      ${miss.length ? `<ul class="plain">${miss.map(m => `<li>${esc(d.ctx.locs[m.loc] || m.loc)}: ${esc(m.what)}</li>`).join('')}</ul>` : '<p class="done">Everything for today is in.</p>'}
      ${(() => { const notes = d.alerts.filter(a => a.code === 'CASHIER_NOTE' && a.ts > Date.now() - 2 * 864e5);
        return notes.length ? `<h2>Refunds and notes from cashiers</h2>${alertList(notes)}` : ''; })()}
      <h2>Act on these</h2>${alertList(hi.slice(0, 12))}
      ${hi.length > 12 ? `<p><button class="ghost" data-tab="alerts">See all ${hi.length}</button></p>` : ''}
    </section>`;
  },
  act: {},
};

// ---------------- Alerts ----------------
const alerts = {
  id: 'alerts', label: 'Alerts', roles: ['owner', 'admin'],
  load: () => ownerData(),
  view(S, d) {
    const by = s => d.alerts.filter(a => a.sev === s);
    const em = d.alerts.filter(a => a.code === 'EMERGENCY_RELEASE');
    return `<section><h2>Act on these</h2>${alertList(by('high'))}
      <h2>Review</h2>${alertList(by('med'))}
      ${em.length ? `<p class="note">${em.length} emergency release${em.length > 1 ? 's' : ''} so far. If this keeps rising, the request process is being bypassed.</p>` : ''}
      <details><summary>Low priority (${by('low').length})</summary>${alertList(by('low'))}</details></section>`;
  },
  act: {},
};

// ---------------- Reports ----------------
const REPORTS = [['money', 'Money end of day'], ['kitchen', 'Kitchen end of day'], ['stock', 'Daily stock'], ['ops', 'Operations']];
function moneyBlock(ctx, m, br) {
  if (!m) return `<div class="card"><h3>${esc(br.name)}</h3><p class="empty">Nothing submitted for this day.</p></div>`;
  const c = m.cash, s = m.sources;
  const line = (l, v) => `<tr><th>${l}</th><td class="n">${v === null || v === undefined ? '—' : naira(v)}</td></tr>`;
  return `<div class="card recon"><h3>Daily reconciliation · ${esc(br.name)}</h3><p class="lede">${fmtD(m.date)}</p>
    <table><tbody>
      ${s ? line('Cash', s.cash) + line('Transfer', s.transfer) + line('Card / POS', s.card) + line('Chowdeck', s.chowdeck) + line('App', s.app)
          + `<tr class="sum"><th>Total received</th><td class="n">${naira(m.received)}</td></tr>`
          + line('Delivery fees', -m.delivery) + `<tr class="sum"><th>After delivery</th><td class="n">${naira(m.net)}</td></tr>`
          : `<tr><th>Cashier</th><td class="n">Not submitted</td></tr>`}
      ${line(m.auto ? `Aronium (sent automatically${m.zs.length > 1 ? ', ' + m.zs.length + ' closes' : ''})` : 'Aronium (desktop EOD)', m.aronium)}
      <tr class="result ${m.status}"><th>Difference</th><td class="n">${m.diff === null ? 'Waiting' : (m.diff > 0 ? '+' : '') + naira(m.diff)}</td></tr>
      ${m.refundTotal ? `<tr><th>Refunds given</th><td class="n">${naira(m.refundTotal)}</td></tr>` + (m.diffAfterRefunds !== null ? `<tr class="sum"><th>Difference if the refunds explain it</th><td class="n">${m.diffAfterRefunds > 0 ? '+' : ''}${naira(m.diffAfterRefunds)}</td></tr>` : '') : ''}
    </tbody></table>
    ${m.diff !== null ? `<p class="verdict ${m.status}">${m.status === 'balanced' ? 'BALANCED' : m.status === 'positive' ? 'POSITIVE' : 'NEGATIVE'}</p>` : ''}
    ${m.missingDocs ? `<p class="note neg"><b>${m.missingDocs} receipt number${m.missingDocs > 1 ? 's' : ''} missing in Aronium</b> for this day. A sale may have been deleted after it was rung up.</p>` : ''}
    ${m.bySource ? `<h4>By payment type</h4><div class="scroll"><table><thead><tr><th>Source</th><th class="n">Counted</th><th class="n">Fees</th><th class="n">Aronium</th><th class="n">Diff.</th></tr></thead><tbody>
      ${m.bySource.map(r => `<tr><td>${SRC_LABEL[r.key]}</td><td class="n">${naira(r.counted)}</td><td class="n">${r.fees ? '−' + naira(r.fees) : '·'}</td><td class="n">${naira(r.aronium)}</td>
        <td class="n ${r.diff < 0 ? 'neg' : ''}">${r.diff ? (r.diff > 0 ? '+' : '') + naira(r.diff) : '0'}</td></tr>`).join('')}
      ${m.aronPay.other ? `<tr><td>Other (in Aronium only)</td><td class="n">·</td><td class="n">·</td><td class="n">${naira(m.aronPay.other)}</td><td class="n neg">−${naira(m.aronPay.other)}</td></tr>` : ''}
      </tbody></table></div>${m.bySource.unassignedFees ? `<p class="lede">${naira(m.bySource.unassignedFees)} of delivery fees has no payment type, so it is only in the total.</p>` : ''}
      <p class="lede">A shortage in one type and an equal surplus in another usually means a payment was rung up under the wrong type in Aronium.</p>` : ''}
    ${m.auto && m.aronRefunds ? `<p class="lede">Aronium recorded ${naira(m.aronRefunds)} of refunds${m.refundTotal !== m.aronRefunds ? `; the cashier listed ${naira(m.refundTotal)}` : ''}.</p>` : ''}
    ${m.refunds.length ? `<div class="note"><b>Refunds</b><ul class="plain">${m.refunds.map(r => `<li>${esc(r.ref || '—')}: ${naira(r.amount)} · ${esc(r.reason)}</li>`).join('')}</ul></div>` : ''}
    ${m.note ? `<p class="note"><b>Cashier's note:</b> ${esc(m.note)}</p>` : ''}
    ${c ? `<p class="lede">Cashier ${esc(c.by.name)}, cash watched by ${esc(c.witness)}, submitted ${fmtT(c.recordedTs)}.${m.aron ? ` Aronium total entered by ${esc(m.aron.by.name)} at ${fmtT(m.aron.recordedTs)}: check it against the photo.` : ''}${m.auto ? ` Aronium report sent by ${esc(m.zs.map(z => z.by.name.replace(/^Aronium sync \((.*)\)$/, '$1') + ' at ' + fmtT(z.recordedTs)).join(', '))}.` : ''}</p>
      ${(c.deliveryFees || []).length ? `<details><summary>${c.deliveryFees.length} deliveries</summary><ul class="plain">${c.deliveryFees.map(f => `<li>${esc(f.ref || '—')}: ${naira(f.amount)}${f.method ? ' · ' + SRC_LABEL[f.method] : ''}</li>`).join('')}</ul></details>` : ''}
      <div class="actions">${Object.entries(c.photos || {}).map(([k, p]) => photoBtn(p, k[0].toUpperCase() + k.slice(1))).join('')}${m.aron ? photoBtn(m.aron.photoPath, 'Aronium report') : ''}</div>` : ''}
  </div>`;
}
const menuLabel = (ctx, id) => { const m = (ctx.raw.menu || []).find(x => x.id === id); return m ? `${m.size ? m.size + ' ' : ''}${m.name}` : id; };
function salesNotes(ctx, sl) {
  if (!sl || !sl.hasSales) return '';
  const un = Object.entries(sl.unlinked), nr = Object.entries(sl.noRecipe);
  return (un.length ? `<p class="note"><b>Sold in Aronium but not linked to the menu:</b> ${un.map(([n, q]) => `${esc(n)} ×${num(q)}`).join(', ')}. Link them in Settings → Menu.</p>` : '')
    + (nr.length ? `<p class="note"><b>Sold, but measurements not set:</b> ${nr.map(([id, q]) => `${esc(menuLabel(ctx, id))} ×${num(q)}`).join(', ')}.</p>` : '');
}
function kitchenBlock(ctx, k, br) {
  if (!k.submitted) return `<div class="card"><h3>${esc(br.name)}</h3><p class="empty">The kitchen lead has not submitted a count for this day.</p>${salesNotes(ctx, k.sales)}</div>`;
  return `<div class="card"><h3>Daily kitchen reconciliation · ${esc(br.name)}</h3><p class="lede">Counted by ${esc(k.by)} at ${fmtT(k.at)}. Used = opening + received − counted tonight.</p>
    <div class="scroll"><table><thead><tr><th>Item</th><th class="n">Opening</th><th class="n">Received</th><th class="n">Counted</th><th class="n">Used</th><th class="n">Sold (Aronium)</th><th></th></tr></thead><tbody>
    ${k.rows.map(r => `<tr><td>${esc(iname(ctx, r.code))} <small>${esc(iunit(ctx, r.code))}</small></td><td class="n">${num(r.opening)}</td><td class="n">${num(r.received)}</td>
      <td class="n">${num(r.counted)}</td><td class="n ${r.used < 0 ? 'neg' : ''}"><b>${num(r.used)}</b></td>
      <td class="n">${r.sold === null ? `<small>${k.sales.hasSales ? 'no measurement' : 'no Aronium report'}</small>` : num(r.sold)}</td>
      <td>${r.status === 'reconciled' ? '<span class="tag ok">Reconciled</span>' : r.status === 'discrepancy' ? `<span class="tag bad">${r.gap > 0 ? num(r.gap) + ' more used than sold' : num(-r.gap) + ' less used than sold'}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${salesNotes(ctx, k.sales)}
    <p class="note">Sold = what Aronium's sales should have used, from the menu measurements. More used than sold is stock that left without a sale. A negative "used" means more was counted than was delivered.</p></div>`;
}
const reports = {
  id: 'reports', label: 'Reports', roles: ['owner', 'admin'],
  load: () => ownerData(),
  view(S, d) {
    const days = [...new Set(d.ctx.events.map(e => Rep.dayOf(e.ts)).concat([lagosDate()]))].sort().reverse();
    S.repDay = days.includes(S.repDay) ? S.repDay : days[0];
    S.repKind = S.repKind || 'money';
    const day = S.repDay, ctx = d.ctx;
    let body = '';
    if (S.repKind === 'money') {
      body = ctx.branches.map(br => moneyBlock(ctx, Rep.money(ctx, br.id, day), br)).join('') +
        `<h2>Last 14 days</h2>` + ctx.branches.map(br => { const h = Rep.moneyHistory(ctx, br.id, day);
          return `<h3 class="rep-h">${esc(br.name)}</h3><div class="hist">${h.slice().reverse().map(m => {
            const v = m.diff; const cls = v === null || v === undefined ? 'none' : v < 0 ? 'neg' : v > 0 ? 'pos' : 'zero';
            const ht = v === null || v === undefined ? 4 : Math.min(60, 6 + Math.abs(v) / 100);
            return `<div class="bar ${cls}" title="${esc(m.date)}: ${v === null || v === undefined ? (m.status === 'missing' ? 'nothing submitted' : 'incomplete') : naira(v)}"><i style="height:${ht}px"></i><span>${m.date.slice(8)}</span></div>`; }).join('')}</div>`; }).join('');
    } else if (S.repKind === 'kitchen') {
      body = ctx.branches.map(br => kitchenBlock(ctx, Rep.kitchen(ctx, d.R, br.id, day), br)).join('');
    } else if (S.repKind === 'stock') {
      const st = Rep.dailyStock(ctx, day);
      const total = Object.values(st).reduce((s, x) => s + x.value, 0);
      body = `<p class="lede">Opening + in − out + count gap = closing. A negative gap is stock that went missing. Closing value ${naira(total)} (priced items only).</p>` +
        Object.keys(ctx.locs).filter(l => st[l] && st[l].rows.length).map(l => `<h3 class="rep-h">${esc(ctx.locs[l])} <small>${naira(st[l].value)}</small></h3>
        <div class="scroll"><table><thead><tr><th>Item</th><th class="n">Opening</th><th class="n">In</th><th class="n">Out</th><th class="n">Count gap</th><th class="n">Closing</th></tr></thead><tbody>
        ${st[l].rows.map(r => `<tr><td>${esc(iname(ctx, r.code))} <small>${esc(iunit(ctx, r.code))}</small></td><td class="n">${num(r.opening) || '·'}</td><td class="n">${num(r.in) || '·'}</td><td class="n">${num(r.out) || '·'}</td>
          <td class="n ${r.gap < 0 ? 'neg' : ''}">${r.gap ? (r.gap > 0 ? '+' : '') + num(r.gap) : '·'}</td><td class="n"><b>${num(r.closing)}</b></td></tr>`).join('')}</tbody></table></div>`).join('') || '<p class="empty">No stock recorded yet.</p>';
    } else {
      const o = Rep.operations(ctx, day);
      body = `<div class="scroll"><table><tbody>
        <tr><th>Goods received</th><td>${o.received.length} deliver${o.received.length === 1 ? 'y' : 'ies'}</td></tr>
        <tr><th>Kitchen</th><td>${o.batches} yield report${o.batches === 1 ? '' : 's'}</td></tr>
        <tr><th>Runs to branches</th><td>${o.planned} planned · ${o.topups} top-up · <span class="${o.emergency ? 'neg' : ''}">${o.emergency} emergency</span> · ${naira(o.sentValue)} sent</td></tr>
        <tr><th>Confirmed at branches</th><td>${o.confirmed}${o.transitOpen.length ? ` · <span class="neg">still open: ${o.transitOpen.map(r => esc(r.movId) + ' (' + esc(r.carrier) + ')').join(', ')}</span>` : ''}</td></tr>
        <tr><th>Write-offs</th><td>${o.waste.length ? o.waste.map(w => `${esc(ctx.locs[w.loc] || w.loc)}: ${w.lines.map(l => num(l.qty) + ' ' + esc(iname(ctx, l.code))).join(', ')} (${esc(w.reason)}, witness ${esc(w.witness)}) ${photoBtn(w.photoPath)}`).join('<br>') : 'None'}</td></tr>
        <tr><th>Store openings</th><td>${o.openings}${o.leftOpen ? ' · <span class="neg">left open</span>' : ''}</td></tr>
        <tr><th>Counts</th><td>${o.counts.length ? [...new Set(o.counts.map(c => ctx.locs[c.loc] || c.loc))].join(', ') : 'None'}</td></tr>
        <tr><th>Typed in from paper</th><td>${o.paper}</td></tr>
      </tbody></table></div><h2>Problems that day</h2>${alertList(o.alerts)}`;
    }
    return `<section><h2>Reports</h2>
      <label>Day<select id="rep-day" data-change="repDay">${days.map(x => `<option value="${x}" ${x === day ? 'selected' : ''}>${fmtD(x)}</option>`).join('')}</select></label>
      <div class="seg">${REPORTS.map(([k, l]) => `<button class="${k === S.repKind ? 'on' : ''}" data-set="repKind" data-value="${k}">${l}</button>`).join('')}</div>
      ${body}
      <div class="actions"><button data-act="csv">Download this report (CSV)</button></div></section>`;
  },
  act: {
    async csv(S) {
      const d = await ownerData(); const ctx = d.ctx, day = S.repDay;
      if (S.repKind === 'money') {
        const rows = [['Date', 'Branch', 'Cash', 'Transfer', 'Card', 'Chowdeck', 'App', 'Total received', 'Delivery fees', 'After delivery', 'Aronium', 'Difference', 'Status', 'Refunds', 'Cashier note',
          'Aronium cash', 'Aronium transfer', 'Aronium card', 'Aronium Chowdeck', 'Aronium app', 'Aronium other', 'Receipts missing']];
        ctx.branches.forEach(br => { const m = Rep.money(ctx, br.id, day); if (m) rows.push([day, br.name, m.sources?.cash, m.sources?.transfer, m.sources?.card, m.sources?.chowdeck, m.sources?.app, m.received, m.delivery, m.net, m.aronium, m.diff, m.status, m.refundTotal, m.note || '',
          m.aronPay?.cash, m.aronPay?.transfer, m.aronPay?.card, m.aronPay?.chowdeck, m.aronPay?.app, m.aronPay?.other, m.missingDocs || 0]); });
        downloadCsv(`money-eod-${day}.csv`, rows);
      } else if (S.repKind === 'kitchen') {
        const rows = [['Date', 'Branch', 'Item', 'Unit', 'Opening', 'Received', 'Counted', 'Used', 'Sold (Aronium)', 'Used minus sold', 'Status']];
        ctx.branches.forEach(br => { const k = Rep.kitchen(ctx, d.R, br.id, day);
          if (!k.submitted) rows.push([day, br.name, 'Kitchen count not submitted']);
          (k.rows || []).forEach(r => rows.push([day, br.name, iname(ctx, r.code), iunit(ctx, r.code), r.opening, r.received, r.counted, r.used, r.sold, r.gap, r.status || ''])); });
        // Second table: what Aronium sold that day, item by item.
        rows.push([], ['Items sold (Aronium)'], ['Date', 'Branch', 'Aronium item', 'Menu item', 'Quantity sold', 'Sales (NGN)', 'Status']);
        ctx.branches.forEach(br => {
          const sold = {};
          Rep.zReports(ctx, br.id, day).forEach(z => (z.items || []).forEach(it => {
            const n = it.name.trim(), s = sold[n] = sold[n] || { qty: 0, total: 0 };
            s.qty += Number(it.qty || 0); s.total += Number(it.total || 0); }));
          Object.keys(sold).sort((a, b) => a.localeCompare(b)).forEach(n => {
            const mid = ctx.menuByNorm[Rep.norm(n)];
            const status = !mid ? 'Not linked to the menu' : (ctx.recipes[mid] || []).length ? 'Linked' : 'Linked, measurements not set';
            rows.push([day, br.name, n, mid ? menuLabel(ctx, mid) : '', Math.round(sold[n].qty * 100) / 100, Math.round(sold[n].total), status]);
          });
        });
        downloadCsv(`kitchen-eod-${day}.csv`, rows);
      } else {
        const st = Rep.dailyStock(ctx, day);
        const rows = [['Date', 'Location', 'Item', 'Unit', 'Opening', 'In', 'Out', 'Count gap', 'Closing', 'Closing value (NGN)']];
        Object.keys(st).forEach(l => st[l].rows.forEach(r => rows.push([day, ctx.locs[l], iname(ctx, r.code), iunit(ctx, r.code), r.opening, r.in, r.out, r.gap, r.closing, Math.round(r.value)])));
        downloadCsv(`daily-stock-${day}.csv`, rows);
      }
      return 'stay';
    },
  },
};

// ---------------- Stock ----------------
const stock = {
  id: 'stock', label: 'Stock', roles: ['owner', 'admin'],
  load: () => ownerData(),
  view(S, d) {
    const ctx = d.ctx, locs = Object.keys(ctx.locs);
    const codes = Object.keys(ctx.items).filter(c => locs.some(l => Math.abs((d.R.book[l] || {})[c] || 0) > 0.001));
    const tr = Object.values(d.R.transit);
    return `<section><h2>Stock on record</h2><p class="lede">What the ledger says is at each location now. Branch figures update at each night's count.</p>
      <div class="scroll"><table><thead><tr><th>Item</th>${locs.map(l => `<th class="n">${esc(ctx.locs[l])}</th>`).join('')}</tr></thead><tbody>
      ${codes.map(c => `<tr><td>${esc(iname(ctx, c))} <small>${esc(iunit(ctx, c))}</small></td>${locs.map(l => { const q = (d.R.book[l] || {})[c] || 0; return `<td class="n ${q < -0.001 ? 'neg' : ''}">${q ? num(q) : '·'}</td>`; }).join('')}</tr>`).join('')
        || `<tr><td colspan="${locs.length + 1}" class="empty">No stock recorded yet. The first goods received will appear here.</td></tr>`}</tbody></table></div>
      <h2>On the road</h2>${tr.length ? `<ul class="plain">${tr.map(t => `<li><b>${esc(t.release.movId)}</b> to ${esc(ctx.locs[t.release.dest])} with ${esc(t.release.carrier)} · left ${fmtT(t.release.ts)}</li>`).join('')}</ul>` : '<p class="empty">Nothing on the road.</p>'}</section>`;
  },
  act: {},
};

// ---------------- Ledger + corrections ----------------
function summary(ctx, e) {
  const ln = ls => (ls || []).map(l => `${num(l.qty)} ${iname(ctx, l.code)}`).join(', ');
  switch (e.type) {
    case 'PURCHASE': return `${e.poId} from ${e.supplier || '—'} · ${ln(e.lines)}`;
    case 'GRN': return `${e.poId} · ${ln(e.lines)}`;
    case 'REQUEST': return `${e.reqId} for ${ctx.locs[e.dest] || e.dest} (${e.kind}) · ${ln(e.lines)}`;
    case 'RELEASE': return `${e.movId} to ${ctx.locs[e.dest] || e.dest}${e.carrier ? ' with ' + e.carrier : ''}${e.reqId ? '' : ' · EMERGENCY: ' + (e.reason || '')} · ${ln(e.lines)}`;
    case 'RECEIPT': return `${e.movId} · ${ln(e.lines)}${e.note ? ' · ' + e.note : ''}`;
    case 'YIELD': return `${e.batchId} · in ${ln(e.inputs)} · out ${ln(e.outputs)}`;
    case 'WASTE': return `${ctx.locs[e.loc] || e.loc} · ${ln(e.lines)} · ${e.reason} · witness ${e.witness}`;
    case 'COUNT': case 'KITCHEN_COUNT': return `${ctx.locs[e.loc] || e.loc} · ${(e.lines || []).length} items${e.custodian === e.by.name ? ' · HELD (own stock)' : ''}`;
    case 'STORE_OPEN': return `${e.sessionId} · ${e.reason} · present: ${(e.present || []).join(', ')}`;
    case 'STORE_CLOSE': return e.sessionId;
    case 'CORRECTION': return `${ctx.locs[e.loc] || e.loc} · ${ln(e.lines)} · ${e.reason}`;
    case 'CASH_EOD': return `${ctx.locs[e.branch] || e.branch} · ${e.businessDate}`;
    case 'ARONIUM_TOTAL': return `${ctx.locs[e.branch] || e.branch} · ${e.businessDate} · ${naira(e.total)}`;
    case 'ARONIUM_ZREPORT': return `${ctx.locs[e.branch] || e.branch} · ${e.businessDate} · close no. ${e.zNumber} · ${naira(e.total)} · ${e.salesCount} sales${Number(e.missingDocs) ? ` · ${e.missingDocs} RECEIPTS MISSING` : ''}`;
    case 'SYNC_ALERT': return `${ctx.locs[e.locationId] || e.locationId} · close no. ${e.report?.zNumber} sent again with ${naira(e.report?.total)}`;
    default: return '';
  }
}
const photosOf = e => [e.photoPath, e.invoicePhoto, ...Object.values(e.photos || {})].filter(Boolean);
const ledger = {
  id: 'ledger', label: 'Ledger', roles: ['owner', 'admin'],
  load: () => ownerData(),
  view(S, d) {
    const ctx = d.ctx;
    const types = [...new Set(ctx.events.map(e => e.type))].sort();
    const list = ctx.events.slice().reverse().filter(e => !S.ledType || e.type === S.ledType).slice(0, 300);
    return `<section><h2>Ledger</h2><p class="lede">Every entry, newest first. Entries are never edited; a mistake is fixed with a correction that points back to it.</p>
      <label>Show<select data-change="ledType"><option value="">Everything</option>${types.map(t => `<option value="${t}" ${t === S.ledType ? 'selected' : ''}>${EV_LABEL[t] || t}</option>`).join('')}</select></label>
      <ol class="log">${list.map(e => `<li><time>${fmtT(e.ts)}</time><div><b>${EV_LABEL[e.type] || e.type}</b>${e.source === 'paper' ? ` <span class="tag">paper p.${esc(e.paperPage)}</span>` : ''}
        <span>${esc(summary(ctx, e))}</span><small>${esc(e.by.name)} · ${esc(ROLE_LABEL[e.by.role] || e.by.role)}${e.recordedTs - e.ts > 3600e3 ? ' · recorded ' + fmtT(e.recordedTs) : ''}</small>
        <div class="actions">${photosOf(e).map(p => photoBtn(p)).join('')}${['GRN', 'RELEASE', 'RECEIPT', 'WASTE', 'COUNT', 'KITCHEN_COUNT', 'YIELD'].includes(e.type) ? `<button class="ghost" data-act="correct" data-id="${e.id}">Correct</button>` : ''}</div>
        ${S.correcting === e.id ? `<div class="card"><h3>Correction for this entry</h3>
          <label>Location<select id="cor-loc">${Object.entries(ctx.locs).map(([k, v]) => `<option value="${k}" ${k === (e.loc || e.dest || e.locationId) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
          <p class="lede">Positive numbers add stock, negative numbers remove it.</p>
          ${lineEditor('cor-lines', S.items)}
          <label>Reason<input id="cor-reason"></label><button class="primary" data-act="saveCorrection" data-id="${e.id}">Save correction</button></div>` : ''}
        </div></li>`).join('') || '<li class="empty">No entries yet.</li>'}</ol></section>`;
  },
  act: {
    correct(S, b) { S.correcting = S.correcting === b.dataset.id ? null : b.dataset.id; return 'rerender'; },
    async saveCorrection(S, b) {
      const lines = [...document.querySelectorAll('#cor-lines .line')].map(r => ({ code: r.querySelector('select').value, qty: Number(r.querySelector('.qty').value) })).filter(l => l.code && l.qty);
      need(lines.length, 'Add the items to correct (negative to remove).'); need(val('cor-reason'), 'Give the reason.');
      await rpc('record_correction', { p_ref: b.dataset.id, p_reason: val('cor-reason'), p_loc: val('cor-loc'), p_lines: lines });
      S.correcting = null; invalidate(); toast('Correction saved.');
    },
  },
};

// ---------------- Settings ----------------
const SETTINGS = [['menu', 'Menu'], ['items', 'Stock items'], ['staff', 'Staff'], ['branches', 'Branches'], ['sync', 'Aronium sync'], ['rules', 'Alert rules'], ['changes', 'Change log']];
const RULE_FIELDS = [['countTolerancePct', 'Count tolerance (% of book)'], ['countToleranceAbs', 'Count tolerance (units)'],
  ['countAlertValue', 'High-priority count gap (₦)'], ['countAlertQty', 'High-priority gap for unpriced items (units)'],
  ['transitHours', 'Delivery not received after (hours)'], ['yieldDueHours', 'Yield report due within (hours)'],
  ['purchaseGrnHours', 'Purchase not received after (hours)'], ['wasteWatchPct', 'Waste warning (% of stock moved)'],
  ['yieldTolerancePct', 'Yield tolerance (%)'], ['backdateHours', 'Write-off backdated after (hours)'], ['moneyTolerance', 'Money difference tolerance (₦)']];
const settings = {
  id: 'settings', label: 'Settings', roles: ['owner', 'admin'],
  load: () => ownerData(),
  view(S, d) {
    S.setTab = S.setTab || 'menu';
    const ctx = d.ctx, raw = d.raw, isOwner = S.me.roles.includes('owner');
    let body = '';
    if (S.setTab === 'menu') {
      const menu = (raw.menu || []).slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      const cats = [...new Set(menu.map(m => m.category))];
      const rec = id => (raw.recipes || []).filter(r => r.menu_item_id === id).map(r => ({ code: r.item_id, qty: Number(r.qty) }));
      const label = m => `${m.size ? m.size + ' ' : ''}${m.name}`;
      // Aronium names: linked through "Name in Aronium" or a link; the rest wait for the owner.
      const linkedTo = id => (raw.aliases || []).filter(a => a.menu_item_id === id);
      const seen = {};
      const liveDev = new Set(ctx.devices.filter(x => x.active).map(x => x.branch_id));
      (raw.products || []).filter(p => liveDev.has(p.branch_id)).forEach(p => { seen[p.norm] = seen[p.norm] || { name: p.name, enabled: p.enabled, branches: new Set() }; seen[p.norm].branches.add(p.branch_id); });
      ctx.events.filter(e => e.type === 'ARONIUM_ZREPORT' && liveDev.has(e.locationId) && e.ts > Date.now() - 30 * 864e5).forEach(z => (z.items || []).forEach(it => { const n = normName(it.name);
        seen[n] = seen[n] || { name: it.name.trim(), enabled: true, branches: new Set() }; seen[n].branches.add(z.locationId); seen[n].sold = true; }));
      const unlinked = Object.entries(seen).filter(([n]) => !ctx.menuByNorm[n]).sort((a, b) => (b[1].sold ? 1 : 0) - (a[1].sold ? 1 : 0) || a[1].name.localeCompare(b[1].name));
      const menuOpts = `<option value="">Link to menu item…</option>` + menu.filter(m => m.active).map(m => `<option value="${esc(m.id)}">${esc(m.category)}: ${esc(label(m))}</option>`).join('');
      const unlinkedHtml = Object.keys(seen).length ? `<details class="card" ${unlinked.length ? 'open' : ''}><summary>Aronium items not linked to the menu ${unlinked.length ? `<span class="tag warn">${unlinked.length}</span>` : '<span class="tag ok">all linked</span>'}</summary>
        <p class="lede">Names as they appear in each branch's Aronium. Link each one to a menu item once, so its sales count against the measurements. Items marked "sold" have appeared in a report.</p>
        <ul class="plain unlinked">${unlinked.map(([n, x]) => `<li><b>${esc(x.name)}</b> <small>${[...x.branches].map(b => esc(ctx.locs[b] || b)).join(', ')}${x.enabled === false ? ' · switched off in Aronium' : ''}</small>${x.sold ? ' <span class="tag warn">sold</span>' : ''}
          <select data-alias="${esc(x.name)}">${menuOpts}</select><button class="ghost" data-act="linkAlias" data-name="${esc(x.name)}">Link</button></li>`).join('') || '<li class="done">Every Aronium item is linked.</li>'}</ul></details>` : '';
      const row = m => { const lines = rec(m.id);
        return `<div class="menu-row ${m.active ? '' : 'off'}" data-menu="${esc(m.id)}">
          <div class="menu-main">
            <label>Name<input value="${esc(m.name)}" data-f="name"></label>
            <label>Size<input value="${esc(m.size || '')}" data-f="size" placeholder="—"></label>
            <label>Price ₦<input type="number" min="0" step="any" value="${m.price ?? ''}" data-f="price"></label>
            <label>Name in Aronium<input value="${esc(m.aronium_name || '')}" data-f="aronium_name" placeholder="exactly as in Aronium"></label>
            <label class="check"><input type="checkbox" data-f="active" ${m.active ? 'checked' : ''}> On the menu</label>
            <button class="ghost" data-act="saveMenu" data-id="${esc(m.id)}">Save</button>
          </div>
          ${m.note ? `<small>${esc(m.note)}</small>` : ''}
          ${linkedTo(m.id).length ? `<div><small>Also matches in Aronium:</small> ${linkedTo(m.id).map(a => `<span class="alias tag">${esc(a.alias)} <button class="x" data-act="unlinkAlias" data-name="${esc(a.alias)}" aria-label="Unlink ${esc(a.alias)}">×</button></span>`).join('')}</div>` : ''}
          <details ${S.openMenu === m.id ? 'open' : ''}><summary>Measurements ${lines.length ? `(${lines.length} items)` : '<span class="tag">not set</span>'}</summary>
            <p class="lede">What one ${esc(label(m))} uses, in each item's count unit.</p>
            ${lineEditor('mr-' + m.id, S.items, lines)}
            <button class="primary" data-act="saveRecipe" data-id="${esc(m.id)}">Save measurements</button></details></div>`; };
      const withRecipe = menu.filter(m => m.active && rec(m.id).length).length, activeN = menu.filter(m => m.active).length;
      body = `<p class="lede">The restaurant's menu. Switch an item off when it's no longer sold; it's never deleted, so past reports stay right. ${isOwner ? '' : 'Only the owner can change a price once it is set.'}
        Aronium's item names are matched ignoring capitals and extra spaces; link any others below. Measurements set: <b>${withRecipe} of ${activeN}</b>.</p>
        ${unlinkedHtml}
        ${cats.map(c => `<h3 class="rep-h">${esc(c)}</h3>${menu.filter(m => m.category === c).map(row).join('')}`).join('') || '<p class="empty">No menu items yet.</p>'}
        <datalist id="menucats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="card"><h3>Add a menu item</h3>
          <label>Category<input id="nm-cat" list="menucats" placeholder="e.g. Chicken burgers"></label>
          <label>Name<input id="nm-name"></label><label>Size <small>(optional)</small><input id="nm-size" placeholder="Regular, Large…"></label>
          <label>Price ₦<input id="nm-price" type="number" min="0" step="any"></label>
          <label>Name in Aronium<input id="nm-aron"></label>
          <button class="primary" data-act="addMenu">Add to menu</button></div>`;
    } else if (S.setTab === 'items') {
      const cats = [...new Set(raw.items.map(i => i.category))].sort();
      body = `<p class="lede">Prices and units can be set once the new suppliers are agreed. Until an item has a price, alerts use quantities. Items are switched off, never deleted. ${isOwner ? '' : 'Only the owner can change a price or unit once it is set.'}</p>
        <div class="scroll"><table class="items"><thead><tr><th>Item</th><th>Category</th><th>Count unit</th><th>Bought as</th><th class="n">Per bulk unit</th><th class="n">Cost ₦ / unit</th><th class="n">Reorder at</th><th>Count</th><th>Expiry</th><th>Active</th><th></th></tr></thead><tbody>
        ${raw.items.slice().sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)).map(i => `<tr data-item="${esc(i.id)}" class="${i.active ? '' : 'off'}">
          <td><input value="${esc(i.name)}" data-f="name"></td><td><input value="${esc(i.category)}" data-f="category" list="cats"></td>
          <td><input value="${esc(i.count_unit || '')}" data-f="count_unit" placeholder="kg, pcs…" size="5"></td>
          <td><input value="${esc(i.purchase_unit || '')}" data-f="purchase_unit" placeholder="bag…" size="5"></td>
          <td class="n"><input type="number" value="${i.units_per_purchase ?? 1}" data-f="units_per_purchase" step="any" min="0"></td>
          <td class="n"><input type="number" value="${i.cost_price ?? ''}" data-f="cost_price" step="any" min="0"></td>
          <td class="n"><input type="number" value="${i.reorder_level ?? ''}" data-f="reorder_level" step="any" min="0"></td>
          <td><select data-f="count_frequency"><option ${i.count_frequency === 'daily' ? 'selected' : ''}>daily</option><option ${i.count_frequency === 'weekly' ? 'selected' : ''}>weekly</option></select></td>
          <td><input type="checkbox" data-f="tracks_expiry" ${i.tracks_expiry ? 'checked' : ''}></td>
          <td><input type="checkbox" data-f="active" ${i.active ? 'checked' : ''}></td>
          <td><button class="ghost" data-act="saveItem" data-id="${esc(i.id)}">Save</button></td></tr>`).join('')}
        </tbody></table></div><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="card"><h3>Add an item</h3><label>Name<input id="ni-name"></label><label>Category<input id="ni-cat" list="cats"></label>
          <label>Type<select id="ni-kind"><option value="raw">Bought</option><option value="prepared">Made in the central kitchen</option></select></label>
          <label>Count unit<input id="ni-unit" placeholder="kg, pcs, L, pack…"></label>
          <label>Counted<select id="ni-freq"><option>daily</option><option selected>weekly</option></select></label>
          <button class="primary" data-act="addItem">Add item</button></div>`;
    } else if (S.setTab === 'staff') {
      const locOpts = sel => `<option value="">—</option>` + raw.locations.filter(l => l.kind === 'branch').map(l => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
      const roleBoxes = (pfx, sel = []) => Object.entries(ROLE_LABEL).filter(([r]) => isOwner || !['owner', 'admin'].includes(r))
        .map(([r, l]) => `<label class="pill"><input type="checkbox" name="${pfx}" value="${r}" ${sel.includes(r) ? 'checked' : ''}>${l}</label>`).join('');
      body = `<p class="lede">Each person signs in with their own username and a 6-digit PIN. Branch roles (branch manager, kitchen lead, cashier) need a branch.</p>
        <ul class="plain">${raw.profiles.map(p => `<li class="${p.active ? '' : 'off'}"><b>${esc(p.full_name)}</b> <small>@${esc(p.username)}</small>
          · ${p.roles.map(r => ROLE_LABEL[r] || r).join(', ') || 'no role'}${p.branch_id ? ' · ' + esc(ctx.locs[p.branch_id]) : ''}${p.active ? '' : ' · <span class="tag bad">switched off</span>'}
          <details><summary>Edit</summary><div class="roles">${roleBoxes('r-' + p.id, p.roles)}</div>
            <label>Branch<select id="b-${p.id}">${locOpts(p.branch_id)}</select></label>
            <div class="actions"><button data-act="saveStaff" data-id="${p.id}">Save roles</button>
            <button data-act="resetPin" data-id="${p.id}">Set a new PIN</button>
            <button class="${p.active ? 'danger' : ''}" data-act="toggleStaff" data-id="${p.id}" data-on="${p.active ? '0' : '1'}">${p.active ? 'Switch off' : 'Switch on'}</button></div></details></li>`).join('')}</ul>
        <div class="card"><h3>Add a staff member</h3>
          <label>Full name<input id="ns-name"></label><label>Username<input id="ns-user" autocapitalize="none" placeholder="e.g. musa"></label>
          <label>PIN (6 digits)<input id="ns-pin" inputmode="numeric" maxlength="6"></label>
          <fieldset class="roles"><legend>Roles</legend>${roleBoxes('ns-roles')}</fieldset>
          <label>Branch<select id="ns-branch">${locOpts('')}</select></label>
          <button class="primary" data-act="addStaff">Create account</button></div>`;
    } else if (S.setTab === 'branches') {
      body = `<ul class="plain">${raw.locations.map(l => `<li><input value="${esc(l.name)}" id="loc-${l.id}"> <small>${esc(l.kind)}</small> <button class="ghost" data-act="renameLoc" data-id="${l.id}">Save name</button></li>`).join('')}</ul>
        <div class="card"><h3>Add a branch</h3><label>Branch name<input id="nb-name"></label><button class="primary" data-act="addBranch">Add branch</button></div>`;
    } else if (S.setTab === 'sync') {
      const devs = d.ctx.devices.slice().sort((a, b) => (b.active - a.active) || a.branch_id.localeCompare(b.branch_id));
      body = `<p class="lede">Each branch laptop sends Aronium's end-of-day report here as soon as the register is closed, so nothing is printed and the cashier never enters Aronium's figures.
        Add a laptop below, then run <b>Install Beiroot Sync</b> on it (in the <code>sync</code> folder) and paste the key.</p>
        ${S.newKey ? `<div class="card open"><h3>Key for ${esc(S.newKey.name)}</h3><p class="lede">Copy it now and paste it into the installer on that laptop. It is shown only once.</p>
          <p class="keybox">${esc(S.newKey.key)}</p><div class="actions"><button data-act="copyKey">Copy key</button><button class="ghost" data-act="doneKey">Done</button></div></div>` : ''}
        <ul class="plain">${devs.map(x => { const st = x.last_status || {};
          return `<li class="${x.active ? '' : 'off'}"><b>${esc(x.name)}</b> · ${esc(ctx.locs[x.branch_id] || x.branch_id)}
          ${x.active ? '' : ' <span class="tag bad">revoked</span>'}<br><small>${x.last_seen_at ? 'Last seen ' + fmtT(x.last_seen_at) : 'Not connected yet'}${st.version ? ' · version ' + esc(st.version) : ''}${st.computer ? ' · ' + esc(st.computer) : ''}</small>
          ${st.error ? `<p class="note neg">${esc(st.error)}</p>` : ''}
          ${x.active ? `<div class="actions"><button class="danger" data-act="revokeDevice" data-id="${x.id}">Revoke key</button></div>` : ''}</li>`; }).join('') || '<li class="empty">No laptops yet. Branches without one enter Aronium\'s total by hand.</li>'}</ul>
        <div class="card"><h3>Add a branch laptop</h3>
          <label>Branch<select id="nd-branch">${raw.locations.filter(l => l.kind === 'branch' && l.active).map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
          <label>Laptop name<input id="nd-name" placeholder="e.g. Tanke counter laptop"></label>
          <button class="primary" data-act="addDevice">Create key</button></div>`;
    } else if (S.setTab === 'rules') {
      body = `<p class="lede">${isOwner ? 'Change when alerts fire. The defaults came from the simulation.' : 'Only the owner can change these.'}</p>
        ${RULE_FIELDS.map(([k, l]) => `<label>${esc(l)}<input type="number" step="any" id="rule-${k}" value="${ctx.rules[k] ?? ''}" ${isOwner ? '' : 'disabled'}></label>`).join('')}
        ${isOwner ? '<button class="primary" data-act="saveRules">Save rules</button>' : ''}`;
    } else {
      body = `<p class="lede">Every change to a stock item or menu item, newest first.</p><div id="changes">Loading…</div>`;
      setTimeout(async () => {
        const [a, m] = await Promise.all([sb.from('item_changes').select('*').order('id', { ascending: false }).limit(100),
          sb.from('menu_changes').select('*').order('id', { ascending: false }).limit(100)]);
        const error = a.error || m.error;
        const menuName = id => { const x = (raw.menu || []).find(y => y.id === id); return x ? `${x.size ? x.size + ' ' : ''}${x.name} (menu)` : id; };
        const data = error ? [] : a.data.concat((m.data || []).map(c => ({ ...c, item_id: null, _menu: menuName(c.menu_item_id) })))
          .sort((x, y) => Date.parse(y.changed_at) - Date.parse(x.changed_at)).slice(0, 150);
        const el = $('#changes'); if (!el) return;
        const who = id => (raw.profiles.find(p => p.id === id) || {}).full_name || 'system';
        el.innerHTML = error ? esc(cleanError(error)) : (data.length ? `<ol class="log">${data.map(c => `<li><time>${fmtT(c.changed_at)}</time><div><b>${esc(c._menu || ctx.items[c.item_id]?.name || c.item_id)}</b>
          <span>${esc(c.field)}: ${esc(c.old_value ?? '—')} → ${esc(c.new_value ?? '—')}</span><small>${esc(who(c.changed_by))}</small></div></li>`).join('')}</ol>` : '<p class="empty">No changes yet.</p>');
      }, 0);
    }
    return `<section><h2>Settings</h2><div class="seg">${SETTINGS.map(([k, l]) => `<button class="${k === S.setTab ? 'on' : ''}" data-set="setTab" data-value="${k}">${l}</button>`).join('')}</div>${body}</section>`;
  },
  act: {
    async saveMenu(S, b) {
      const row = document.querySelector(`.menu-row[data-menu="${CSS.escape(b.dataset.id)}"]`); const u = {};
      row.querySelectorAll('.menu-main [data-f]').forEach(el => {
        const f = el.dataset.f;
        u[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value.trim() || null);
      });
      need(u.name, 'The menu item needs a name.');
      const { error } = await sb.from('menu_items').update(u).eq('id', b.dataset.id);
      if (error) throw new Error(cleanError(error));
      invalidate(); toast('Menu item saved.');
    },
    async linkAlias(S, b) {
      const sel = [...document.querySelectorAll('select[data-alias]')].find(x => x.dataset.alias === b.dataset.name);
      need(sel && sel.value, 'Choose the menu item first.');
      await rpc('link_aronium_name', { p_name: b.dataset.name, p_menu_item: sel.value }); invalidate(); toast('Linked.');
    },
    async unlinkAlias(S, b) { await rpc('link_aronium_name', { p_name: b.dataset.name, p_menu_item: null }); invalidate(); toast('Unlinked.'); },
    async addDevice(S) {
      const name = val('nd-name'); need(name, 'Give the laptop a name.');
      const { key, hash } = await newDeviceKey();
      await rpc('create_sync_device', { p_branch: val('nd-branch'), p_name: name, p_key_hash: hash });
      S.newKey = { name, key }; invalidate(); toast('Key created. Copy it now.');
    },
    async copyKey(S) { try { await navigator.clipboard.writeText(S.newKey.key); toast('Key copied.'); } catch (e) { toast('Select the key and copy it.', true); } return 'stay'; },
    doneKey(S) { S.newKey = null; return 'rerender'; },
    async revokeDevice(S, b) {
      if (!confirm('Revoke this laptop\'s key? It stops sending reports until it is installed again with a new key.')) return 'stay';
      await rpc('set_sync_device_active', { p_id: b.dataset.id, p_active: false }); invalidate(); toast('Key revoked.');
    },
    async saveRecipe(S, b) {
      const id = b.dataset.id;
      const lines = [...document.querySelectorAll(`#mr-${CSS.escape(id)} .line`)].map(r => ({ code: r.querySelector('select').value, qty: Number(r.querySelector('.qty').value) })).filter(l => l.code && l.qty);
      await rpc('save_menu_recipe', { p_menu_item: id, p_lines: lines });
      S.openMenu = id; invalidate(); toast('Measurements saved.');
    },
    async addMenu() {
      const name = val('nm-name'); need(name, 'Give the menu item a name.'); need(val('nm-cat'), 'Give it a category.');
      const size = val('nm-size');
      const id = (val('nm-cat') + '-' + name + (size ? '-' + size : '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
      const { error } = await sb.from('menu_items').insert({ id, name, category: val('nm-cat'), size: size || null,
        price: val('nm-price') === '' ? null : Number(val('nm-price')), aronium_name: val('nm-aron') || null, sort: 900 });
      if (error) throw new Error(/duplicate/i.test(error.message) ? 'That menu item already exists.' : cleanError(error));
      invalidate(); toast('Added to the menu.');
    },
    async saveItem(S, b) {
      const row = document.querySelector(`tr[data-item="${CSS.escape(b.dataset.id)}"]`); const u = {};
      row.querySelectorAll('[data-f]').forEach(el => {
        const f = el.dataset.f;
        u[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : (el.value.trim() || null);
      });
      need(u.name, 'The item needs a name.'); need(u.category, 'The item needs a category.');
      if (u.units_per_purchase === null) u.units_per_purchase = 1;
      const { error } = await sb.from('items').update(u).eq('id', b.dataset.id);
      if (error) throw new Error(cleanError(error));
      invalidate(); toast('Item saved.');
    },
    async addItem() {
      const name = val('ni-name'); need(name, 'Give the item a name.'); need(val('ni-cat'), 'Give it a category.');
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || ('item-' + Date.now());
      const { error } = await sb.from('items').insert({ id, name, category: val('ni-cat'), kind: val('ni-kind'), count_unit: val('ni-unit') || null, count_frequency: val('ni-freq') });
      if (error) throw new Error(/duplicate/i.test(error.message) ? 'An item with that name already exists.' : cleanError(error));
      invalidate(); toast('Item added.');
    },
    async addStaff() {
      const roles = [...document.querySelectorAll('input[name=ns-roles]:checked')].map(x => x.value);
      need(val('ns-name') && val('ns-user'), 'Enter the name and username.'); need(/^\d{6}$/.test(val('ns-pin')), 'The PIN must be 6 digits.');
      need(roles.length, 'Pick at least one role.');
      need(!roles.some(r => BRANCH_ROLES.includes(r)) || val('ns-branch'), 'Pick the branch for this person.');
      await staffApi('create', { fullName: val('ns-name'), username: val('ns-user'), pin: val('ns-pin'), roles, branchId: val('ns-branch') || null });
      invalidate(); toast('Account created. Give them their username and PIN.');
    },
    async saveStaff(S, b) {
      const id = b.dataset.id; const roles = [...document.querySelectorAll(`input[name="r-${id}"]:checked`)].map(x => x.value);
      const br = val('b-' + id) || null;
      need(!roles.some(r => BRANCH_ROLES.includes(r)) || br, 'Pick the branch for this person.');
      await staffApi('update', { userId: id, roles, branchId: br }); invalidate(); toast('Saved.');
    },
    async resetPin(S, b) {
      const pin = prompt('New 6-digit PIN for this person:'); if (pin === null) return 'stay';
      need(/^\d{6}$/.test(pin), 'The PIN must be 6 digits.');
      await staffApi('reset_pin', { userId: b.dataset.id, pin }); toast('PIN changed.'); return 'stay';
    },
    async toggleStaff(S, b) { await staffApi('update', { userId: b.dataset.id, active: b.dataset.on === '1' }); invalidate(); toast('Saved.'); },
    async renameLoc(S, b) { const name = val('loc-' + b.dataset.id); need(name, 'Enter a name.');
      const { error } = await sb.from('locations').update({ name }).eq('id', b.dataset.id); if (error) throw new Error(cleanError(error)); invalidate(); toast('Saved.'); },
    async addBranch() { const name = val('nb-name'); need(name, 'Enter the branch name.');
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
      const { error } = await sb.from('locations').insert({ id, name, kind: 'branch' }); if (error) throw new Error(cleanError(error)); invalidate(); toast('Branch added.'); },
    async saveRules(S) {
      const d = await ownerData(); const v = Object.assign({}, d.ctx.settings.rules || {});
      RULE_FIELDS.forEach(([k]) => { const x = val('rule-' + k); if (x !== '') v[k] = Number(x); });
      const { error } = await sb.from('settings').upsert({ key: 'rules', value: v }); if (error) throw new Error(cleanError(error));
      invalidate(); toast('Rules saved.');
    },
  },
};

export const OWNER_TABS = [today, alerts, reports, stock, ledger, settings];

export async function openPhoto(path) {
  const w = window.open('', '_blank');
  try { const url = await photoUrl(path); if (w) w.location = url; else window.location = url; }
  catch (e) { if (w) w.close(); toast(e.message, true); }
}
