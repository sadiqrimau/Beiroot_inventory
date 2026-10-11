// Turns the ledger into the owner's reports. Pure functions: no network, easy to test.
import * as E from './engine.js';

const H = 3600e3, DAY = 24 * H;
export const dayRange = d => { const a = Date.parse(d + 'T00:00:00+01:00'); return [a, a + DAY]; };
export const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const r2 = x => Math.round(x * 100) / 100;

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
  return { items, locs, rules, events, branches, raw, settings };
}

export const run = (ctx, until) => {
  const evs = until === undefined ? ctx.events : ctx.events.filter(e => e.ts < until);
  return E.apply(evs, ctx.rules, until === undefined ? Date.now() : until - 1, { items: ctx.items, locs: ctx.locs });
};

// ---------- Money end of day (owner's format) ----------
export function money(ctx, branch, date) {
  const find = t => ctx.events.find(e => e.type === t && e.locationId === branch && e.businessDate === date);
  const c = find('CASH_EOD'), a = find('ARONIUM_TOTAL');
  if (!c && !a) return null;
  const sources = c ? { cash: +c.cash, transfer: +c.transfer, card: +c.card, chowdeck: +c.chowdeck, app: +c.app } : null;
  const received = sources ? Object.values(sources).reduce((s, v) => s + v, 0) : null;
  const delivery = c ? +c.deliveryTotal : null;
  const net = c ? received - delivery : null;
  const aronium = a ? +a.total : null;
  const diff = (c && a) ? r2(net - aronium) : null;
  const tol = Number(ctx.rules.moneyTolerance ?? 500);
  const status = diff === null ? 'incomplete' : diff === 0 ? 'balanced' : diff > 0 ? 'positive' : 'negative';
  const refunds = c ? (c.refunds || []) : [], refundTotal = c ? Number(c.refundTotal || 0) : 0;
  const diffAfterRefunds = diff === null || !refundTotal ? null : r2(diff + refundTotal);
  return { branch, date, cash: c, aron: a, sources, received, delivery, net, aronium, diff, status, refunds, refundTotal, diffAfterRefunds,
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
  if (!kc) return { branch, date, submitted: false, received };
  const counted = {}; (kc.event.lines || []).forEach(l => { counted[l.code] = Number(l.qty); });
  const rows = Object.keys(counted).map(code => {
    const used = kc.used[code] || 0, rec = received[code] || 0;
    return { code, opening: r2(used + counted[code] - rec), received: rec, counted: counted[code], used: r2(used), sold: null };
  }).filter(r => r.opening || r.received || r.counted || r.used)
    .sort((x, y) => (ctx.items[x.code]?.name || x.code).localeCompare(ctx.items[y.code]?.name || y.code));
  return { branch, date, submitted: true, by: kc.event.by.name, at: kc.event.ts, rows };
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
const liveSince = (ctx, loc) => { const e = ctx.events.find(x => x.locationId === loc || x.dest === loc || x.loc === loc); return e ? dayOf(e.ts) : null; };
export function missing(ctx, date) {
  const out = [];
  const [a, b] = dayRange(date);
  const has = (t, loc, byDate) => ctx.events.some(e => e.type === t && e.locationId === loc &&
    (byDate ? e.businessDate === date : (e.ts >= a && e.ts < b)));
  ctx.branches.forEach(br => {
    const since = liveSince(ctx, br.id);
    if (!since || since > date) return;
    if (!has('CASH_EOD', br.id, true)) out.push({ loc: br.id, what: 'Money end of day (cashier)' });
    if (!has('ARONIUM_TOTAL', br.id, true)) out.push({ loc: br.id, what: 'Aronium total (branch manager)' });
    if (!has('KITCHEN_COUNT', br.id, false)) out.push({ loc: br.id, what: 'Kitchen count (kitchen lead)' });
  });
  const storeCounted = ctx.events.some(e => e.type === 'COUNT' && e.loc === 'store' && e.custodian !== e.by.name && e.ts >= a && e.ts < b);
  const storeSince = liveSince(ctx, 'store');
  if (!storeCounted && storeSince && storeSince <= date) out.push({ loc: 'store', what: 'Blind count of the central store' });
  return out;
}

// ---------- Alerts the engine doesn't know about (money, missing work) ----------
export function extraAlerts(ctx, now = Date.now()) {
  const out = [];
  const today = dayOf(now), yday = dayOf(now - DAY);
  ctx.branches.forEach(br => {
    for (let i = 0; i < 30; i++) {
      const d = dayOf(now - i * DAY);
      const m = money(ctx, br.id, d);
      if (m && m.beyond) out.push({ code: 'MONEY_VARIANCE', sev: m.diff < 0 ? 'high' : 'med', ts: Math.max(m.cash.ts, m.aron.ts),
        title: `Money ${m.diff < 0 ? 'short' : 'over'} at ${br.name}`, detail: `${d}: received ₦${Math.round(m.net).toLocaleString()} after delivery, Aronium ₦${Math.round(m.aronium).toLocaleString()}`,
        accountable: m.cash.by.name, value: Math.abs(m.diff), refs: { loc: br.id } });
    }
    // Every refund or note from the cashier reaches the owner.
    ctx.events.filter(e => e.type === 'CASH_EOD' && e.locationId === br.id && e.ts > now - 30 * DAY && ((e.refunds || []).length || e.note))
      .forEach(e => out.push({ code: 'CASHIER_NOTE', sev: 'med', ts: e.recordedTs || e.ts,
        title: (e.refunds || []).length ? `Refund${e.refunds.length > 1 ? 's' : ''} at ${br.name}: ₦${Math.round(e.refundTotal || 0).toLocaleString()}` : `Cashier note at ${br.name}`,
        detail: [e.businessDate, ...(e.refunds || []).map(r => `${r.ref ? r.ref + ': ' : ''}₦${Math.round(r.amount).toLocaleString()} (${r.reason})`), e.note ? 'Note: ' + e.note : ''].filter(Boolean).join(' · '),
        accountable: e.by.name, value: Number(e.refundTotal || 0), refs: { loc: br.id } }));
    const last7 = moneyHistory(ctx, br.id, today, 7).filter(m => m.diff !== null && m.diff !== undefined);
    const neg = last7.filter(m => m.diff < 0);
    if (neg.length >= 4) out.push({ code: 'MONEY_VARIANCE_PATTERN', sev: 'high', ts: now, title: `Money short again and again at ${br.name}`,
      detail: `Short on ${neg.length} of the last ${last7.length} days, total ₦${Math.round(-neg.reduce((s, m) => s + m.diff, 0)).toLocaleString()}`,
      value: -neg.reduce((s, m) => s + m.diff, 0), refs: { loc: br.id } });
  });
  missing(ctx, yday).forEach(m => out.push({ code: 'MISSING_SUBMISSION', sev: 'med', ts: dayRange(yday)[1] - 1,
    title: `${ctx.locs[m.loc] || m.loc}: ${m.what} not submitted yesterday`, detail: 'Follow up with the person responsible.', refs: { loc: m.loc }, value: 0 }));
  return out;
}

export const ALERT_LABEL = {
  CASHIER_NOTE: 'Cashier note',
  MONEY_VARIANCE: 'Money', MONEY_VARIANCE_PATTERN: 'Money pattern', MISSING_SUBMISSION: 'Missing',
};
