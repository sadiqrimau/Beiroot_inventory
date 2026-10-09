// Usage: node run-simulation.js
// Replays a 14-day fortnight of central kitchen + 2 branches with planted thefts,
// then reports which ones the rules engine caught. Also compares role combinations.
// NOTE: item list, quantities and prices here are INVENTED test data, not the restaurant's.
const E = require('./engine.js');
const { run, RECIPE } = require('./simulation.js')(E);
const BASE = ['I1','I2','I2b','I3','I4','I5','I6','I7','I8','I9','I10','I11','I13'];
const scenarios = [
  ['Current design (separate driver), no yield standards', {}, [], {}],
  ['Current design (separate driver), with yield standards', {}, [], { yieldStandards: RECIPE }],
  ['Procurement officer also drives', { combined: true }, ['J1','J2','J3'], { yieldStandards: RECIPE }],
  ['Storekeeper also drives', { storeCarry: true }, ['S1','S2','S3'], { yieldStandards: RECIPE }],
];
for (const [label, opts, extra, rules] of scenarios) {
  const r = run(42, new Set([...BASE, ...extra]), opts);
  const out = E.apply(r.events, rules, r.end);
  let caught = 0, total = 0;
  console.log('\n=== ' + label + ' ===');
  r.incidents.forEach(i => {
    const m = i.match(out.alerts); total += i.loss; if (m === 'named' || m === 'location') caught += i.loss;
    console.log(`${i.id.padEnd(4)} day ${String(i.day).padStart(2)}  ${(m || 'MISSED').padEnd(9)} NGN ${String(Math.round(i.loss)).padStart(6)}  ${i.title}`);
  });
  console.log(`Surfaced NGN ${caught} of NGN ${total} (${Math.round(caught / total * 100)}%)`);
}
// False-positive baseline: honest operations, 5 seeds
const tot = {};
[1,2,3,4,5].forEach(sd => { const r = run(sd, new Set()); E.apply(r.events, { yieldStandards: RECIPE }, r.end).alerts.forEach(a => { const k = a.code + ':' + a.sev; tot[k] = (tot[k] || 0) + 1; }); });
console.log('\nHonest operations, alerts per fortnight (avg of 5 runs):', Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, v / 5])));
