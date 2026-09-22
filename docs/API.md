# API reference

Every endpoint below is under `/api`. Unless noted, requests need `Authorization: Bearer <token>` from `POST /api/auth/login` (staff) or `POST /api/auth/parent-login` (parents). Kiosk endpoints use an `x-device-token` header instead. The permission column lists what the signed-in person needs (any one of them). The database applies its own limits on top: a teacher only ever gets their own room, and a parent only their own child.

Generated from the route files.

## admin

| Method | Path | Needs |
|---|---|---|
| GET | `/api/admin/users` | users.manage |
| POST | `/api/admin/users` | users.manage |
| PATCH | `/api/admin/users/:id` | users.manage |
| GET | `/api/admin/permissions` | users.manage |
| PUT | `/api/admin/permissions` | users.manage |
| GET | `/api/admin/pins` | users.manage, attendance.checkout |
| POST | `/api/admin/pins` | users.manage |
| POST | `/api/admin/pins/:id/unlock` | users.manage, attendance.checkout |
| GET | `/api/admin/staff` | staff.view |
| POST | `/api/admin/staff/:id/pin` | users.manage |
| POST | `/api/admin/staff/:id/biometric/consent` | users.manage |
| POST | `/api/admin/staff/:id/biometric/enroll` | users.manage |
| GET | `/api/admin/devices` | users.manage |
| POST | `/api/admin/devices` | users.manage |
| GET | `/api/admin/settings` | settings.manage |
| PUT | `/api/admin/settings` | settings.manage |
| GET | `/api/admin/audit` | audit.view |
| GET | `/api/admin/meta` | users.manage, attendance.record, enrollment.view, orders.request, meals.view, supplies.flag, time.punch |

## alerts

| Method | Path | Needs |
|---|---|---|
| GET | `/api/alerts` | attendance.record |
| POST | `/api/alerts/:id/response` | attendance.record |
| POST | `/api/alerts/:id/resolve` | attendance.record |
| POST | `/api/jobs/run` | settings.manage |
| POST | `/api/jobs/demo/start-day-late` | settings.manage |
| GET | `/api/dev/outbox` | settings.manage |

## attendance

| Method | Path | Needs |
|---|---|---|
| GET | `/api/attendance/today` | attendance.view |
| GET | `/api/attendance/ratios` | attendance.view |
| POST | `/api/attendance/check-in` | attendance.record |
| POST | `/api/attendance/check-out` | attendance.checkout |
| POST | `/api/attendance/absent` | attendance.record |
| GET | `/api/attendance/pickup-people/:childId` | attendance.checkout |
| GET | `/api/attendance/absences/today` | attendance.record |

## auth

| Method | Path | Needs |
|---|---|---|
| POST | `/api/auth/login` | any signed-in user |
| POST | `/api/auth/parent-login` | any signed-in user |
| GET | `/api/me` | any signed-in user |

## compliance

| Method | Path | Needs |
|---|---|---|
| POST | `/api/documents` | food_products.manage, children.manage, purchasing.view |
| GET | `/api/documents/:id/download` | food_products.manage, children.manage, purchasing.view, meals.claims |
| GET | `/api/products` | food_products.manage, meals.claims, recipes.manage |
| GET | `/api/products/:id` | food_products.manage, meals.claims, recipes.manage |
| POST | `/api/products` | food_products.manage |
| POST | `/api/products/:id/versions` | food_products.manage |
| GET | `/api/certificates` | food_products.manage, meals.claims |
| POST | `/api/certificates` | food_products.manage |
| POST | `/api/certificates/:id/verify` | food_products.manage |
| GET | `/api/compliance/summary` | food_products.manage, meals.claims |
| GET | `/api/recipes` | recipes.manage, meals.claims, food_products.manage |
| GET | `/api/recipes/:id` | recipes.manage, meals.claims, food_products.manage |
| POST | `/api/recipes` | recipes.manage |
| GET | `/api/ingredients` | recipes.manage, food_products.manage |
| GET | `/api/portions` | recipes.manage, meals.claims, food_products.manage |
| POST | `/api/portions` | recipes.manage |
| GET | `/api/meta/food` | recipes.manage, food_products.manage, meals.claims |
| GET | `/api/menus/day` | recipes.manage, meals.claims, food_products.manage |
| POST | `/api/menus/day` | recipes.manage |

## enrollment

| Method | Path | Needs |
|---|---|---|
| GET | `/api/enrollment/board` | enrollment.view |
| POST | `/api/enrollment/inquiries` | enrollment.manage |
| POST | `/api/enrollment/applications/:id/stage` | enrollment.manage |
| GET | `/api/enrollment/applications/:id` | enrollment.view |
| POST | `/api/enrollment/checklist/:id` | enrollment.manage |
| POST | `/api/enrollment/applications/:id/tour` | enrollment.manage |
| POST | `/api/enrollment/applications/:id/convert` | enrollment.manage |
| GET | `/api/enrollment/waitlist` | enrollment.view |
| GET | `/api/enrollment/capacity` | enrollment.view |
| GET | `/api/enrollment/offer-candidates` | enrollment.view |
| GET | `/api/enrollment/roster` | enrollment.view, attendance.view |
| GET | `/api/enrollment/enrollments` | enrollment.view |
| POST | `/api/enrollment/enrollments/:id/status` | enrollment.manage |
| GET | `/api/enrollment/age-ups` | enrollment.view |
| POST | `/api/enrollment/age-ups/confirm` | enrollment.manage |
| POST | `/api/enrollment/transitions/run` | enrollment.manage |
| GET | `/api/enrollment/tasks` | enrollment.view |

## kiosk

| Method | Path | Needs |
|---|---|---|
| GET | `/api/kiosk/info` | any signed-in user |
| GET | `/api/kiosk/staff` | any signed-in user |
| POST | `/api/kiosk/punch` | any signed-in user |
| POST | `/api/kiosk/family/lookup` | any signed-in user |
| POST | `/api/kiosk/family/sign` | any signed-in user |

## meals

| Method | Path | Needs |
|---|---|---|
| POST | `/api/meals/services/ensure` | meals.claims, food_products.manage |
| GET | `/api/meals/room` | meals.view |
| POST | `/api/meals/record` | meals.record |
| POST | `/api/meals/infant-feeding` | meals.record |
| POST | `/api/meals/food-event` | meals.record |
| POST | `/api/meals/services/:id/finalize` | meals.record |
| POST | `/api/meals/services/:id/reopen` | meals.claims |
| GET | `/api/meals/claims` | meals.claims |
| GET | `/api/reports/daily/readiness` | daily_report.view |
| POST | `/api/reports/daily/build` | daily_report.publish |
| POST | `/api/reports/daily/publish` | daily_report.publish |
| GET | `/api/reports/daily/preview/:childId` | daily_report.view |

## notifications

| Method | Path | Needs |
|---|---|---|
| GET | `/api/notifications` | any signed-in user |
| POST | `/api/notifications/read` | any signed-in user |

## orders

| Method | Path | Needs |
|---|---|---|
| GET | `/api/orders/catalog` | orders.request, orders.review |
| POST | `/api/orders/stockroom/take` | orders.request, orders.review |
| POST | `/api/orders/requests` | orders.request |
| GET | `/api/orders/mine` | orders.request |
| POST | `/api/orders/lines/:id/cancel` | orders.request |
| POST | `/api/orders/lines/:id/confirm` | orders.request |
| GET | `/api/orders/queue` | orders.review |
| POST | `/api/orders/lines/:id/decide` | orders.review |
| POST | `/api/orders/lines/:id/comment` | orders.review, orders.request |
| GET | `/api/pos` | purchasing.view, orders.review |
| POST | `/api/pos` | purchasing.view, orders.review |
| POST | `/api/pos/:id/status` | purchasing.view, orders.review |

## parent

| Method | Path | Needs |
|---|---|---|
| GET | `/api/parent/children` | portal.sign_in_out |
| GET | `/api/parent/sign-in-out` | portal.sign_in_out |
| GET | `/api/parent/daily-report` | portal.sign_in_out |
| POST | `/api/parent/supply-response` | portal.sign_in_out |

## purchasing

| Method | Path | Needs |
|---|---|---|
| GET | `/api/purchasing/list` | purchasing.view |
| GET | `/api/purchasing/all` | purchasing.view |
| GET | `/api/purchasing/meta` | purchasing.view |
| POST | `/api/purchasing/needs` | purchasing.view |
| POST | `/api/purchasing/submit` | purchasing.view |
| GET | `/api/purchasing/review` | purchasing.approve |
| POST | `/api/purchasing/needs/:id/decide` | purchasing.approve |
| POST | `/api/purchasing/adopt/:lineId` | purchasing.view |
| GET | `/api/purchasing/to-order` | purchasing.view |
| GET | `/api/purchasing/pipeline` | purchasing.view |
| GET | `/api/purchasing/budgets` | purchasing.view |

## supplies

| Method | Path | Needs |
|---|---|---|
| GET | `/api/supplies/room` | supplies.flag, supplies.review |
| POST | `/api/supplies/flag` | supplies.flag |
| POST | `/api/supplies/flags/:id/undo` | supplies.flag |
| GET | `/api/supplies/queue` | supplies.review |
| POST | `/api/supplies/flags/:id/ack` | supplies.review |
| POST | `/api/supplies/flags/:id/resolve` | supplies.review |

## timeclock

| Method | Path | Needs |
|---|---|---|
| GET | `/api/time/who-is-in` | time.view_all |
| GET | `/api/time/review-queue` | time.view_all |
| POST | `/api/time/punches/:id/review` | time.approve |
| POST | `/api/time/timesheets/build` | time.approve |
| GET | `/api/time/weekly-report` | time.view_all |
| POST | `/api/time/timesheets/:id/approve` | time.approve |
| POST | `/api/time/timesheets/:id/lock` | time.approve |
| POST | `/api/time/timesheets/:id/reopen` | time.approve |
| GET | `/api/time/my` | time.punch |
| POST | `/api/time/my/confirm` | time.punch |
| GET | `/api/time/corrections` | time.view_all |
| POST | `/api/time/corrections` | time.view_all, time.punch |
| POST | `/api/time/corrections/:id/approve` | time.approve |
| POST | `/api/time/corrections/:id/deny` | time.approve |
| GET | `/api/time/punctuality` | punctuality.view |
| GET | `/api/time/exceptions` | time.view_all |

## Simple create, read, and update lists

`/api/vendors`, `/api/catalog-items`, and `/api/food-items` each support GET (list), GET `/:id`, POST, and PATCH `/:id`.
