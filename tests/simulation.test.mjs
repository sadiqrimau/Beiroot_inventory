// Regression test: the rules must keep catching the planted thefts.
// Run: npm test   (items, quantities and prices in the simulation are invented test data)
import { createRequire } from 'module';
import * as E from '../src/engine.js';
const require = createRequire(import.meta.url);
const { run, RECIPE } = require('./simulation.cjs')(E);
const BASE = ['I1','I2','I2b','I3','I4','I5','I6','I7','I8','I9','I10','I11','I13'];
const cases = [
  ['Separate driver, no yield standards', {}, [], {}, 0.82],
  ['Separate driver, yield standards', {}, [], { yieldStandards: RECIPE }, 0.89],
  ['Procurement officer drives', { combined: true }, ['J1','J2','J3'], { yieldStandards: RECIPE }, 0.96],
  ['Storekeeper drives', { storeCarry: true }, ['S1','S2','S3'], { yieldStandards: RECIPE }, 0.91],
];
let failed = 0;
for (const [label, opts, extra, rules, min] of cases) {
  const r = run(42, new Set([...BASE, ...extra]), opts);
  const out = E.apply(r.events, rules, r.end);
  let caught = 0, total = 0;
  r.incidents.forEach(i => { const m = i.match(out.alerts); total += i.loss; if (m === 'named' || m === 'location') caught += i.loss; });
  const pct = caught / total;
  const ok = pct >= min - 1e-9;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: ${Math.round(pct * 100)}% surfaced (minimum ${Math.round(min * 100)}%)`);
}
if (failed) { console.error(`${failed} regression(s)`); process.exit(1); }
