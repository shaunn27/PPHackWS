# Snap & Pay + Split the Bill: PayPal + AI

**Snap it. Check it. PayPal settles it.**

A hackathon project for _Build What's Next with PayPal and AI_. It adds two AI-powered payment features on top of PayPal's v6 Web SDK sample integration:

| Feature | What it does | Full write-up |
|---|---|---|
| 📸 **Snap & Pay** | Photograph a bill, or screenshot an email or chat. AI reads the payee's PayPal email and the amount, you check them, and PayPal pays the biller **directly**. | [SNAP_AND_PAY.md](SNAP_AND_PAY.md) |
| 🧾 **Split the Bill** | Snap a group receipt and tap who had what. Tax, service and discounts are shared in proportion, to the cent. Each friend gets a PayPal pay link for their exact share, paid **straight to you**. Friends who pay in cash can say so, and you confirm. | [SPLIT_BILL.md](SPLIT_BILL.md) |

Both features are phone-first and work in a desktop browser too.

---

## Judges: how to run the two demos

It takes about 10 minutes. Everything runs locally against the **PayPal sandbox**, so no real money moves.

### 1. What you need

- **Node.js 22+**
- **A free [PayPal Developer](https://developer.paypal.com/dashboard/) account.** In the Dashboard, switch to **Sandbox**:
  - Under **Apps & Credentials**, create an app and copy its **Client ID** and **Secret**.
  - Under **Testing Tools → Sandbox Accounts**, note a **personal** test account (to pay with) and a **business** test account (to receive money). The sandbox creates one of each by default.
- **A free Gemini API key** from [Google AI Studio](https://aistudio.google.com). This is the vision model that reads the photos.

### 2. Install and start

```bash
git clone https://github.com/shaunn27/PPHackWS.git
cd PPHackWS
cp .env.sample .env
```

Open `.env` and fill in these three values:

```
PAYPAL_SANDBOX_CLIENT_ID=...
PAYPAL_SANDBOX_CLIENT_SECRET=...
GEMINI_API_KEY=...
```

Then start the server:

```bash
cd server/node
npm install
npm start
```

Open **http://localhost:8080**. Both demos are linked under **"AI Examples"** on that page.

> 💡 For the phone view, open your browser's developer tools and turn on device emulation (e.g. iPhone 14).

### 3. Demo 1: Snap & Pay

**Open:** http://localhost:8080/client/components/snapAndPay/html/src/index.html

1. **Pick a sample.** No photo needed: tap one of the built-in samples, or upload your own picture or screenshot of a bill.
   - **Internet bill**: the bill shows two emails, and the AI picks the PayPal one, not the support address.
   - **Email invoice**: a screenshot of an emailed invoice.
   - **Chat message**: someone asks to be paid in a chat.
   - **Tampered bill**: the small print hides an instruction aimed at the AI. Watch it get **flagged** instead of followed.
2. **Review.** The AI fills in the payee, amount and reference (fields it filled are highlighted). Edit anything, then tick **"I've checked the payee and amount"**.
3. **Pay.** Click the PayPal button and log in with your **personal** sandbox account. If you're already logged in to sandbox.paypal.com as a business account, log out first.
4. **Done.** A receipt appears. The money went straight to the biller's PayPal account, not to this app.

> The sample bills are made out to the project's sandbox biller (`sb-acuw253851754@business.example.com`). To see money arrive in **your** sandbox, replace the payee email in the review form with your business test account before paying.

### 4. Demo 2: Split the Bill

**Open:** http://localhost:8080/client/components/splitBill/html/src/index.html

1. **Pick the "Dinner for 3" sample receipt** ($75.79). The AI reads every line: items, tax, service charge and discount. The receipt should say **"✓ Adds up"**. Tap **Next**.
2. **Set up the split.** Enter your name and **your PayPal email**: use a sandbox **business** test account as the host. Add two friends, then tap who had what on each item. Shares update live and always add up exactly to the total.
3. **Create PayPal pay links.** Your dashboard shows a pay link per friend (Share, Copy, WhatsApp, or **Open pay page**).
4. **Friend 1 pays with PayPal.** Open their pay page, ideally in a private window. Pay with your **personal** sandbox account. Within a few seconds your dashboard marks them **paid · PayPal**.
5. **Friend 2 pays another way.** On their pay page, open **"Paid another way?"**, choose **Cash** and tap **I've paid**. Your dashboard shows **"says paid"**. Tap **Confirm received** (or **Not received**). A claim never counts as collected until the host confirms it.
6. **Check the money arrived.** Log in to sandbox.paypal.com as the host account to see Friend 1's payment.

### Troubleshooting

| Symptom | Fix |
|---|---|
| "AI couldn't read the bill" / "Set GEMINI_API_KEY" | Add the key to `.env`, then **restart** `npm start`. |
| AI is slow or returns "busy" | The free Gemini tier allows about 5 requests per minute per model. The server already falls back to other models; wait a minute and retry. |
| PayPal popup logs you into the wrong account | Log out of sandbox.paypal.com, or use a private window. |

### Run the tests

```bash
cd server/node
npm test       # 78 tests: AI extraction, bill payments, split maths, pay links, claims
npm run lint   # ESLint + TypeScript
```

---

## How it's built

```
Photo / screenshot
   → Gemini vision: structured JSON via a response schema, temperature 0,
     with timeout and backup models
   → Node.js server: zod validation, safety warnings, money maths in whole cents
   → User reviews and confirms
   → PayPal Orders API v2 with purchase_units[0].payee = biller / host
   → PayPal v6 Web SDK button: buyer approves in a popup
   → Money lands directly in the payee's PayPal account
```

- **PayPal Orders API v2** "pay another account" (`payee.email_address`): money goes to the biller or host, never through this app. Captures are verified against the expected amount before anything is marked paid.
- **PayPal v6 Web SDK**: the `paypal-payments` component, `<paypal-button>` and one-time payment sessions.
- **Google Gemini** (`gemini-3.5-flash-lite`, plus fallback models) reads bills and receipts into JSON.
- **Safety first:** text in an image is treated as data, never as instructions. The server re-validates every value (email, amount cap, currency allow-list). Nothing is paid without the user's confirmation.
- **Fair splits:** integer-cent arithmetic with largest-remainder rounding, so the shares always add up exactly to the receipt total.

Main code:

- `server/node/src/ai/`: AI prompts, schemas and the Gemini provider
- `server/node/src/split/`: split engine and store
- `server/node/src/routes/`: the AI, bill-payment and split routes
- `client/components/snapAndPay/` and `client/components/splitBill/`: the two web apps

**Built with:** PayPal Orders API v2, the PayPal v6 Web SDK, the PayPal Server SDK, Google Gemini, Node.js + Express + TypeScript, zod, Vitest, and Claude Code (AI coding assistant).

All bills, receipts, people and businesses in the samples are fictional.

---

## About the base repository

This project is built on PayPal's open-source [v6 Web SDK sample integration](https://github.com/paypal-examples/v6-web-sdk-sample-integration) (Apache-2.0, see [LICENSE](LICENSE)). The original examples are still included and available from http://localhost:8080: one-time payments with PayPal, Venmo and other methods, saved payment methods, and Pay Later messaging. Server implementations live in the `server` folder. See each folder's README for details.
