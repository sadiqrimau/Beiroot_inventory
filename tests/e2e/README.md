# End-to-end tests

These run the real `supabase/setup.sql` on an embedded Postgres (PGlite), so you can test without a Supabase project.

- `npm run db`: 130 checks on the database functions: roles, blind reads, separation of duties, append-only ledger, paper entries, Aronium sync, name links, low stock.
- `npm run mock` + `npm run full-day`: serves the built app against a stand-in for Supabase and drives a whole day in a headless browser (owner setup, purchase, goods received, write-off, request, release, blind receipt, kitchen yield, kitchen count, cashier end of day, blind store count, laptop key + Aronium report through the real `api/aronium.js`, name linking, owner reports).

Before `full-day`, build the app pointing at the stand-in:

```
cd ../.. && VITE_SUPABASE_URL=http://localhost:5174 VITE_SUPABASE_ANON_KEY=anon npx vite build
cd tests/e2e && npm install && (npm run mock &) && npm run full-day
```

`full-day.mjs` needs a Chromium; set `executablePath` in it to your local browser.
