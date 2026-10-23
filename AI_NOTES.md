# AI usage notes

This project was built with an AI coding assistant (Claude, via Claude Code), working in stages
with the developer reviewing each stage: inspect and plan → database and backend → tests →
frontend → verification.

## What the AI did
- Proposed the architecture, schema and concurrency strategy, then wrote the migration, seed,
  Express API, services, signed webhook script, integration and unit tests, React frontend,
  Dockerfiles, Compose file, README and these notes.
- Picked the database-level mechanisms for each correctness requirement: ordered `FOR UPDATE`
  locks, a single-statement expiry with `SKIP LOCKED`, `ON CONFLICT DO NOTHING` on the event id,
  and a conditional `UPDATE … WHERE status = 'paid'` for the pickup claim. The README explains
  each one.
- Wrote the late-payment policy: record, never auto-revive, `needs_review`, then re-reserve if
  possible, otherwise refund.

## How the output was checked
- **The developer reviewed** the plan before any code was written, and each stage before the next.
- **The developer installed PostgreSQL 18 locally** (Windows, port 5432) and ran `npm run db:setup`.
  The developer also did a manual checkout in the browser: all five products, ₹430 total, then
  the signed webhook script.

### Automated tests (run by the AI, against the local PostgreSQL 18)
| Command | Result |
|---|---|
| `backend: npx tsc --noEmit` | No errors |
| `backend: npm test` | **27/27 passed**: 24 integration tests across `orders`, `webhooks` and `pickup` (real PostgreSQL), plus 3 signature unit tests |
| `frontend: npm run build` (tsc + vite) | Passed |
| `frontend: npm test` | 3/3 passed (paise formatting, countdown) |

### End-to-end check against the running app
The AI ran a script against the running backend (`http://localhost:4000`) and the local
database. Every webhook went through the project's own `send-webhook.ts`, and the database was
only *read* to confirm results, never edited by hand. **All 17 checks passed:**
- Order creation stores the total in integer paise, starts as `pending_payment` with a 120 s
  hold measured by the database clock, creates its holds atomically, and reduces available stock.
- An invalid signature gets 401 and nothing is recorded.
- A valid payment within the hold → `paid`. The same event sent again is reported as a duplicate
  and applied only once.
- An amount mismatch → `needs_review`.
- Unpaid and expired orders cannot be collected (409).
- Of two simultaneous pickup claims, exactly one succeeds and the other gets 409. Shelf stock is
  permanently deducted.
- A real 120 s expiry, with no manual time travel, releases the hold and restores availability.
  A payment arriving after that follows the late-payment policy (`needs_review`, stock re-reserved).

### Issue found during manual testing
In the developer's first manual checkout, the webhook returned `late_payment_stock_reserved`.
The database timestamps showed why: the order was created at 10:13:43, its hold expired at
10:15:43, and the webhook arrived at 10:20:52, about 5 minutes after expiry. So the result was
**correct per policy, not a backend bug**.

It did expose a small frontend defect: the order page stopped checking for updates once an
order expired, so it never showed the later move to `needs_review`. The fix keeps checking
expired orders every 10 s; only `picked_up` is final. That change type-checks and builds, but it
has not been watched changing over in a browser.

### Still not verified
- The **Docker Compose** setup (`docker-compose.yml`, both Dockerfiles) has **never been built or
  run**: Docker is not installed on the development machine.
- The browser DevTools console and network tabs have not been reviewed by the AI.

## Judgement calls worth reviewing
- Holds have their own `expires_at`, and availability ignores overdue holds immediately. This
  trades a little duplication (the order and its holds both store the deadline) for correctness
  that doesn't depend on the sweeper.
- On-time amount mismatches keep the stock committed while under review. That protects the
  customer who paid, but can tie up stock until staff act, and there is no staff tooling yet.
- Events for unknown orders return `200` (recorded) rather than `4xx`, so providers don't retry forever.
- The order UUID is the pickup credential in this demo. Real deployments need staff auth and a
  pickup code.

## Prompts and process
The developer gave the full requirement list up front and asked for staged delivery, with an
explicit rule never to claim a test passed unless it had actually been run. The assistant
reported each verification step with its actual result.
