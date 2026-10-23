# AI notes

## Tools and what they were used for
- **Claude Code (Claude Opus)**, the main tool. It wrote the plan, schema, Express API, signed webhook
  script, integration and unit tests, React screen, Dockerfiles, Compose file, CI workflow and
  first drafts of these notes. It also ran the tests and diagnosed issues against the local database.
- **ChatGPT**, used alongside it for planning and for writing up task handovers between sessions.
  <!-- Deepshikha: adjust this line to match exactly how you used ChatGPT. -->

I reviewed the plan before any code was written, and each stage before the next one started. I ran
the app myself, including a full manual checkout, and installed PostgreSQL locally.

## A prompt that worked well
> "Work in stages: 1. Inspect the project and provide an implementation plan. 2. Implement the
> database and backend. 3. Run and fix backend tests. … Do not claim a test passed unless you
> actually ran it. Keep secrets in environment variables and never commit .env files."

It worked because the staging forced a reviewable plan first, and the "don't claim it passed"
rule made every report say exactly what had and hadn't been run. For example, the AI kept
saying "written but not run against PostgreSQL" until a database was available.

## Things the AI got wrong, and how I noticed
1. **It built against my summary of the brief, not the brief itself.** The first version used
   `/api/webhooks/payment` and `/api/orders/:id/pickup` instead of `/payments/webhook` and
   `/orders/:id/pickup-claim`. It ignored the webhook's `status` field, so any signed event would
   have marked an order paid. It named the script `npm run webhook`, and its `docker compose up`
   refused to start without a `.env`. **Noticed** when I gave it the original brief and asked for
   a summary of what was done and what was left. It compared the two line by line. All of these
   were fixed and covered by tests.
2. **The payment screen stopped polling once an order expired.** In my manual checkout, the
   webhook returned `late_payment_stock_reserved` while I expected `paid`. Before changing
   anything, I had the AI query the database. The timestamps showed the webhook arrived 5 minutes
   after the 120 s hold ended, so the backend was correct. But it exposed that the screen never
   showed the later move to `needs_review`. Fixed: expired orders keep being polled.
3. **An Express 5 routing assumption.** `app.use(['/api', '/'], router)` silently matched only
   `/api`. **Noticed** because every integration test suddenly returned 404 after the route
   change. A 10-line reproduction confirmed it, and the fix uses two `app.use` calls.

## How the result was checked
- **Locally (Windows 11, Node 24, PostgreSQL 18):** backend `tsc` clean; backend `npm test` 29/29
  (26 integration tests on PostgreSQL + 3 unit); frontend build passing and 3/3 tests.
- **End to end against the running API:** an AI-written script with 17 checks, all passing: 120 s
  holds measured by the database clock, availability, invalid signature, payment, duplicate,
  amount mismatch, unpaid and expired pickups rejected, two simultaneous claims giving 200 and 409,
  permanent stock deduction, a real expiry, and a late payment. The database was only read to
  confirm results. This ran before the route rename; the renamed routes are covered by the
  integration tests and CI.
- **GitHub Actions on every push:** the same test suites against a PostgreSQL container, plus
  `docker compose up` from a clean checkout with no `.env`, smoke-tested with products, the web
  app, an order, a signed webhook, and two pickup claims (200, then 409). Docker isn't installed on
  the development machine, so CI is the only place the Docker setup has been run.
- **Secrets:** the local database password and webhook secret were rotated after being pasted into
  a chat. Git history was scanned for secrets before the repository was made public.
