# Architecture

```
Browser (React)  ->  API (Node, Express)  ->  PostgreSQL 15+
 web/                 server/                  db/migrations
  screens              routes, jobs             tables, rules, row-level security
```

## How access is enforced (three layers)

1. **Application permissions.** `role_permissions` says what each role can do. Screens and routes check it.
2. **Database roles.** For each request the API switches to `cubby_office`, `cubby_teacher`, or `cubby_parent` (`SET LOCAL ROLE`) and tells the database who is asking (`app.user_id`). Teachers and parents have almost no table access, only specific views.
3. **Row-level security.** A teacher sees only children in their own classroom. A parent sees only their own child. The role and center are looked up from the user account, not trusted from the request.

The kiosk uses a separate role, `cubby_kiosk`, that can run exactly one function: check a PIN and record a sign-in or sign-out.

## Rules that live in the database (so no screen or script can skip them)
Enrollment stage moves and status moves, purchase and request status moves, separation of duties (nobody approves their own item, timesheet, or correction), the age rule for blankets, one open flag per child and item, immutable raw time punches, face templates only with recorded consent, and PIN lockout.

## Background jobs (`server/src/jobs`)
Run every minute (and on demand at `POST /api/jobs/run`). All are safe to repeat. Expected arrivals, missing-child alerts and the contact plan, on-time and late records, missed punches, certificate expiry, weekly hours, meal setup, face template deletion.

## Plug-in points
- `server/src/lib/notify.js`: texts and calls (`console` or `twilio`).
- `server/src/lib/face.js`: face verification interface (`verify`, `enroll`, `deleteTemplate`). Only a demo stand-in is included.
- File storage: uploaded documents go to `UPLOAD_DIR` on disk. Use object storage in production.

## Database migrations
`db/migrations/*.sql` run once each, in order, when the server starts. The design notes for the tables are in `docs/workflows-and-jobs.md`.
