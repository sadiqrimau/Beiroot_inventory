// Stand-in for Supabase (auth + PostgREST + storage) and the Vercel /api/staff function,
// backed by the real setup.sql on embedded Postgres. For end-to-end testing only.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';

const DIST = '../../dist';
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon; grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;`);
await db.exec(fs.readFileSync('../../supabase/setup.sql', 'utf8'));

const users = {};          // email -> {id, pin}
const tokens = {};         // token -> id
const banned = new Set();
// The server functions' service key (api/aronium.js calls in with it).
process.env.SUPABASE_URL = 'http://localhost:5174';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
tokens['service-key'] = 'service';
let q = Promise.resolve();
const serial = fn => (q = q.then(fn, fn));

async function asUser(uid, fn) {
  return serial(async () => {
    const svc = uid === 'service';
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${svc ? '' : uid || ''}', false); set role ${svc ? 'service_role' : uid ? 'authenticated' : 'anon'};`);
    try { return await fn(); } finally { await db.exec('reset role'); }
  });
}
const procCache = {};
async function procInfo(fn) {
  if (procCache[fn]) return procCache[fn];
  const r = await serial(() => db.query(`select proretset, proargnames, array(select format_type(t, null) from unnest(proargtypes) t) as types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname = $1`, [fn]));
  return (procCache[fn] = r.rows[0]);
}
const pgArray = a => '{' + a.map(x => '"' + String(x).replace(/"/g, '\\"') + '"').join(',') + '}';

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const pgErr = (res, e) => send(res, 400, { code: 'P0001', message: e.message, details: null, hint: null });

function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); }); }

function parseFilters(u) {
  const where = [], params = [];
  for (const [k, v] of u.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k)) continue;
    const m = v.match(/^(eq|cs)\.(.*)$/);
    if (m && m[1] === 'eq') { params.push(m[2]); where.push(`"${k}" = $${params.length}`); }
    if (m && m[1] === 'cs') { params.push(m[2]); where.push(`"${k}" @> $${params.length}`); }
  }
  return { where, params };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204);
  const raw = await readBody(req);
  const body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : {};
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const uid = tokens[token];
  try {
    // ---- auth ----
    if (u.pathname === '/auth/v1/token') {
      const usr = users[body.email];
      if (!usr || usr.pin !== body.password || banned.has(usr.id)) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      const t = 't' + Math.random().toString(36).slice(2); tokens[t] = usr.id;
      return send(res, 200, { access_token: t, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r' + t,
        user: { id: usr.id, aud: 'authenticated', role: 'authenticated', email: body.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
    }
    if (u.pathname === '/auth/v1/user') return uid ? send(res, 200, { id: uid, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }) : send(res, 401, { message: 'no' });
    if (u.pathname === '/auth/v1/logout') { delete tokens[token]; return send(res, 204); }

    // ---- rpc ----
    const rm = u.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rm) {
      const info = await procInfo(rm[1]);
      if (!info) return send(res, 404, { message: 'Could not find the function ' + rm[1] });
      const names = info.proargnames || [], args = [], params = [];
      Object.entries(body || {}).forEach(([k, v]) => {
        const i = names.indexOf(k); if (i < 0) throw new Error(`Function ${rm[1]} has no parameter ${k}`);
        const t = info.types[i];
        params.push(v === null || v === undefined ? null : t === 'jsonb' || t === 'json' ? JSON.stringify(v) : t.endsWith('[]') ? pgArray(v) : v);
        args.push(`${k} => $${params.length}::${t}`);
      });
      const sql = info.proretset ? `select * from public.${rm[1]}(${args.join(', ')})` : `select public.${rm[1]}(${args.join(', ')}) as r`;
      const r = await asUser(uid, () => db.query(sql, params));
      return send(res, 200, info.proretset ? r.rows : r.rows[0].r);
    }

    // ---- tables ----
    const tm = u.pathname.match(/^\/rest\/v1\/(\w+)$/);
    if (tm) {
      const tbl = tm[1];
      const { where, params } = parseFilters(u);
      if (req.method === 'GET' || req.method === 'HEAD') {
        let sql = `select * from public.${tbl}` + (where.length ? ' where ' + where.join(' and ') : '');
        const ord = u.searchParams.get('order');
        if (ord) sql += ' order by ' + ord.split(',').map(o => { const [c, d] = o.split('.'); return `"${c}" ${d === 'desc' ? 'desc' : 'asc'}`; }).join(', ');
        if (u.searchParams.get('limit')) sql += ' limit ' + Number(u.searchParams.get('limit'));
        if (u.searchParams.get('offset')) sql += ' offset ' + Number(u.searchParams.get('offset'));
        const r = await asUser(uid, () => db.query(sql, params));
        return send(res, 200, r.rows);
      }
      if (req.method === 'PATCH') {
        const keys = Object.keys(body); const p2 = [...params];
        const sets = keys.map(k => { p2.push(body[k]); return `"${k}" = $${p2.length}`; });
        const r = await asUser(uid, () => db.query(`update public.${tbl} set ${sets.join(', ')} where ${where.join(' and ')} returning *`, p2));
        if (!r.rows.length) return send(res, 200, []);
        return send(res, 204);
      }
      if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const upsert = /merge-duplicates/.test(req.headers.prefer || '');
        for (const row of rows) {
          const keys = Object.keys(row);
          const vals = keys.map(k => typeof row[k] === 'object' && row[k] !== null ? JSON.stringify(row[k]) : row[k]);
          const pk = tbl === 'settings' ? 'key' : 'id';
          const sql = `insert into public.${tbl} (${keys.map(k => `"${k}"`).join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')})` +
            (upsert ? ` on conflict (${pk}) do update set ${keys.filter(k => k !== pk).map(k => `"${k}" = excluded."${k}"`).join(', ')}` : '');
          await asUser(uid, () => db.query(sql, vals));
        }
        return send(res, 201);
      }
    }

    // ---- storage ----
    if (u.pathname.startsWith('/storage/v1/object/sign/')) return send(res, 200, { signedURL: '/object/sign/x?token=y' });
    if (u.pathname.startsWith('/storage/v1/object/photos/')) {
      const p = u.pathname.replace('/storage/v1/object/photos/', '');
      if (!uid || !p.startsWith(uid + '/')) return send(res, 403, { message: 'new row violates row-level security policy' });
      return send(res, 200, { Key: 'photos/' + p });
    }

    // ---- /api/staff (mirrors api/staff.js rules) ----
    if (u.pathname === '/api/staff') {
      const create = async (b) => {
        const email = `${b.username.trim().toLowerCase()}@beiroot.staff`;
        if (users[email]) throw new Error('That username is taken.');
        const id = crypto.randomUUID(); users[email] = { id, pin: String(b.pin) };
        await serial(async () => { await db.query('insert into auth.users(id) values ($1)', [id]);
          await db.query('insert into profiles(id, full_name, username, roles, branch_id) values ($1,$2,$3,$4,$5)', [id, b.fullName, b.username.trim().toLowerCase(), b.roles, b.branchId || null]); });
        return id;
      };
      if (body.action === 'bootstrap') {
        if (body.code !== 'test-code') return send(res, 403, { error: 'Wrong setup code.' });
        const c = await serial(() => db.query(`select count(*)::int c from profiles where 'owner' = any(roles)`));
        if (c.rows[0].c) return send(res, 409, { error: 'The admin account already exists. Sign in instead.' });
        await create({ ...body, roles: ['owner'] }); return send(res, 200, { ok: true });
      }
      if (!uid) return send(res, 401, { error: 'Sign in first.' });
      const me = (await serial(() => db.query('select * from profiles where id = $1', [uid]))).rows[0];
      if (!me.roles.some(r => r === 'owner' || r === 'admin')) return send(res, 403, { error: 'Only the admin or assistant admin can manage staff.' });
      if (body.action === 'create') { try { const id = await create(body); return send(res, 200, { ok: true, id }); } catch (e) { return send(res, 400, { error: e.message }); } }
      if (body.action === 'update') {
        if (body.roles) await serial(() => db.query('update profiles set roles = $1, branch_id = $2 where id = $3', [body.roles, body.branchId || null, body.userId]));
        if (body.active !== undefined) { await serial(() => db.query('update profiles set active = $1 where id = $2', [!!body.active, body.userId])); if (!body.active) banned.add(body.userId); else banned.delete(body.userId); }
        return send(res, 200, { ok: true });
      }
      if (body.action === 'reset_pin') { const e = Object.values(users).find(x => x.id === body.userId); e.pin = String(body.pin); return send(res, 200, { ok: true }); }
    }

    // ---- /api/aronium: the real Vercel function, adapted ----
    if (u.pathname === '/api/aronium') {
      const { default: handler } = await import('../../api/aronium.js');
      const out = { code: 200 };
      const vres = { status(c) { out.code = c; return vres; }, json(b) { send(res, out.code, b); } };
      return handler({ method: req.method, headers: req.headers, body: raw }, vres);
    }

    // ---- static ----
    let f = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }[path.extname(f)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); res.end(fs.readFileSync(f));
  } catch (e) { pgErr(res, e); }
});

// test hook: shift event times so a "past day" exists
server.listen(5174, () => console.log('mock on 5174'));
export { db };
