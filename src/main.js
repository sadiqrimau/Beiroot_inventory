import './style.css';
import { sb, configured, rpc, signIn, signOut, staffApi } from './api.js';
import { $, esc, toast, wireLineEditors } from './ui.js';
import { STAFF_TABS, countTab } from './staff.js';
import { OWNER_TABS, openPhoto, invalidate } from './owner.js';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', storekeeper: 'Storekeeper', buyer: 'Procurement', driver: 'Driver', cook: 'Kitchen',
  branch_manager: 'Branch manager', kitchen_lead: 'Kitchen lead', cashier: 'Cashier', counter: 'Counter' };

const S = { me: null, staff: [], items: [], locations: [], paper: false, tab: null, data: {} };
const app = () => $('#app');

function tabsFor(me) {
  const has = r => me.roles.includes(r);
  const all = [...OWNER_TABS, countTab, ...STAFF_TABS];
  const seen = new Set();
  return all.filter(t => t.roles.some(has) && !seen.has(t.id) && seen.add(t.id));
}

// ---------- screens ----------
function viewNotConfigured() {
  app().innerHTML = `<section class="setup"><h1>Almost there</h1><p class="lede">This site isn't connected to its database yet. In Vercel, add
    <b>VITE_SUPABASE_URL</b> and <b>VITE_SUPABASE_ANON_KEY</b> under Settings → Environment Variables, then redeploy. The README has the full steps.</p></section>`;
}

function viewLogin(msg) {
  app().innerHTML = `<section class="setup"><div class="mark">Beiroot</div><h1>Stock and end of day</h1>
    <form id="login" autocomplete="on">
      <label>Username<input id="li-user" autocomplete="username" autocapitalize="none" required></label>
      <label>PIN<input id="li-pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="6" required></label>
      <button class="primary" type="submit">Sign in</button>
      ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    </form>
    <details class="first"><summary>First-time setup</summary>
      <p class="lede">Only once, to create the owner's account. You need the setup code that was added to Vercel.</p>
      <label>Setup code<input id="bs-code" type="password"></label>
      <label>Owner's full name<input id="bs-name"></label>
      <label>Owner's username<input id="bs-user" autocapitalize="none"></label>
      <label>Owner's PIN (6 digits)<input id="bs-pin" inputmode="numeric" maxlength="6"></label>
      <button type="button" id="bs-go">Create owner account</button>
    </details></section>`;
  $('#login').onsubmit = async ev => {
    ev.preventDefault();
    const b = ev.submitter || $('#login button'); b.disabled = true; b.textContent = 'Signing in…';
    try { await signIn($('#li-user').value, $('#li-pin').value); await start(); }
    catch (e) { viewLogin(e.message); }
  };
  $('#bs-go').onclick = async () => {
    try {
      if (!/^\d{6}$/.test($('#bs-pin').value)) throw new Error('The PIN must be 6 digits.');
      await staffApi('bootstrap', { code: $('#bs-code').value, fullName: $('#bs-name').value.trim(), username: $('#bs-user').value.trim(), pin: $('#bs-pin').value });
      await signIn($('#bs-user').value, $('#bs-pin').value); await start();
    } catch (e) { toast(e.message, true); }
  };
}

async function render(reload) {
  const tabs = tabsFor(S.me);
  if (!tabs.length) {
    app().innerHTML = `<section class="setup"><h1>No role yet</h1><p class="lede">Your account has no role. Ask the owner to give you one.</p><button data-act-global="signout">Sign out</button></section>`;
    return;
  }
  if (!tabs.find(t => t.id === S.tab)) S.tab = tabs[0].id;
  const tab = tabs.find(t => t.id === S.tab);
  const shell = (body) => `
    <header><div class="brand">Beiroot</div><div class="who"><span>${esc(S.me.full_name)}</span><small>${S.me.roles.map(r => ROLE_LABEL[r] || r).join(' · ')}${S.me.branch_name ? ' · ' + esc(S.me.branch_name) : ''}</small></div>
      <button class="me" data-act-global="signout">Sign out</button></header>
    <main>${body}</main>
    ${tabs.length > 1 ? `<nav>${tabs.map(t => `<button class="${t.id === S.tab ? 'on' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</nav>` : ''}`;
  if (reload || !(S.tab in S.data)) {
    if (!app().querySelector('main')) app().innerHTML = shell('<p class="loading">Loading…</p>');
    else { app().querySelector('main').innerHTML = '<p class="loading">Loading…</p>'; }
    let loaded;
    try { loaded = await tab.load(S); }
    catch (e) { if (S.tab !== tab.id) return; app().innerHTML = shell(`<section><p class="err">${esc(e.message)}</p><button data-act-global="retry">Try again</button></section>`); return; }
    if (S.tab !== tab.id) return;   // the user moved to another tab while this one was loading
    S.data[tab.id] = loaded;
  }
  const y = window.scrollY;
  app().innerHTML = shell(tab.view(S, S.data[S.tab]));
  if (!reload) window.scrollTo(0, y);
}

async function start() {
  if (!configured) return viewNotConfigured();
  const { data } = await sb.auth.getSession();
  if (!data.session) return viewLogin();
  try {
    S.me = await rpc('my_profile');
    const [staff, items, locs] = await Promise.all([rpc('staff_directory'), rpc('item_list'), sb.from('locations').select('*').order('name')]);
    S.staff = staff; S.items = items; S.locations = locs.data || [];
  } catch (e) { await signOut(); return viewLogin(e.message); }
  S.data = {};
  await render(true);
}

// ---------- events ----------
wireLineEditors(() => S.items);

document.addEventListener('click', async ev => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.actGlobal === 'signout') { await signOut(); S.me = null; S.data = {}; invalidate(); return viewLogin(); }
  if (b.dataset.actGlobal === 'retry') return render(true);
  if (b.dataset.tab || b.dataset.set === 'setTab') S.newKey = null;   // a laptop key is shown once only
  if (b.dataset.tab) { S.tab = b.dataset.tab; window.scrollTo(0, 0); return render(true); }
  if (b.dataset.set) { S[b.dataset.set] = b.dataset.value; return render(false); }
  if (b.dataset.act === 'photo') return openPhoto(b.dataset.path);
  const name = b.dataset.act; if (!name || !S.me) return;
  const tab = tabsFor(S.me).find(t => t.id === S.tab);
  const fn = tab && tab.act && tab.act[name]; if (!fn) return;
  const label = b.textContent; b.disabled = true;
  if (!['addfee', 'rmfee', 'addrefund', 'rmrow', 'correct'].includes(name)) b.textContent = 'Saving…';
  try {
    const r = await fn(S, b);
    if (r === 'stay') { b.disabled = false; b.textContent = label; return; }
    if (r === 'rerender') return render(false);
    invalidate();
    if (['saveItem', 'addItem', 'renameLoc', 'addBranch'].includes(name)) {
      const [items, locs] = await Promise.all([rpc('item_list'), sb.from('locations').select('*').order('name')]);
      S.items = items; S.locations = locs.data || S.locations;
    }
    if (['addStaff', 'saveStaff', 'toggleStaff'].includes(name)) S.staff = await rpc('staff_directory');
    await render(true);
  } catch (e) { toast(e.message, true); b.disabled = false; b.textContent = label; }
});

document.addEventListener('change', ev => {
  const el = ev.target;
  if (el.dataset.change) { S[el.dataset.change] = el.value; render(false); }
  if (el.dataset.toggle) { S[el.dataset.toggle] = el.checked; render(false); }
});

if (sb) sb.auth.onAuthStateChange((evt) => { if (evt === 'SIGNED_OUT' && S.me) { S.me = null; viewLogin(); } });

// Sign out shared devices after 30 minutes without use.
let idle = Date.now();
['click', 'keydown', 'touchstart'].forEach(t => document.addEventListener(t, () => { idle = Date.now(); }, { passive: true }));
setInterval(async () => { if (S.me && Date.now() - idle > 30 * 60e3) { await signOut(); S.me = null; viewLogin('Signed out after 30 minutes without use.'); } }, 60e3);

start();
