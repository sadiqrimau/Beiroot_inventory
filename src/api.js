// Data layer: Supabase client, secure function calls, photo uploads.
import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = !!(URL && KEY);
export const sb = configured ? createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null;

export const STAFF_DOMAIN = 'beiroot.staff';
export const usernameToEmail = u => `${String(u).trim().toLowerCase()}@${STAFF_DOMAIN}`;

// Turn database errors into plain sentences.
export function cleanError(err) {
  const m = (err && (err.message || err.error_description || err.msg)) || String(err || 'Something went wrong');
  if (/Invalid login credentials/i.test(m)) return 'Wrong username or PIN.';
  if (/Failed to fetch|NetworkError|network/i.test(m)) return 'No internet connection. Check the network and try again.';
  if (/JWT expired|invalid JWT/i.test(m)) return 'Your session expired. Sign in again.';
  return m.replace(/^.*?ERROR:\s*/i, '');
}

export async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw new Error(cleanError(error));
  return data;
}

export async function signIn(username, pin) {
  const { error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password: String(pin) });
  if (error) throw new Error(cleanError(error));
}
export const signOut = () => sb.auth.signOut();

// Staff accounts go through the server function (it holds the service key).
export async function staffApi(action, body) {
  const { data: s } = await sb.auth.getSession();
  const res = await fetch('/api/staff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(s.session ? { Authorization: 'Bearer ' + s.session.access_token } : {}) },
    body: JSON.stringify({ action, ...body }),
  });
  let out = {};
  try { out = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok) throw new Error(out.error || `Request failed (${res.status}). Is the site deployed on Vercel?`);
  return out;
}

// Shrink a phone photo to ~1280px JPEG before upload to save data.
async function compress(file) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
    return blob || file;
  } catch (e) { return file; }
}

export async function uploadPhoto(file, uid) {
  if (!file) return null;
  const small = await compress(file);
  const day = new Date().toISOString().slice(0, 10);
  const path = `${uid}/${day}/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.jpg`;
  const { error } = await sb.storage.from('photos').upload(path, small, { contentType: 'image/jpeg', upsert: false });
  if (error) throw new Error('Photo did not upload: ' + cleanError(error));
  return path;
}

export async function photoUrl(path) {
  const { data, error } = await sb.storage.from('photos').createSignedUrl(path, 3600);
  if (error) throw new Error(cleanError(error));
  return data.signedUrl;
}

// Owner/admin: everything needed to run the engine and reports.
export async function loadOwnerData() {
  const page = async (table, order) => {
    let rows = [], from = 0;
    for (;;) {
      const q = sb.from(table).select('*').order(order, { ascending: true }).range(from, from + 999);
      const { data, error } = await q;
      if (error) throw new Error(cleanError(error));
      rows = rows.concat(data);
      if (data.length < 1000) break;
      from += 1000;
    }
    return rows;
  };
  const optional = p => p.catch(e => { console.warn('Run the latest supabase/setup.sql:', e.message); return []; });
  const [events, items, locations, settings, profiles, menu, recipes, aliases, products, devices] = await Promise.all([
    page('events', 'seq'), page('items', 'name'), page('locations', 'id'), page('settings', 'key'), page('profiles', 'full_name'),
    page('menu_items', 'sort'), page('menu_recipe_lines', 'menu_item_id'),
    // Newer tables: if the database update hasn't been run yet, carry on without them.
    optional(page('menu_aliases', 'norm')), optional(page('aronium_products', 'name')), optional(page('sync_devices', 'created_at')),
  ]);
  return { events, items, locations, settings, profiles, menu, recipes, aliases, products, devices };
}

// Aronium item names are matched ignoring case and extra spaces (same as norm_name() in the database).
export const normName = t => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Laptop keys for Aronium sync: made in this browser, shown once; only the hash is stored.
export async function newDeviceKey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return { key, hash: [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('') };
}

export const toEngineEvent = r => ({
  ...r.data,
  id: r.id, seq: r.seq, ts: Date.parse(r.occurred_at), recordedTs: Date.parse(r.recorded_at), type: r.type,
  source: r.source, paperPage: r.paper_page, locationId: r.location_id,
  by: { name: r.actor_name, role: r.actor_role, uid: r.actor_id },
});
