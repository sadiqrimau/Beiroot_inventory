# Decisions

The design decisions come from [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md). This file records choices made while building, and anything that differs from the spec. Newest first.

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
