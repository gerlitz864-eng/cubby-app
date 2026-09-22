# Cubby: daycare management platform

One application for a childcare center: staff time clock with face or PIN, current and future enrollment, missing-child alerts, child supply flags, classroom ordering, facility purchasing, meal tracking with a daily parent summary, and vendor products, certificates, recipes, and portion sizes for the New Jersey food program.

> **Read this first.** This is a working prototype with demo data. Face verification is a stand-in that identifies nobody. Texts and calls are logged, not sent, until you connect a provider. Meal pattern amounts and reimbursement rates in the demo are placeholders. Before real children's or staff data goes in, it needs a security review, real integrations, and legal review (biometrics, automated calls and texts, records retention, licensing).

## Try it (needs Node 20 or newer)

```bash
npm install
npm run build
npm start            # open http://localhost:4000
```

The first start creates an embedded PostgreSQL in `server/data/` and loads a fictional center. Delete that folder to start fresh. For development with reloading: `npm run dev` (web on http://localhost:5173, API on 4000).

### Demo accounts (password `demo1234`)
`owner@`, `director@`, `office@`, `teacher@` (Ladybugs), `teacher2@` (Bumblebees), `cook@` `willowcreek.test`. Parent: `parent@willowcreek.test` with PIN `123456`. The sign-in screen has buttons that fill these in.

Kiosk (staff time clock, and parents signing children in and out): open `/kiosk`, use device token `demo-kiosk-token`. Staff PIN is `2468`. Parent phone `(555) 010-2311`, PIN `123456`.

### Things to try
- **Missing-child alerts:** the demo starts at whatever time you open it, so alerts may already be running. Sign in as the director, open Alerts, choose *Demo: start the day late*, then *Run checks now*. Watch the plan run: text, call, then staff are given the emergency contacts, then the director is told. Sign the child in at the kiosk and the alert closes.
- **Teacher screens:** sign in as `teacher@`. Try Child supplies (tap once for low, again for out), Classroom orders (add a custom item), and Meals.
- **Meals and the state claim:** as the cook, Meals, *Prepare today's lunch*. Sign children in (Attendance as the office), then record meals as `teacher2@`. The State claim tab shows counts and an estimate.
- **Approvals with separation of duties:** as the office, add a purchasing item and submit it. As the director, approve it. Try approving something you entered yourself.
- **Enrollment:** the pipeline board, moving an application through to *Enroll now*.

## Tests
```bash
npm test -w server   # 25 tests against the API and the real database rules
npm test -w web      # 20 tests that render every screen against the API
```
Set `TEST_PG_ADMIN_URL=postgres://user:pw@localhost:5432/postgres` to run the server tests against a real PostgreSQL server instead of the embedded one (they were run against PostgreSQL 16 as well).

## Production
- Use a real PostgreSQL 15 or newer: set `DATABASE_URL`. `docker compose up --build` runs the app with PostgreSQL 16 (not yet tested with Docker).
- Set long random `JWT_SECRET` and `PIN_PEPPER` (the server refuses to start in production with the defaults). Keep them out of the database and out of source control.
- Run the API over HTTPS behind a proxy, back up the database, and store uploads in object storage.
- Give the API's database login the right shape: it should be able to `SET ROLE` to `cubby_office`, `cubby_teacher`, `cubby_parent`, and `cubby_kiosk` (migration 009 creates them). Server-side jobs and kiosk punches use the owner connection.
- Use one database per center. Several reporting views use the database's own "today", which is why `DB_TIMEZONE` is set.

## What is real and what is not
| Real and tested | Stand-in or untested |
|---|---|
| All tables, rules, and access limits, on PostgreSQL 16 and 18 | Face verification (demo only) |
| PIN check, lockout, release restrictions | Sending texts and calls (Twilio code written, not run against an account) |
| Hours to the second, overtime, timesheet approval | Docker files (not run) |
| Missing-child alert plan with consent rules | Meal pattern amounts and rates (placeholders) |
| Enrollment stages, waitlist, conversion | Email delivery (not built) |
| Ordering and purchasing approvals | Billing screens (tables exist, no screens) |

## Layout
```
db/migrations/   the database (10 files)
server/          API, background jobs, tests
web/             React screens, screen tests
docs/            ARCHITECTURE.md, API.md, workflows-and-jobs.md (design notes, triggers, jobs)
```
