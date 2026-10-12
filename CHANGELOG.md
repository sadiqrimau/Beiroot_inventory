# Changelog

## 0.3.0 (2026-10-12)

- Settings → **Menu**: 45 menu items from the current posters (loaded fries split into Irish and sweet potato; slush cup ₦2,000), with price, size, Aronium name, on/off, and **measurements** per item. Change log covers menu items too.
- Database: `menu_items`, `menu_recipe_lines`, `menu_changes`, `save_menu_recipe`.

## 0.2.0 (2026-10-11)

- Cashier end of day in two steps: (1) money received, locked; (2) Aronium total with photo. Branch manager no longer enters Aronium's total.
- Refunds (order no., amount, reason) and a note for exceptions; the owner is alerted for each, sees them on Today and in the money report.
- Chowdeck and App labelled "full order value".
- Database: `submit_cash_eod` takes refunds; `submit_aronium_total` accepts the cashier and requires the money first.

## 0.1.1 (2026-10-09)

- Branches named **Tanke branch** and **Adeta branch**. `setup.sql` now also fixes a database set up with the old "Branch 2" placeholder.
- README: clearer Vercel environment-variable steps.

## 0.1.0 (2026-10-09): Phase 1

- Database: `supabase/setup.sql` with locations, staff profiles, 63 seeded items, settings, an append-only ledger, row-level security, photo storage, and 27 secure functions for every staff action.
- Staff logins by username + PIN; owner creates accounts; one-time owner setup.
- Storekeeper: store sessions, blind goods-received with expiry dates, releases against requests, emergency release, write-offs.
- Procurement officer: purchases with bulk units, prices and invoice photo.
- Driver: read-only runs.
- Central kitchen: ingredient requests, yield reports, write-offs.
- Branch manager: blind receipt at the door with photo, stock requests, Aronium total, write-offs.
- Kitchen lead: tonight's count only.
- Cashier: money end of day in the owner's format (five sources, delivery fees per order, witness, photos).
- Owner: Today, Alerts, Reports (money, kitchen, daily stock, operations, CSV), Stock, Ledger with photos and corrections, Settings (items, staff, branches, alert rules, change log), blind count.
- Paper-book entry mode on purchases, goods received, releases and receipts.
- Tests: theft-simulation regression (`npm test`), 70 database checks and a full-day browser test (`tests/e2e`).
