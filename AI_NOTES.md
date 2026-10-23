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
- **The AI ran these:** backend `tsc --noEmit`, backend production build, backend unit tests
  (signature), frontend typecheck and build, and frontend unit tests (paise formatting, countdown).
- **Not yet run:** the PostgreSQL integration tests (`backend/npm test`) and the Docker
  Compose build. At the time of writing, the development machine had no working PostgreSQL
  server and no Docker. These tests were written but **have not been run against a real
  database yet**, so they should be run, and any failures fixed, before relying on them.

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
