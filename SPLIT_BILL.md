# Split the Bill: AI receipt splitting, settled with PayPal

**You paid for everyone. Snap the receipt, tap who had what, and each friend gets a PayPal link for their exact share, paid straight into your PayPal account.**

Split the Bill is the second feature of this hackathon project, alongside [Snap & Pay](SNAP_AND_PAY.md). It reuses the same AI pipeline and the same PayPal "pay another account" approach, but in the other direction: instead of you paying a biller, your friends pay **you**.

## The problem

After a group dinner, one person pays and then has to:

- read the receipt line by line,
- work out who had what,
- divide tax, service and discounts fairly (not 50/50 when one person had a $50 steak and the other a $10 salad),
- handle the leftover cent, and
- chase everyone for their money, and keep track of who has paid.

It's tedious, error-prone and awkward, so people round, guess, or never get paid back.

## How it works

1. **Snap.** Photograph the receipt or upload it. Gemini vision reads **every line**: items, subtotal, tax, service charge, tip, discounts and total.
2. **Check.** The lines prefill an editable receipt. The page shows live whether items + charges − discounts add up to the total, and blocks splitting until they do.
3. **Split.** Add your friends' names and tap who had each item. Tap several people for something you shared, or switch to an equal split. Everyone's share updates live, calculated on the server.
4. **Collect.** Each friend gets a pay link. **Share…** opens the phone's own share sheet, so you pick the friend from your real contacts in WhatsApp, Messages or any app. Copy link and WhatsApp work everywhere too. Your name and PayPal email are remembered on your device, so the next split is quicker. The link shows their items and their share of tax and discounts, and has a PayPal button. The money goes **directly to the host's PayPal account**. The host's page updates by itself as each friend pays: "$21.00 of $48.28 collected".
5. **Paid another way?** Not everyone pays back with PayPal. A friend who paid in cash, by bank transfer or with another app taps **"I've paid"** on their link, picks how, and can add a note. The host sees **"says paid"** and taps **Confirm received** or **Not received**. A claim never counts as collected until the host confirms it. The host can also **Mark as paid** someone who handed over cash without opening their link. The total shows where the money came from: "$32.00 collected ($21.00 via PayPal, $11.00 confirmed by you)".

```
 Host's browser                    Node.js server                         External
 ──────────────                    ──────────────                         ────────
 receipt photo ─► POST /ai/extract-receipt ─────────────────────────────► Gemini (vision, JSON schema)
 edit lines, add friends, tap items
           ─────► POST /api/splits/preview   calculateSplit() in cents
           ─────► POST /api/splits           store split + a secret pay token per friend
 dashboard ◄────  GET  /api/splits/:id?hostToken=…   (polled every 4s)

 Friend's browser (pay link)
           ─────► GET  /api/splits/:id/pay/:token        their share only
 PayPal button ─► POST …/pay/:token/create-order ───► Orders v2: payee = host, amount = STORED share ─► PayPal
 approve in PayPal popup
           ─────► POST …/pay/:token/capture ─────────► capture, verify amount ─► mark share PAID (via PayPal)
 or "I've paid" ► POST …/pay/:token/claim             mark share CLAIMED (not counted yet)

 Host's browser
 Confirm / Not received / Mark as paid
           ─────► POST /api/splits/:id/participants/:pid/confirm|reject  (host token)
                                                     CLAIMED/PENDING ─► PAID (another way), or back to PENDING
```

## The calculation engine

[`server/node/src/split/calculateSplit.ts`](server/node/src/split/calculateSplit.ts) is a pure function with 16 unit tests, including 300 randomised receipts.

- **Whole cents only.** Amounts are parsed from their digits, never through floating point (in floating point, `1.005 × 100` is `100.4999…`).
- **Shared items** are divided equally among the people who shared them.
- **Tax, service, tips and discounts are split in proportion** to each person's items, never evenly.
- **Rounding:** every division uses the largest-remainder method, and any leftover cent goes to the host. The shares **always add up to the receipt total exactly**.
- **Validation:** an item nobody claimed, or a receipt that doesn't add up, is rejected with a clear message.

Worked example from the sample receipt ($75.79 total: $70.00 of items, a $5.00 promo, $6.50 service, $4.29 tax):

| | Items | Tax & service | Discount | **Pays** |
|---|---|---|---|---|
| Alex (host): noodles, pudding, ⅓ dumplings | 25.40 | 3.92 | −1.81 | **27.51** |
| Ben: wonton soup, ⅓ dumplings, ½ teas | 19.40 | 2.99 | −1.39 | **21.00** |
| Cara: fried rice, ⅓ dumplings, ½ teas | 25.20 | 3.88 | −1.80 | **27.28** |
| | **70.00** | **10.79** | **−5.00** | **75.79** |

## Trust and safety

| Risk | Guardrail |
|---|---|
| AI misreads a line | Every line is editable, and the page refuses to split until the receipt adds up exactly. |
| A friend (or a tampered page) changes their amount | The browser never sends an amount. The server recalculates every share, stores it, and creates the PayPal order from the stored value. Unknown request fields are rejected. |
| Someone guesses a pay link or the host's dashboard | Links contain random 144-bit tokens. A pay link only reveals that one person's share (not the host's email or other people's shares). The dashboard needs the host token. |
| Paying twice | A paid share can't create another order (409). A retried capture of the same order is recognised and isn't charged again. |
| Capturing someone else's order through your link | The server only captures the order it created for that pay link. |
| The captured amount differs from the share | The share is **not** marked paid, and the friend isn't told it worked. |
| A friend says they paid but didn't | "I've paid" only marks the share as **claimed**. It isn't counted as collected until the host confirms it, and the host can answer "Not received". |
| A friend confirms their own claim | Confirming needs the host token. A pay link's token is rejected (403). |
| Prompt injection printed on the receipt | Same rule as Snap & Pay: text in the image is data, never instructions, and anything suspicious is reported as a warning. |

## Run it

Follow the setup in [SNAP_AND_PAY.md](SNAP_AND_PAY.md#run-it) (PayPal sandbox credentials and `GEMINI_API_KEY` in `.env`, then `npm start` in `server/node`). Then:

1. Open http://localhost:8080/client/components/splitBill/html/src/index.html (also linked from the home page under "AI Examples").
2. Click the **Dinner for 3** sample, or upload `client/components/splitBill/html/src/samples/lantern-noodle-house-receipt.png`.
3. Check the receipt (it should say "✓ Adds up"), then **Next**.
4. Enter your name and **the host's PayPal email**. In the sandbox, use a personal test account, e.g. `sb-wner053769911@personal.example.com`. Add two friends and tap who had what.
5. **Create PayPal pay links**, then **Open pay page** for a friend. Pay in the PayPal popup with a **different** sandbox account than the host.
6. Watch the host's page mark that friend as **paid**. Log in to sandbox.paypal.com as the host to see the money arrive.

Split sessions are saved to `server/node/data/splits.json` (gitignored), so they survive a server restart. Set `SPLIT_DATA_FILE` to change the path.

## Tools used

| Tool | How it's used |
|---|---|
| **PayPal Orders API v2** | One order per friend with `purchase_units[0].payee.email_address` = the host, so money goes directly to the host. `custom_id` links each order to its split and person. Captured with `return=representation` so the amount can be verified before marking the share paid. |
| **PayPal v6 Web SDK** | The `paypal-payments` component and a one-time payment session on each friend's pay page. |
| **Google Gemini** (`gemini-3.5-flash-lite`, falling back to `gemini-3-flash-preview`) | Reads every receipt line into JSON that follows a response schema, through the same timeout and fallback code as Snap & Pay. |
| **zod** | Validates the AI output, the reviewed receipt, and every API request. |
| **Claude Code** | AI coding assistant used to plan, build and test the feature. |

## Limitations

- **Storage is a JSON file**, not a database, and there are no user accounts. Anyone with the host link can see the dashboard.
- **Payments made outside PayPal are only as reliable as the host's confirmation.** The app records who confirmed what and when, but can't verify cash or bank transfers.
- **Friends are added by name, not from PayPal.** PayPal doesn't let third-party apps read a user's PayPal contacts, so links are shared through the phone's share sheet instead.
- **The host types their PayPal email once** (then it's remembered on their device). The natural next step is "Log in with PayPal", which would fill it in with a verified account and prove the payee really is the host.
- **No push notifications or SMS.** The host shares links by copy or WhatsApp, and "reminders" mean sharing again.
- **Splits are itemized or equal.** Custom amounts and percentages aren't built yet.
- **Friends pay with PayPal.** A friend without PayPal can use PayPal's guest card checkout where it's available.
- **Currencies:** USD, EUR, GBP, AUD, CAD and SGD (2 decimal places).

The sample receipt is fictional.
