
/* Stock ledger engine — append-only events in, stock positions + alerts out.
   Shared by the app (browser) and the simulation (node). */
(function (root) {
  const H = 3600e3, DAY = 24 * H;

  const ITEMS = {
    CHK:   { name: 'Whole chicken',        unit: 'kg',    kind: 'raw',  price: 4500 },
    BEEF:  { name: 'Minced beef',          unit: 'kg',    kind: 'raw',  price: 6000 },
    RICE:  { name: 'Rice',                 unit: 'kg',    kind: 'raw',  price: 1600 },
    TOM:   { name: 'Tomatoes',             unit: 'kg',    kind: 'raw',  price: 1500 },
    PEP:   { name: 'Pepper',               unit: 'kg',    kind: 'raw',  price: 2000 },
    ONI:   { name: 'Onions',               unit: 'kg',    kind: 'raw',  price: 1200 },
    OIL:   { name: 'Vegetable oil',        unit: 'L',     kind: 'raw',  price: 2800 },
    SPICE: { name: 'Spice mix',            unit: 'pack',  kind: 'raw',  price: 500  },
    PLANT: { name: 'Plantain',             unit: 'kg',    kind: 'raw',  price: 1000 },
    BUN:   { name: 'Burger buns (6)',      unit: 'pack',  kind: 'raw',  price: 1500 },
    PACK:  { name: 'Takeaway packs (50)',  unit: 'pack',  kind: 'raw',  price: 6000 },
    MCHK:  { name: 'Marinated chicken (20 pcs)', unit: 'tray', kind: 'semi', price: 26000 },
    JOL:   { name: 'Jollof base',          unit: 'kg',    kind: 'semi', price: 1400 },
    PATTY: { name: 'Burger patties (12)',  unit: 'tray',  kind: 'semi', price: 10000 },
    STEW:  { name: 'Stew base',            unit: 'L',     kind: 'semi', price: 2600 },
  };

  const LOCS = { store: 'Central store', kitchen: 'Central kitchen', branchA: 'Branch A', branchB: 'Branch B' };
  const BRANCHES = ['branchA', 'branchB'];

  // Defaults. yieldStandards stays empty until real yields are agreed (deliberately deferred).
  const DEFAULT_RULES = {
    countTolerancePct: 2,      // variance under this % of book (or under minAbs) is ignored
    countToleranceAbs: 0.5,
    transitHours: 6,           // dispatched but not received within this → open transit alert
    yieldDueHours: 24,         // kitchen issue with no yield report → alert
    purchaseGrnHours: 24,
    wasteWatchPct: 3,          // waste above this share of location throughput → watch
    yieldTolerancePct: 8,
    yieldStandards: {},
    countAlertValue: 5000,     // ₦ lost in one count before a gap is high priority
    writeOffWitnessValue: 5000,// ₦ write-off that needs a second person        // e.g. { MCHK: { CHK: 5, SPICE: 1 } } = inputs per 1 unit of output
  };

  const r2 = x => Math.round(x * 100) / 100;
  const add = (m, loc, code, q) => { (m[loc] = m[loc] || {}); m[loc][code] = r2((m[loc][code] || 0) + q); };
  const lineMap = lines => { const m = {}; (lines || []).forEach(l => m[l.code] = r2((m[l.code] || 0) + Number(l.qty || 0))); return m; };
  const value = lines => (lines || []).reduce((s, l) => s + Math.abs(l.qty) * ((ITEMS[l.code] || {}).price || 0), 0);
  const same = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();

  function apply(events, rulesIn, now) {
    const R = Object.assign({}, DEFAULT_RULES, rulesIn || {});
    const ev = events.slice().sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    now = now || (ev.length ? ev[ev.length - 1].ts : Date.now());

    const book = {};                 // loc -> code -> qty
    const transit = {};              // movId -> {release, lines}
    const purchases = {}, grns = {}, requests = {}, releases = {}, receipts = {};
    const sessions = {};             // sessionId -> {open, close, events:[]}
    const kitchenIssues = {};        // movId -> release (dest kitchen)
    const yields = [];
    const counts = [];               // {event, loc, variances:[{code,book,counted,diff}]}
    const throughput = {}, waste = {};
    const corrections = {};
    const alerts = [];
    const alert = (code, sev, title, detail, ev, who, refs, val) =>
      alerts.push({ code, sev, title, detail, ts: ev ? ev.ts : now, eventId: ev && ev.id, accountable: who || null, refs: refs || {}, value: Math.round(val || 0) });

    let openSession = null;

    for (const e of ev) {
      const by = e.by || {};
      switch (e.type) {
        case 'STORE_OPEN':
          sessions[e.sessionId] = { open: e, close: null, moves: 0 };
          openSession = e.sessionId; break;
        case 'STORE_CLOSE':
          if (sessions[e.sessionId]) sessions[e.sessionId].close = e;
          if (openSession === e.sessionId) openSession = null; break;

        case 'PURCHASE': purchases[e.poId] = e; break;

        case 'GRN': {
          grns[e.poId] = e;
          if (!openSession) alert('STORE_NOT_OPEN', 'high', 'Goods received with store not logged open', `PO ${e.poId}`, e, by.name);
          else sessions[openSession].moves++;
          e.lines.forEach(l => { add(book, 'store', l.code, l.qty); throughput.store = (throughput.store || 0) + l.qty; });
          const po = purchases[e.poId];
          if (!po) { alert('GRN_NO_PO', 'med', 'Goods received without a purchase record', `PO ${e.poId}`, e, by.name, { poId: e.poId }); break; }
          const bought = lineMap(po.lines), got = lineMap(e.lines);
          const short = [];
          Object.keys(bought).forEach(c => { const d = r2(bought[c] - (got[c] || 0)); if (Math.abs(d) > 0.001) short.push({ code: c, qty: d }); });
          if (short.length) alert('GRN_MISMATCH', 'high', 'Purchase and goods received differ',
            short.map(s => `${s.code} ${s.qty > 0 ? 'short' : 'over'} ${Math.abs(s.qty)}`).join(', '),
            e, po.by.name + ' / ' + by.name, { poId: e.poId }, value(short.filter(s => s.qty > 0)));
          if (same(po.by.name, by.name)) alert('SELF_RECEIVED', 'high', 'Buyer confirmed his own delivery', `PO ${e.poId}`, e, by.name, { poId: e.poId });
          break;
        }

        case 'REQUEST': requests[e.reqId] = e; break;

        case 'RELEASE': {
          releases[e.movId] = e;
          if (!openSession) alert('STORE_NOT_OPEN', 'high', 'Stock released with store not logged open', `Movement ${e.movId}`, e, by.name, { movId: e.movId });
          else sessions[openSession].moves++;
          e.lines.forEach(l => { add(book, 'store', l.code, -l.qty); throughput.store = (throughput.store || 0) + l.qty; });
          if (e.dest === 'kitchen') {
            e.lines.forEach(l => add(book, 'kitchen', l.code, l.qty));
            kitchenIssues[e.movId] = e;
          } else {
            transit[e.movId] = { release: e, lines: e.lines };
          }
          const req = e.reqId && requests[e.reqId];
          if (!req) {
            alert('EMERGENCY_RELEASE', 'med', 'Released without a request', `${e.movId} to ${LOCS[e.dest] || e.dest}${e.reason ? ' — ' + e.reason : ''}`, e, by.name, { movId: e.movId }, value(e.lines));
          } else {
            const asked = lineMap(req.lines), sent = lineMap(e.lines), over = [];
            Object.keys(sent).forEach(c => { const d = r2(sent[c] - (asked[c] || 0)); if (d > 0.001) over.push({ code: c, qty: d }); });
            if (over.length) alert('OVER_RELEASE', 'high', 'Released more than was requested', over.map(o => `${o.code} +${o.qty}`).join(', '), e, by.name, { movId: e.movId, reqId: e.reqId }, value(over));
            if (same(req.by.name, e.carrier)) alert('CARRIER_REQUESTED', 'high', 'Driver raised the request he is carrying', `${e.reqId} raised by ${req.by.name}`, e, e.carrier, { movId: e.movId, reqId: e.reqId });
          }
          break;
        }

        case 'RECEIPT': {
          receipts[e.movId] = e;
          const t = transit[e.movId], rel = releases[e.movId];
          if (!rel) { alert('RECEIPT_NO_RELEASE', 'med', 'Receipt for an unknown movement', e.movId, e, by.name); break; }
          delete transit[e.movId];
          e.lines.forEach(l => add(book, rel.dest, l.code, l.qty));
          const sent = lineMap(rel.lines), got = lineMap(e.lines), short = [];
          Object.keys(sent).forEach(c => { const d = r2(sent[c] - (got[c] || 0)); if (Math.abs(d) > 0.001) short.push({ code: c, qty: d }); });
          if (short.length) alert('TRANSIT_SHORT', 'high', 'Branch received less than was released',
            short.map(s => `${s.code} ${s.qty > 0 ? 'short' : 'over'} ${Math.abs(s.qty)}`).join(', '), e, rel.carrier, { movId: e.movId }, value(short.filter(s => s.qty > 0)));
          if (same(rel.carrier, by.name)) alert('CARRIER_RECEIVED', 'high', 'Driver confirmed his own delivery', e.movId, e, by.name, { movId: e.movId });
          if (!e.photo) alert('NO_PHOTO', 'low', 'Handover recorded without a photo', e.movId, e, rel.carrier, { movId: e.movId });
          break;
        }

        case 'YIELD': {
          yields.push(e);
          (e.inputs || []).forEach(l => add(book, 'kitchen', l.code, -l.qty));
          (e.outputs || []).forEach(l => add(book, 'store', l.code, l.qty));
          (e.issueIds || []).forEach(id => { if (kitchenIssues[id]) kitchenIssues[id].yielded = true; });
          const std = R.yieldStandards, used = lineMap(e.inputs), expect = {}, outVal = {};
          (e.outputs || []).forEach(o => { const s = std[o.code]; if (!s) return;
            Object.keys(s).forEach(c => { expect[c] = (expect[c] || 0) + s[c] * o.qty; outVal[c] = (outVal[c] || 0) + o.qty * ITEMS[o.code].price; }); });
          const low = Object.keys(expect).filter(c => expect[c] > 0 && (used[c] || 0) > expect[c] * (1 + R.yieldTolerancePct / 100));
          if (low.length) alert('LOW_YIELD', 'high', 'Yield below standard',
            low.map(c => `${used[c]} ${c} used, standard ${r2(expect[c])}`).join('; '), e, by.name, { batchId: e.batchId },
            Math.max(...low.map(c => (used[c] - expect[c]) * ITEMS[c].price)));
          break;
        }

        case 'USE': case 'WASTE': {
          e.lines.forEach(l => add(book, e.loc, l.code, -l.qty));
          if (e.type === 'WASTE') {
            waste[e.loc] = (waste[e.loc] || 0) + value(e.lines);
            if (value(e.lines) >= R.writeOffWitnessValue && (!e.witness || same(e.witness, by.name)))
              alert('WRITE_OFF_UNWITNESSED', 'high', 'Large write-off with no witness', `${LOCS[e.loc]}: ${e.lines.map(l => l.qty + ' ' + l.code).join(', ')} — ${e.reason || 'no reason'}`, e, by.name, { loc: e.loc }, value(e.lines));
          }
          else throughput[e.loc + ':v'] = (throughput[e.loc + ':v'] || 0) + value(e.lines);
          break;
        }

        case 'COUNT': {
          const b = book[e.loc] || {}, cnt = lineMap(e.lines), vs = [];
          const selfCount = e.custodian && same(e.custodian, by.name);
          const codes = new Set([...Object.keys(cnt), ...Object.keys(b).filter(c => Math.abs(b[c]) > 0.001)]);
          codes.forEach(c => {
            if (!(c in cnt) && e.partial) return;
            const bk = b[c] || 0, ct = cnt[c] || 0, d = r2(ct - bk);
            const tol = Math.max(R.countToleranceAbs, Math.abs(bk) * R.countTolerancePct / 100);
            if (Math.abs(d) > tol) vs.push({ code: c, book: bk, counted: ct, diff: d });
            if (!selfCount) add(book, e.loc, c, d);   // book follows an independent count only
          });
          counts.push({ event: e, loc: e.loc, variances: vs, held: selfCount });
          if (selfCount) {
            alert('SELF_COUNT', 'high', 'Custodian counted his own stock — count held', `${LOCS[e.loc]} counted by ${by.name}; book unchanged until an independent recount`, e, by.name, { loc: e.loc });
            break;
          }
          const lost = vs.filter(v => v.diff < 0), lostVal = value(lost.map(v => ({ code: v.code, qty: v.diff })));
          if (vs.length) alert('COUNT_VARIANCE', lostVal >= R.countAlertValue ? 'high' : 'low', `Count gap at ${LOCS[e.loc]}`,
            vs.map(v => `${v.code} ${v.diff > 0 ? '+' : ''}${v.diff}`).join(', '), e, null, { loc: e.loc }, lostVal);
          break;
        }

        case 'CORRECTION': {
          (e.lines || []).forEach(l => add(book, e.loc, l.code, l.qty));
          corrections[by.name] = (corrections[by.name] || 0) + 1;
          if (!e.refId || !e.reason) alert('BAD_CORRECTION', 'med', 'Correction without reference or reason', '', e, by.name);
          break;
        }
      }
    }

    // Time-based checks at "now"
    Object.values(transit).forEach(t => {
      if (now - t.release.ts > R.transitHours * H)
        alert('TRANSIT_OPEN', 'high', 'Dispatched but never received', `${t.release.movId} to ${LOCS[t.release.dest]}, carried by ${t.release.carrier}`, t.release, t.release.carrier, { movId: t.release.movId }, value(t.lines));
    });
    Object.values(kitchenIssues).forEach(k => {
      if (!k.yielded && now - k.ts > R.yieldDueHours * H)
        alert('NO_YIELD', 'med', 'Kitchen took stock but reported no yield', k.movId, k, k.receivedBy || 'Cooking staff', { movId: k.movId }, value(k.lines));
    });
    Object.values(purchases).forEach(p => {
      if (!grns[p.poId] && now - p.ts > R.purchaseGrnHours * H)
        alert('PURCHASE_NOT_RECEIVED', 'med', 'Purchase logged but never received', p.poId, p, p.by.name, { poId: p.poId }, value(p.lines));
    });
    Object.entries(sessions).forEach(([id, s]) => {
      if (s.moves === 0 && s.close)
        alert('IDLE_OPENING', 'med', 'Store opened with nothing recorded', `${s.open.reason || 'no reason'} — present: ${(s.open.present || []).join(', ')}`, s.open, s.open.by.name, { sessionId: id });
      if (!s.close && now - s.open.ts > 12 * H)
        alert('STORE_LEFT_OPEN', 'med', 'Store session never closed', id, s.open, s.open.by.name, { sessionId: id });
    });
    Object.keys(waste).forEach(loc => {
      const tv = (throughput[loc + ':v'] || 0) + waste[loc];
      if (tv > 0 && waste[loc] / tv * 100 > R.wasteWatchPct)
        if (throughput[loc + ':v']) alert('HIGH_WASTE', 'med', `Waste is high at ${LOCS[loc]}`, `${Math.round(waste[loc] / tv * 100)}% of stock value moved`, null, null, { loc }, waste[loc]);
    });

    alerts.sort((a, b) => b.ts - a.ts);
    return { book, transit, releases, receipts, requests, purchases, grns, sessions, yields, counts, alerts, corrections, rules: R };
  }

  const api = { ITEMS, LOCS, BRANCHES, DEFAULT_RULES, apply, value, H, DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StockEngine = api;
})(this);

