// Turns the ledger into the owner's reports. Pure functions: no network, easy to test.
import * as E from './engine.js';

const H = 3600e3, DAY = 24 * H;
export const dayRange = d => { const a = Date.parse(d + 'T00:00:00+01:00'); return [a, a + DAY]; };
export const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const r2 = x => Math.round(x * 100) / 100;
export const norm = t => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
export const SOURCES = ['cash', 'transfer', 'card', 'chowdeck', 'app'];

// Aronium end-of-day reports for one branch and business day (the register may be closed more than once).
export const zReports = (ctx, branch, date) => ctx.events.filter(e => e.type === 'ARONIUM_ZREPORT' && e.locationId === branch && e.businessDate === date);

// raw = { events, items, locations, settings, profiles } from the database
export function buildContext(raw, toEngineEvent) {
  const items = {};
  raw.items.forEach(i => { items[i.id] = { name: i.name, unit: i.count_unit || '', price: i.cost_price === null ? 0 : Number(i.cost_price), kind: i.kind, category: i.category, active: i.active }; });
  const locs = {};
  raw.locations.forEach(l => { locs[l.id] = l.name; });
  const settings = {};
  raw.settings.forEach(s => { settings[s.key] = s.value; });
  const rules = Object.assign({}, E.DEFAULT_RULES, settings.rules || {});
  const events = raw.events.map(toEngineEvent).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  const branches = raw.locations.filter(l => l.kind === 'branch' && l.active);
  // One menu for all branches. Aronium names reach a menu item through "Name in Aronium" or a link the owner made.
  const menuByNorm = {};
  (raw.menu || []).forEach(m => { if (m.aronium_name) menuByNorm[norm(m.aronium_name)] = m.id; });
  (raw.aliases || []).forEach(a => { menuByNorm[a.norm] = a.menu_item_id; });
  const recipes = {};
  (raw.recipes || []).forEach(r => { (recipes[r.menu_item_id] = recipes[r.menu_item_id] || []).push({ code: r.item_id, qty: Number(r.qty) }); });
  const devices = raw.devices || [];
  const autoBranch = id => devices.some(d => d.branch_id === id && d.active);
  return { items, locs, rules, events, branches, raw, settings, menuByNorm, recipes, devices, autoBranch };
}

export const run = (ctx, until) => {
  const evs = until === undefined ? ctx.events : ctx.events.filter(e => e.ts < until);
  return E.apply(evs, ctx.rules, until === undefined ? Date.now() : until - 1, { items: ctx.items, locs: ctx.locs });
};

// ---------- Money end of day (owner's format) ----------
export function money(ctx, branch, date) {
  const find = t => ctx.events.find(e => e.type === t && e.locationId === branch && e.businessDate === date);
  const c = find('CASH_EOD'), zs = zReports(ctx, branch, date);
  const a = zs.length ? null : find('ARONIUM_TOTAL');
  if (!c && !a && !zs.length) return null;
  const sources = c ? { cash: +c.cash, transfer: +c.transfer, card: +c.card, chowdeck: +c.chowdeck, app: +c.app } : null;
  const received = sources ? Object.values(sources).reduce((s, v) => s + v, 0) : null;
  const delivery = c ? +c.deliveryTotal : null;
  const net = c ? received - delivery : null;
  // Sent automatically by the branch laptop: payments by type, so each source can be checked on its own.
  let aronPay = null, bySource = null, missingDocs = 0, aronRefunds = 0;
  if (zs.length) {
    aronPay = { cash: 0, transfer: 0, card: 0, chowdeck: 0, app: 0, other: 0 };
    zs.forEach(z => { Object.keys(aronPay).forEach(k => { aronPay[k] = r2(aronPay[k] + Number((z.payments || {})[k] || 0)); });
      missingDocs += Number(z.missingDocs || 0); aronRefunds += Number(z.refundTotal || 0); });
    if (c) {
      const feeBy = {}; (c.deliveryFees || []).forEach(f => { const k = f.method || 'unknown'; feeBy[k] = r2((feeBy[k] || 0) + Number(f.amount)); });
      bySource = SOURCES.map(k => ({ key: k, counted: sources[k], fees: feeBy[k] || 0, aronium: aronPay[k], diff: r2(sources[k] - (feeBy[k] || 0) - aronPay[k]) }));
      if (feeBy.unknown) bySource.unassignedFees = feeBy.unknown;
    }
  }
  const aronium = zs.length ? r2(zs.reduce((s, z) => s + Number(z.total || 0), 0)) : a ? +a.total : null;
  const diff = (c && aronium !== null) ? r2(net - aronium) : null;
  const tol = Number(ctx.rules.moneyTolerance ?? 500);
  const status = diff === null ? 'incomplete' : diff === 0 ? 'balanced' : diff > 0 ? 'positive' : 'negative';
  const refunds = c ? (c.refunds || []) : [], refundTotal = c ? Number(c.refundTotal || 0) : 0;
  // Aronium's own report already takes its refunds off, so this line only applies to a hand-entered total.
  const diffAfterRefunds = diff === null || !refundTotal || zs.length ? null : r2(diff + refundTotal);
  const aronTs = zs.length ? Math.max(...zs.map(z => z.ts)) : a ? a.ts : null;
  return { branch, date, cash: c, aron: a, zs, auto: zs.length > 0, aronPay, bySource, missingDocs, aronRefunds, aronTs,
    sources, received, delivery, net, aronium, diff, status, refunds, refundTotal, diffAfterRefunds,
    note: c ? c.note : null, beyond: diff !== null && Math.abs(diff) > tol };
}

export function moneyHistory(ctx, branch, endDate, days = 14) {
  const out = [];
  const [end] = dayRange(endDate);
  for (let i = 0; i < days; i++) { const d = dayOf(end - i * DAY + 12 * H); out.push(money(ctx, branch, d) || { branch, date: d, status: 'missing' }); }
  return out;
}

// ---------- Kitchen end of day (owner's format) ----------
export function kitchen(ctx, R, branch, date) {
  const kc = R.kitchenCounts.find(k => k.loc === branch && (k.date === date || dayOf(k.event.ts) === date));
  const [a, b] = dayRange(date);
  const received = {};
  ctx.events.filter(e => e.type === 'RECEIPT' && e.locationId === branch && e.ts >= a && e.ts < b)
    .forEach(e => (e.lines || []).forEach(l => { received[l.code] = r2((received[l.code] || 0) + Number(l.qty)); }));
  const sales = soldFromAronium(ctx, branch, date);
  if (!kc) return { branch, date, submitted: false, received, sales };
  const counted = {}; (kc.event.lines || []).forEach(l => { counted[l.code] = Number(l.qty); });
  const R_ = ctx.rules;
  const rows = Object.keys(counted).map(code => {
    const used = kc.used[code] || 0, rec = received[code] || 0;
    const sold = sales.hasSales && code in sales.stock ? sales.stock[code] : null;
    const gap = sold === null ? null : r2(used - sold);
    const tol = Math.max(Number(R_.countToleranceAbs || 0), Math.abs(sold || 0) * Number(R_.countTolerancePct || 0) / 100);
    return { code, opening: r2(used + counted[code] - rec), received: rec, counted: counted[code], used: r2(used), sold, gap,
      status: gap === null ? null : Math.abs(gap) <= tol ? 'reconciled' : 'discrepancy' };
  }).filter(r => r.opening || r.received || r.counted || r.used || r.sold)
    .sort((x, y) => (ctx.items[x.code]?.name || x.code).localeCompare(ctx.items[y.code]?.name || y.code));
  return { branch, date, submitted: true, by: kc.event.by.name, at: kc.event.ts, rows, sales };
}

// What Aronium's sales should have used, through the menu measurements.
export function soldFromAronium(ctx, branch, date) {
  const zs = zReports(ctx, branch, date);
  const stock = {}, unlinked = {}, noRecipe = {}, menuSold = {};
  zs.forEach(z => (z.items || []).forEach(it => {
    const q = Number(it.qty || 0); if (!q) return;
    const mid = ctx.menuByNorm[norm(it.name)];
    if (!mid) { unlinked[it.name.trim()] = r2((unlinked[it.name.trim()] || 0) + q); return; }
    menuSold[mid] = r2((menuSold[mid] || 0) + q);
    const rec = ctx.recipes[mid];
    if (!rec || !rec.length) { noRecipe[mid] = r2((noRecipe[mid] || 0) + q); return; }
    rec.forEach(l => { stock[l.code] = r2((stock[l.code] || 0) + l.qty * q); });
  }));
  return { hasSales: zs.length > 0, stock, unlinked, noRecipe, menuSold };
}

// ---------- Daily stock: opening + in − out + gap = closing ----------
export function dailyStock(ctx, date) {
  const [a, b] = dayRange(date);
  const before = run(ctx, a), after = run(ctx, b);
  const today = ctx.events.filter(e => e.ts >= a && e.ts < b);
  const flow = {}; const f = (loc, c, dir, q) => { const k = loc + '|' + c; (flow[k] = flow[k] || { in: 0, out: 0 })[dir] += Number(q); };
  today.forEach(e => {
    const ls = e.lines || [];
    if (e.type === 'GRN') ls.forEach(l => f('store', l.code, 'in', l.qty));
    if (e.type === 'RELEASE') ls.forEach(l => { f('store', l.code, 'out', l.qty); if (e.dest === 'kitchen') f('kitchen', l.code, 'in', l.qty); });
    if (e.type === 'RECEIPT') { const rel = after.releases[e.movId]; if (rel) ls.forEach(l => f(rel.dest, l.code, 'in', l.qty)); }
    if (e.type === 'YIELD') { (e.inputs || []).forEach(l => f('kitchen', l.code, 'out', l.qty)); (e.outputs || []).forEach(l => f('store', l.code, 'in', l.qty)); }
    if (e.type === 'USE' || e.type === 'WASTE') ls.forEach(l => f(e.loc, l.code, 'out', l.qty));
    if (e.type === 'CORRECTION') ls.forEach(l => f(e.loc, l.code, l.qty > 0 ? 'in' : 'out', Math.abs(l.qty)));
  });
  after.kitchenCounts.filter(k => k.event.ts >= a && k.event.ts < b)
    .forEach(k => Object.entries(k.used).forEach(([c, u]) => { if (u > 0) f(k.loc, c, 'out', u); else if (u < 0) f(k.loc, c, 'in', -u); }));
  const out = {};
  Object.keys(ctx.locs).forEach(loc => {
    const codes = new Set([...Object.keys(before.book[loc] || {}), ...Object.keys(after.book[loc] || {}),
      ...Object.keys(flow).filter(k => k.startsWith(loc + '|')).map(k => k.split('|')[1])]);
    const rows = [...codes].map(c => {
      const op = (before.book[loc] || {})[c] || 0, cl = (after.book[loc] || {})[c] || 0, fl = flow[loc + '|' + c] || { in: 0, out: 0 };
      return { code: c, opening: r2(op), in: r2(fl.in), out: r2(fl.out), gap: r2(cl - op - fl.in + fl.out), closing: r2(cl), value: cl * (ctx.items[c]?.price || 0) };
    }).filter(r => r.opening || r.in || r.out || r.closing || r.gap)
      .sort((x, y) => (ctx.items[x.code]?.name || x.code).localeCompare(ctx.items[y.code]?.name || y.code));
    out[loc] = { rows, value: rows.reduce((s, r) => s + Math.max(0, r.value), 0) };
  });
  return out;
}

// ---------- Operations end of day ----------
export function operations(ctx, date) {
  const [a, b] = dayRange(date);
  const R = run(ctx, b);
  const today = ctx.events.filter(e => e.ts >= a && e.ts < b);
  const V = ls => E.value(ls || [], ctx.items);
  const rel = today.filter(e => e.type === 'RELEASE' && e.dest !== 'kitchen');
  const kind = r => !r.reqId ? 'emergency' : (R.requests[r.reqId] || {}).kind || 'planned';
  return {
    received: today.filter(e => e.type === 'GRN'),
    batches: today.filter(e => e.type === 'YIELD').length,
    planned: rel.filter(r => kind(r) === 'planned').length, topups: rel.filter(r => kind(r) === 'topup').length,
    emergency: rel.filter(r => kind(r) === 'emergency').length, sentValue: rel.reduce((s, e) => s + V(e.lines), 0),
    confirmed: today.filter(e => e.type === 'RECEIPT').length,
    transitOpen: Object.values(R.transit).map(t => t.release),
    waste: today.filter(e => e.type === 'WASTE'),
    openings: today.filter(e => e.type === 'STORE_OPEN').length,
    leftOpen: Object.values(R.sessions).filter(s => !s.close).length,
    counts: today.filter(e => e.type === 'COUNT' || e.type === 'KITCHEN_COUNT'),
    paper: today.filter(e => e.source === 'paper').length,
    alerts: R.alerts.filter(x => x.ts >= a && x.ts < b && x.sev !== 'low'),
  };
}

// ---------- What should have been submitted for a day ----------
// A location counts as "live" once anything has been recorded for it, so a branch that
// hasn't started using the system yet doesn't raise reminders every day.
// Automatic Aronium reports don't count: a laptop can be set up before the staff start.
const liveSince = (ctx, loc) => { const e = ctx.events.find(x => x.source !== 'import' && (x.locationId === loc || x.dest === loc || x.loc === loc)); return e ? dayOf(e.ts) : null; };
export function missing(ctx, date) {
  const out = [];
  const [a, b] = dayRange(date);
  const has = (t, loc, byDate) => ctx.events.some(e => e.type === t && e.locationId === loc &&
    (byDate ? e.businessDate === date : (e.ts >= a && e.ts < b)));
  ctx.branches.forEach(br => {
    const since = liveSince(ctx, br.id);
    if (!since || since > date) return;
    if (!has('CASH_EOD', br.id, true)) out.push({ loc: br.id, what: 'Money end of day (cashier)' });
    if (ctx.autoBranch(br.id)) { if (!has('ARONIUM_ZREPORT', br.id, true)) out.push({ loc: br.id, what: 'Aronium report (close the register; the laptop sends it)' }); }
    else if (!has('ARONIUM_TOTAL', br.id, true)) out.push({ loc: br.id, what: 'Aronium total (cashier)' });
    if (!has('KITCHEN_COUNT', br.id, false)) out.push({ loc: br.id, what: 'Kitchen count (kitchen lead)' });
  });
  const storeCounted = ctx.events.some(e => e.type === 'COUNT' && e.loc === 'store' && e.custodian !== e.by.name && e.ts >= a && e.ts < b);
  const storeSince = liveSince(ctx, 'store');
  if (!storeCounted && storeSince && storeSince <= date) out.push({ loc: 'store', what: 'Blind count of the central store' });
  return out;
}

// ---------- Alerts the engine doesn't know about (money, missing work) ----------
export function extraAlerts(ctx, now = Date.now(), R = null) {
  const out = [];
  const today = dayOf(now), yday = dayOf(now - DAY);
  ctx.branches.forEach(br => {
    for (let i = 0; i < 30; i++) {
      const d = dayOf(now - i * DAY);
      const m = money(ctx, br.id, d);
      if (m && m.beyond) out.push({ code: 'MONEY_VARIANCE', sev: m.diff < 0 ? 'high' : 'med', ts: Math.max(m.cash.ts, m.aronTs),
        title: `Money ${m.diff < 0 ? 'short' : 'over'} at ${br.name}`, detail: `${d}: received ₦${Math.round(m.net).toLocaleString()} after delivery, Aronium ₦${Math.round(m.aronium).toLocaleString()}`,
        accountable: m.cash.by.name, value: Math.abs(m.diff), refs: { loc: br.id } });
    }
    // Every refund or note from the cashier reaches the owner.
    ctx.events.filter(e => e.type === 'CASH_EOD' && e.locationId === br.id && e.ts > now - 30 * DAY && ((e.refunds || []).length || e.note))
      .forEach(e => out.push({ code: 'CASHIER_NOTE', sev: 'med', ts: e.recordedTs || e.ts,
        title: (e.refunds || []).length ? `Refund${e.refunds.length > 1 ? 's' : ''} at ${br.name}: ₦${Math.round(e.refundTotal || 0).toLocaleString()}` : `Cashier note at ${br.name}`,
        detail: [e.businessDate, ...(e.refunds || []).map(r => `${r.ref ? r.ref + ': ' : ''}₦${Math.round(r.amount).toLocaleString()} (${r.reason})`), e.note ? 'Note: ' + e.note : ''].filter(Boolean).join(' · '),
        accountable: e.by.name, value: Number(e.refundTotal || 0), refs: { loc: br.id } }));
    // Aronium: receipts deleted, register closes that never arrived, reports sent twice with different figures.
    const zs = ctx.events.filter(e => e.type === 'ARONIUM_ZREPORT' && e.locationId === br.id).sort((x, y) => x.zId - y.zId);
    zs.filter(z => z.ts > now - 30 * DAY && Number(z.missingDocs) > 0).forEach(z => out.push({ code: 'ARONIUM_GAP', sev: 'high', ts: z.ts,
      title: `Receipts missing in Aronium at ${br.name}`, detail: `${z.businessDate}, register close no. ${z.zNumber}: ${z.missingDocs} receipt number${z.missingDocs > 1 ? 's are' : ' is'} missing (receipts ${z.fromDoc} to ${z.toDoc}). A deleted sale is a common way to take money.`,
      value: 0, refs: { loc: br.id } }));
    for (let i = 1; i < zs.length; i++) {
      const a = Number(zs[i - 1].zNumber), b = Number(zs[i].zNumber);
      if (b > a + 1 && zs[i].ts > now - 30 * DAY) out.push({ code: 'ARONIUM_Z_SKIPPED', sev: 'med', ts: zs[i].ts, title: `A register close never arrived from ${br.name}`,
        detail: `Close no. ${a + 1}${b > a + 2 ? ' to ' + (b - 1) : ''} missing between ${zs[i - 1].businessDate} and ${zs[i].businessDate}.`, value: 0, refs: { loc: br.id } });
    }
    ctx.events.filter(e => e.type === 'SYNC_ALERT' && e.locationId === br.id && e.ts > now - 30 * DAY).forEach(e => out.push({ code: 'SYNC_CONFLICT', sev: 'high', ts: e.ts,
      title: `Aronium report changed after it was sent (${br.name})`, detail: `Register close no. ${e.report?.zNumber} (${e.report?.businessDate}) arrived again with different figures. The first one is kept; compare them in the ledger.`,
      value: 0, refs: { loc: br.id } }));
    const last7 = moneyHistory(ctx, br.id, today, 7).filter(m => m.diff !== null && m.diff !== undefined);
    const neg = last7.filter(m => m.diff < 0);
    if (neg.length >= 4) out.push({ code: 'MONEY_VARIANCE_PATTERN', sev: 'high', ts: now, title: `Money short again and again at ${br.name}`,
      detail: `Short on ${neg.length} of the last ${last7.length} days, total ₦${Math.round(-neg.reduce((s, m) => s + m.diff, 0)).toLocaleString()}`,
      value: -neg.reduce((s, m) => s + m.diff, 0), refs: { loc: br.id } });
  });
  // Branch laptops that stopped reporting.
  ctx.devices.filter(d => d.active).forEach(d => {
    const seen = d.last_seen_at ? Date.parse(d.last_seen_at) : null;
    if (!seen || now - seen > 3 * H) out.push({ code: 'SYNC_OFFLINE', sev: 'med', ts: seen || Date.parse(d.created_at),
      title: `Aronium sync not heard from: ${d.name}`, detail: `${ctx.locs[d.branch_id] || d.branch_id}. ${seen ? 'Last seen ' + new Date(seen).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' }) : 'Never connected'}. Check the laptop is on and has internet.`,
      value: 0, refs: { loc: d.branch_id } });
    else if (d.last_status && d.last_status.error) out.push({ code: 'SYNC_ERROR', sev: 'med', ts: seen, title: `Aronium sync problem: ${d.name}`, detail: String(d.last_status.error), value: 0, refs: { loc: d.branch_id } });
  });
  // Low stock in the central store (reorder levels set in Settings → Stock items).
  if (R) {
    const low = Object.entries(ctx.raw.items || []).map(([, i]) => i).filter(i => i.active && i.reorder_level !== null && i.reorder_level !== undefined
      && ((R.book.store || {})[i.id] || 0) <= Number(i.reorder_level));
    if (low.length) out.push({ code: 'LOW_STOCK', sev: 'low', ts: now, title: `${low.length} item${low.length > 1 ? 's' : ''} low in the store`,
      detail: low.map(i => `${i.name} ${r2((R.book.store || {})[i.id] || 0)}${i.count_unit ? ' ' + i.count_unit : ''} (reorder at ${i.reorder_level})`).join(', '), value: 0, refs: { loc: 'store' } });
  }
  missing(ctx, yday).forEach(m => out.push({ code: 'MISSING_SUBMISSION', sev: 'med', ts: dayRange(yday)[1] - 1,
    title: `${ctx.locs[m.loc] || m.loc}: ${m.what} not submitted yesterday`, detail: 'Follow up with the person responsible.', refs: { loc: m.loc }, value: 0 }));
  return out;
}

export const ALERT_LABEL = {
  CASHIER_NOTE: 'Cashier note',
  MONEY_VARIANCE: 'Money', MONEY_VARIANCE_PATTERN: 'Money pattern', MISSING_SUBMISSION: 'Missing',
  ARONIUM_GAP: 'Aronium', ARONIUM_Z_SKIPPED: 'Aronium', SYNC_CONFLICT: 'Aronium', SYNC_OFFLINE: 'Aronium sync', SYNC_ERROR: 'Aronium sync', LOW_STOCK: 'Low stock',
};
