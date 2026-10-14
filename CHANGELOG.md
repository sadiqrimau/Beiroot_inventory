# Changelog

## 0.4.0 (2026-10-12)

- **Aronium sync**: `sync/` program for the branch laptops and `api/aronium.js`. The Z report arrives automatically when the register is closed. Settings → **Aronium sync** to add or revoke laptops; Today shows each laptop's last contact.
- Money report checks each payment type against Aronium; missing receipt numbers flagged. Cashier at a synced branch has no Aronium step. Delivery fees record how they were paid.
- Kitchen report fills "Sold (Aronium)" with Reconciled / discrepancy per item; lists Aronium items not linked or without measurements.
- Settings → Menu: link Aronium item names to menu items (one menu for all branches). Crispy meal and Extra fries added (no price yet).
- Storekeeper: photo required at goods received, releases and emergency releases.
- Procurement officer: low-stock list (names and reorder levels only). Owner gets a `LOW_STOCK` alert.
- Kitchen report download now includes the items Aronium sold (name, menu item, quantity, sales, link status), even before the kitchen count is in.
- A branch only starts getting "not submitted" reminders once staff record something there; automatic Aronium reports alone (or a test) no longer trigger them.
- Aronium item names: only from branches with an active laptop, and names removed from Aronium drop off. Test names are cleared when setup.sql is run.
- Sync installer: sends registers closed in the last 24 hours (installing the morning after no longer skips last night's close); no more Y/N question; re-installing keeps the laptop's key.
- The owner role is shown as **Admin**, and the admin role as **Assistant admin**, everywhere on screen. Staff guides updated (storekeeper photos, low stock, delivery fee "Paid by", cashier without the Aronium step at synced branches).
- Sync 1.0.1: works with older Aronium versions (no `Payment.ZReportId`: payments are taken from the close's receipt range). On an error the laptop also reports which columns its Aronium has (Settings → Aronium sync → Technical details).
- Fix: switching tabs while a slow tab was loading could show the wrong screen.
- Database: `sync_devices`, `aronium_products`, `menu_aliases`, `norm_name`, `create_sync_device`, `set_sync_device_active`, `link_aronium_name`, `_aronium_ingest`, `_store_balance`, `low_stock`; photo argument on `confirm_grn`, `release_stock`, `emergency_release`.

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
