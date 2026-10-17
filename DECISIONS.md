# Decisions

The design decisions come from [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md). This file records choices made while building, and anything that differs from the spec. Newest first.

## 2026-10-17: Photo of the items bought

The owner asked that the procurement officer photographs the items bought, not only the receipt. `log_purchase` now requires `p_goods_photo` (except paper-book entries). The invoice photo stays optional, because market purchases often have no receipt.

## 2026-10-14: The owner is shown as "Admin"

The owner asked to be called **Admin**, not Owner. Only the wording on screen changed: the `owner` role is shown as **Admin** and the `admin` role as **Assistant admin**, in the app, the error messages and the staff guides. Role ids and permissions are unchanged (only the Admin can change a price or unit once set, the alert rules, and admin accounts).

## 2026-10-12: Aronium sync, storekeeper photos, low stock

| Decision | Detail |
| --- | --- |
| **Each branch laptop sends Aronium's end-of-day report automatically** (`sync/`). The cashier only closes the register; nothing is printed. | Owner did not want the report printed (leaks). The laptops are Windows with internet. A small PowerShell program reads Aronium's `pos.db` **read-only** with Aronium's own SQLite reader and posts to `api/aronium.js` every 5 minutes. |
| **Laptop keys**: made in the owner's browser (Settings → Aronium sync), shown once; only the SHA-256 hash is stored (`sync_devices`). Revoking a key stops that laptop. | A stolen key can only send reports for its own branch. All checks and the ledger write are in the database (`_aronium_ingest`, callable only with the service key). |
| **Report = `ARONIUM_ZREPORT` in the ledger** (source `import`): payments by type mapped to the five sources, sales and refund totals, items sold, and missing receipt numbers. **Business day** = the close time in Lagos; closed before 06:00 counts for the day before. | A close is stored once. Sent again with different figures → kept as first sent, `SYNC_CONFLICT` alert. |
| **At a synced branch the cashier has no Aronium step**, and `submit_aronium_total` refuses. Branches without a laptop keep the manual step. | Removes the "cashier holds both sides" risk recorded on 2026-10-11. |
| **Money is checked per payment type** when the report is automatic: counted − fees paid that way − Aronium's figure. The cashier now says how each delivery fee was paid. | Shows a payment rung up under the wrong type, and narrows a shortage to cash, transfer, etc. |
| **New alerts**: `ARONIUM_GAP` (receipt numbers missing: a deleted sale), `ARONIUM_Z_SKIPPED` (a register close never arrived), `SYNC_CONFLICT`, `SYNC_OFFLINE` (laptop silent 3 h), `SYNC_ERROR`, `LOW_STOCK`. | |
| **One menu for all branches, plus name links.** Aronium names match a menu item ignoring capitals and spaces, by "Name in Aronium" or a link the owner makes once (`menu_aliases`, logged in the change log). Unlinked names are listed in Settings → Menu. | Owner's answer: "uniform menu … can we implement both?" Names in Aronium have typos and trailing spaces. |
| **Kitchen report "Sold (Aronium)"** = items sold × menu measurements; Reconciled / discrepancy per stock item (count tolerance). | Switches on per item as measurements are filled in. |
| **Storekeeper photos are required** at goods received, releases and emergency releases (not for paper-book entries). | Friend's feedback: "photo upload by staff (mainly storekeeper)". Confirm with the owner these are the right moments. |
| **Low stock goes to the procurement officer** as a list of item names and reorder levels only, plus "already bought". The store balance is never shown to staff. | Friend's feedback. Balance = last independent store count + movements since (`_store_balance`). Reorder levels set per item in Settings → Stock items. |
| **Crispy meal and Extra fries** added to the menu with no price (owner sets it). | User's answer. |

## 2026-10-12: Menu

- The owner manages the menu in **Settings → Menu**: add items, edit name/size/price, switch off (never delete). Seeded with the **orange menu posters** (37 items).
- The orange posters are the menu. The white "THE MENU" sheet is not used; the owner handles any changes himself in Settings → Menu.
- Each menu item has a **Name in Aronium** field. It must match Aronium exactly so sales can be matched to measurements later.
- **Measurements** (stock used per portion) are attached per menu item and saved in one step through `save_menu_recipe`, which logs each change.
- Once set, a menu price can only be changed by the owner. Every change is in the change log.
- Aronium records Irish and sweet loaded fries separately, so they are **separate menu items** (7 each, same prices), because they use different stock.
- **Slush** is sold by the cup at ₦2,000 (Drinks).
- 45 menu items in total.

## 2026-10-11: Money end of day: owner's answers

| Decision | Detail |
| --- | --- |
| **All five money sources are entered by the cashier**, with a photo or screenshot each. | Moniepoint terminals and the restaurant's own app are not to be connected. Chowdeck is third-party. |
| **Chowdeck and App amounts are the full order value**, as Aronium records them. | So the totals compare like for like. (Assumed from "same as delivery fees"; confirm with the owner.) |
| **Delivery fees are listed per order by the cashier.** | Unchanged. |
| **The cashier also enters Aronium's total, in two steps.** Step 1 locks the money received; only then does step 2 accept Aronium's total, with a photo of the report. | Owner's choice until the branch laptops are integrated. Risk: one person holds both sides. Mitigations: the photo (owner checks it), money locked before Aronium, and kitchen stock gaps reveal unrecorded sales. |
| **Refunds** (order no., amount, reason) and a **note for exceptions**. Every refund or note raises a `CASHIER_NOTE` alert, appears on the owner's Today screen and in the money report, with "difference if the refunds explain it". | Owner asked to be alerted to exceptions and refunds. |
| **Money alert threshold stays at ₦500.** | Owner confirmed. |

## 2026-10-09: Branch names

The branches are **Tanke branch** (id `tanke`) and **Adeta branch** (id `adeta`). The placeholder "Branch 2" is gone. Names carry the word "branch" and differ from the first letter on, so they can't be confused on screen. Ids never change, so renaming a branch later never breaks past records.

## 2026-10-09: Phase 1 build

| Decision | Why |
| --- | --- |
| **Vite + plain JavaScript**, reusing the prototype's screens and styling, instead of Next.js. | Monday deadline; the owner already approved the prototype's look; the engine was already plain JS. |
| **One append-only `events` table** in the prototype's event shape; stock and alerts computed by `src/engine.js`. | Reuses the tested engine unchanged; the theft simulation still passes (`npm test`). |
| **Staff never read the ledger.** Every staff read and write goes through a `security definer` database function that checks role, branch and separation of duties. Only owner/admin can `select` from `events`. | Blind entry must be enforced by the database, not hidden in the UI. |
| **Login = username + 6-digit PIN**, stored as `username@beiroot.staff` in Supabase Auth. Accounts are created by the owner via `api/staff.js`. First owner via a one-time `BOOTSTRAP_CODE`. | Staff may not have email. |
| **Write-offs always need a witness and a photo** (spec: witness only above ₦5,000). | Simpler rule for staff, and unpriced items have no value to compare against yet. |
| **Corrections: owner/admin only** (Phase 1). Staff report mistakes to the owner. | Letting staff correct their own entries would let them hide gaps. |
| **Storekeeper counting his own store** (and cook counting the kitchen, manager counting his branch) is saved but **held**: stock figures don't follow it, and `SELF_COUNT` fires. | Spec section 6.7; the first simulation showed self-counts erase theft. |
| **Kitchen lead's count** is its own event (`KITCHEN_COUNT`). "Used" = opening + received − counted. "Sold (Aronium)" and Reconciled/Discrepancy switch on when recipes + sales import exist. | Recipes are not in yet (open question 1). |
| **Money end of day, Phase 1:** the cashier enters all five sources with a photo/screenshot each; the **branch manager** enters Aronium's total with a photo of the report. The cashier never sees the Aronium figure. | Moniepoint webhook and Aronium import come in Phase 2. |
| **Delivery fees are listed per order**, not as one total. | A smaller total could hide a shortage (spec 6.12). |
| **Paper-book entries** (offline fallback) accept a page number and the time written on paper, up to 7 days back; older ones go through an owner correction. They don't raise "store not open". | Spec 6.9. |
| **Unpriced items:** a count loss of 2 or more units is high priority (`countAlertQty`). | Prices are not set yet (open question 3). |
| **New alerts:** `BACKDATED_WRITE_OFF` (recorded > 12h after it happened), `COUNT_ABOVE_DELIVERED` (branch has more than was delivered: stock arriving outside the system), `MONEY_VARIANCE`, `MONEY_VARIANCE_PATTERN` (short 4 of the last 7 days), `MISSING_SUBMISSION` (only once a branch has started using the system). | Spec 6.6, 6.12, 7. |
| **Releasing to yourself as driver is not blocked.** | The owner is still deciding on role combinations (spec 3.3). The ledger shows it if it happens. |
| **Shared phones sign out after 30 minutes idle.** | Branch devices are shared. |
| **Items cannot be deleted** (switch off instead); only the owner can change a price, unit or conversion once set. Every item change is logged. | Spec 5.3. |
