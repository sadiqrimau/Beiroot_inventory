// Vercel serverless function: receives Aronium reports from the branch laptops.
// The laptop sends `Authorization: Bearer <device key>`. Only the key's SHA-256 hash
// is stored; all checks and the ledger write happen in the database (_aronium_ingest).
// Kinds: heartbeat, zreport, products.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

const fail = (res, code, error) => res.status(code).json({ ok: false, error });

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'beiroot-aronium-sync' });
  if (req.method !== 'POST') return fail(res, 405, 'Use POST.');
  if (!URL || !SERVICE) return fail(res, 500, 'Server not configured (Supabase URL or service key missing).');
  const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(key)) return fail(res, 401, 'Missing or malformed device key.');
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (e) { return fail(res, 400, 'Body is not JSON.'); }
  const kind = body.kind;
  if (!['heartbeat', 'zreport', 'products'].includes(kind)) return fail(res, 400, 'Unknown kind.');

  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const hash = createHash('sha256').update(key).digest('hex');
  const { data, error } = await admin.rpc('_aronium_ingest', { p_key_hash: hash, p_kind: kind, p_body: body });
  if (error) {
    const m = error.message || '';
    if (/unknown or revoked device/.test(m)) return fail(res, 403, 'This laptop key is not recognised or was revoked. Create a new key in Settings → Aronium sync.');
    return fail(res, 400, m);
  }
  return res.status(200).json(data);
}
