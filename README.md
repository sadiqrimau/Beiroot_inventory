# Beiroot stock and end of day

Stock control and daily reconciliation for the restaurant's central kitchen, central store and branches.

- Every stock movement needs two people: one releases, a different one receives.
- Counts and cash are entered **blind**: the person entering never sees the expected figure.
- The ledger is **append-only**: mistakes are fixed with a correction, never an edit.
- The owner gets alerts, the money and kitchen end-of-day reports in his own format, daily stock, and a full ledger with photos.

The full design, with every decision and why, is in [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md). Build-time decisions are in [`DECISIONS.md`](DECISIONS.md).

---

## Going live: 3 accounts, about 15 minutes

Do these in order. Everything works from a phone browser.

### 1. Supabase (the database)

1. Go to [supabase.com](https://supabase.com), sign in, and create a **New project**. Pick a region close to Nigeria (e.g. *West EU (London)* or *Central EU (Frankfurt)*). Save the database password somewhere safe.
2. When the project is ready, open **SQL Editor** → **New query**.
3. Open [`supabase/setup.sql`](supabase/setup.sql) in this repository, copy **all** of it, paste it into the editor and press **Run**. It should say *Success. No rows returned*.
4. Open **Authentication** → **Sign In / Providers** (or **Providers**), and turn **off** "Allow new users to sign up". Staff accounts are created by the owner inside the app. (If you miss this, nothing breaks: someone who signs themselves up gets no access.)
5. Open **Project Settings** → **API** (in some versions **Data API** and **API Keys**) and copy three things:
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon / publishable** key
   - **service_role / secret** key: treat this like a bank PIN; it only ever goes into Vercel.

### 2. Vercel (the website)

1. Go to [vercel.com](https://vercel.com) and sign up **with your GitHub account**.
2. **Add New** → **Project** → import **Beiroot_inventory**. Vercel detects Vite automatically; leave the build settings as they are.
3. Before pressing **Create Project** / **Deploy**, open **Environment Variables** on the same page. Add these four, one at a time: type the name in the **Key** box, paste the value in the **Value** box, then add the next one.

   | Key (type exactly) | Value (where to find it) |
   | --- | --- |
   | `VITE_SUPABASE_URL` | Supabase → Project Settings → API (or Data API) → **Project URL** |
   | `VITE_SUPABASE_ANON_KEY` | Supabase → Project Settings → API Keys → **anon public** key (under "Legacy API keys" if there are two tabs) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Same page → **service_role** key (press Reveal). Keep it secret. |
   | `BOOTSTRAP_CODE` | A secret phrase you make up, e.g. `beiroot-start-2026`. You type it once when creating the owner account. |

   Leave Root Directory as `./` and Application Preset as **Vite**. Don't use the "Add Supabase" integration button; the four keys above are all the site needs.

4. Press **Deploy**. You get a live link like `beiroot-inventory.vercel.app`. Every time new code is saved to GitHub, Vercel republishes it automatically.

If you add or change an environment variable later, go to **Deployments** → **⋯** → **Redeploy**.

### 3. First sign-in

1. Open the live link → **First-time setup**.
2. Enter the `BOOTSTRAP_CODE`, and the owner's full name, username and a 6-digit PIN. This works only once.
3. Signed in as the owner, go to **Settings → Staff** and create everyone else. Each person gets a username and 6-digit PIN. Give branch roles (branch manager, kitchen lead, cashier) their branch.
4. **Settings → Branches**: the two branches are already set up as **Tanke branch** and **Adeta branch**. Add more here if the restaurant opens another.
5. **Settings → Items**: set units, bulk units and prices when the new suppliers are agreed. Until then, alerts work on quantities.

Staff can add the site to their phone's home screen (browser menu → *Add to Home screen*).

---

## Who sees what

| Role | Screens |
| --- | --- |
| Owner / admin | Today, Alerts, Reports, Stock, Ledger, Settings, Blind count |
| Storekeeper | Store: open/close, receive purchases (blind), release requests, emergency release, write-off |
| Procurement officer | Purchases: log purchases with invoice photo |
| Driver | My runs (read-only) |
| Central kitchen cook | Kitchen: request ingredients, report yield, write-off |
| Branch manager | Branch: receive deliveries (blind, photo), request stock, Aronium total, write-off |
| Kitchen lead | Tonight's count, and nothing else |
| Cashier | Money end of day, and nothing else |
| Counter | Blind count |

A person can hold several roles. The rules are checked per person in the database, e.g. nobody can receive a delivery they carried.

---

## What's in Phase 1 (live now) and what comes next

**Live:** staff logins, every stock flow, write-offs with date/time/location/witness/photo, blind counts, paper-book entries, corrections, all alerts, money end of day (owner's format), kitchen end of day (used per item), daily stock, operations report, CSV downloads, item and staff settings.

**Next (needs information from the owner):**
1. Menu measurements → Aronium sales import → kitchen "Reconciled / Discrepancy" per item.
2. Moniepoint webhook → transfer and card filled automatically.
3. Central kitchen recipes → low-yield alerts.
4. Insights page (simulator + review).

---

## For developers

```
npm install
cp .env.example .env.local     # fill in the Supabase URL and anon key
npm run dev                    # http://localhost:5173 (the /api/staff function needs Vercel: use `vercel dev`)
npm test                       # theft-simulation regression: the rules must keep catching planted thefts
```

- `src/engine.js`: the rules engine (ported from the tested prototype). Stock and alerts are computed from the ledger.
- `src/reports.js`: owner reports, as pure functions.
- `src/owner.js`, `src/staff.js`: screens. Staff screens only call database functions; the owner's screens read the ledger.
- `supabase/setup.sql`: tables, row-level security, and every function the app calls.
- `api/staff.js`: Vercel function for creating staff accounts (uses the service key).
- `tests/e2e/`: database and full-day browser tests against an embedded Postgres.
