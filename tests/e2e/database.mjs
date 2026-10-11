import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const db = new PGlite();
const stub = `
create role anon; create role authenticated;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
`;
await db.exec(stub);
await db.exec(fs.readFileSync('../../supabase/setup.sql', 'utf8'));
const U = {};
const people = [
  ['owner','Ibrahim',['owner'],null],['store','Musa',['storekeeper'],null],['buyer','Tunde',['buyer'],null],
  ['driver','Yusuf',['driver'],null],['cook','Aisha',['cook'],null],['bm','Bola',['branch_manager'],'tanke'],
  ['kl','Kemi',['kitchen_lead'],'tanke'],['cash','Femi',['cashier'],'tanke'],['bm2','Sola',['branch_manager'],'adeta'],
];
for (const [k, n, roles, br] of people) {
  const id = crypto.randomUUID(); U[k] = id;
  await db.query('insert into auth.users(id) values ($1)', [id]);
  await db.query('insert into profiles(id, full_name, username, roles, branch_id) values ($1,$2,$3,$4,$5)', [id, n, k, roles, br]);
}
await db.exec(`grant select on public.profiles to authenticated`);
let n = 0, fail = 0;
async function as(who, sql, params = [], expectErr) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${U[who]}', false); set role authenticated;`);
  try {
    const r = await db.query(sql, params);
    await db.exec('reset role');
    if (expectErr) { fail++; console.log(`FAIL (expected error "${expectErr}") ${who}: ${sql}`); } else n++;
    return r.rows;
  } catch (e) {
    await db.exec('reset role');
    if (expectErr && e.message.toLowerCase().includes(expectErr.toLowerCase())) { n++; return null; }
    fail++; console.log(`FAIL ${who}: ${sql}\n   -> ${e.message}`); return null;
  }
}
const one = async (...a) => { const r = await as(...a); return r && r[0] && Object.values(r[0])[0]; };

// Store session + purchase + GRN
await as('buyer', "select store_open('x')", [], 'role cannot');
const sid = await one('store', "select store_open('Morning delivery', array['Tunde'])");
await as('store', "select store_open('again')", [], 'already open');
const po = await one('buyer', `select log_purchase('Mile 12', '[{"code":"chicken","qty":20,"unitPrice":4500},{"code":"vegetable-oil","qty":2,"inPurchaseUnits":true}]'::jsonb)`);
const pend = await one('store', 'select pending_purchases()');
if (JSON.stringify(pend).includes('"qty"')) { fail++; console.log('FAIL pending_purchases leaks qty'); } else n++;
await as('store', `select confirm_grn($1, '[{"code":"chicken","qty":18},{"code":"vegetable-oil","qty":2}]'::jsonb)`, [po]);
await as('store', `select confirm_grn($1, '[{"code":"chicken","qty":18}]'::jsonb)`, [po], 'already received');
await as('store', `select confirm_grn('PO-9', '[{"code":"nope","qty":1}]'::jsonb)`, [], 'not found');
// buyer who is also storekeeper cannot self-confirm
// Requests and release
const rq = await one('bm', `select raise_request('topup', '[{"code":"chicken","qty":5}]'::jsonb)`);
await as('driver', `select raise_request('topup', '[{"code":"chicken","qty":5}]'::jsonb)`, [], 'role cannot');
const reqs = await one('store', 'select open_requests()');
const mv = await one('store', `select release_stock($1, '[{"code":"chicken","qty":5}]'::jsonb, $2)`, [rq, U.driver]);
await as('store', `select release_stock($1, '[{"code":"chicken","qty":5}]'::jsonb, $2)`, [rq, U.driver], 'already released');
const rq2 = await one('bm', `select raise_request('planned', '[{"code":"eggs","qty":2}]'::jsonb)`);
await as('store', `select release_stock($1, '[{"code":"eggs","qty":2}]'::jsonb, $2)`, [rq2, U.cook], 'not a driver');
// Driver runs, branch incoming (blind)
const runs = await one('driver', 'select my_runs()');
const inc = await one('bm', 'select incoming_deliveries()');
if (JSON.stringify(inc).includes('"qty"')) { fail++; console.log('FAIL incoming leaks qty'); } else n++;
const inc2 = await one('bm2', 'select incoming_deliveries()');
if (inc2.length !== 0) { fail++; console.log('FAIL other branch sees delivery'); } else n++;
await as('bm2', `select confirm_receipt($1, '[{"code":"chicken","qty":5}]'::jsonb)`, [mv], 'not for your branch');
await as('bm', `select confirm_receipt($1, '[{"code":"chicken","qty":4}]'::jsonb, 'one short', 'u/p.jpg')`, [mv]);
// Kitchen
const kr = await one('cook', `select raise_request('production', '[{"code":"garlic-powder","qty":1}]'::jsonb)`);
const km = await one('store', `select release_stock($1, '[{"code":"garlic-powder","qty":1}]'::jsonb, null)`, [kr]);
const iss = await one('cook', 'select kitchen_open_issues()');
await as('cook', `select report_yield(array[$1], '[{"code":"garlic-powder","qty":1}]'::jsonb, '[{"code":"chicken","qty":3}]'::jsonb)`, [km], 'not a kitchen-made');
await as('cook', `select report_yield(array[$1], '[{"code":"garlic-powder","qty":1}]'::jsonb, '[{"code":"garlic-sauce","qty":3}]'::jsonb)`, [km]);
const iss2 = await one('cook', 'select kitchen_open_issues()');
if (iss2.length !== 0) { fail++; console.log('FAIL yield did not close issue'); } else n++;
// Write-off
await as('store', `select record_write_off('store', now() - interval '2 hours', '[{"code":"tomatoes","qty":2}]'::jsonb, 'rotten', $1, 'p.jpg')`, [U.store], 'different person');
await as('store', `select record_write_off('store', now() - interval '2 hours', '[{"code":"tomatoes","qty":2}]'::jsonb, 'rotten', $1, null)`, [U.cook], 'photo');
await as('store', `select record_write_off('store', now() - interval '2 hours', '[{"code":"tomatoes","qty":2}]'::jsonb, 'rotten', $1, 'p.jpg')`, [U.cook]);
await as('bm', `select record_write_off('adeta', now(), '[{"code":"tomatoes","qty":1}]'::jsonb, 'x', $1, 'p.jpg')`, [U.cook], 'your branch');
// Counts
const c1 = await one('kl', `select submit_count('tanke', '[{"code":"chicken","qty":3}]'::jsonb)`);
await as('kl', `select submit_count('tanke', '[{"code":"chicken","qty":3}]'::jsonb)`, [], 'already submitted');
const c2 = await one('store', `select submit_count('store', '[{"code":"chicken","qty":13}]'::jsonb)`);
if (!c2.held) { fail++; console.log('FAIL storekeeper self count not held'); } else n++;
const c3 = await one('owner', `select submit_count('store', '[{"code":"chicken","qty":13}]'::jsonb)`);
if (c3.held) { fail++; console.log('FAIL owner count held'); } else n++;
await as('kl', `select submit_count('store', '[{"code":"chicken","qty":3}]'::jsonb)`, [], 'role cannot');
// Money EOD
await as('cash', `select submit_cash_eod(lagos_today(), 13500, 243600, 0, 4900, 40550, '[{"ref":"A1","amount":1500},{"ref":"A2","amount":1800}]'::jsonb, $1, '{"cash":"c.jpg","transfer":"t.jpg","chowdeck":"d.jpg","app":"a.jpg"}'::jsonb)`, [U.cash], 'different person');
await as('cash', `select submit_cash_eod(lagos_today(), 13500, 243600, 0, 4900, 40550, '[]'::jsonb, $1, '{"cash":"c.jpg"}'::jsonb)`, [U.bm], 'Chowdeck screenshot');
await as('cash', `select submit_aronium_total(lagos_today(), 298550, 'ar.jpg')`, [], 'money received for this date first');
await as('cash', `select submit_cash_eod(lagos_today(), 13500, 243600, 0, 4900, 40550, '[{"ref":"A1","amount":1500},{"ref":"A2","amount":1800}]'::jsonb, $1, '{"cash":"c.jpg","transfer":"t.jpg","chowdeck":"d.jpg","app":"a.jpg"}'::jsonb, null, '[{"ref":"A9","amount":2500,"reason":"wrong order"}]'::jsonb)`, [U.bm]);
await as('cash', `select submit_cash_eod(lagos_today(), 1, 0, 0, 0, 0, '[]'::jsonb, $1, '{"cash":"c.jpg"}'::jsonb)`, [U.bm], 'already submitted');
await as('cash', `select submit_aronium_total(lagos_today(), 298550, 'ar.jpg')`);
await as('kl', `select submit_aronium_total(lagos_today(), 298550, 'ar.jpg')`, [], 'role cannot');
// Blind reads: staff cannot read events or other profiles
const ev = await as('cash', 'select count(*)::int as c from events');
if (ev[0].c !== 0) { fail++; console.log('FAIL cashier can read events'); } else n++;
const pr = await as('kl', 'select count(*)::int as c from profiles');
if (pr[0].c !== 1) { fail++; console.log('FAIL kitchen lead reads profiles', pr); } else n++;
const evo = await as('owner', 'select count(*)::int as c from events');
console.log('owner sees events:', evo[0].c);
// Direct writes blocked
await as('store', `insert into events(type, actor_id, actor_name, actor_role) values ('GRN', $1, 'x', 'x')`, [U.store], 'permission denied');
await as('owner', `update events set data = '{}'`, [], 'permission denied');
await db.exec('reset role');
try { await db.exec(`update events set data='{}'`); fail++; console.log('FAIL superuser update allowed'); } catch (e) { n++; }
await as('cash', 'select _me()', [], 'permission denied');
// Items: owner-only price change after set
await as('store', `update items set cost_price = 100 where id = 'flour'`);
const fl = await db.query(`select cost_price from items where id='flour'`); 
if (fl.rows[0].cost_price !== null) { fail++; console.log('FAIL storekeeper updated item'); } else n++;
await as('owner', `update items set cost_price = 100 where id = 'flour'`);
await db.exec(`select set_config('request.jwt.claim.sub', '${U.owner}', false)`);
await db.query(`update profiles set roles = array['admin'] where id = $1`, [U.bm2]);
await as('bm2', `update items set cost_price = 200 where id = 'flour'`, [], 'Only the owner');
await as('owner', `update items set cost_price = 200 where id = 'flour'`);
const ch = await db.query(`select count(*)::int c from item_changes where item_id='flour'`);
console.log('item changes logged:', ch.rows[0].c);
await as('owner', `delete from items where id='flour'`, [], 'permission denied');
// Correction + paper entry
const anyEv = (await db.query(`select id from events where type='RECEIPT'`)).rows[0].id;
await as('owner', `select record_correction($1, 'Recount found the tray', 'tanke', '[{"code":"chicken","qty":1}]'::jsonb)`, [anyEv]);
await as('store', `select record_correction($1, 'x', 'tanke', '[{"code":"chicken","qty":1}]'::jsonb)`, [anyEv], 'role cannot');
const po2 = await one('buyer', `select log_purchase('Mkt', '[{"code":"onions","qty":5}]'::jsonb, null, now() - interval '1 day', 'P-12')`);
await as('store', 'select store_close()');
await as('store', `select confirm_grn($1, '[{"code":"onions","qty":5}]'::jsonb)`, [po2], 'Open the store');
await as('store', `select confirm_grn($1, '[{"code":"onions","qty":5}]'::jsonb, now() - interval '1 day', 'B-7')`, [po2]);
await as('store', `select confirm_grn($1, '[{"code":"onions","qty":5}]'::jsonb, now() + interval '1 day', 'B-7')`, [po2], 'already');
const src = await db.query(`select type, source, paper_page from events where source='paper'`);
console.log('paper entries:', src.rows.length);
const st = await one('store', 'select store_status()');
console.log(`\n${n} checks passed, ${fail} failed`);
const dump = (await db.query(`select seq, type, occurred_at, recorded_at, actor_id, actor_name, actor_role, location_id, source, paper_page, data from events order by seq`)).rows;
fs.writeFileSync('./events.json', JSON.stringify(dump, null, 1));
