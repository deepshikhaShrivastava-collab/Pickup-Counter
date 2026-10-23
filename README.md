# Pickup Counter

A self-service snack counter. A customer picks items, the stock is held for **120 seconds**
while they pay by UPI, a (simulated) payment provider confirms through a signed webhook, and a
locker hands the order over exactly once.

- **Backend:** Node.js, Express 5, TypeScript, PostgreSQL (`pg`, parameterised SQL)
- **Frontend:** React 19, Vite, TypeScript
- **Tests:** Vitest against a real PostgreSQL database (no mocks)
- **One command:** `docker compose up`

```
.
├── docker-compose.yml          db + api + web
├── .github/workflows/ci.yml    tests on PostgreSQL + `docker compose up` smoke test
├── .env.example                local-dev settings (copy to .env; never commit .env)
├── backend/
│   ├── migrations/001_init.sql schema
│   ├── seeds/products.sql      five products (idempotent)
│   ├── src/
│   │   ├── routes/             products, orders, webhooks (HTTP only)
│   │   ├── services/           inventory, orders, expiry, payments, pickup (all SQL)
│   │   ├── lib/signature.ts    HMAC-SHA256 sign / verify
│   │   └── scripts/send-webhook.ts
│   └── test/                   integration tests (real PostgreSQL) + unit tests
└── frontend/src/               catalog, cart, payment countdown, status polling
```

---

## Quick start: one command

```bash
docker compose up
```

- Customer screen: <http://localhost:8080>
- API: <http://localhost:4000> (e.g. <http://localhost:4000/products>)

This needs no `.env`. Compose falls back to **dev-only** defaults for the database password and
webhook secret, and you can override them in a `.env` (see `.env.example`). The API container applies
migrations and seeds the products when it starts.

Pay for an order (the payment screen shows the order id):

```bash
docker compose exec api npm run send-webhook:dist -- --order <orderId>
```

> **How Docker was verified:** the development machine had no Docker. The `docker-compose` job in
> [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs this exact startup on GitHub with no
> `.env`. It then checks `/products`, the web app, an order, a signed webhook (→ `paid`), and two
> pickup claims (200, then 409). See the repository's **Actions** tab for runs.

---

## Running locally without Docker (Windows / PowerShell)

Needs **Node.js 22+** and **PostgreSQL 13+**. Developed and tested on Windows 11 with Node.js 24
and PostgreSQL 18. Run each part in its own terminal.

### 1. PostgreSQL

Any PostgreSQL 13+ on `localhost:5432` works:

- **Installer:** <https://www.postgresql.org/download/windows/>. You can untick pgAdmin and Stack
  Builder to save disk space.
- **Portable zip, with no installer or service:** get the zip from
  <https://www.enterprisedb.com/download-postgresql-binaries> and extract it to e.g. `C:\pgsql`, then:

  ```powershell
  C:\pgsql\bin\initdb.exe -D C:\pgsql\data -U postgres -E UTF8 -A scram-sha-256 -W   # once
  C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data -l C:\pgsql\postgres.log start            # each boot
  ```

Create the app role and database. Use your install's `bin` folder, and use the password you
will put in `.env`:

```powershell
$psql = "C:\pgsql\bin\psql.exe"
& $psql -h localhost -U postgres -c "CREATE ROLE pickup LOGIN CREATEDB PASSWORD 'your-password-here';"
& $psql -h localhost -U postgres -c "CREATE DATABASE pickup OWNER pickup;"
```

`CREATEDB` is needed only because the tests drop and recreate their own `pickup_test` database.

### 2. Configuration

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `DATABASE_URL` and `TEST_DATABASE_URL` to use your password. Set `PAYMENT_WEBHOOK_SECRET` to
a random value:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Every backend npm script loads `../.env` automatically.

### 3. Backend (http://localhost:4000)

```powershell
cd backend
npm install
npm run db:setup     # migrations + seed (safe to re-run)
npm run dev
```

### 4. Frontend (http://localhost:5173)

```powershell
cd frontend
npm install
npm run dev          # proxies /api to http://localhost:4000
```

### 5. Simulate the payment provider

Run these from the `backend` folder.

```powershell
npm run send-webhook -- --order <orderId>                   # exact total, captured -> paid
npm run send-webhook -- --order <orderId> --amount 100      # wrong amount -> needs_review
npm run send-webhook -- --order <orderId> --repeat 3        # same eventId 3x -> applied once
npm run send-webhook -- --order <orderId> --status failed   # recorded, order unchanged
npm run send-webhook -- --order <orderId> --bad-signature   # -> 401
```

The script signs the exact bytes it sends with `PAYMENT_WEBHOOK_SECRET` and puts the hex digest in
`X-Signature`. Pay within the 120 s hold, or the payment counts as late (see below). Once an order
is paid, the payment screen shows a **Confirm pickup** button that plays the locker
(`POST /orders/:id/pickup-claim`).

---

## Tests

| Command | Needs PostgreSQL | Covers |
|---|---|---|
| `cd backend; npm test` | **yes** (`TEST_DATABASE_URL`) | integration + unit tests |
| `cd backend; npm run test:unit` | no | HMAC sign / verify |
| `cd frontend; npm test` | no | paise formatting, countdown maths |
| `cd frontend; npm run build` | no | typecheck + production build |

The integration tests start the real Express app on a random port and send real concurrent
HTTP requests to it. They cover the three required cases, and more:

- **Ten customers, last two units** (`orders.test.ts`): 10 simultaneous `POST /orders` for a
  product with 2 in stock. Exactly 2 succeed (201), 8 get `409 insufficient_stock`, and exactly 2
  units are held. Also: a 2-unit order racing 1-unit orders never oversells, and multi-product
  orders are all-or-nothing.
- **Duplicate webhook** (`webhooks.test.ts`): the same event delivered **10 times concurrently** is
  applied once. One payment event row is stored and the order is paid once. Also: bad, tampered or
  wrong-secret signatures, raw-byte signing, amount mismatch, non-captured status, and late payments.
- **Simultaneous pickup claims** (`pickup.test.ts`): **10 concurrent** claims on one paid order.
  Exactly one gets 200, nine get 409, and stock is deducted once. Unpaid, expired and under-review
  orders cannot be claimed.

The test setup refuses to run unless the database name in `TEST_DATABASE_URL` contains `test`.

**How it was checked:**
- Locally on Windows with PostgreSQL 18: backend **29/29**, frontend 3/3, build passing.
- In CI on every push: the same suites against a PostgreSQL service container, plus the
  `docker compose up` smoke test above.
- Before the brief's exact paths were adopted, a 17-step end-to-end script ran against the live
  API: real 120 s expiry, signed webhooks, duplicate, mismatch, late payment, and concurrent pickup.
  See [AI_NOTES.md](AI_NOTES.md).

---

## API

Every route is served at the path below, and again under `/api` for the web app's proxy.

| Method & path | Success | Errors |
|---|---|---|
| `GET /products` | `200 {products:[{id, sku, name, description, pricePaise, stockOnHand, available}]}` | |
| `POST /orders` `{items:[{productId, quantity}]}` | `201 {order}` | `400 invalid_request`, `404 product_not_found`, `409 insufficient_stock` |
| `GET /orders/:id` | `200 {order}` | `404 order_not_found` |
| `POST /orders/:id/pickup-claim` | `200 {order}` | `404`, `409 order_not_paid` / `order_expired` / `order_needs_review` / `already_picked_up` |
| `POST /payments/webhook` | `200 {eventId, duplicate, outcome, orderStatus}` | `401 invalid_signature`, `400 invalid_json` / `invalid_request` |
| `GET /health` | `200 {ok:true}` | |

- `order` = `{id, status, totalPaise, expiresAt, expiresInSeconds, reviewReason, createdAt, paidAt, pickedUpAt, items[]}`.
- `available` = stock minus units held by unpaid (and paid-but-not-collected) orders.
- Errors always look like `{ "error": "<code>", "message": "...", "details": {...} }`.
- Webhook body: `{"eventId":"evt_123","orderId":"<uuid>","amountPaise":4500,"status":"captured"}`,
  header `X-Signature: <hex HMAC-SHA256 of the raw body>`.

---

## Decisions

### Stock and holds
- Money is always **integer paise** (`INTEGER` columns, integer validation, integer-only formatting).
- `stock_on_hand` is the physical stock. It only changes at pickup.
- Each order line gets a **hold**, which moves `active` (unpaid, has a deadline) → `committed` (paid
  or under review) → `consumed` (picked up), or → `released` (expired).
- **Available** = `stock_on_hand − (committed holds + active holds whose deadline is still in the future)`,
  computed by a view. An expired hold stops counting the moment its deadline passes, even before
  the background sweeper marks the order `expired`.

### Concurrency
| Risk | What prevents it |
|---|---|
| Overselling the last units | Creating an order locks the product rows `FOR UPDATE` **in id order** (so there are no deadlocks), re-reads availability, and inserts holds in the same transaction. |
| Expiry vs payment race | Both lock the order row. Expiry is one statement with `FOR UPDATE SKIP LOCKED`. It runs every 5 s, and also lazily whenever an order is read, paid or claimed. |
| Duplicate webhooks | `event_id` is the primary key, and `INSERT … ON CONFLICT DO NOTHING` runs first. A concurrent duplicate waits on the index, then returns the stored outcome without side effects. |
| Two lockers, one order | `UPDATE orders SET status='picked_up' WHERE id=$1 AND status='paid'`. Only one transaction can match. The other matches 0 rows and gets 409. Stock is deducted in the same transaction. |

### Webhook
- The signature is verified over the **raw bytes** (`express.raw`, mounted before the JSON parser)
  with a constant-time compare. JSON is parsed only after verification.
- **Only `status: "captured"` pays.** Any other status is recorded (so it is also idempotent) as
  `ignored_not_captured` and leaves the order and stock untouched.
- **Amount mismatch** → `needs_review`. The stock stays reserved while staff check.
- A second, different capture for an already-paid order is recorded as `order_not_payable` (a
  refund candidate). An unknown order id is recorded and gets `200`, so the provider stops retrying.

### Late payment (valid capture after the hold expired)
1. Always **record** the event. **Never** silently revive the order to `paid`, because its units
   may already belong to someone else.
2. Move the order to **`needs_review`**, so a human decides.
3. If the full amount was paid **and** every item is still available, **re-reserve** the stock
   (`late_payment_stock_reserved`) so staff can fulfil it.
4. Otherwise reserve nothing and flag a **refund** (`late_payment_refund_required`).
5. A `needs_review` order cannot be claimed at a locker.

**Why:** the customer paid in good faith, so we try to honour it, but never at the expense of someone
who bought the units in the meantime. A human only gets involved in the rare edge case.

### Countdown with a wrong counter clock
The screen never uses its own wall clock to decide how much time is left. It takes the server's
`expiresInSeconds` from each poll (every 2 s) and, between polls, subtracts only the real elapsed
time measured with `performance.now()`, a clock that only moves forward and isn't affected by
the system time. So a counter whose clock is minutes off, or changes mid-countdown, still shows
the right time.

---

## Assumptions
- **The locker is a trusted caller.** `POST /orders/:id/pickup-claim` has no authentication, and the
  order UUID serves as the pickup credential. In the UI, the **Confirm pickup** button plays the locker.
- **Paid orders keep their stock reserved** until pickup, with no deadline. Paid but never collected
  is a staff problem, not an automatic release.
- **Webhook statuses:** only `captured` is acted on. Other values are recorded and ignored.
- **Same `eventId` with a different payload** is treated as a duplicate, and the first payload wins.
- **Quantities** are limited to 1–20 per line and at most 20 lines per order.
- **Product prices** are copied onto the order lines when the order is placed, so later price
  changes don't affect existing orders.
- **"Expired" is shown** once the hold passes. If a late payment then arrives, the screen (still
  polling every 10 s) switches to "Payment under review".

## What I would do next with more time
- Staff endpoints and a screen to resolve `needs_review` orders (fulfil, refund, release the stock),
  and to release stock held by paid orders that are never collected.
- Authentication for lockers and staff, plus a short pickup code instead of the order UUID.
- Check a provider timestamp on webhooks, with a replay window.
- Browser-level tests (e.g. Playwright) for the cart → pay → pickup flow, including a faked clock offset.
- Metrics and alerts for the expiry sweeper, webhook failures and orders stuck in `needs_review`.
