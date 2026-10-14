// Vercel serverless function: staff account management.
// Holds the Supabase service key, so it must only ever run on the server.
// Actions: bootstrap (first owner), create, update, reset_pin.
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOOTSTRAP = process.env.BOOTSTRAP_CODE;
const DOMAIN = 'beiroot.staff';
const ROLES = ['owner', 'admin', 'storekeeper', 'buyer', 'driver', 'cook', 'branch_manager', 'kitchen_lead', 'cashier', 'counter'];
const BRANCH_ROLES = ['branch_manager', 'kitchen_lead', 'cashier'];

const fail = (res, code, error) => res.status(code).json({ error });
const cleanUser = u => String(u || '').trim().toLowerCase();

export default async function handler(req, res) {
  if (req.method !== 'POST') return fail(res, 405, 'Use POST.');
  if (!URL || !SERVICE) return fail(res, 500, 'The server is missing SUPABASE_SERVICE_ROLE_KEY or the Supabase URL. Add them in Vercel → Settings → Environment Variables.');
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const { action } = body;

  const validate = ({ username, pin, fullName, roles, branchId }, creating) => {
    if (creating) {
      if (!/^[a-z0-9._-]{2,30}$/.test(cleanUser(username))) return 'Username: 2–30 letters, numbers, dots or dashes, no spaces.';
      if (!fullName || !String(fullName).trim()) return 'Enter the full name.';
    }
    if (pin !== undefined && !/^\d{6}$/.test(String(pin))) return 'The PIN must be 6 digits.';
    if (roles !== undefined) {
      if (!Array.isArray(roles) || roles.some(r => !ROLES.includes(r))) return 'Unknown role.';
      if (roles.some(r => BRANCH_ROLES.includes(r)) && !branchId) return 'Branch roles need a branch.';
    }
    return null;
  };

  async function createUser({ username, pin, fullName, roles, branchId }) {
    const email = `${cleanUser(username)}@${DOMAIN}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password: String(pin), email_confirm: true });
    if (error) return { error: /already/i.test(error.message) ? 'That username is taken.' : error.message };
    const { error: e2 } = await admin.from('profiles').insert({ id: data.user.id, full_name: String(fullName).trim(),
      username: cleanUser(username), roles, branch_id: branchId || null });
    if (e2) { await admin.auth.admin.deleteUser(data.user.id); return { error: e2.message }; }
    return { id: data.user.id };
  }

  try {
    // First owner: allowed only while no owner exists, and only with the setup code.
    if (action === 'bootstrap') {
      if (!BOOTSTRAP) return fail(res, 500, 'BOOTSTRAP_CODE is not set in Vercel.');
      if (body.code !== BOOTSTRAP) return fail(res, 403, 'Wrong setup code.');
      const { count } = await admin.from('profiles').select('id', { count: 'exact', head: true }).contains('roles', ['owner']);
      if (count > 0) return fail(res, 409, 'The admin account already exists. Sign in instead.');
      const bad = validate({ ...body, roles: ['owner'] }, true); if (bad) return fail(res, 400, bad);
      const r = await createUser({ ...body, roles: ['owner'] });
      return r.error ? fail(res, 400, r.error) : res.status(200).json({ ok: true });
    }

    // Everything else: the caller must be a signed-in owner or admin.
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return fail(res, 401, 'Sign in first.');
    const { data: who, error: we } = await admin.auth.getUser(token);
    if (we || !who.user) return fail(res, 401, 'Your session expired. Sign in again.');
    const { data: me } = await admin.from('profiles').select('*').eq('id', who.user.id).single();
    if (!me || !me.active || !me.roles.some(r => r === 'owner' || r === 'admin')) return fail(res, 403, 'Only the admin or assistant admin can manage staff.');
    const isOwner = me.roles.includes('owner');
    const touchesTop = roles => (roles || []).some(r => r === 'owner' || r === 'admin');

    if (action === 'create') {
      const bad = validate(body, true); if (bad) return fail(res, 400, bad);
      if (touchesTop(body.roles) && !isOwner) return fail(res, 403, 'Only the admin can create admin or assistant admin accounts.');
      const r = await createUser(body);
      return r.error ? fail(res, 400, r.error) : res.status(200).json({ ok: true, id: r.id });
    }

    const { data: target } = await admin.from('profiles').select('*').eq('id', body.userId).single();
    if (!target) return fail(res, 404, 'Staff member not found.');
    if (touchesTop(target.roles) && !isOwner) return fail(res, 403, 'Only the admin can change an admin or assistant admin account.');

    if (action === 'update') {
      const patch = {};
      if (body.roles !== undefined) {
        const bad = validate({ roles: body.roles, branchId: body.branchId ?? target.branch_id }); if (bad) return fail(res, 400, bad);
        if (touchesTop(body.roles) && !isOwner) return fail(res, 403, 'Only the admin can give admin or assistant admin roles.');
        if (target.id === me.id && isOwner && !body.roles.includes('owner')) return fail(res, 400, 'You cannot remove your own admin role.');
        patch.roles = body.roles;
      }
      if (body.branchId !== undefined) patch.branch_id = body.branchId || null;
      if (body.fullName) patch.full_name = String(body.fullName).trim();
      if (body.active !== undefined) {
        if (target.id === me.id) return fail(res, 400, 'You cannot switch off your own account.');
        patch.active = !!body.active;
        await admin.auth.admin.updateUserById(target.id, { ban_duration: body.active ? 'none' : '876000h' });
      }
      const { error } = await admin.from('profiles').update(patch).eq('id', target.id);
      return error ? fail(res, 400, error.message) : res.status(200).json({ ok: true });
    }

    if (action === 'reset_pin') {
      const bad = validate({ pin: body.pin }); if (bad) return fail(res, 400, bad);
      const { error } = await admin.auth.admin.updateUserById(target.id, { password: String(body.pin) });
      return error ? fail(res, 400, error.message) : res.status(200).json({ ok: true });
    }

    return fail(res, 400, 'Unknown action.');
  } catch (e) {
    return fail(res, 500, e.message || 'Server error');
  }
}
