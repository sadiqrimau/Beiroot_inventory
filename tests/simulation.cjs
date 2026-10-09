function makeSim(E) {
const { ITEMS, H, DAY } = E;

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

const RECIPE = { MCHK:{CHK:5,SPICE:1}, JOL:{RICE:0.45,TOM:0.13,OIL:0.05}, PATTY:{BEEF:1.5,ONI:0.2}, STEW:{TOM:0.67,PEP:0.2,ONI:0.2,OIL:0.17} };
const BASE = { MCHK:2, JOL:15, PATTY:3, STEW:6, PLANT:8, BUN:6, PACK:2, OIL:3 };   // per branch per day
const P0 = { turnkey:'Ibrahim', store:'Musa', buyer:'Tunde', cook:'Aisha', driver:'Yusuf', A:'Bola', A2:'Ngozi', B:'Femi', B2:'Sola', counter2:'Kemi' };
const by = (name, role) => ({ name, role });
const r2 = x => Math.round(x*100)/100;

function run(seed, incidentsOn, opts) {
  opts = opts || {};
  const P = Object.assign({}, P0, opts.combined ? { driver: P0.buyer } : opts.storeCarry ? { driver: P0.store } : {});
  const rnd = mulberry32(seed);
  const U = (a,b) => a + (b-a)*rnd();
  const phys = { store:{}, kitchen:{}, branchA:{}, branchB:{}, driver:{}, outside:{} };
  const get = (l,c) => phys[l][c] || 0;
  const mv = (f,t,c,q) => { if (f) phys[f][c] = r2(get(f,c)-q); if (t) phys[t][c] = r2(get(t,c)+q); };
  const events = []; let n = 0;
  const emit = (type, ts, who, p) => { const e = Object.assign({ id: 'e'+(++n), ts, type, by: who }, p); events.push(e); return e; };
  let sess = 0, mov = 0, req = 0, po = 0, batch = 0;
  const open = (ts, reason, present) => { const id = 'S'+(++sess); emit('STORE_OPEN', ts, by(P.store,'storekeeper'), { sessionId:id, reason, present }); return id; };
  const close = (ts, id) => emit('STORE_CLOSE', ts, by(P.store,'storekeeper'), { sessionId:id });
  const incidents = [];
  const inc = (id, day, title, loss, match) => incidents.push({ id, day, title, loss, match });
  const on = id => incidentsOn && incidentsOn.has(id);
  const val = (c,q) => q * ITEMS[c].price;

  // Opening stock
  const t0 = 6*H;
  let s = open(t0, 'Opening stock', [P.store, P.turnkey]);
  const openLines = { CHK:50, SPICE:10, RICE:40, TOM:30, PEP:6, ONI:10, OIL:30, BEEF:22, PLANT:40, BUN:30, PACK:10, MCHK:4, JOL:30, PATTY:6, STEW:12 };
  const pid = 'PO'+(++po);
  emit('PURCHASE', t0, by(P.buyer,'buyer'), { poId:pid, lines:Object.entries(openLines).map(([code,qty])=>({code,qty})) });
  Object.entries(openLines).forEach(([c,q]) => mv(null,'store',c,q));
  emit('GRN', t0+60e3, by(P.store,'storekeeper'), { poId:pid, lines:Object.entries(openLines).map(([code,qty])=>({code,qty})) });
  close(t0+600e3, s);
  for (const b of ['branchA','branchB']) Object.entries(BASE).forEach(([c,q]) => { phys[b][c] = r2(q*0.6); });
  // record branch opening via a count (book starts at count)
  for (const b of ['branchA','branchB']) emit('COUNT', t0+700e3, by(b==='branchA'?P.A2:P.B2,'branch'), { loc:b, custodian: b==='branchA'?P.A:P.B, lines:Object.keys(BASE).map(c=>({code:c,qty:phys[b][c]})) });

  const DAYS = 14;
  for (let d = 1; d <= DAYS; d++) {
    const T = h => d*DAY + h*H;
    // ---------- 06:00 store session: purchases, kitchen issue, production, planned dispatch
    s = open(T(6), 'Morning operations', [P.store, P.cook, P.driver]);

    if (d % 2 === 1) {   // buy every other day
      const need = {};
      Object.entries(RECIPE).forEach(([out,ins]) => Object.entries(ins).forEach(([c,q]) => need[c] = (need[c]||0) + q*BASE[out]*2*2*1.15));
      ['PLANT','BUN','PACK','OIL'].forEach(c => need[c] = (need[c]||0) + BASE[c]*2*2*1.15);
      const lines = Object.entries(need).map(([c,q]) => ({ code:c, qty: Math.max(0, Math.ceil(q - get('store',c))) })).filter(l => l.qty>0);
      const id = 'PO'+(++po);
      let recorded = lines.map(l=>({...l})), delivered = lines.map(l=>({...l})), grn = lines.map(l=>({...l}));
      if (d===5 && on('I5')) {   // supplier short-delivers, buyer logs full amount, storekeeper counts honestly
        const L = delivered.find(l=>l.code==='CHK'); L.qty -= 3; grn.find(l=>l.code==='CHK').qty -= 3;
        inc('I5', d, 'Buyer pays for 3 kg chicken that never arrived', val('CHK',3), a => a.some(x=>x.code==='GRN_MISMATCH' && x.refs.poId===id) ? 'named' : null);
      }
      if (d===7 && on('I6')) {   // buyer + storekeeper collude: GRN records full, 5 kg rice never arrived
        delivered.find(l=>l.code==='RICE').qty -= 5;
        inc('I6', d, 'Buyer and storekeeper collude: GRN signed for 5 kg rice not delivered', val('RICE',5), locMatch('store','RICE',5,d));
      }
      emit('PURCHASE', T(6.1), by(P.buyer,'buyer'), { poId:id, lines:recorded });
      delivered.forEach(l => mv(null,'store',l.code,l.qty));
      emit('GRN', T(6.3), by(P.store,'storekeeper'), { poId:id, lines:grn });
    }

    // kitchen production: plan = both branches' base
    const plan = {}; Object.keys(RECIPE).forEach(o => plan[o] = BASE[o]*2);
    const issue = {}; Object.entries(plan).forEach(([o,q]) => Object.entries(RECIPE[o]).forEach(([c,k]) => issue[c] = r2((issue[c]||0) + k*q)));
    const kr = 'R'+(++req); emit('REQUEST', T(6.4), by(P.cook,'cook'), { reqId:kr, dest:'kitchen', kind:'production', lines:Object.entries(issue).map(([code,qty])=>({code,qty})) });
    const km = 'M'+(++mov); const issued = Object.entries(issue).map(([code,qty])=>({code, qty: Math.min(qty, get('store',code))}));
    issued.forEach(l => mv('store','kitchen',l.code,l.qty));
    emit('RELEASE', T(6.5), by(P.store,'storekeeper'), { movId:km, reqId:kr, dest:'kitchen', receivedBy:P.cook, lines:issued });
    let stolenChk = 0;
    if (d===8 && on('I7')) { stolenChk = 4; mv('kitchen','outside','CHK',stolenChk);
      const b = 'B'+(batch+1);
      inc('I7', d, 'Cooks take 4 kg chicken home; yield reported lower', val('CHK',4), a => a.some(x=>x.code==='LOW_YIELD' && x.refs.batchId===b) ? 'named' : null); }
    const outs = Object.keys(plan).map(o => {
      const ins = RECIPE[o]; let k = Infinity;
      Object.entries(ins).forEach(([c,q]) => { const have = issued.find(l=>l.code===c).qty - (c==='CHK'?stolenChk:0); k = Math.min(k, have/q); });
      return { code:o, qty: r2(Math.min(plan[o], k) * U(0.97,1.02)) };
    });
    // inputs physically consumed = everything issued (minus stolen); recorded = everything issued
    issued.forEach(l => { const q = get('kitchen',l.code); mv('kitchen',null,l.code,q); });
    outs.forEach(o => mv(null,'store',o.code,o.qty));
    emit('YIELD', T(8.5), by(P.cook,'cook'), { batchId:'B'+(++batch), issueIds:[km], inputs:issued, outputs:outs });

    // planned dispatch to each branch
    for (const b of ['branchA','branchB']) {
      const recv = b==='branchA'?P.A:P.B;
      const lines = Object.keys(BASE).map(c => ({ code:c, qty: Math.max(0, Math.round((BASE[c]*1.25 - get(b,c))*2)/2) })).filter(l=>l.qty>0);
      const rq = 'R'+(++req); emit('REQUEST', T(8.6), by(recv,'branch'), { reqId:rq, branch:b, dest:b, kind:'planned', lines });
      const m = 'M'+(++mov);
      const rel = lines.map(l => ({ code:l.code, qty: Math.min(l.qty, Math.floor(get('store',l.code)*2)/2) })).filter(l=>l.qty>0);
      rel.forEach(l => mv('store','driver',l.code,l.qty));
      let extraOil = 0;
      if (d===4 && b==='branchA' && on('I3')) { extraOil = 5; mv('store','driver','OIL',5);
        inc('I3', d, 'Storekeeper loads 5 L extra oil off the record; driver keeps it', val('OIL',5), locMatch('store','OIL',5,d)); }
      emit('RELEASE', T(9), by(P.store,'storekeeper'), { movId:m, reqId:rq, dest:b, carrier:P.driver, lines:rel });
      if (extraOil) mv('driver','outside','OIL',extraOil);
      // in transit
      const got = rel.map(l=>({...l}));
      let signed = got.map(l=>({...l}));
      if (d===2 && b==='branchA' && on('I1')) { mv('driver','outside','MCHK',1); got.find(l=>l.code==='MCHK').qty -= 1; signed = got.map(l=>({...l}));
        inc('I1', d, 'Driver skims 1 tray chicken; branch counts honestly', val('MCHK',1), a => a.some(x=>x.code==='TRANSIT_SHORT' && x.refs.movId===m) ? 'named' : null); }
      if (d===3 && b==='branchB' && on('I2')) { mv('driver','outside','PATTY',1); got.find(l=>l.code==='PATTY').qty -= 1;  // receiver signs full
        inc('I2', d, 'Driver skims 1 patty tray; receiver signs for full amount', val('PATTY',1), locMatch('branchB','PATTY',1,d)); }
      if (d===10 && b==='branchB' && on('I2b')) { mv('driver','outside','MCHK',1); got.find(l=>l.code==='MCHK').qty -= 1;
        inc('I2b', d, 'Driver + receiver collude, then cover it with extra recorded usage', val('MCHK',1), locMatch('branchB','MCHK',1,d)); phys._coverB = 1; }
      got.forEach(l => mv('driver', b, l.code, l.qty));
      // honest receipt-count slip 3%
      signed = signed.map(l => (rnd()<0.03 ? {...l, qty: l.qty - 0.5} : l));
      emit('RECEIPT', T(10), by(recv,'branch'), { movId:m, photo: rnd()>0.1, lines: signed.map(l=>({...l, status:'matched'})) });
    }
    close(T(10.5), s);

    // I8: driver raises a fake top-up in branch A's name and keeps the goods
    if (d===9 && on('I8')) {
      const rq = 'R'+(++req); const lines = [{code:'MCHK',qty:1},{code:'OIL',qty:4}];
      emit('REQUEST', T(12.9), by(P.driver,'driver'), { reqId:rq, branch:'branchA', dest:'branchA', kind:'topup', lines });
      const s2 = open(T(13), 'Top-up branch A', [P.store, P.driver]); const m = 'M'+(++mov);
      lines.forEach(l => { mv('store','driver',l.code,l.qty); mv('driver','outside',l.code,l.qty); });
      emit('RELEASE', T(13.1), by(P.store,'storekeeper'), { movId:m, reqId:rq, dest:'branchA', carrier:P.driver, lines });
      close(T(13.2), s2);
      inc('I8', d, 'Driver raises a fake top-up and keeps the goods', val('MCHK',1)+val('OIL',4), a => a.some(x=>(x.code==='CARRIER_REQUESTED'||x.code==='TRANSIT_OPEN') && x.refs.movId===m) ? 'named' : null);
    }
    // I10: emergency release with no request, never arrives
    if (d===11 && on('I10')) {
      const s2 = open(T(15), 'Urgent: branch B out of patties', [P.store, P.driver]); const m = 'M'+(++mov);
      const lines = [{code:'PATTY',qty:2}];
      lines.forEach(l => { mv('store','driver',l.code,l.qty); mv('driver','outside',l.code,l.qty); });
      emit('RELEASE', T(15.1), by(P.store,'storekeeper'), { movId:m, reqId:null, reason:'phone call from branch', dest:'branchB', carrier:P.driver, lines });
      close(T(15.2), s2);
      inc('I10', d, 'Emergency release by phone; goods never reach the branch', val('PATTY',2), a => a.some(x=>(x.code==='TRANSIT_OPEN') && x.refs.movId===m) ? 'named' : null);
    }

    if (d===6 && on('J1')) {
      const id='PO'+(++po); emit('PURCHASE', T(11), by(P.buyer,'buyer'), { poId:id, supplier:'Market', lines:[{code:'CHK',qty:15}] });
      mv(null,'branchA','CHK',12);
      inc('J1', d, 'Buys 15 kg chicken, drives it straight to a branch skipping the store, keeps 3 kg', val('CHK',3), a => a.some(x=>x.code==='PURCHASE_NOT_RECEIVED' && x.refs.poId===id) ? 'named' : null);
    }
    if (d===11 && on('J2')) {
      mv('store','outside','MCHK',2);
      inc('J2', d, 'Colludes with storekeeper: 2 trays chicken loaded off the record', val('MCHK',2), locMatch('store','MCHK',2,d));
    }
    if (d===12 && on('J3')) {
      const id='PO'+(++po); const lines=[{code:'BEEF',qty:6}];
      emit('PURCHASE', T(11), by(P.buyer,'buyer'), { poId:id, supplier:'Market', lines });
      mv(null,'store','BEEF',6); emit('GRN', T(11.2), by(P.store,'storekeeper'), { poId:id, lines });
      inc('J3', d, 'Logs and delivers 6 kg beef correctly but paid the supplier for 8 (money, not stock)', val('BEEF',2), a => null);
    }
    if (d===6 && on('S1')) {
      mv('store','outside','MCHK',1); mv('store','outside','OIL',3);
      inc('S1', d, 'Loads 1 tray chicken + 3 L oil off the record on his own run, no accomplice needed', val('MCHK',1)+val('OIL',3), locMatch('store','MCHK',1,d));
    }
    if (d===9 && on('S2')) {
      const m='M'+(++mov); const lines=[{code:'PATTY',qty:2}];
      const s2=open(T(15),'Top-up branch B',[P.store]); lines.forEach(l=>{mv('store','outside',l.code,l.qty);});
      emit('RELEASE', T(15.1), by(P.store,'storekeeper'), { movId:m, reqId:null, reason:'branch called', dest:'branchB', carrier:P.store, lines }); close(T(15.2), s2);
      inc('S2', d, 'Logs an emergency run to himself, goods never arrive', val('PATTY',2), a => a.some(x=>x.code==='TRANSIT_OPEN'&&x.refs.movId===m)?'named':null);
    }
    if (d===12 && on('S3')) {
      mv('store','outside','BEEF',2);
      inc('S3', d, 'Store left with a spare key while he delivers; 2 kg beef gone, nobody logged', val('BEEF',2), locMatch('store','BEEF',2,d));
    }
    // ---------- branch trading
    for (const b of ['branchA','branchB']) {
      const used = {};
      const half = () => Object.keys(BASE).forEach(c => { const q = r2(Math.min(get(b,c), BASE[c]*U(0.4,0.6))); mv(b,null,c,q); used[c]=(used[c]||0)+q; });
      half();
      // top-up if low
      const low = Object.keys(BASE).filter(c => get(b,c) < BASE[c]*0.35);
      if (low.length) {
        const recv = b==='branchA'?P.A:P.B;
        const lines = low.map(c => ({ code:c, qty: Math.ceil(BASE[c]*0.5) }));
        const rq = 'R'+(++req); emit('REQUEST', T(13.5), by(recv,'branch'), { reqId:rq, branch:b, dest:b, kind:'topup', lines });
        const s2 = open(T(13.6), 'Top-up '+b, [P.store, P.driver]); const m = 'M'+(++mov);
        const rel = lines.map(l => ({ code:l.code, qty: Math.min(l.qty, Math.floor(get('store',l.code))) })).filter(l=>l.qty>0);
        rel.forEach(l => mv('store','driver',l.code,l.qty));
        emit('RELEASE', T(13.7), by(P.store,'storekeeper'), { movId:m, reqId:rq, dest:b, carrier:P.driver, lines:rel });
        close(T(13.8), s2);
        let got = rel.map(l=>({...l})), signed = got.map(l=>({...l}));
        if (d===13 && b==='branchA' && on('I12') && got.length) { const L = got[0]; mv('driver','outside',L.code,1); L.qty -= 1;
          inc('I12', d, 'Driver skims a top-up run; receiver signs full', val(L.code,1), locMatch('branchA',L.code,1,d)); }
        got.forEach(l => mv('driver',b,l.code,l.qty));
        emit('RECEIPT', T(14.3), by(recv,'branch'), { movId:m, photo: rnd()>0.1, lines: signed.map(l=>({...l,status:'matched'})) });
      }
      half();
      // record usage from POS (sum of real use) — I2b covers with inflated usage
      const lines = Object.entries(used).map(([code,qty])=>({code,qty:r2(qty)}));
      if (b==='branchB' && phys._coverB) { lines.find(l=>l.code==='MCHK').qty += phys._coverB; phys._coverB = 0; }
      emit('USE', T(21), by(b==='branchA'?P.A:P.B,'branch'), { loc:b, lines });
      if (rnd()<0.3) { const c='PLANT', q = r2(Math.min(get(b,c), U(0.3,1))); mv(b,null,c,q); emit('WASTE', T(21.1), by(b==='branchA'?P.A:P.B,'branch'), { loc:b, reason:'overripe', lines:[{code:c,qty:q}] }); }
    }

    // I4: storekeeper writes off good beef as spoiled
    if (d===5 && on('I4')) { const s2 = open(T(17), 'Waste check', [P.store]); mv('store','outside','BEEF',3);
      emit('WASTE', T(17.1), by(P.store,'storekeeper'), { loc:'store', reason:'spoiled', lines:[{code:'BEEF',qty:3}] }); close(T(17.2), s2);
      inc('I4', d, 'Storekeeper takes 3 kg beef and records it as spoiled', val('BEEF',3), a => a.some(x=>x.code==='WRITE_OFF_UNWITNESSED' && x.refs.loc==='store') ? 'named' : null); }
    // I13: night entry with a copied key, no session logged
    if (d===6 && on('I13')) { mv('store','outside','PATTY',2);
      inc('I13', d, 'Night entry with a copied key, nothing logged; 2 patty trays gone', val('PATTY',2), locMatch('store','PATTY',2,d)); }
    // I9: storekeeper opens store late "to check freezer", takes chicken
    if (d===10 && on('I9')) { const s2 = open(T(22), 'Check freezer', [P.store]); mv('store','outside','MCHK',1); close(T(22.3), s2);
      inc('I9', d, 'Storekeeper opens store at night alone, takes 1 tray chicken', val('MCHK',1), a => a.some(x=>x.code==='IDLE_OPENING' && x.ts>=T(22)&&x.ts<T(23)) ? 'named' : null); }

    // ---------- 21:30 blind counts
    const counter = d===12 && on('I11') ? P.store : (d%2 ? P.turnkey : P.counter2);
    if (d===12 && on('I11')) { mv('store','outside','OIL',4);
      inc('I11', d, 'Storekeeper takes 4 L oil and does the count himself, entering the old figure', val('OIL',4), a => a.some(x=>x.code==='SELF_COUNT') && locMatch('store','OIL',4,d)(a) ? 'named' : a.some(x=>x.code==='SELF_COUNT') ? 'flag' : null); }
    const cnt = (loc, who, custodian, cheat) => {
      const codes = Object.keys(ITEMS).filter(c => get(loc,c)>0.001 || cheat&&cheat[c]);
      const lines = codes.map(c => { let q = get(loc,c); if (rnd()<0.03) q = r2(q + (rnd()<0.5?-1:1)); if (cheat&&cheat[c]) q = r2(q+cheat[c]); return { code:c, qty:Math.max(0,q) }; });
      emit('COUNT', T(21.5)+(who===P.store?0:1), by(who,'counter'), { loc, custodian, lines });
      if (who===P.store) emit('COUNT', T(21.6), by(P.turnkey,'counter'), { loc, custodian, lines: codes.map(c=>({code:c,qty:get(loc,c)})) });
    };
    cnt('store', counter, P.store, d===12 && on('I11') ? { OIL:4 } : null);
    cnt('branchA', P.A2, P.A); cnt('branchB', P.B2, P.B);
  }

  return { events, incidents, phys, end: (DAYS+1)*DAY };

  function locMatch(loc, code, qty, day) {
    return a => a.some(x => x.code==='COUNT_VARIANCE' && x.refs.loc===loc && x.ts >= day*DAY && x.ts < (day+2)*DAY && x.detail.split(', ').some(p => p.startsWith(code+' -') && Math.abs(parseFloat(p.split(' ')[1])) >= qty*0.6)) ? 'location' : null;
  }
}

return { run, RECIPE };
}
if (typeof module !== 'undefined' && module.exports) { module.exports = makeSim; }

