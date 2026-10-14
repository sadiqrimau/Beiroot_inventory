#!/usr/bin/env python3
"""Builds one printable staff guide (HTML) per role. Rendered to PDF with Chromium."""
import markdown, pathlib, sys

OUT = pathlib.Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

SIGNIN = """**Signing in**

1. Open **beiroot-inventory.vercel.app** on your phone.
2. Type the **username** and **6-digit PIN** the admin gave you, then tap **Sign in**.
3. Add it to your home screen: in Chrome, tap ⋮ → **Add to Home screen**."""

RULES = """**The golden rules**

- **Count what is really there.** Expected numbers are hidden on purpose. Count, don't guess.
- **Two people for every handover.** The giver and the receiver are never the same person.
- **Nothing can be changed after you save it.** If you make a mistake, tell the admin straight away. They record a correction.
- **Take the photo when the screen asks.** It protects you if there is a dispute.
- **Keep your PIN to yourself.** Everything you enter is saved under your name. Tap **Sign out** on a shared phone."""

OFFLINE = """### If the internet is down

Write it in the paper book as usual: date, time, items, quantities and both people's names. When the internet is back, tick **Typing in entries from the paper book** and enter the **page number** and the **date and time written on the paper**. Paper entries must be typed in within 7 days."""

WRITE_OFF = """### Spoiled or damaged stock

Open **{title}** and fill in the items and quantities, **when it happened or was found**, the **reason**, a **witness** (a different person who saw it) and a **photo**. Tap **Record write-off**. Record it the same day; late write-offs are flagged."""

ROLES = [
 ("Storekeeper", "Store",
  "You hold the store key. Nothing comes in or goes out without passing through you, and you always work with a second person.",
  """### Opening and closing the store

1. Before unlocking, type the **Reason for opening** (e.g. "Morning delivery") and **Who else is present**.
2. Tap **Open store**. You can't receive or release anything while the store is logged as locked.
3. When you lock up, tap **Close and lock the store**.

Never leave the store open or hand the key to anyone. The driver never goes in alone: you pick the items and hand them over at the door.

### Receiving a purchase

Purchases logged by the procurement officer appear under **Deliveries to receive**.

1. Count every item that actually arrived. The quantities bought are hidden on purpose.
2. Type each count. Put 0 for anything that didn't come.
3. For fresh items, also fill in the **Expiry** date.
4. Take a **Photo of the goods received**.
5. Tap **Confirm goods received** and write the PO number in your book.

You can't confirm a purchase you logged yourself.

### Releasing stock

Requests from the kitchen and branches appear under **Requests to release**.

1. Check the items and change a quantity if you are giving less than was asked.
2. For a branch, choose the **Driver carrying it**. For the kitchen, it goes to the cook who asked.
3. Take a **Photo of the stock being released**.
4. Tap **Release stock**.
5. Write the number the screen shows (e.g. **MOV-00012**) in your book next to the items.

### Emergency release

Only when a branch truly can't wait for a request. Open **Emergency release without a request**, choose the branch, say why, choose the driver and the items, take a **photo of the stock being released**, then tap **Release as emergency**. The admin reviews every emergency release, so use it rarely.

""" + WRITE_OFF.format(title="Write off spoiled or damaged stock") + """

### Counting

You don't count your own store. Someone else (the admin, assistant admin or a counter) does the blind count. If you count it yourself, the count is held and isn't used.

""" + OFFLINE + "\n\nWhen typing in from the paper book, the photos are optional."),

 ("Procurement Officer", "Purchases",
  "You log everything you buy, before or as it arrives at the store.",
  """### Low stock

At the top of your screen, **Low stock in the store** lists items at or below the level the admin set for reordering. You see the item names and the reorder level, not how much is left; check with the storekeeper how much to buy. Items you have already bought show **Bought, waiting for the storekeeper**.

### Logging a purchase

1. Type the **Supplier**.
2. Tap **Choose item…**, pick the item and type the quantity. Tap **Add item** for each extra item.
3. If you bought in bulk (bags, cartons), tick **in bag** (or the bulk unit shown) so the system converts it for you.
4. Type the **Price ₦ each**.
5. Take a **photo of the invoice or receipt**.
6. Tap **Log purchase**. Write the **PO number** the screen shows on the invoice.

Take the goods to the **store** every time, never straight to a branch. The storekeeper counts what arrived without seeing your numbers. Any difference shows up for the admin.

**My purchases** shows each purchase as **Waiting for storekeeper** or **Received**. You can't confirm your own delivery into the store.

""" + OFFLINE),

 ("Driver", "My runs",
  "You carry every delivery from the store to the branches: planned deliveries and top-ups. Your screen only shows your runs; you don't enter anything.",
  """### Each run

1. Wait at the store door. The storekeeper picks the items and hands them to you. Don't go into the store.
2. Check the run appears under **My runs** as **On the road**, with the items listed.
3. At the branch, stay while the branch manager counts everything at the door.
4. You and the branch manager **both sign the delivery book**. One copy stays at the branch; bring the other back to the store.
5. The run changes to **Received** once the branch manager confirms it.

If something is damaged or short, tell the branch manager so it's noted. Never sign for or confirm a delivery yourself, and never carry a request you raised yourself."""),

 ("Central Kitchen Cook", "Kitchen",
  "You request raw ingredients from the store and report what each batch produced.",
  """### Getting ingredients

1. Under **Request ingredients from the store**, add each item and quantity.
2. Tap **Send request**. The storekeeper releases it to you.

### Reporting yield

After cooking, each batch of ingredients you received waits under **Report yield**.

1. **What went in** is filled in from what you received. Change any number you didn't actually use.
2. Under **What came out**, add each kitchen-made item (e.g. garlic sauce) and how much you made.
3. Tap **Report yield**.

Report yield the same day. Ingredients with no yield report after 24 hours are flagged for the admin.

""" + WRITE_OFF.format(title="Write off spoiled stock in the kitchen")),

 ("Branch Manager", "Branch",
  "You receive every delivery at your branch, ask the store for stock, and watch the cashier count the cash at closing.",
  """### Receiving a delivery

Deliveries on the way to your branch appear under **Incoming deliveries**.

1. Count everything at the door **with the driver present**. The quantities sent are hidden on purpose.
2. Type each count. Put 0 for anything missing.
3. Add a **Note** if anything is damaged or odd.
4. Take a **Photo of the crates**.
5. Tap **Confirm received**.
6. You and the driver **both sign the delivery book**. Keep the branch copy.

You can't receive a delivery you carried yourself.

### Asking for stock

Under **Request stock**, choose **Planned delivery** or **Top-up (urgent)**. Add the items and tap **Send request**. Raise every top-up here first, even a minute before the driver leaves, so the store releases against your request number and not a phone call.

### Watching the cash count

Stand with the cashier while the cash is counted. The cashier chooses your name as the witness.

""" + WRITE_OFF.format(title="Write off spoiled stock at the branch") + "\n\n" + OFFLINE),

 ("Kitchen Lead", "Tonight's count",
  "You have one job in the system: count what is left in your branch kitchen every night.",
  """### Tonight's count

1. After the kitchen closes, count every item on the list: what is physically there right now.
2. Type each number. Put **0** if there is none. Every box must be filled.
3. If you have something that isn't on the list, open **Other items** and add it.
4. Tap **Submit count**. The screen then says the count is submitted.

You can submit once per night and you can't change it afterwards, so count carefully. Count in the unit shown next to each item (e.g. kg, pieces). You won't see any expected numbers or results; the system works out what was used."""),

 ("Cashier", "End of day",
  "At closing you record all the money your branch received.",
  """### Which branch are you at?

- **Branch with the Aronium laptop set up (Adeta):** only step 1. Then close the register in Aronium as usual; its report goes to the admin automatically. Nothing to print, nothing to type from Aronium.
- **Branch without it (Tanke, for now):** step 1, then step 2 (Aronium's total).

### Have ready

- the cash, and the branch manager standing with you to watch the count
- the Moniepoint app, for the transfer and card totals
- the Chowdeck vendor app and the restaurant's own app
- the list of delivery orders, their fees and how each was paid, and any refunds given today
- only at a branch without the laptop: the Aronium end-of-day report

### Step 1: money received

1. Choose the **Date** (today, or yesterday if you finish after midnight).
2. **Cash (counted):** count with the branch manager watching, type the amount and take a photo of the counted cash.
3. **Transfer** and **Card / POS:** type the totals from Moniepoint and add a screenshot of each.
4. **Chowdeck** and **App:** type the **full order value** for the day and add a screenshot.
5. Put **0** for any source with nothing. A screenshot is needed for every amount above 0.
6. **Who watched the cash count:** choose the branch manager.
7. **Delivery fees:** tap **Add delivery** once per delivery order. Type the order number and the fee the customer paid, and choose **Paid by** (cash, transfer, card, Chowdeck or app).
8. **Refunds:** tap **Add refund** for any money given back to a customer. Type the order number, amount and reason. The admin is alerted.
9. **Note for the admin:** write anything unusual today (e.g. POS down, a customer paying tomorrow).
10. Tap **Submit money received**.

### Step 2: Aronium total (only at a branch without the laptop)

1. Open or print the Aronium end-of-day report.
2. Type **Aronium total sales** and take a photo of the report.
3. Tap **Submit Aronium total**. The screen then says the end of day is complete.

Nothing can be changed after submitting, so check each number first. You won't see the difference; the admin checks it."""),

 ("Admin and Assistant Admin", "Today, Alerts, Reports, Stock, Ledger, Settings, Blind count",
  "You see everything and review it. You don't do stock handovers yourself. The assistant admin sees the same screens, but only the admin can change a price or unit once set, the alert rules, and admin accounts.",
  """### Every day (about 10 minutes)

1. **Today:** problems to act on, value at risk, deliveries on the road, the money difference per branch, when each branch laptop last sent Aronium's report, and what hasn't been submitted yet.
2. **Alerts:** work through **Act on these** first. Each alert names who to check with.
3. **Reports → Money end of day:** each branch's reconciliation, with photos, refunds, the cashier's note and the last 14 days. Where the laptop sends Aronium's report, each payment type is checked on its own and missing receipt numbers (a sale possibly deleted) are flagged. Where the cashier enters Aronium's total, open the report photo and check it matches.
4. **Reports → Kitchen end of day:** what each branch kitchen used per item, compared with what Aronium sold once the menu measurements are set.
5. Look at the **emergency releases**. If they keep rising, the request process is being skipped.

### Other reports

**Daily stock** shows opening + in − out + count gap = closing for every location; a negative gap is stock that went missing. **Operations** summarises the day. Each report has **Download this report (CSV)** for Excel.

### Fixing a mistake

In **Ledger**, find the wrong entry and tap **Correct**. Choose the location, add the items (positive adds stock, negative removes it), give the reason and tap **Save correction**. The original entry stays visible.

### Blind counts

Use **Blind count** (or give someone the Counter role) to count the central store regularly. The storekeeper must never count his own store. Tick **Include weekly items** for the weekly count.

### Settings

- **Menu:** prices, sizes and measurements per menu item. Link new Aronium item names once under **Aronium items not linked**.
- **Stock items:** count units, bulk units, prices and reorder levels; switch off items no longer used. Every change is in **Change log**.
- **Staff:** create accounts (username + 6-digit PIN), set roles and branch, set a new PIN, or **Switch off** someone who leaves.
- **Branches:** rename or add branches.
- **Aronium sync:** add a branch laptop (gives a key, shown once, for the installer), see when each laptop last reported, revoke a lost laptop's key.
- **Alert rules:** when alerts fire (admin only).

### Weekly

- Check a few pages of each branch delivery book against the **Ledger**.
- Compare supplier invoices with what the storekeeper received."""),
]

CSS = """
@page { size: A4; margin: 16mm 15mm; }
* { box-sizing: border-box; }
body { font-family: Inter, sans-serif; color: #17201B; font-size: 10.5pt; line-height: 1.45; margin: 0; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #17201B; padding-bottom: 6px; margin-bottom: 10px; }
.kicker { font-size: 8pt; letter-spacing: .08em; font-weight: 700; color: #1E5C46; text-transform: uppercase; }
h1 { font-family: 'Inter Display', Inter, sans-serif; font-size: 24pt; margin: 2px 0 0; letter-spacing: -.01em; }
.url { text-align: right; font-size: 8pt; color: #5E6B63; } .url b { color: #17201B; }
.lede { font-size: 11.5pt; margin: 8px 0 6px; }
.screen { display: inline-block; background: #E3EEE8; color: #1E5C46; font-size: 8.5pt; font-weight: 600; padding: 3px 9px; border-radius: 4px; margin-bottom: 12px; }
.box { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; background: #F2F4F0; border-radius: 6px; padding: 10px 14px; font-size: 8.8pt; margin-bottom: 14px; break-inside: avoid; }
.box p { margin: 0 0 4px; } .box ol, .box ul { margin: 0; padding-left: 16px; } .box li { margin: 2px 0; }
h3 { font-size: 12pt; margin: 14px 0 4px; break-after: avoid; }
ol, ul { padding-left: 26px; margin: 4px 0 8px; } li { margin: 2px 0; }
p { margin: 4px 0 8px; }
footer { margin-top: 18px; font-size: 8pt; color: #5E6B63; border-top: 1px solid #D5DBD5; padding-top: 6px; }
"""

md = lambda t: markdown.markdown(t)
for title, screen, lede, body in ROLES:
    slug = title.replace(" ", "-")
    html = f"""<!doctype html><html><head><meta charset="utf-8"><title>Beiroot guide: {title}</title><style>{CSS}</style></head><body>
<header><div><div class="kicker">Beiroot stock · staff guide</div><h1>{title}</h1></div>
<div class="url">Open on your phone<br><b>beiroot-inventory.vercel.app</b></div></header>
<p class="lede">{lede}</p><span class="screen">Your screen: {screen}</span>
<div class="box"><div>{md(SIGNIN)}</div><div>{md(RULES)}</div></div>
{md(body)}
<footer>Updated 14 October 2026. Questions: ask the admin.</footer></body></html>"""
    (OUT / f"Beiroot-Guide-{slug}.html").write_text(html)
    print(slug)
