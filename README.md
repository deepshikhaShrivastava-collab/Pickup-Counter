# Pickup Counter

Order ahead, pay, collect at the counter. Customers browse a menu, reserve items for
**120 seconds** while they pay, and collect at the counter once a signed payment webhook
confirms the payment.

- **Backend:** Node.js, Express 5, TypeScript, PostgreSQL (`pg`, plain parameterised SQL)
- **Frontend:** React 19, Vite, TypeScript
- **Tests:** Vitest. The integration tests run against a real PostgreSQL, with no mocks or SQLite.
- **Docker Compose** is provided for one-command startup, but **local development does not need Docker**.

```
.
├── docker-compose.yml        optional: db + api + web
├── .env.example              copy to .env (never commit .env)
├── backend/
│   ├── migrations/           SQL schema (001_init.sql)
│   ├── seeds/products.sql    the five demo products (idempotent)
│   ├── src/
│   │   ├── app.ts            Express app (routes + error handler)
│   │   ├── server.ts         entry point + expiry sweeper
│   │   ├── routes/           products, orders, webhooks
│   │   ├── services/         inventory, orders, expiry, payments, pickup
│   │   ├── lib/signature.ts  HMAC-SHA256 sign / verify
│   │   ├── db/               migration runner + CLI
│   │   └── scripts/send-webhook.ts   signed webhook test script
│   └── test/                 PostgreSQL integration tests + unit tests
└── frontend/
    └── src/                  catalog, cart, payment countdown, order status polling
```

---

## Running locally on Windows (no Docker)

You need **Node.js 22+** and **PostgreSQL 13+** running locally. Run each part in its own
PowerShell window.

### 1. PostgreSQL

Use any PostgreSQL 13+ server on `localhost:5432`. Two low-disk options:

**Option A: repair or install with the EDB installer.** Download it from
<https://www.postgresql.org/download/windows/>. In the component screen you can untick
*pgAdmin* and *Stack Builder* to save disk space. The installer registers a Windows service
that starts automatically.

**Option B: portable zip, with no installer and no service.** Download the "zip archive"
binaries from <https://www.enterprisedb.com/download-postgresql-binaries>. Extract them to
e.g. `C:\pgsql`, then:

```powershell
# one-time: create a data directory (you will be asked for a postgres superuser password)
C:\pgsql\bin\initdb.exe -D C:\pgsql\data -U postgres -E UTF8 -A scram-sha-256 -W

# start it (repeat after each reboot); stop with: C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data stop
C:\pgsql\bin\pg_ctl.exe -D C:\pgsql\data -l C:\pgsql\postgres.log start
```

**Create the app role and database.** This works for either option. Replace the `psql.exe`
path with your install's `bin` folder (EDB installs to `C:\Program Files\PostgreSQL\<version>\bin`).
Use the same password you put in `.env`:

```powershell
$psql = "C:\pgsql\bin\psql.exe"
& $psql -h localhost -U postgres -c "CREATE ROLE pickup LOGIN CREATEDB PASSWORD 'your-password-here';"
& $psql -h localhost -U postgres -c "CREATE DATABASE pickup OWNER pickup;"
```

`CREATEDB` is needed only by the integration tests, which drop and recreate their own
`pickup_test` database on every run.

### 2. Configuration

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `DATABASE_URL` and `TEST_DATABASE_URL` to use the password from step 1. Then set
`PAYMENT_WEBHOOK_SECRET` to a random value:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`.env` is gitignored. All backend npm scripts load it automatically (`node --env-file-if-exists=../.env`).

### 3. Backend (http://localhost:4000)

```powershell
cd backend
npm install
npm run db:setup     # apply migrations + seed the five products (safe to re-run)
npm run dev          # API with auto-reload
```

Check it: <http://localhost:4000/api/health> → `{"ok":true}`

### 4. Frontend (http://localhost:5173)

```powershell
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to `http://localhost:4000`, so there is no CORS setup. Set
`API_PROXY_TARGET` to point elsewhere.

### 5. Simulate a payment

There is no real payment provider. Place an order in the UI, then send the provider's
signed webhook from a terminal (the order page shows this command with your order id filled in):

```powershell
cd backend
npm run webhook -- --order <orderId>                  # pays the exact total -> paid
npm run webhook -- --order <orderId> --amount 100     # wrong amount -> needs_review
npm run webhook -- --order <orderId> --repeat 3       # same event id 3x -> applied once
npm run webhook -- --order <orderId> --bad-signature  # -> 401
```

The script signs the exact body bytes with HMAC-SHA256 using `PAYMENT_WEBHOOK_SECRET` from
`.env` and sends the hex digest in `X-Signature`. Once the order is paid, the order page shows a
**Confirm pickup** button that plays the role of the counter staff.

### 6. Tests

| Command | Needs PostgreSQL? | What it covers |
|---|---|---|
| `cd backend; npm test` | **Yes** (`TEST_DATABASE_URL`) | All backend tests: integration + unit |
| `cd backend; npm run test:unit` | No | HMAC signature sign/verify |
| `cd backend; npm run typecheck` | No | Typechecks source and tests |
| `cd frontend; npm test` | No | Paise formatting, countdown maths |
| `cd frontend; npm run build` | No | Typecheck + production build |

The integration tests (`backend/test/*.test.ts`) start the real Express app on a random port
and hit it over HTTP with real concurrency. They cover:

- **orders.test.ts:** 10 simultaneous orders for the last 2 units (exactly 2 succeed); a
  2-unit order racing 1-unit orders never oversells; multi-product orders are all-or-nothing;
  server-measured `expiresInSeconds`; expired holds stop counting immediately and are released.
- **webhooks.test.ts:** missing, invalid, wrong-secret and tampered signatures are rejected with
  no side effects; the signature covers the raw bytes; 10 simultaneous deliveries of one event
  are applied exactly once; amount mismatch goes to `needs_review`; late payments with and
  without remaining stock.
- **pickup.test.ts:** 10 simultaneous pickup claims (exactly 1 succeeds, stock deducted once);
  unpaid, expired and under-review orders are rejected; stock stays deducted.

For safety, the test setup refuses to run unless the database name in `TEST_DATABASE_URL`
contains `test`.

---

## Running with Docker Compose (optional)

```bash
cp .env.example .env    # then edit the values
docker compose up --build
```

- Web UI: <http://localhost:8080> (nginx serves the built app and proxies `/api`)
- API: <http://localhost:4000>
- Postgres: `localhost:5433`. Host port 5433 avoids clashing with a local install on 5432.

The API container applies migrations and the seed on start. Send webhooks from the host with
`cd backend; npm run webhook -- --order <id>`. The script defaults to `http://localhost:4000`.

---

## API

All responses are JSON. Errors always have this shape:

```json
{ "error": "insufficient_stock", "message": "Not enough stock for this product", "details": { "productId": 5, "requested": 3, "available": 2 } }
```

| Method & path | Success | Errors |
|---|---|---|
| `GET /api/health` | `200 {ok:true}` | `500` if the DB is unreachable |
| `GET /api/products` | `200 {products:[{id, sku, name, description, pricePaise, stockOnHand, available}]}` | |
| `POST /api/orders` `{items:[{productId, quantity}]}` | `201 {order}` | `400 invalid_request`, `404 product_not_found`, `409 insufficient_stock` |
| `GET /api/orders/:id` | `200 {order}` | `404 order_not_found` |
| `POST /api/orders/:id/pickup` | `200 {order}` | `404`, `409 order_not_paid` / `order_expired` / `order_needs_review` / `already_picked_up` |
| `POST /api/webhooks/payment` | `200 {eventId, duplicate, outcome, orderStatus}` | `401 invalid_signature`, `400 invalid_json` / `invalid_request` |

`order` = `{id, status, totalPaise, expiresAt, expiresInSeconds, reviewReason, createdAt, paidAt, pickedUpAt, items[]}`.
`expiresInSeconds` is computed by PostgreSQL (`expires_at - now()`) on every read. It is `null`
unless the order is `pending_payment`.

Webhook body: `{"eventId": "evt_…", "orderId": "<uuid>", "amountPaise": 9000}`, header
`X-Signature: <hex HMAC-SHA256 of the raw body>` (a `sha256=` prefix is also accepted).

---

## Design

### Data model
- **Money** is always integer **paise** (`INTEGER` columns, `Number.isInteger` validation, integer
  formatting in the UI). No floats anywhere.
- `products.stock_on_hand` is what is physically on the shelf. It only changes at pickup.
- `holds` reserve stock per order line: `active` (unpaid, has `expires_at`) → `committed` (paid
  or under review, no expiry) → `consumed` (picked up), or → `released` (expired).
- **Available stock** = `stock_on_hand − Σ(committed holds + active holds whose expires_at > now())`,
  computed by the `product_availability` view. An expired hold stops counting the instant its
  deadline passes, even if the sweeper hasn't run yet.

### Order statuses
`pending_payment` → `paid` → `picked_up`, or `pending_payment` → `expired`, or → `needs_review`
(amount mismatch or late payment).

### Concurrency guarantees
| Concern | Mechanism |
|---|---|
| Two buyers, last units | Order creation locks the product rows `FOR UPDATE` **in ascending id order** (no deadlocks), then re-reads availability. Under READ COMMITTED that read sees every hold committed by the previous lock holder. Check and insert happen in one transaction. |
| Expiry | `expireDueOrders()` is a single statement that flips overdue orders to `expired` and releases their holds. It uses `FOR UPDATE SKIP LOCKED`, so it never blocks behind (or fights) a payment in progress. It runs every 5s **and** lazily on order reads, payments and pickups, so correctness never depends on the sweeper's timing. |
| Duplicate webhooks | `payment_events.event_id` is the primary key. `INSERT … ON CONFLICT DO NOTHING` runs first in the transaction. Concurrent duplicates block on the index, then see the row and return the stored outcome. If the first attempt rolls back, the retry is processed normally. |
| Payment vs expiry race | The payment locks the order row `FOR UPDATE`. Whichever of payment and expiry commits first wins, and the other re-checks status. |
| Double pickup | `UPDATE orders SET status='picked_up' WHERE id=$1 AND status='paid'`. Concurrent claimers queue on the row lock, and after the winner commits the rest match zero rows → `409 already_picked_up`. Stock deduction and hold consumption happen in the same transaction. |

### Webhook verification
The webhook route uses `express.raw()` and is mounted before `express.json()`, so the HMAC is
computed over the exact received bytes. The JSON is parsed only after verification. The
comparison uses `crypto.timingSafeEqual`. The secret comes from the `PAYMENT_WEBHOOK_SECRET`
environment variable and is never sent to the browser.

### Late payment policy (payment arrives after the 120s hold expired)
1. The event is always **recorded** (idempotently), and the order is **never silently revived** to
   `paid`. Its stock may already belong to someone else.
2. The order moves to **`needs_review`**, so a human decides, and the customer is told to ask at the counter.
3. If the full amount was paid **and** every item is still available, the stock is
   **re-reserved** (committed hold) so staff can choose to fulfil it: `review_reason = late_payment_stock_reserved`.
4. Otherwise nothing is reserved and the order is flagged for a **refund**:
   `review_reason = late_payment_refund_required`.
5. `needs_review` orders **cannot be picked up** through the normal flow.

Other payment edge cases:
- An **amount mismatch** on time → `needs_review` (`amount_mismatch`), with the stock kept
  committed pending review.
- A **second, different event** for an already paid order is recorded as `order_not_payable`,
  and the status doesn't change (a candidate for a refund).
- An event for an **unknown order** is recorded as `unknown_order` and acknowledged with `200`,
  so the provider stops retrying.

### Known limitations and next steps
- There are no staff endpoints yet to resolve `needs_review` orders (approve, refund) or to release
  stock committed for them. Today that is a manual DB operation.
- There is no authentication on the pickup endpoint. A real counter would require staff auth and a
  short pickup code instead of the order UUID.
- There is no webhook timestamp or replay window. Replays of the same event are harmless (idempotent),
  but a provider-supplied timestamp should be checked in production.
- If the same `eventId` is re-sent with a *different* payload, it is treated as a duplicate and the
  new payload is ignored.
