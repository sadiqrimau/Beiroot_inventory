import { chromium } from 'playwright-core';
const B = 'http://localhost:5174';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' });
const errors = [];
let step = 0;
async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_TUNNEL_CONNECTION_FAILED/.test(m.text())) errors.push(`[${name}] console: ${m.text()}`); });
  await page.goto(B);
  return page;
}
const toastText = async p => { await p.waitForSelector('#toast.show', { timeout: 8000 }); const t = await p.textContent('#toast'); await p.waitForTimeout(150); return t; };
async function expectToast(p, re, label) {
  const t = await toastText(p);
  const ok = re.test(t); step++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${t}`);
  if (!ok) errors.push(`${label}: ${t}`);
  await p.evaluate(() => { const t = document.getElementById('toast'); if (t) t.className = 'toast'; });
}
async function login(p, u, pin) {
  await p.fill('#li-user', u); await p.fill('#li-pin', pin); await p.click('#login button[type=submit]');
  await p.waitForSelector('header', { timeout: 8000 });
}
const btn = (p, text) => p.locator('button', { hasText: text }).first();
async function fillLines(p, boxId, rows) {
  for (let i = 0; i < rows.length; i++) {
    const lines = p.locator(`#${boxId} .line`);
    if (await lines.count() <= i) { await p.click(`button.add-line[data-for="${boxId}"]`); }
    const line = p.locator(`#${boxId} .line`).nth(i);
    if (rows[i].code) { await line.locator('select').selectOption(rows[i].code); }
    await p.locator(`#${boxId} .line`).nth(i).locator('.qty').fill(String(rows[i].qty));
  }
}

// --- bootstrap owner ---
const owner = await user('owner');
await owner.click('details.first summary');
await owner.fill('#bs-code', 'test-code'); await owner.fill('#bs-name', 'Ibrahim Owner'); await owner.fill('#bs-user', 'ibrahim'); await owner.fill('#bs-pin', '111111');
await owner.click('#bs-go'); await owner.waitForSelector('header'); console.log('ok   owner bootstrapped and signed in');

// --- owner creates staff ---
await btn(owner, 'Settings').click(); await btn(owner, 'Staff').click();
const staff = [['Musa Store', 'musa', ['storekeeper'], ''], ['Tunde Buyer', 'tunde', ['buyer'], ''], ['Yusuf Driver', 'yusuf', ['driver'], ''],
  ['Aisha Cook', 'aisha', ['cook'], ''], ['Bola Manager', 'bola', ['branch_manager'], 'tanke'], ['Kemi Kitchen', 'kemi', ['kitchen_lead'], 'tanke'],
  ['Femi Cashier', 'femi', ['cashier'], 'tanke'], ['Sadiq Admin', 'sadiq', ['admin'], '']];
for (const [n, u, roles, br] of staff) {
  await owner.fill('#ns-name', n); await owner.fill('#ns-user', u); await owner.fill('#ns-pin', '222222');
  for (const r of roles) await owner.check(`input[name=ns-roles][value=${r}]`);
  if (br) await owner.selectOption('#ns-branch', br);
  await btn(owner, 'Create account').click(); await expectToast(owner, /Account created/, 'create ' + u);
}
// branch role without branch is refused
await owner.fill('#ns-name', 'X'); await owner.fill('#ns-user', 'x'); await owner.fill('#ns-pin', '222222'); await owner.check('input[name=ns-roles][value=cashier]');
await btn(owner, 'Create account').click(); await expectToast(owner, /Pick the branch/, 'branch role needs branch');
// owner sets prices on two items
await btn(owner, 'Items').click();
for (const [id, price, unit] of [['chicken', 4500, 'kg'], ['shawarma-bread', 300, 'pcs']]) {
  const row = owner.locator(`tr[data-item="${id}"]`);
  await row.locator('[data-f=cost_price]').fill(String(price)); await row.locator('[data-f=count_unit]').fill(unit);
  if (id === 'chicken') await row.locator('[data-f=reorder_level]').fill('12');
  await row.locator('button', { hasText: 'Save' }).click(); await expectToast(owner, /Item saved/, 'price ' + id);
}
await btn(owner, 'Branches').click(); await owner.fill('#loc-adeta', 'Adeta branch'); await owner.locator('button[data-id=adeta]').click(); await expectToast(owner, /Saved/, 'save Adeta branch name');

// --- buyer logs purchase ---
const buyer = await user('buyer'); await login(buyer, 'tunde', '222222');
await buyer.fill('#po-supplier', 'Mile 12 market');
await fillLines(buyer, 'po-lines', [{ code: 'chicken', qty: 20 }, { code: 'shawarma-bread', qty: 100 }, { code: 'tomatoes', qty: 10 }]);
await btn(buyer, 'Log purchase').click(); await expectToast(buyer, /Logged as PO-/, 'buyer logs purchase');

// --- storekeeper: open, GRN (blind, chicken 2 short), write-off ---
const store = await user('store'); await login(store, 'musa', '222222');
await btn(store, 'Confirm goods received').click(); await expectToast(store, /Enter a number for every item/, 'GRN needs every line');
const grnBox = (await store.locator('[id^=grn-PO]').first().getAttribute('id'));
const grnHtml = await store.locator('#' + grnBox).innerHTML();
if (/value="20"|value="100"/.test(grnHtml)) errors.push('GRN shows purchase quantities'); else console.log('ok   GRN is blind');
await fillLines(store, grnBox, [{ qty: 18 }, { qty: 100 }, { qty: 10 }]);
await btn(store, 'Confirm goods received').click(); await expectToast(store, /Open the store first/, 'GRN needs open store');
await store.fill('#op-reason', 'Morning delivery'); await store.fill('#op-present', 'Tunde');
await btn(store, 'Open store').click(); await expectToast(store, /Store opened/, 'open store');
await fillLines(store, grnBox, [{ qty: 18 }, { qty: 100 }, { qty: 10 }]);
await btn(store, 'Confirm goods received').click(); await expectToast(store, /photo of the goods/, 'GRN needs photo');
await store.setInputFiles('#grn-ph-' + grnBox.slice(4), 'photo.jpg');
await btn(store, 'Confirm goods received').click(); await expectToast(store, /received/, 'GRN confirmed');
// write-off with witness + photo
await store.click('summary:has-text("Write off")');
await fillLines(store, 'wo-lines', [{ code: 'tomatoes', qty: 2 }]);
await store.fill('#wo-reason', 'Rotten on arrival');
await store.selectOption('#wo-witness', { label: 'Tunde Buyer' });
await btn(store, 'Record write-off').click(); await expectToast(store, /Add a photo/, 'write-off needs photo');
await store.setInputFiles('#wo-photo', 'photo.jpg');
await btn(store, 'Record write-off').click(); await expectToast(store, /Write-off recorded/, 'write-off recorded');

// --- branch manager requests; storekeeper releases to driver; manager receives ---
const bm = await user('bm'); await login(bm, 'bola', '222222');
await fillLines(bm, 'br-lines', [{ code: 'chicken', qty: 8 }, { code: 'shawarma-bread', qty: 40 }]);
await btn(bm, 'Send request').click(); await expectToast(bm, /Request REQ-/, 'branch request');
await store.reload(); await store.waitForSelector('header');
const relBox = await store.locator('[id^=rel-REQ]').first().getAttribute('id');
await store.selectOption(`#rel-drv-${relBox.slice(4)}`, { label: 'Yusuf Driver' });
await btn(store, 'Release stock').click(); await expectToast(store, /photo of the stock/, 'release needs photo');
await store.setInputFiles('#rel-ph-' + relBox.slice(4), 'photo.jpg');
await btn(store, 'Release stock').click(); await expectToast(store, /Released as MOV-/, 'release to driver');
// procurement officer sees chicken low (18 in, 8 out = 10, reorder at 12), without quantities
await buyer.reload(); await buyer.waitForSelector('header');
const lowTxt = await buyer.locator('.card.low').textContent().catch(() => '');
console.log((/Chicken/.test(lowTxt) && !/\b10\b/.test(lowTxt) ? 'ok  ' : 'FAIL') + ' buyer sees low stock without the balance: ' + lowTxt.replace(/\s+/g, ' ').slice(0, 160));
if (!/Chicken/.test(lowTxt)) errors.push('low stock not shown to buyer');
const drv = await user('driver'); await login(drv, 'yusuf', '222222');
const runsTxt = await drv.textContent('main'); console.log((/On the road/.test(runsTxt) ? 'ok  ' : 'FAIL') + ' driver sees run on the road');
await bm.reload(); await bm.waitForSelector('header');
const rcBox = await bm.locator('[id^=rc-MOV]').first().getAttribute('id');
const rcHtml = await bm.locator('#' + rcBox).innerHTML();
if (/value="8"|value="40"/.test(rcHtml)) errors.push('Receipt shows released quantities'); else console.log('ok   receipt is blind');
await fillLines(bm, rcBox, [{ qty: 7 }, { qty: 40 }]);
await btn(bm, 'Confirm received').click(); await expectToast(bm, /Take a photo/, 'receipt needs photo');
await bm.setInputFiles(`#rc-photo-${rcBox.slice(3)}`, 'photo.jpg');
await btn(bm, 'Confirm received').click(); await expectToast(bm, /Delivery confirmed/, 'receipt confirmed (1 short)');

// --- kitchen: cook requests, store releases, cook reports yield ---
const cook = await user('cook'); await login(cook, 'aisha', '222222');
await fillLines(cook, 'kr-lines', [{ code: 'garlic-powder', qty: 1 }]);
await btn(cook, 'Send request').click(); await expectToast(cook, /Request REQ-/, 'kitchen request');
await store.reload(); await store.waitForSelector('header');
const kBox = await store.locator('[id^=rel-REQ]').first().getAttribute('id');
await store.setInputFiles('#rel-ph-' + kBox.slice(4), 'photo.jpg');
await btn(store, 'Release stock').click(); await expectToast(store, /Released as MOV-/, 'release to kitchen');
await cook.reload(); await cook.waitForSelector('header');
const yo = await cook.locator('[id^=yo-MOV]').first().getAttribute('id');
await fillLines(cook, yo, [{ code: 'garlic-sauce', qty: 3 }]);
await btn(cook, 'Report yield').click(); await expectToast(cook, /Yield reported/, 'yield reported');
await btn(store, 'Close and lock').click(); await expectToast(store, /Store closed/, 'close store');

// --- kitchen lead count (blind; sees nothing else) ---
const kl = await user('kl'); await login(kl, 'kemi', '222222');
const navCount = await kl.locator('nav').count(); console.log((navCount === 0 ? 'ok  ' : 'FAIL') + ' kitchen lead has a single screen');
await btn(kl, 'Submit count').click(); await expectToast(kl, /Enter a number for every item/, 'count needs every item');
const n = await kl.locator('#kc-daily .line').count();
const vals = []; for (let i = 0; i < n; i++) vals.push({ qty: 0 });
const daily = await kl.locator('#kc-daily .fixed').evaluateAll(els => els.map(e => e.dataset.code));
const ci = daily.indexOf('chicken'), si = daily.indexOf('shawarma-bread');
vals[ci] = { qty: 3 }; vals[si] = { qty: 26 };
await fillLines(kl, 'kc-daily', vals);
await btn(kl, 'Submit count').click(); await expectToast(kl, /Count submitted/, 'kitchen count');
const klTxt = await kl.textContent('main'); console.log((/submitted/.test(klTxt) ? 'ok  ' : 'FAIL') + ' kitchen lead sees only "submitted"');

// --- cashier ---
const cash = await user('cash'); await login(cash, 'femi', '222222');
await cash.fill('#ce-cash', '13500'); await cash.fill('#ce-transfer', '243600'); await cash.fill('#ce-chowdeck', '4900'); await cash.fill('#ce-app', '40550');
await cash.selectOption('#ce-witness', { label: 'Bola Manager' });
await btn(cash, 'Add delivery').click(); await btn(cash, 'Add delivery').click();
await cash.locator('.fee-ref').nth(0).fill('A101'); await cash.locator('.fee-amt').nth(0).fill('1500');
await cash.locator('.fee-ref').nth(1).fill('A102'); await cash.locator('.fee-amt').nth(1).fill('1800');
await btn(cash, 'Submit money received').click(); await expectToast(cash, /how each delivery fee was paid|photo of the counted cash/, 'fee needs payment type (or cash photo first)');
await cash.locator('.fee-how').nth(0).selectOption('cash'); await cash.locator('.fee-how').nth(1).selectOption('transfer');
await btn(cash, 'Add refund').click();
await cash.locator('.rf-ref').nth(0).fill('A099'); await cash.locator('.rf-amt').nth(0).fill('2500'); await cash.locator('.rf-why').nth(0).fill('Wrong order sent');
await cash.fill('#ce-note', 'POS network was down for an hour');
await btn(cash, 'Submit money received').click(); await expectToast(cash, /photo of the counted cash/, 'cash needs photo');
for (const k of ['cash', 'transfer', 'chowdeck', 'app']) await cash.setInputFiles('#ce-ph-' + k, 'photo.jpg');
await btn(cash, 'Submit money received').click(); await expectToast(cash, /Money received saved/, 'cash EOD step 1');
const step2 = await cash.textContent('main');
if (/298,550|\+₦700|Difference/.test(step2)) errors.push('cashier sees result after step 1'); else console.log('ok   step 2 shows no result');
await cash.fill('#ar-total', '298550'); await cash.setInputFiles('#ar-photo', 'photo.jpg');
await btn(cash, 'Submit Aronium total').click(); await expectToast(cash, /End of day complete/, 'cash EOD step 2 (Aronium)');
const cashTxt = await cash.textContent('main');
if (/298,550|700/.test(cashTxt)) errors.push('cashier can see Aronium total or difference'); else console.log('ok   cashier sees no totals');

// --- admin does a blind count of the store (chicken counted 1 short of book) ---
const adm = await user('admin'); await login(adm, 'sadiq', '222222');
await btn(adm, 'Blind count').click();
const ctCodes = await adm.locator('#ct-lines .fixed').evaluateAll(els => els.map(e => e.dataset.code));
const ctv = ctCodes.map(c => c === 'chicken' ? { qty: 9 } : c === 'shawarma-bread' ? { qty: 60 } : { qty: '' });
for (let i = 0; i < ctv.length; i++) if (ctv[i].qty !== '') await adm.locator('#ct-lines .line').nth(i).locator('.qty').fill(String(ctv[i].qty));
await btn(adm, 'Submit count').click(); await expectToast(adm, /Count saved/, 'admin store count');

// --- owner: menu ---
await owner.reload(); await owner.waitForSelector('header');
await btn(owner, 'Settings').click(); await owner.waitForSelector('.menu-row');
const menuRows = await owner.locator('.menu-row').count(); console.log((menuRows === 47 ? 'ok  ' : 'FAIL') + ' menu shows 47 items: ' + menuRows);
const wrap = owner.locator('.menu-row[data-menu="wrap-regular"]');
await wrap.locator('summary').click();
await fillLines(owner, 'mr-wrap-regular', [{ code: 'shawarma-bread', qty: 1 }, { code: 'chicken', qty: 0.12 }]);
await wrap.locator('button', { hasText: 'Save measurements' }).click(); await expectToast(owner, /Measurements saved/, 'menu measurements');
await owner.locator('.menu-row[data-menu="wrap-regular"] [data-f=aronium_name]').fill('Chicken Wrap Regular');
await owner.locator('.menu-row[data-menu="wrap-regular"] button', { hasText: 'Save' }).first().click(); await expectToast(owner, /Menu item saved/, 'menu aronium name');
await owner.fill('#nm-cat', 'Drinks'); await owner.fill('#nm-name', 'Water'); await owner.fill('#nm-price', '300');
await btn(owner, 'Add to menu').click(); await expectToast(owner, /Added to the menu/, 'add menu item');
const sumTxt = await owner.locator('.menu-row[data-menu="wrap-regular"] summary').textContent(); console.log((/2 items/.test(sumTxt) ? 'ok  ' : 'FAIL') + ' measurements count shown: ' + sumTxt.trim());
await owner.screenshot({ path: 'shot-menu.png', fullPage: false });

// --- owner adds the Tanke laptop; the laptop sends tonight's Aronium report ---
await btn(owner, 'Aronium sync').click();
await owner.fill('#nd-name', 'Tanke counter laptop'); await owner.selectOption('#nd-branch', 'tanke');
await btn(owner, 'Create key').click(); await expectToast(owner, /Key created/, 'laptop key created');
const devKey = (await owner.textContent('.keybox')).trim();
await owner.screenshot({ path: 'shot-sync.png', fullPage: true });
await btn(owner, 'Done').click();
if (await owner.locator('.keybox').count()) errors.push('key still shown after Done'); else console.log('ok   key hidden after Done');
const lagos = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
const post = (key, body) => fetch(B + '/api/aronium', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body) }).then(async r => ({ code: r.status, body: await r.json() }));
const zrep = { zId: 7, zNumber: 5, closedAt: `${lagos} 22:30:00`, fromDoc: 100, toDoc: 140, docCount: 40, missingDocs: 1, salesCount: 39, salesTotal: 299950, refundTotal: 0, refundCount: 0,
  payments: [{ name: 'Cash', amount: 12700 }, { name: 'Transfer', amount: 241800 }, { name: 'CHOWDECK', amount: 4900 }, { name: 'APP', amount: 40550 }],
  items: [{ name: 'chicken wrap regular ', qty: 5, total: 17500 }, { name: 'Beiroot Bomb', qty: 2, total: 9800 }] };
let r1 = await post('wrong-key-wrong-key-wrong', { kind: 'heartbeat' }); console.log((r1.code === 403 ? 'ok  ' : 'FAIL') + ' unknown laptop key refused');
r1 = await post(devKey, { kind: 'zreport', report: zrep }); console.log((r1.body.ok ? 'ok  ' : 'FAIL') + ' Z report accepted: ' + JSON.stringify(r1.body));
r1 = await post(devKey, { kind: 'products', products: [{ name: 'Beiroot Bomb', price: 4900, group: 'Subs' }, { name: 'Chicken Wrap Regular', price: 3500 }] });
r1 = await post(devKey, { kind: 'heartbeat', status: { version: '1.0.0', computer: 'TANKE-PC' } });
// cashier at a synced branch has no Aronium step and still sees no figures
await cash.reload(); await cash.waitForSelector('main .done');
const cashAuto = await cash.textContent('main');
console.log((/sent to the owner automatically/.test(cashAuto) && !/12,700|299,950/.test(cashAuto) ? 'ok  ' : 'FAIL') + ' cashier: automatic, no figures');
// owner links the unlinked Aronium name
await owner.reload(); await owner.waitForSelector('header'); await btn(owner, 'Settings').click(); await owner.waitForSelector('.menu-row');
const unl = await owner.locator('.unlinked').textContent(); console.log((/Beiroot Bomb/.test(unl) && !/Chicken Wrap Regular/i.test(unl) ? 'ok  ' : 'FAIL') + ' unlinked list: ' + unl.replace(/\s+/g, ' ').slice(0, 120));
await owner.locator('select[data-alias="Beiroot Bomb"]').selectOption('sub-bomb-regular');
await owner.locator('button[data-act=linkAlias][data-name="Beiroot Bomb"]').click(); await expectToast(owner, /Linked/, 'link Aronium name');
const aliasTxt = await owner.locator('.menu-row[data-menu="sub-bomb-regular"]').textContent(); console.log((/Beiroot Bomb/.test(aliasTxt) ? 'ok  ' : 'FAIL') + ' alias shown on the menu item');

// --- owner reviews ---
await owner.reload(); await owner.waitForSelector('header');
await btn(owner, 'Today').click(); await owner.waitForSelector('.headline');
const today = await owner.textContent('main');
console.log('owner today:', today.replace(/\s+/g, ' ').slice(0, 400));
await btn(owner, 'Alerts').click(); await owner.waitForTimeout(300);
const al = await owner.locator('.alerts li b').allTextContents(); console.log('alerts:', al);
console.log((al.some(a => /Receipts missing in Aronium/.test(a)) ? 'ok  ' : 'FAIL') + ' missing-receipt alert');
await btn(owner, 'Reports').click(); await owner.waitForSelector('.recon, .card');
const money = await owner.locator('.recon').first().textContent(); console.log('money:', money.replace(/\s+/g, ' ').slice(0, 900));
console.log((/By payment type/.test(money) && /receipt number missing/.test(money) && /−₦700|-₦700/.test(money) ? 'ok  ' : 'FAIL') + ' money report: per type, missing receipt, short ₦700');
await owner.screenshot({ path: 'shot-money.png', fullPage: true });
await btn(owner, 'Kitchen end of day').click(); await owner.waitForTimeout(300);
const kt = (await owner.textContent('main')).replace(/\s+/g, ' ');
console.log('kitchen:', kt.slice(0, 700));
console.log((/9 more used than sold/.test(kt) ? 'ok  ' : 'FAIL') + ' kitchen: bread 14 used vs 5 sold flagged');
const [dl] = await Promise.all([owner.waitForEvent('download'), btn(owner, 'Download this report').click()]);
const csvTxt = (await import('fs')).readFileSync(await dl.path(), 'utf8');
console.log((/Items sold \(Aronium\)/.test(csvTxt) && /Beiroot Bomb,.*,2,9800,Linked, measurements not set|Beiroot Bomb,Regular Beiroot Bomb \(chicken \+ beef\),2,9800/.test(csvTxt) && /chicken wrap regular,Regular Chicken wrap,5,17500,Linked/.test(csvTxt) ? 'ok  ' : 'FAIL') + ' kitchen CSV lists items sold');
if (!/Items sold/.test(csvTxt)) console.log(csvTxt);
await owner.screenshot({ path: 'shot-kitchen.png', fullPage: true });
await btn(owner, 'Daily stock').click(); await owner.waitForTimeout(300);
console.log('stock:', (await owner.textContent('main')).replace(/\s+/g, ' ').slice(0, 500));
await btn(owner, 'Operations').click(); await owner.waitForTimeout(300);
await btn(owner, 'Ledger').click(); await owner.waitForTimeout(300);
const led = await owner.locator('.log li').count(); console.log('ledger entries:', led);
await btn(owner, 'Today').click(); await owner.waitForTimeout(300);
await owner.screenshot({ path: 'shot-today.png', fullPage: true });
await store.screenshot({ path: 'shot-store.png', fullPage: true });
await cash.reload(); await cash.waitForSelector('header'); await cash.screenshot({ path: 'shot-cash.png', fullPage: true });

console.log(`\n${errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No errors.'}`);
await browser.close();
process.exit(0);
