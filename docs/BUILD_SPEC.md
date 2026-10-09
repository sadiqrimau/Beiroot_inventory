# Restaurant Stock & Reconciliation System: Build Spec

**For:** Claude Code (builder)
**Project lead:** Sadiq (relays between the strategist chat and the builder)
**Client:** the restaurant owner, a fast-food restaurant in Ilorin, Nigeria
**Prepared:** Friday 9 October 2026
**Target:** a live link by **Monday 12 October 2026** (see section 14 for what is realistic by then)

---

## 0. How to use this document

This is the single source of truth for the build. It collects every decision made while designing the system, from the first conversation onward.

Each requirement carries a status:

- **DECIDED:** agreed with Sadiq and/or the owner. Build it.
- **PROPOSED:** recommended by the strategist and not rejected, but not explicitly confirmed by the owner. Build it, and keep it easy to change.
- **OPEN:** waiting on information from the owner. Build the structure so the data can be added later; don't invent values.

Reference files in `reference/`:

| File | What it is |
| --- | --- |
| `engine.js` | The tested rules engine: takes a list of events and returns stock per location plus alerts. Port its logic; don't redesign it. |
| `simulation.js` | A 14-day simulation of the central kitchen + 2 branches with planted thefts. Use it as a regression test for the rules. |
| `run-simulation.js` | `node run-simulation.js` prints which thefts the engine caught. |
| `prototype-app.html` | The single-page prototype the owner already saw and liked. Shows the flows and screens per role. |
| `items-seed.csv` | The owner's 62 stock items in 8 categories (+ garlic sauce, made in the kitchen). Units and prices are blank on purpose. |

**Working agreement:** keep a `DECISIONS.md` and a `CHANGELOG.md` in the repo. Sadiq will paste progress back to the strategist, and new decisions forward to you. When something in this spec conflicts with a new instruction from Sadiq, Sadiq's instruction wins; note it in `DECISIONS.md`.

---

## 1. The business

- Fast food / quick service. Orders come in through walk-in, WhatsApp and phone, pickup and online ordering, **Chowdeck** (a third-party delivery platform), and the restaurant's **own custom ordering app** (built last year).
- **One central kitchen + store** (same building) supplies **two branches**. The branches are **Tanke branch** and **Adeta branch**.
- The central kitchen produces **half-prepared components**. The branches finish and assemble the food.
- Every order at a branch, from every channel, is entered by front desk staff into **Aronium** (desktop point-of-sale software). **Each branch has its own laptop running Aronium.**
- Money comes in through five sources: **cash, transfer (Moniepoint), card (Moniepoint POS terminal), Chowdeck, own app.**
- The restaurant is about to switch to **bulk buying from new suppliers**, so purchase units and prices are not set yet.
- Today, Sadiq does the stock end-of-day and money end-of-day calculations for each branch by hand. The system replaces that work.
- **The core problem is stock discrepancies and theft.** The goal: every discrepancy points to a specific handover, person and time.
- A separate **accounting / financial management system** is planned later as its own project. Build this one so it can feed accounting (section 10.5).

---

## 2. Principles (non-negotiable)

1. **Two-person rule.** Stock never moves without one person releasing it and a *different* person receiving it. A movement is complete only when both sides confirm.
2. **Nobody checks their own figures.** Separation of duties is enforced **per person, not per role**, because one person may hold two roles (section 3.3).
3. **Blind entry.** Anyone counting stock or entering money does so without seeing the expected figure. Expected figures are computed server-side and are never readable by the person entering. This must be enforced in the database (RLS and views), not just hidden in the UI.
4. **Append-only.** No record is edited or deleted after it's saved. A mistake is fixed by a new correction entry that references the original, with a reason and a name. The owner sees every correction.
5. **Every stock change has a reason**: received, issued, produced, dispatched, received-at-branch, used, sold, wasted, counted, corrected.
6. **The server sets the recorded time.** Users may give an "occurred at" time where it matters (e.g. spoilage), and the system flags large gaps between the two.
7. **Proof.** Photos for handovers, write-offs, cash counts, and screenshots for Chowdeck/app totals.
8. **Physical controls the software relies on** (DECIDED in discussion; the system logs them):
   - The central store opens only when the storekeeper is present. He holds the only key; no spare keys for convenience.
   - Every store opening is logged with the reason and who was present.
   - The driver never enters the store alone. The storekeeper picks the items and hands them over at the door.
   - A camera over the store door (recommended).
9. **Paper backup at two checkpoints** (section 6.9).

---

## 3. Roles and permissions

### 3.1 Roles

Each person logs in with their own account. Roles are assigned per person, and branch roles are scoped to one branch.

| Role | Who | Can do | Cannot do / never sees |
| --- | --- | --- | --- |
| **Owner** | The restaurant owner (Sadiq's friend). The reviewer. | Sees everything: alerts, reports, ledger, corrections, insights. Manages items, categories, units, prices, thresholds, users and branches. Reviews emergency releases, corrections and count gaps daily. | — |
| **System admin** | Sadiq, during setup | Creates users, seeds items, configures integrations. Every admin change is logged and visible to the owner. | Should not perform stock or money entries. |
| **Storekeeper** | Central store custodian, holds the key | Opens and closes store sessions. Confirms goods received against purchases (blind). Releases stock against requests to the kitchen and branches. Emergency release (always flagged). Records store write-offs (with witness). Keeps handwritten book #1. | Cannot count his own store (his count is held; section 6.7). Cannot confirm a purchase he logged. |
| **Procurement officer** | The buyer | Logs purchases: supplier, items, quantities, unit price, invoice photo. Sees his own purchases and whether they were received. | Cannot confirm his own delivery into the store. |
| **Driver** | All delivery runs | Carries planned deliveries and top-ups from the store to branches. Sees his own runs only. Signs the carbon delivery book. | Cannot raise requests. Cannot confirm receipt. The **dispatcher role was dissolved**; the driver does all runs. |
| **Central kitchen cook(s)** | Production staff | Request ingredients from the store. Report yield per batch: what went in, what came out. | — |
| **Branch manager / supervisor** | One per branch | Raises stock requests (planned and top-up). **Receives deliveries from the driver**: blind count at the door, photo, signs the carbon book. Witnesses the cashier's cash count. Records branch write-offs (with witness). | Not the kitchen lead. Receiving was deliberately kept away from the kitchen lead so he doesn't control both arrival and usage. |
| **Branch kitchen lead** | One per branch | Submits the end-of-day kitchen count (what is left). **That is all.** | Sees **no other data**: no deliveries, no Aronium figures, no previous counts, no results. The system computes "used" and compares it. |
| **Cashier** | One per branch | Submits the money end-of-day: cash (counted blind, witnessed, photo), Chowdeck (screenshot), App (screenshot), delivery fees per order. | Does not see Aronium's total or Moniepoint figures before submitting. Cannot edit after submitting. Transfer and card are filled automatically (section 10.2). |
| **Front desk** | Existing staff | No system role. They keep entering every order into Aronium as today. At closing, the daily Aronium sales export is uploaded (by the cashier or branch manager; section 6.10). | — |

### 3.2 Separation-of-duties rules (enforce in the database)

| Rule | If broken |
| --- | --- |
| Goods-received confirmer ≠ purchase logger | Alert `SELF_RECEIVED` (high) |
| Branch receipt confirmer ≠ carrier | Alert `CARRIER_RECEIVED` (high) |
| Request raiser ≠ carrier | Alert `CARRIER_REQUESTED` (high) |
| A count by the location's own custodian | Count is **held**: stock figures don't follow it; alert `SELF_COUNT`; needs an independent recount |
| Write-off witness ≠ recorder | Alert `WRITE_OFF_UNWITNESSED` (high) above threshold |
| Cash counter ≠ cash witness | Block submission |
| Nobody approves their own correction | Owner reviews all corrections |

### 3.3 Role combinations under consideration (OPEN: owner deciding)

The owner asked whether roles can be combined to cut staff. Simulations were run (sections 15.2 and 15.3). Build so **any user can hold more than one role**, with the rules above always evaluated on the person.

- **Procurement officer also drives:** possible, but only with four conditions:
  1. Suppliers are paid by transfer from the business account, never with cash in his hand.
  2. Every purchase goes to the store first, never straight to a branch.
  3. The owner checks supplier invoices and prices weekly.
  4. Buying and deliveries happen at different times of day.
- **Storekeeper also drives:** **not recommended.** He'd release and carry his own stock (theft with no accomplice needed), and the store would be unguarded while he's on the road.

---

## 4. Locations

- Central store
- Central kitchen
- Tanke branch
- Adeta branch

The owner can add branches later. Every stock figure, count and report is per location.

---

## 5. Items

### 5.1 Seed list (DECIDED)

`reference/items-seed.csv` holds 62 bought items in 8 categories, plus garlic sauce, which is made in the kitchen:

| Category | Count | Items |
| --- | --- | --- |
| Dry ingredients | 12 | Flour, sugar, corn starch, citric acid, Maggi, black pepper, thyme, pepper powder, curry masala, salt, ginger powder, garlic powder |
| Wet ingredients | 4 | Slush concentrate, food colours, vegetable oil, lime |
| Veggies | 7 | Tomatoes, sweet potatoes, Irish potatoes, fresh pepper, onions, green pepper, cabbage |
| Proteins | 3 | Chicken, beef, eggs |
| Condiments | 3 | Bama, Jago, ketchup |
| Perishables | 7 | Sausage, cheese slices, cheese melt, bread loaves, shawarma bread, burger bread, frozen fries |
| Packaging | 15 | Foil paper, slush cups, straws, slush nylon, tissue, toothpicks, takeaway nylon, large / regular / mini food box, forks, rubber bands, nylon gloves, ketchup sauce containers, thousand island containers |
| Maintenance | 11 | Detergent, towels, stapler, stapler pins, POS paper 58mm, POS paper 80mm, pens, markers, air freshener, glass cleaner, mosquito spray |

Changes from the owner's raw list, and why:

- **Split into separate items**, because each is bought and used separately: sweet / Irish potatoes, POS paper 58mm / 80mm, air freshener / glass cleaner, ginger powder / garlic powder.
- **Renamed for clarity:** "fresh pepper" (veggies) vs "pepper powder" and "black pepper" (dry), so nobody counts the wrong one.
- **Garlic sauce** moved out of Veggies: it is **made in the central kitchen**, not bought.
- **Slush concentrate:** one item per flavour if bought in flavours (OPEN).

### 5.2 Item fields

`name`, `category`, `kind` (raw / prepared), `count_unit` (the unit it is counted in, e.g. kg), `purchase_unit` (e.g. 50 kg bag) with `units_per_purchase_unit` (conversion), `cost_price` (nullable), `reorder_level`, `count_frequency` (daily / weekly), `tracks_expiry`, `active`.

- **Units and prices are OPEN.** The restaurant is moving to bulk buying with new suppliers. Treat every item as **"unpriced until set."** While an item has no price, alerts and thresholds fall back to **quantity**, not naira value.
- **Bulk conversion:** a delivery of "2 bags" of a 50 kg item becomes 100 kg in stock.
- **Expiry:** perishables, proteins and veggies get an expiry date at goods-received, so spoilage shows up before it happens.
- **Count frequency (PROPOSED):**
  - Daily: proteins, perishables, veggies, and fast-moving packaging (slush cups, food boxes).
  - Weekly: dry ingredients, wet ingredients, condiments, other packaging, maintenance.

  The owner is confirming which items are counted daily (OPEN).

### 5.3 Item customization (DECIDED: owner feedback #2)

- The owner can add items and categories, set units, conversions, prices, reorder levels, count frequency and the expiry flag.
- **Items are deactivated, never deleted**, so past records stay intact.
- **Only the owner** can change price, unit or conversion. Every change is logged with who, when, old value and new value. A silent unit change (e.g. "kg" to "bag") would make stock appear or vanish.

### 5.4 Prepared items (central kitchen output): OPEN

The central kitchen sends half-prepared items to the branches. Only **garlic sauce** is confirmed. The owner is preparing the full list. For each prepared item, capture:

- the ingredients and quantities per batch (the production recipe)
- the expected yield per batch
- the unit it is sent to branches in

This is what lets the system catch a batch that comes out smaller than it should (`LOW_YIELD`).

### 5.5 Menu recipes ("measurements"): OPEN

Each menu item and size uses fixed measurements of stock. For example, bread for a regular sandwich differs from a large one. The owner is preparing these. Data shape:

- menu item **name exactly as it appears in Aronium** + size
- lines of `stock item`, `quantity`, `unit`

If a menu item uses a central-kitchen prepared item, the recipe uses the **prepared** item, because branches only receive that, not raw stock.

These recipes convert Aronium sales into stock used (section 6.10). Build the tables and an owner-facing editor. Flag any Aronium item that has no recipe.

---

## 6. Flows

The prototype (`prototype-app.html`) implements most of these flows. The event names below match `engine.js`.

### 6.1 Purchase → goods received (`PURCHASE` → `GRN`)

1. The procurement officer logs the purchase: supplier, items, quantity in purchase units, unit price, invoice photo.
2. The storekeeper counts what actually arrived **without seeing the purchase quantities** and confirms.
3. Differences raise `GRN_MISMATCH`, naming both people. A purchase never received within 24h raises `PURCHASE_NOT_RECEIVED`.
4. Store must be logged open (`STORE_NOT_OPEN` otherwise).

### 6.2 Kitchen issue → yield (`REQUEST` → `RELEASE` dest=kitchen → `YIELD`)

1. A cook requests ingredients.
2. The storekeeper releases against the request.
3. The cook reports the yield: inputs and outputs per batch. Outputs go into store stock as prepared items.
4. No yield report within 24h raises `NO_YIELD`. Once production recipes exist, input above standard beyond the tolerance raises `LOW_YIELD`.

### 6.3 Branch delivery, planned or top-up (`REQUEST` → `RELEASE` → `RECEIPT`)

Planned deliveries and top-ups follow **the same flow**. Only the request type differs.

1. The **branch manager** raises the request, even if only a minute before the run.
2. The storekeeper releases **against the request number**, never a verbal ask, and names the driver. Quantity released is recorded separately from quantity requested.
3. The driver carries it.
4. The **branch manager** counts it at the door, **blind** (sent quantities hidden), with the driver present, takes a photo, and both sign the carbon delivery book. A per-line status (matched / short / over / damaged) and a note are recorded.
5. Alerts:
   - `TRANSIT_SHORT`: received less than released; names the carrier.
   - `TRANSIT_OPEN`: not received within 6h.
   - `OVER_RELEASE`: released more than requested.
   - `NO_PHOTO`: handover without a photo.

### 6.4 Emergency release

When something truly cannot wait, the storekeeper may release without a request, with a reason. This raises `EMERGENCY_RELEASE` and goes on a list the owner reviews daily. A rising count means the request process is being bypassed.

### 6.5 Store sessions (`STORE_OPEN` / `STORE_CLOSE`)

- Every opening records the reason and who is present.
- `IDLE_OPENING` fires on an opening with nothing recorded. In the simulation, this caught the storekeeper's night visit.
- `STORE_LEFT_OPEN` fires on a session never closed.
- Any stock movement outside an open session raises `STORE_NOT_OPEN`.

### 6.6 Write-offs and spoilage (`WASTE`): DECIDED, owner feedback #1

Fields:

- items and quantities
- **date and time the event happened or was found** (user-entered)
- **location** (store / kitchen / branch)
- reason
- **witness** (a different person)
- **photo** (required)
- recorded time (set by the server)

Rules:

- A write-off over the threshold (₦5,000 by default; a quantity threshold while the item is unpriced) without a different witness raises `WRITE_OFF_UNWITNESSED`. In the simulation, this caught the storekeeper writing off good beef as "spoiled".
- **New:** `BACKDATED_WRITE_OFF` fires when the recorded time is far after the occurred time (PROPOSED default: 12 hours). Backdating is a common way to hide theft.
- `HIGH_WASTE` fires when waste exceeds 3% of the stock value moving through a location.

### 6.7 Blind counts (`COUNT`)

- The counter sees item names only, never expected quantities. The system computes variance after submission and shows it **only to the owner**.
- **Store:** counted by someone other than the storekeeper. If the custodian counts his own location, the count is **held**: the stock figure doesn't follow it, `SELF_COUNT` fires, and an independent recount is needed. In the simulation, this caught a storekeeper hiding his own theft.
- **Branch:** the kitchen lead's end-of-day count (section 6.11).
- **Tolerance:** a variance is ignored if under 2% of the book figure, or under 0.5 units.
- **Priority:** a gap is high if the value lost in one count exceeds ₦5,000 (quantity-based while unpriced).
- Rotate who counts. Counts happen daily at both store and branches from day one, since the branches already have count routines.

### 6.8 Corrections (`CORRECTION`)

- A correction is a new entry that references the original entry's ID, with a reason and a name.
- Without both a reference and a reason, `BAD_CORRECTION` fires.
- All corrections are listed for the owner.

### 6.9 Handwritten backup and offline (DECIDED: owner feedback #3)

Two checkpoints keep paper records:

1. **Storekeeper's book** (DECIDED): every goods-received and release.
2. **Branch door: numbered carbon delivery book** (PROPOSED by the strategist as the second checkpoint).
   - The driver and branch manager both sign each delivery.
   - One copy stays at the branch, and one goes back to the store.
   - This is the weakest point now that the driver does every run, and the one place a driver and a receiver could cover for each other.
   - Numbered pages show if one goes missing.

Use of the books:

- The owner spot-checks a few pages against the system each week.
- **Offline fallback:** when the internet is down, entries go on paper and are typed in later, marked **"from paper" with the page number**. These entries keep both the occurred time and the recorded time.

### 6.10 Sales import from Aronium (branch usage)

- Branch usage comes **from Aronium sales**, not hand entry. Hand-entered usage was the one gap the simulation missed: a driver and receiver colluding, then hiding it with inflated usage.
- **Start simple:** at closing, upload the day's **sales-by-product** report exported from that branch's Aronium. One upload per branch per day; duplicates are rejected.
- The system matches each Aronium item name to its recipe (section 5.5), converts quantities sold into stock used, and deducts from that branch.
  - Unmatched names are listed for the owner to map.
  - A missing upload raises an alert.
- **Later:** check whether reading Aronium's data directly (it runs locally on each branch laptop) is more reliable than the export. Don't promise automation until verified against their actual setup.
- The export also provides **Aronium's total sales** for the money end-of-day. That total must come from this upload, never typed by the cashier.

### 6.11 Branch kitchen end-of-day (kitchen lead): DECIDED

The owner's current sheet (Appendix B) compares, per item:

- **Used:** what the branch kitchen used out of what it received.
- **EOD:** what Aronium says was sold.

In the system:

1. The kitchen lead submits **only** a blind count of what is left. He sees nothing else.
2. The system computes **Used = opening stock + received from the driver − closing count**.
3. The system computes **Expected from sales = Aronium quantities × recipes**.
4. Per item it shows **Reconciled** (within tolerance) or **Discrepancy**, with the amount not accounted for (and naira, once priced).
5. **Nobody can mark an item "Reconciled" by hand.** In the sample, regular fries showed 23 vs 123 but was marked reconciled.
6. **One unit per item.** In the sample, cheese melt showed 237 vs 3, almost certainly two different units.

OPEN: the sample sheet counts "slush", "bread", and fries as "mini / regular / large pack". These look like portion units rather than stock items. Confirm with the owner how they map to the item list and recipes.

### 6.12 Money end-of-day (cashier): DECIDED

**Keep the owner's exact format** (Appendix A). The calculation:

```
Total received = Cash + Transfer + Card + Chowdeck + App
Net = Total received − Delivery fees
Difference = Net − Aronium total sales ("Desktop EOD")
Positive if Net > Aronium, negative if Net < Aronium.
```

Worked example from the owner's sample (Tanke, 3 Oct 2026): 13,500 + 243,600 + 0 + 4,900 + 40,550 = 302,550; minus 3,300 delivery = 299,250; minus Aronium 298,550 = **₦700 positive**.

Who supplies each figure:

| Figure | Source | Notes |
| --- | --- | --- |
| Cash | Cashier, counted blind | Branch manager witnesses; both names recorded; photo of the cash |
| Transfer | **Automatic from Moniepoint** (section 10.2) | Interim until connected: cashier enters it with a screenshot, marked "manual" |
| Card / POS | **Automatic from Moniepoint** | Same interim rule |
| Chowdeck | Cashier | Screenshot of the Chowdeck vendor app |
| App | Cashier | Screenshot from the restaurant's own app, unless integrated (section 10.4) |
| Delivery fees | Cashier, **listed per order** | Not one total: a smaller total could hide a shortage. PROPOSED alternative below. |
| Aronium total | **The uploaded Aronium export** | Never typed. Hidden from the cashier until he has submitted. |

Rules:

- The cashier cannot see the expected figures before submitting and cannot edit after. Changes go through corrections only.
- **History per branch.** One small difference means little; ₦500 short every day for a month is a pattern. Show a per-branch chart and raise `MONEY_VARIANCE_PATTERN` on repeated same-direction differences.
- **Link to stock.** A positive difference usually means a sale that was taken but not entered in Aronium. That food is also missing from stock, so show money and kitchen results side by side.
- **PROPOSED:** add "Delivery fee" as an item in Aronium, entered with each delivery order. Then fees are already in Aronium's total, nothing is subtracted by hand, and fees can't be adjusted to cover a shortage. Support both modes with a setting until the owner decides.

---

## 7. Alerts

All implemented in `engine.js` unless marked **new**. Every alert carries a severity (high / med / low), time, detail, the accountable person (where known) and a naira value (where priced).

| Code | Severity | Fires when | Accountable |
| --- | --- | --- | --- |
| `GRN_MISMATCH` | high | Goods received differ from purchase | Buyer / storekeeper |
| `GRN_NO_PO` | med | Goods received with no purchase record | Storekeeper |
| `SELF_RECEIVED` | high | Buyer confirmed his own delivery | Buyer |
| `PURCHASE_NOT_RECEIVED` | med | Purchase not received within 24h | Buyer |
| `STORE_NOT_OPEN` | high | Movement while store not logged open | Storekeeper |
| `IDLE_OPENING` | med | Store opened, nothing recorded | Storekeeper |
| `STORE_LEFT_OPEN` | med | Session open over 12h | Storekeeper |
| `EMERGENCY_RELEASE` | med | Release with no request | Storekeeper |
| `OVER_RELEASE` | high | Released more than requested | Storekeeper |
| `CARRIER_REQUESTED` | high | Carrier raised the request he's carrying | Driver |
| `TRANSIT_SHORT` | high | Branch received less than released | Driver |
| `TRANSIT_OPEN` | high | Not received within 6h | Driver |
| `CARRIER_RECEIVED` | high | Carrier confirmed his own delivery | Driver |
| `RECEIPT_NO_RELEASE` | med | Receipt for an unknown movement | Branch manager |
| `NO_PHOTO` | low | Handover without photo | Driver |
| `NO_YIELD` | med | Kitchen took stock, no yield report in 24h | Cook |
| `LOW_YIELD` | high | Inputs above production standard + 8% | Cook |
| `WRITE_OFF_UNWITNESSED` | high | Write-off ≥ threshold, no separate witness | Recorder |
| `HIGH_WASTE` | med | Waste > 3% of stock value moved at a location | — |
| `COUNT_VARIANCE` | high / low | Blind count differs from book beyond tolerance | — (location) |
| `SELF_COUNT` | high | Custodian counted his own stock; count held | Custodian |
| `BAD_CORRECTION` | med | Correction without reference or reason | Author |
| `BACKDATED_WRITE_OFF` **new** | med | Write-off recorded > 12h after it occurred | Recorder |
| `KITCHEN_DISCREPANCY` **new** | high / low | Used ≠ expected from Aronium × recipes | — (branch) |
| `MONEY_VARIANCE` **new** | high / low | Money end-of-day difference beyond tolerance | — (branch) |
| `MONEY_VARIANCE_PATTERN` **new** | high | Repeated same-direction money differences | — (branch) |
| `MISSING_SUBMISSION` **new** | med | No cashier / kitchen lead / Aronium upload by cut-off | That role |
| `UNMAPPED_SALES_ITEM` **new** | med | Aronium item with no recipe | Owner |
| `ITEM_CHANGED` **new** | low | Price / unit / conversion changed | Owner (audit) |

All thresholds are owner-editable settings: count tolerance 2% / 0.5 units, high-priority gap ₦5,000, write-off witness ₦5,000, transit 6h, yield due 24h, purchase-to-receipt 24h, waste 3%, yield tolerance 8%.

**Noise matters.** In the simulation's honest fortnights, about 5 `TRANSIT_SHORT` alerts per fortnight were plain miscounts, each pointing at the driver. Counting at the door with the driver and receiver together, plus the photo, reduces this. Watch alert volume in the Insights review (section 9).

---

## 8. Reports

All reports are per day, per location, exportable as CSV (and PDF later). They're already built in the prototype except where marked.

1. **Daily stock**: per location and item: opening, in, out, count gap, closing, closing value. A negative gap is stock that went missing.
2. **End of day (operations)**: goods received; kitchen yield reports; runs to branches (planned / top-up / emergency) and value sent; deliveries confirmed and still open; till usage per branch; write-offs; store openings (and any left open); blind counts done and missing; that day's problems with who to check with.
3. **Money end-of-day** (**new**): the owner's exact format (Appendix A) per branch, with photos attached and the history chart.
4. **Kitchen end-of-day** (**new**): the owner's exact format (Appendix B) per branch: Used vs EOD, Reconciled ✅ / Discrepancy ❌, amount not accounted for.
5. **Owner's daily summary**: one screen across all branches: high alerts, stock value at risk, money differences, kitchen discrepancies, missing submissions.

---

## 9. Insights page (DECIDED: owner feedback #4)

The owner wants the system to keep improving with its data. One page, two tabs:

1. **Simulator**: runs a simulated period the owner picks, using the restaurant's **real items, prices and typical volumes** (once set), with planted theft scenarios. It checks whether the current rules still catch them, especially after a threshold or rule changes. Port `simulation.js`; the incidents in it are the starting scenario library.

   *A simulation uses invented events, so it tests the rules but can't find real discrepancies.*

2. **Review (real data)**: for a chosen period:
   - which handover points keep losing stock
   - items with repeated gaps
   - rising top-ups at one branch
   - money differences by branch
   - alerts that fire too often to be useful

   It ends with **specific suggestions** for what to change.

---

## 10. Integrations

### 10.1 Aronium (sales)

See section 6.10. Start with the daily export upload, one per branch.

### 10.2 Moniepoint (transfer and card): automate

Moniepoint offers webhooks for transaction events. What I found in their public developer documentation (verify everything against the restaurant's real account before relying on it):

- A business can subscribe to transaction events (purchases, withdrawals, transfers, bill payments, etc.) and get real-time notifications. ([source](https://teamapt.atlassian.net/wiki/spaces/EI/pages/1892974728/POS+as+a+Platform+Documentation))
- Setup is in the Moniepoint business account: Settings → POS App Developers → Webhooks → New subscription. You add the receiving URL and pick transaction types. The secret is shown only once, at creation. ([source](https://teamapt.atlassian.net/wiki/spaces/EI/pages/1651605514/Suscription+Management))
- **Verify every webhook:** join the `moniepoint-webhook-id` header, the `moniepoint-webhook-timestamp` header and the raw request body with `__`, compute HMAC-SHA256 with the webhook secret, and compare to the `moniepoint-webhook-signature` header. ([source](https://teamapt.atlassian.net/wiki/x/UYCYYg))
- API docs: https://api.pos.moniepoint.com/v3/api-docs. Integration contact: pos-integrations@moniepoint.com.

To build:

- An endpoint (e.g. a Supabase Edge Function) that verifies the signature, stores each transaction **idempotently** (unique on the webhook ID / transaction reference), and maps it to a branch by terminal serial or business ID.
- Transfer and card totals per branch per day are summed from these records.

Unknowns to confirm:

- Do bank transfers into the account arrive through this webhook, or only terminal transactions? The docs are written for POS terminals.
- Does each branch have its own terminal or account?

Fallback: the interim manual entry with screenshot (section 6.12).

### 10.3 Chowdeck: manual

It's a third-party platform, and no restaurant-side integration was found. The cashier enters the day's figure with a screenshot of the Chowdeck vendor app. Later: check Chowdeck's payouts to the restaurant against the daily figures.

### 10.4 The restaurant's own app

It's their own custom app, built last year, so an integration may be possible. Ask who built it and whether it can export or send orders. Until then: manual with a screenshot.

### 10.5 Future accounting system

A separate project. Structure the data now so it can feed accounting later without rebuilding: supplier invoices and prices (from purchases), stock value, write-off value, and daily money end-of-day per branch.

---

## 11. Data model (Supabase)

### 11.1 Approach

Reuse the tested engine. The prototype stores everything as an **append-only event list** and computes stock and alerts from it. For a Monday launch, the lowest-risk path is:

- **Reference tables:** `locations`, `profiles`, `role_assignments`, `item_categories`, `items`, `item_changes` (audit), `suppliers`, `menu_recipes` + `menu_recipe_lines`, `production_recipes` + `production_recipe_lines`, `settings` (thresholds).
- **`events`:** append-only. Columns:
  - `id` (uuid)
  - `type` (enum: `PURCHASE`, `GRN`, `REQUEST`, `RELEASE`, `RECEIPT`, `YIELD`, `USE`/`SALES_IMPORT`, `WASTE`, `COUNT`, `CORRECTION`, `STORE_OPEN`, `STORE_CLOSE`, `CASH_EOD`, `PAYMENT`)
  - `location_id`, `actor_id`, `occurred_at`
  - `recorded_at` (default `now()`, server-only)
  - `source` (`app` / `paper` / `import` / `webhook`), `paper_page`
  - `ref_id` (the document it relates to)
  - `lines` (jsonb: `[{item_id, qty, unit, status}]`), `payload` (jsonb), `photo_paths` (text[])
- Revoke `UPDATE` and `DELETE` on `events` for every role. Add indexes on `(type, occurred_at)`, `(location_id, occurred_at)` and `ref_id`.
- **Engine:** run the `engine.js` logic server-side (Edge Function or server route) to compute stock positions and alerts. Write daily snapshots (`daily_stock`, `alerts`) so reports are fast and the owner's history is stable.
- **Uploads:** `aronium_imports` (file, branch, business date, parsed rows, checksum: unique per branch and date) and `moniepoint_transactions` (raw payload, verified flag, unique reference).
- **Photos:** Supabase Storage, in a private bucket, with paths stored on the event.

Normalizing `events` into per-type tables can come later if reporting needs it.

### 11.2 Security

- **One login per person.** Staff may not have email, so choose a method that works without it: admin-created accounts with phone + password, or an internal username + PIN. Shared branch devices need fast user switching and auto-logout.
- **Row-level security by role and branch:**
  - Kitchen leads can insert their own `COUNT` and read nothing else.
  - Cashiers insert `CASH_EOD` for their branch and can't read Aronium totals or payments.
  - Drivers read only their own runs.
  - The owner reads everything.
- **Blind views:** expected quantities and expected money are computed server-side and exposed only to the owner's views. Never send them to a counting user's device, even hidden.
- **Separation-of-duties checks in the database** (triggers or RPC functions), not only in the UI.
- **Server timestamps;** clients can't set `recorded_at`.
- **Audit:** every admin and owner change to items, users and settings is logged.

---

## 12. Screens by role

Mobile-first, since most staff will use phones. Large tap targets; works on cheap Android phones and slow connections.

- **Owner:** Today (summary + high alerts), Alerts, Reports (daily stock, operations, money, kitchen), Stock, Ledger, Corrections, Insights, Settings (items, users, branches, thresholds, integrations).
- **Storekeeper:** Store session (open/close), Deliveries to receive, Requests to release, Emergency release, Write-off.
- **Procurement officer:** Log purchase, My purchases.
- **Driver:** My runs (read only).
- **Cook:** Request ingredients, Report yield.
- **Branch manager:** Incoming deliveries (blind receive), Request stock, Write-off, Witness cash count, Upload Aronium export.
- **Kitchen lead:** one screen: tonight's count. Nothing else.
- **Cashier:** one screen: money end-of-day form, then a "submitted" confirmation. No results shown.

---

## 13. Tech stack (PROPOSED)

- **Supabase** (DECIDED): Postgres, Auth, RLS, Storage, Edge Functions.
- **Front end:** Next.js or Vite + React, deployed on Vercel (or similar) for a quick live link. Installable as a PWA so it lives on staff home screens.
- Keep the rules engine in one shared module, so the server, the reports and the simulator all use the same logic. Run `simulation.js` in CI as a regression test: the catch rates in section 15 must not drop.

---

## 14. Delivery plan

Today is Friday. Monday leaves about two and a half working days, and some data (recipes, prepared items, units, prices) isn't in yet. Recommended phasing:

### Phase 1: Monday live link

- Auth, roles and branch scoping; owner and admin user setup.
- Locations; items seeded from `items-seed.csv` with the owner's item editor (deactivate, audit log).
- Purchase → goods received; kitchen request → release → yield; branch request → release → driver → blind receipt with photo; emergency release.
- Store sessions; write-offs with occurred time, location, witness and photo; blind counts with the self-count hold; corrections.
- Alerts (all `engine.js` rules) and the owner's alerts screen.
- Reports: daily stock and operations end-of-day, CSV export.
- Money end-of-day: the cashier form in the owner's format. Interim: transfer and card entered with screenshots until Moniepoint is connected; Aronium total entered by the branch manager with a photo of the Aronium report until the import is built.
- Kitchen lead count screen (collects counts from day one; reconciliation switches on in phase 2).
- "From paper" entry mode (page number + occurred time).

### Phase 2: following week

- Aronium export upload, recipe editor, sales-to-stock deduction, unmapped-item alert.
- Kitchen end-of-day reconciliation in the owner's format.
- Moniepoint webhook (needs the owner's Moniepoint account access).
- Money end-of-day from the Aronium total and Moniepoint; history chart; pattern alert.
- Production recipes and `LOW_YIELD`.
- Owner's daily summary.

### Phase 3: after that

- Insights page (simulator + review).
- Own-app integration; Chowdeck payout check; PDF exports; offline-first forms; accounting hooks.

---

## 15. Evidence: simulation results

Run `node reference/run-simulation.js` to reproduce. **Caveat:** the simulation's items, quantities and naira prices are invented test data, not the restaurant's. Read the percentages as a rough guide.

### 15.1 Current design (dispatcher dissolved, driver does all runs), 14 days, 13 planted incidents

| Setup | Stolen value surfaced |
| --- | --- |
| Without production yield standards | ₦203,900 of ₦247,900 (82%) |
| With production yield standards | ₦221,900 of ₦247,900 (90%) |

What it missed or weakly caught, and the fix now in this spec:

- **Driver + branch receiver collude, then hide it with inflated hand-entered usage:** missed. Fix: usage from Aronium, not hand entry (6.10); rotate who receives; carbon book (6.9).
- **Cooks take raw chicken and report a lower yield:** missed until yield standards exist. Fix: production recipes (5.4).
- **Collusion between buyer and storekeeper, a copied key, or extra stock loaded off the record:** shows only as a store shortage with no name attached. Fix: weekly invoice-vs-received check by the owner, camera on the store door, change the lock.

Design holes the first run exposed, now fixed in `engine.js`:

1. The storekeeper counting his own store erased his theft. Self-counts are now **held**.
2. Good stock written off as "spoiled" passed silently. Write-offs over the threshold now **need a witness**.
3. The yield check over-fired. It now aggregates expected inputs across all outputs of a batch.

Honest-operations noise (average of 5 honest fortnights): about 17 low and 4 high count variances, 5 `TRANSIT_SHORT` (miscounts at receipt), 3 `NO_PHOTO`.

### 15.2 Procurement officer also drives

- **96% surfaced** (₦313,400 of ₦325,400), including 3 extra scenarios only the combined role makes possible.
- **Caught with his name on it:** taking a purchase straight to a branch and skimming some, because the purchase never reached the store.
- **Missed:** paying the supplier for more than was delivered while logging and delivering the true amount. That's a money problem, not a stock problem; fix with condition 1 in 3.3.
- He'd be buying and delivering on the same morning on 7 of 15 days. About ₦4.3m of purchases and ₦4.3m of deliveries pass through one person per fortnight.

### 15.3 Storekeeper also drives

- **92% surfaced** (₦288,300 of ₦314,300).
- Loading stock off the record on his own run needs no accomplice, and shows only as a store shortage at night count, with no name attached.
- While he's on the road, the store is either locked (kitchen and receiving blocked) or someone else has a key (key control gone; a 2 kg beef loss in the simulation had nobody accountable).
- **Not recommended.**

---

## 16. Open questions (waiting on the owner)

| # | Question | Needed for |
| --- | --- | --- |
| 1 | Menu recipes: each menu item + size, with exact Aronium names | Sales-to-stock, kitchen reconciliation |
| 2 | Full list of what the central kitchen makes, with batch recipes and yields (garlic sauce confirmed) | Production, `LOW_YIELD` |
| 3 | Units, bulk purchase units and prices once new suppliers are set | Naira values, conversions |
| 4 | Which items are counted daily | Count schedule |
| 5 | How the kitchen sheet's "slush", "bread", "fries mini/regular/large pack" map to stock items | Kitchen end-of-day |
| 6 | ~~Name of branch 2~~: answered, **Adeta branch** | Setup |
| 7 | Moniepoint: one terminal/account per branch? Do bank transfers arrive via webhook? Owner's account access | Automating transfer and card |
| 8 | Who built the restaurant's own app; can it export or send orders? | App integration |
| 9 | Delivery fee as an Aronium item, or keep subtracting per order? | Money end-of-day |
| 10 | Role combinations: procurement officer as driver? (storekeeper as driver not recommended) | Roles |
| 11 | Login method for staff without email | Auth |
| 12 | Slush concentrate: one item per flavour? | Items |

---

## 17. How we got here (decision history)

A chronological record of the design conversation, so the reasoning behind each rule is visible.

1. **Starting point.** Sadiq is building an inventory-focused system for his friend's fast-food restaurant. The restaurant is setting up a central kitchen and store that delivers half-prepared food to its branches (two for now), where it's finished and assembled.
2. **Priority set.** Fix stock discrepancies first; yield ratios later. With no data yet, the system was designed to make leaks discoverable: blind daily counts at each location, so after two weeks it's clear where stock leaks.
3. **Staff described.** The person in charge of the store/building (called "turnkey" by Sadiq; this is the storekeeper); cooks who record yield after production; the procurement officer who buys stock; the driver for planned delivery routes; and the dispatcher for backup and urgent top-ups.
4. **Core controls agreed:**
   - The two-person rule.
   - Five control points: purchase receipt, issue to kitchen, production yield, dispatch and receipt, blind count.
   - Reason codes on every change.
   - No editing past records, only corrections.
5. **Dispatcher top-ups.** Every top-up must be raised as a request by the branch before anything moves (each branch has someone who can). An emergency release by the storekeeper goes on a list reviewed daily.
6. **Theft risk: the dispatcher alone in the store.** The software can't fix this; physical controls do. The dispatcher never enters alone; the storekeeper picks and hands over at the door. The store is lockable and the storekeeper holds the key; openings are logged; camera recommended.
7. **Handover record designed:** request, release side, carrier, receipt side, audit fields (locked after both confirm), plus a photo at handover.
8. **Blind count sheet designed.** A shared doc, "Restaurant Stock Control System", was created. Branches already have count routines, so counts run at both store and branches from day one.
9. **Update: dispatcher dissolved** to cut staff. The driver handles all runs, planned and top-up. A working prototype was built with a 14-day simulation; findings and fixes are in section 15.1.
10. **Reports added:** daily stock and end-of-day (operations). Supabase recommended over storing data inside Claude.
11. **Reviewer clarified.** "Turnkey" was briefly mis-used as a separate manager role. The reviewer is **the owner** (Sadiq's friend), who doesn't handle stock himself.
12. **The owner saw the prototype and loved it**, and wants it built as a website. Plan: Claude (chat) as strategist, Claude Code as builder, Sadiq in between.
13. **Confirmed:** Supabase; the owner as reviewer.
14. **Owner feedback:**
    1. Spoilage entries need date, time and location of the event.
    2. Store items must be customizable.
    3. Handwritten backup at two checkpoints: storekeeper confirmed; second proposed at the branch door.
    4. A simulation page to keep improving the system: became the Insights page with two tabs.
15. **Item list received:** 8 categories. Units and prices postponed because of the move to bulk buying with new suppliers.
16. **Garlic sauce** is made in the kitchen. Branches have POS. An accounting system is planned as a separate later project.
17. **Sales:** each branch has its own laptop with Aronium; every order from every channel is entered there. Moniepoint handles transfer and card.
18. **Money end-of-day sample shared** (Appendix A) and explained: five sources, delivery fees subtracted, compared with Aronium's total. Keep the owner's format.
19. **Kitchen end-of-day sample shared** (Appendix B). Used = what the branch kitchen used from what it received; EOD = what Aronium says was sold. Menu measurements differ by size, so recipes are needed per menu item and size.
20. **New roles:** a cashier (money end-of-day) and a kitchen lead (kitchen count).
    - The kitchen lead sees no data except his own submission.
    - The branch manager, not the kitchen lead, receives the driver's deliveries.
    - The cashier's power is reduced by automating transfer and card from Moniepoint.
21. **Role-combination simulations** run for the owner (section 15.2–15.3).
22. **"App"** is the restaurant's own custom app, built last year.
23. **Deadline:** a live link expected Monday. Handover to Claude Code.

---

## Appendix A: Money end-of-day sample (owner's format, verbatim)

```
DAILY RECONCILIATION TANKE:

Date: 3rd October, 2026

Desktop End of Day
  • Cash: 13,500
  • Transfer: ₦243,600
  • Card/POS:  none
  • Chowdeck: 4,900
  • App: 40,550

Reconciliation;
Cash + Transfer + Debit + Chow + App
13,500+243,600+4,900+40,550 = 302,550

Delivery :- ₦3,300
Desktop EOD : 298,550
Difference: ₦700

302,550-3,300 = 299,250
299,250-298,550 = 700

POSITIVE
```

How Sadiq explained it:

- Every item sold is entered into Aronium, whatever the channel (walk-in, WhatsApp, pickup, Chowdeck, own app).
- The five figures are the money received per source. They're added up, delivery fees are subtracted (customers pay the delivery fee together with the order, by transfer or cash), and the result is compared with Aronium's total ("Desktop EOD") to get a positive or negative difference.
- Transfer and card both come from Moniepoint. Cash is counted at the branch. Chowdeck and App are entered as orders in Aronium like any other, but Aronium doesn't reliably separate them by source.

## Appendix B: Kitchen end-of-day sample (owner's format, verbatim)

```
DAILY KITCHEN RECONCILIATION TANKE:

Date:  3rd October 2026
Slush:          Used: 13    End of day: 13     Reconciled ✅
Shawarma bread: Used: 14    EOD: 14            Reconciled ✅
Sausage:        Used: 3     EOD: 3             Reconciled ✅
Cheese slices:  Used: none  EOD: none          Reconciled ✅
Cheese melt:    Used: 237   EOD: 3             Discrepancy ❌
Burger bread:   Used: none  EOD: none          Reconciled ✅
Bread:          Used: 10    EOD: 7.6           Discrepancy ❌  2.4 not accounted for
FRIES:
  Mini pack:    Used: 1     EOD: 1             Reconciled ✅
  Regular pack: Used: 23    EOD: 123           Reconciled ✅   <- marked reconciled despite mismatch
  Large pack:   Used: 9     EOD: 9             Reconciled ✅
```

- **Used** = what the branch kitchen used from what it received from the central kitchen/store.
- **EOD** = what Aronium says was sold.

## Appendix C: Prototype

The live prototype the owner tested: https://claude.ai/artifact/9FT2YsCkmCHv6jNWk6pgwm (also in `reference/prototype-app.html`).

It has role switching, all stock flows, alerts, daily stock and end-of-day reports, and the built-in simulation (Turnkey/Owner role → Simulation). Treat it as a reference for flows and rules, not for architecture: it stores data in Claude's artifact storage and lets anyone pick any role, which the real build must not do.
