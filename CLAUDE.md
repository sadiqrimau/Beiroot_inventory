# Notes for Claude

This is the Beiroot restaurant stock and reconciliation system. Before changing anything:

1. Read `docs/BUILD_SPEC.md` (the design and every decision, with status DECIDED / PROPOSED / OPEN) and `DECISIONS.md` (build-time choices).
2. Don't change anything marked DECIDED without Sadiq's say-so. Record new decisions in `DECISIONS.md` and changes in `CHANGELOG.md`.

Rules that must never be broken:

- The `events` ledger is append-only. Never add an update or delete path; fixes are `CORRECTION` events.
- Staff never read expected quantities, other people's data, Aronium totals or money results. Staff reads/writes go only through `security definer` functions in `supabase/setup.sql` that check role, branch and separation of duties. Enforce rules in the database, not only in the UI.
- Nobody checks their own figures (spec section 3.2).

Before committing:

- `npm test`: the theft simulation must still pass.
- `npm run build`.
- Database changes: add them to `supabase/setup.sql` in a way that is safe to re-run (`create or replace`, `if not exists`), and give Sadiq the exact SQL to paste into Supabase. Run `tests/e2e` (`npm run db`, then the full-day test) when touching functions or screens.

Owner's open questions are listed in `docs/BUILD_SPEC.md` section 16. Don't invent recipes, prices or units.
