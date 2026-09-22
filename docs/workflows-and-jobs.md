# Cubby: workflows and background jobs (draft v0.2)

Companion to `cubby_schema.sql`, `cubby_schema_002_automation_products_recipes.sql`, `cubby_schema_003_supplies.sql`, `cubby_schema_004_meal_timeline_and_daily_report.sql`, `cubby_schema_005_classroom_ordering.sql`, `cubby_schema_006_office_purchasing.sql`, `cubby_schema_007_enrollment_pipeline.sql`, `cubby_schema_008_staff_time_tracking.sql`, and `cubby_schema_009_access_control_and_punctuality.sql`.

## 1. Missing-child alert workflow

**Goal:** if a child who is expected has not been signed in 30 minutes after the expected arrival, reach the family and tell staff, without false alarms and without silent failures.

### Inputs the system needs before it can judge "missing"
- `child_schedules`: which days and what time each child is expected. If no time is set, use the center's program start.
- `closure_calendar`: holidays, snow days, delayed openings.
- `planned_absences`: a parent reported the child is out (portal, text reply, or staff entry).
- `expected_attendance`: generated nightly from the three tables above. Rows for closed days or planned absences are created as `closed` or `excused` and are never scanned.

### State machine (`attendance_alerts.status`)
1. `open`: the scanner found an expected child, past the grace window, with no check-in, no absence report, and no existing alert.
2. `parent_responded`: a guardian answered "arriving late" or "call me". The alert stays open with a new deadline so a promise to be late is still followed up.
3. Terminal states:
   - `resolved_arrived`: the child was checked in. Automatic.
   - `resolved_absent`: a guardian reported the absence, or staff recorded it.
   - `resolved_by_staff`: staff closed it with a note.
   - `cancelled`: closure or data correction.

### Escalation ladder (`alert_policy_steps`, editable per center or room)
| Step | Wait | Channel | Who |
|---|---|---|---|
| 1 | 0 min | Text | Primary guardian |
| 2 | 10 min | Automated call | Primary guardian |
| 3 | 10 min | Automated call | Other guardians |
| 4 | 10 min | Call | Emergency contacts |
| 5 | 0 min | Push and text | Director, to decide next actions |

The director is notified at step 1, not only at step 5, so a person owns every open alert from the start. Steps can be marked `requires_staff_ok` if you want a human to approve the first automated call.

### Call script (voice template)
Keep it calm and short: "This is Willow Creek Early Learning. We haven't seen {child_first_name} yet today. Press 1 if they are on their way, 2 if they are staying home today, 3 to speak with us now." Do not leave health, schedule, or family details in a voicemail. Responses are stored in `notification_attempts.response_code` and mapped to `response_meaning`.

### Rules that prevent bad outcomes
- **Re-check before every send.** Each step re-reads attendance and the alert status inside the same transaction that queues the message. A child who arrives while a call is being placed cancels it.
- **One alert per child per day**, enforced by a unique key. A retried job cannot open a second alert.
- **One attempt per recipient per step**, enforced by `idempotency_key`. A retried job cannot call twice.
- **Consent gate.** Automated or prerecorded calls and texts go only to guardians with `voice_consent` or `sms_consent` on file and no `opted_out_at`. A blocked attempt is logged as `blocked_no_consent` and the ladder moves on. Automated-call consent rules (the federal TCPA and state rules) are strict; have counsel review your enrollment consent wording.
- **Staff always see it.** Every open alert shows on the director's dashboard and the classroom screen. The automated call supplements staff follow-up; it never replaces it.
- **Watchdog.** The scanner writes `job_heartbeats` every run. If it has not run in about three minutes, an independent monitor pages the director.
- **Licensing.** Confirm with the NJ licensing office whether it prescribes steps for an unaccounted-for or absent child, and match the ladder to it.

## 2. Vendor product intake workflow

1. **Add product** (`products`, status `pending_review`). Nobody can add it to a recipe or menu yet.
2. **Enter version 1** (`product_versions`): paste the ingredient list and allergen statement exactly as printed, upload the label photo, and enter nutrition facts. The app parses the list into `product_ingredients` and matches names to the `ingredients` master.
3. **Enter crediting** (`product_crediting`): the component and quantity a serving credits, the basis (CN label, manufacturer formulation statement, USDA Food Buying Guide, or a standardized recipe), and the supporting document.
4. **Attach certificates** (see section 3).
5. **Approve** (`status = approved`, `verified_by`, `verified_at`). Only approved products appear in the recipe and menu pickers.
6. **Reformulation:** when a vendor changes a product, add a new version. Old versions keep their dates, so any past meal can be traced to the exact ingredient list in force. Approving the new version triggers the change watch (section 6).
7. **Receiving:** each delivery records vendor, invoice scan, lot code, best-by date, and the temperature of cold items. A failed temperature check requires a rejection reason.

## 3. Compliance certificates

- A certificate (`vendor_certificates`) belongs to a vendor or a manufacturer, has a type, issuer, number, dates, and an uploaded document. It links to the products it covers through `certificate_products`.
- Statuses: `pending`, `verified`, `rejected`, `expired`. Only a person can mark a certificate `verified`.
- Expiry reminders go out at 60, 30, and 7 days. On expiry, the certificate becomes `expired` and covered products appear in `v_products_missing_documents`. Start by warning rather than blocking, so a late renewal does not stop lunch. Decide your policy per certificate type.
- Documents live in object storage. The database holds only the key.

## 4. Recipes and portion control

- **Recipes are versioned.** `recipe_versions` holds the base batch (yield and number of portions). `recipe_lines` hold exact quantities of vendor products or generic ingredients.
- **Scaling:** `scale_recipe(version, portions)` returns the exact ingredient quantities for any headcount.
- **Portion standards** (`portion_standards`) say, per food and age group, exactly what a serving is: a count of pieces, ounces, or cups, the tool to use (scoop size, ladle), what it credits, and the minimum that still counts.
- **Kitchen plan:** the nightly job reads expected attendance by age group for the next day, multiplies by the portion standards, scales the recipes, and writes `production_plans`. The cook confirms and later records what was actually prepared and left over (`production_records`).
- **Allergen roll-up:** `v_recipe_allergens` combines ingredient allergens with the current version of each product used. A menu item that conflicts with a present child's `child_alerts` is flagged on the teacher screen and in the kitchen plan.
- **Lot traceability:** linking served items to delivery lots lets `v_lot_exposure` answer, within seconds, which children ate from a recalled lot.

## 5. Teacher meal screen: how it uses all of this
1. Opens the classroom's meal service for the meal. The app lists present children (from attendance) with their age group.
2. Shows the required portion for each child's age group from the portion standard.
3. One tap records "served as planned." Tapping a child records what they ate, item by item, and substitutions for accommodations.
4. Shows allergen warnings inline, in color and text.
5. "Finalize" locks the meal after checks: every present child has a record, every required component is served at or above the standard portion, and no child exceeds the daily meal limit.

## 6. Background jobs

| Job | Schedule | What it does |
|---|---|---|
| `generate_expected_attendance` | Nightly, plus on schedule change | Builds tomorrow's `expected_attendance` from schedules, closures, and planned absences, only for children on tomorrow's roster (`roster_on`). Scheduled starts, children on leave, and withdrawn children are never scanned. |
| `missing_child_scanner` | Every minute during operating hours | Reads `v_missing_child_candidates`, opens alerts, queues step 1. Writes heartbeat. |
| `alert_step_runner` | Event-driven, delayed jobs | Runs each ladder step after re-checking attendance and consent. |
| `telephony_webhook_handler` | Real time | Stores delivery status and keypad or reply responses. Updates the alert. |
| `alert_auto_resolver` | On every check-in | Resolves the open alert and cancels queued steps. |
| `job_watchdog` | Every minute, separate process | Pages the director if any heartbeat is stale. |
| `build_meal_services` | Early morning | Creates the day's meal services from the published menu. |
| `build_production_plan` | Evening before | Scales recipes to expected headcount by age group. |
| `day_close_checks` | After closing | Flags unfinalized meals, present children with no meal record, children still checked in, and creates late-pickup fees. |
| `eligibility_expiry_check` | Daily | Warns at 60, 30, and 7 days before a child's eligibility determination expires. |
| `certificate_expiry_check` | Daily | Staff and vendor certificates at 60, 30, and 7 days. |
| `product_change_watch` | On new product version | Finds recipes and menus that use the product, re-runs allergens and crediting, and requires re-approval. |
| `claim_precheck` | Nightly, and on the 1st | Writes `claim_validation_issues` for the open month so problems surface daily, not on deadline day. |
| `draft_monthly_claim` | Month end | Builds `claims`, `claim_lines`, `claim_enrollment_counts`, and `claim_included_meals`. Locks on submission. |
| `generate_invoices` | Monthly | Creates tuition invoices and applies sibling discounts. |
| `overdue_reminders` | Daily | Sends reminders for past-due invoices. |
| `supply_flag_dispatcher` | Event-driven, on each flag | Applies `supply_notification_rules`, writes in-app notices, queues texts, sets `ack_due_at`. |
| `supply_escalation` | Every minute | Tells the director about urgent flags the front office has not acknowledged by `ack_due_at`. |
| `supply_evening_reminder` | Evening | For children expected tomorrow who still have open flags, reminds the family once. |
| `supply_morning_bring_list` | At opening | Sends the front office and teachers `v_todays_bring_list`. |
| `stock_reorder_check` | Daily | Reads `v_low_center_stock` and notifies the front office. It also adds a proposed item to the master list (source `child_supply_reorder`). |
| `supply_weekly_digest` | Weekly | Sends the director `v_frequent_supply_flags`. |
| `supply_stale_flag_cleanup` | Daily | Cancels flags for withdrawn children and asks staff to close flags open more than 14 days. |
| `meal_update_batcher` | Every minute | For guardians who chose real-time updates, sends one notice per meal (not per item) about 5 minutes after the last entry for that meal. |
| `build_daily_report_drafts` | At the center's draft time (default 3:30 PM) | Builds a draft report for every present child with `build_daily_report`, then lists children with missing meals for their teacher (`v_daily_report_readiness`). |
| `daily_report_review_reminders` | Draft time, and 45 minutes before publish time | Reminds teachers about drafts not marked ready. Tells the director about any still unfinished at the final reminder. |
| `publish_daily_reports` | At the center's publish time (default 5:00 PM), and on early checkout | Publishes reports marked ready, queues delivery, and sends the notice. |
| `late_meal_entry_report` | Weekly | Sends the director `v_late_meal_entries` so slow logging is caught early. |
| `request_sla_check` | Hourly | Reminds the front office about requests waiting longer than the policy allows (default 48 hours), then tells the director. Uses `v_overdue_request_lines`. |
| `request_delivery_followup` | Daily | Flags orders past their expected delivery, and received items the teacher has not confirmed after 5 days. |
| `budget_threshold_check` | On each submission | Warns the office and director when a classroom passes 80% of its budget or would exceed it. |
| `stockroom_reorder_check` | Daily | Reads `v_stockroom_reorder_needed` and adds a proposed item to the purchasing master list for each item at its reorder level (source `stockroom_reorder`). |
| `request_consolidation_hint` | Daily | Uses `v_pending_by_item` to suggest combining the same item requested by several classrooms. |
| `request_weekly_digest` | Weekly | Sends the director spending by classroom, denial reasons, and slow approvals. |
| `recurring_purchases_generator` | Daily | Adds a proposed item to the master list for each recurring purchase that is due (paper towels every month, for example) and moves its next due date. |
| `purchasing_review_reminder` | On the policy's review day, and daily after | Reminds the director or administrator about items waiting for approval, and the office about items not yet submitted. |
| `purchasing_budget_check` | On each submission | Warns the director when a category passes 80% of its budget or an item would exceed it. |
| `po_delivery_watch` | Daily | Flags purchase orders past their expected date, and orders where less arrived than was ordered (`v_po_receiving_gaps`). |
| `invoice_match_check` | On each invoice entered | Compares the invoice to the purchase order (`v_invoice_po_match`) and flags a difference over 2%. |
| `invoice_due_reminder` | Daily | Reminds the owner or billing role of vendor invoices due within 5 days. |
| `monthly_spend_report` | Monthly | Sends the director `v_spend_by_category_month` against the budgets. |
| `execute_scheduled_transitions` | Daily just after midnight (center time), and on demand | Starts enrollments, moves children to their next room, returns children from leave, and ends enrollments on their dates. |
| `age_up_planner` | Weekly | Reads `v_upcoming_age_transitions`, creates proposed room changes, and asks the director to confirm. Never moves a child without a person's approval. |
| `waitlist_opening_matcher` | Daily | Reads `v_offer_candidates` and creates a task for the office to consider an offer. It never sends an offer by itself. |
| `waitlist_interest_check` | Quarterly | Asks waitlisted families whether they are still interested. Families that do not answer after two reminders get a task for staff, not automatic removal. |
| `offer_expiry_job` | Hourly | Moves offers past their expiry to `offer_expired` and notifies the office and family. |
| `tour_reminders` | Hourly | Reminds the family and the tour guide 24 hours and 2 hours ahead, and flags no-shows for follow-up. |
| `inquiry_followup_tasks` | On each new inquiry | Creates a reply task due within one business day, and checks for duplicates (`v_possible_duplicate_inquiries`). |
| `stalled_application_check` | Daily | Reads `v_stalled_applications` and reminds the assigned person. |
| `checklist_reminders` | Daily | Reminds families of missing paperwork 14, 7, and 3 days before it is due. |
| `enrollment_readiness_check` | Daily | For children starting within 14 days, reads `v_starting_soon`. Alerts the director and kitchen about open allergy or contact gaps. |
| `prospect_data_purge` | Monthly | Anonymizes closed leads older than the retention period (`v_prospects_due_for_purge`). |
| `missed_punch_scanner` | Every 5 minutes during operating hours | Reads `v_missing_punches`. Reminds staff who have not punched in or out, then tells the director. Never closes a shift on its own. |
| `timesheet_draft_builder` | Nightly | Rebuilds open timesheets with `build_timesheet` so staff and the director always see current hours. |
| `weekly_hours_report` | Friday after close (preliminary), and Monday 7:00 AM (final) | Builds every timesheet for the week, emails the report to the director, owner, and payroll contact, lists unresolved items, and invites staff to review and confirm their hours. |
| `timesheet_review_reminders` | Daily | Reminds staff to confirm their hours, then the approver to approve. |
| `near_overtime_check` | Daily and on each clock-out | Warns the director and the staff member at 90% of the overtime threshold, for overtime-eligible staff only. |
| `punch_review_reminder` | Every few hours | Reminds the director about punches waiting for review, and escalates after 24 hours. |
| `time_device_health_check` | Every 5 minutes | Alerts IT or the director when a kiosk stops reporting, or when `v_verification_stats_by_device` shows a high failure rate. |
| `biometric_deletion_job` | Daily | Reads `v_biometric_deletions_due`, deletes templates in the secure store for withdrawn consent or departed staff, and removes old failure images. Records the deletion. |
| `time_record_retention` | Yearly | Lists time records past the retention period for review before any deletion. |
| `punctuality_rollup` | Every 5 minutes from 6:00 to 11:00, and once at closing | Runs `compute_daily_punctuality` for the center's local date: on time, late, not yet due, no-show, or excused absence, for children and staff. |
| `late_arrival_alerts` | Every 5 minutes during the morning | Tells the director when a staff member is past the alert threshold, the director and office when a staff member has not shown up, and the office and teacher when a child is past the grace period. |
| `arrivals_digest` | At the digest time (default 10:00 AM) | Sends the director, owner, and office the list of who was late or did not show, children and staff (`v_arrivals_today`). |
| `pin_security_monitor` | Every 5 minutes | Watches `family_access_attempts` for repeated failures across kiosks or odd hours and alerts the director and office. |
| `backup_and_retention` | Nightly | Encrypted backups, restore test each month, retention per state rules. |

## 7. Architecture notes
- **Queue:** use a Postgres-backed queue (pg-boss or Graphile Worker) or Celery with Redis. It needs scheduled jobs, delayed jobs, retries with backoff, and a dead-letter queue that alerts a person.
- **Time zones:** store timestamps in UTC and compare "today" and "expected arrival" in the center's zone. Test the daylight saving transitions.
- **Telephony:** use a provider such as Twilio for SMS and voice. Verify webhook signatures and de-duplicate deliveries by `provider_message_id`.
- **Security:** row-level security by `center_id`, role-based access, encrypted storage of documents, audit logging on finalization and reopening, and no card numbers in your database.
- **Offline:** teacher tablets queue meal records with client-generated IDs and sync when reconnected. Finalization requires a connection.

## 8. Teacher supply alerts

**Goal:** a teacher taps once, and the family and the front office both know a child is running low, with no phone tag.

### Teacher quick-tap screen
- Each child shows only the items their family supplies (`child_supply_profiles`) that apply to the child's age. A blanket does not appear for a child under 12 months, and the server rejects it too (`supply_item_allowed`).
- One tap flags an item as **low**. A second tap raises it to **out**. Both taps land on the same open flag, so nobody is notified twice for one problem.
- A two-minute undo removes a mistaken tap without notifying anyone further.
- Flags carry a client-generated ID, so a tap made offline syncs without duplicates.
- A tapped item shows its status: notified, seen by office, parent replied, or resolved.

### Front office queue (`v_office_supply_queue`)
Sorted by urgency, then level, then age. Shows whether the child is here now, the parent's reply, and the item's details (size or brand). For formula and baby food, the child's allergy alerts appear beside the item, so nobody supplies the wrong product. Actions: acknowledge, supply from center stock, note, resolve.

### Notification triggers (all editable in `supply_notification_rules`)
| Trigger | Who | Channel | When |
|---|---|---|---|
| Teacher flags an item as low | Guardians who receive supply alerts, and the front office | In-app, plus text for urgent items when the guardian consented | Immediately |
| Item raised to out | Same, plus a push to the front office | In-app, push, text | Immediately. If the item is urgent and the child is here, the front office must acknowledge within about 10 minutes, or the director is told. |
| Parent replies (bringing today, bringing tomorrow, please supply, question) | Front office and the child's teacher | In-app | Immediately |
| Front office acknowledges | Teacher sees the status | In-app | Immediately |
| Center supplies from stock | Guardians | In-app, with any fee shown | Immediately, and stock drops by the amount given |
| Restocked or delivered | Guardians (optional thank-you) | In-app | Immediately, and the flag is resolved |
| Still open and the child is expected tomorrow | Guardians | In-app, then text | Once, the evening before |
| Opening of the day | Front office, teachers | In-app list | At opening |
| Same item flagged 3 times in 30 days | Director | Weekly digest | Weekly. Never sent to the family automatically. |
| Center stock at or below reorder level | Front office | In-app | When it crosses the level |

Routine texts respect quiet hours (default 9 PM to 7 AM) and wait until morning. Every text goes only to guardians with SMS consent on file.

### Message tone
Plain and kind, never blaming: "Diapers are running low for Ava at school. Please send more when you can. Tap here to let us know when." Include only the child's first name and the item. A guardian is notified only about their own child.

### How it connects to the rest of the system
- **Meals:** when formula, bottles, or baby food run out and the center supplies them, the meal screen prompts an infant feeding record with `supplied_by = 'center'` and checks the child's allergy alerts first. Confirm the infant-meal claim rules with your NJ reviewer.
- **Billing:** if you charge for center-supplied items, the resolution creates an invoice line (`supply_flags.invoice_line_id`).
- **Attendance:** urgency escalates only while the child is in the building.
- **Reports:** `v_frequent_supply_flags` gives the director a factual list for a conversation with a family.

## 9. Timed meal tracking and the parent daily report

### Recording when a child ate
- Every meal record has `ate_at` (when the child ate) and `recorded_at` (when the teacher tapped). By default they match; the teacher can back-date a few minutes with a quick adjuster.
- The teacher taps a meal, sees the present children, and marks everyone "ate as served" in one tap, then changes individual children. Tapping a child records what they ate, item by item.
- Infants are fed on demand, so each bottle or solid feeding is its own row (`infant_feedings`) with a time and the ounces. A quick "+ Bottle" button records it in two taps.
- Food outside the meal program (a second helping, a birthday cupcake, a snack a parent sent) goes in `child_food_events`. Parents see it, but it never counts toward a state claim.
- Records written more than 30 minutes after the fact appear in `v_late_meal_entries`. That view helps the director and matters in an audit, since records made at the time carry more weight.

### What parents see
- **During the day (optional):** a guardian chooses real-time, end-of-day, or off. Real-time sends one notice per meal, not one per item.
- **End of day:** one report per child, in time order: every meal, snack, bottle, and extra food with the foods and how much was eaten, plus naps, diapers and potty, milestones, photos, and the teacher's note.
- `v_parent_eating_timeline` builds the meal part. It leaves out eligibility category, claim status, and staff-only notes, so a family never sees program details about themselves or other children.
- A photo appears only if the child has photo consent on file and sharing is on for that child. A photo of several children is controlled per child.
- A parent sees only their own child, and only through guardians marked to receive daily reports.

### Draft, review, publish
1. **Draft time (default 3:30 PM):** the system builds a draft for each present child.
2. **Teacher review:** `v_daily_report_readiness` lists children whose meals do not match the meals served while they were present. The teacher fixes gaps, adds a note, and taps "Ready."
3. **Publish time (default 5:00 PM):** ready reports are published and delivered. Publishing freezes a snapshot.
4. **Not ready:** the system never publishes an incomplete report silently. The teacher gets a reminder, then the director is told, and the director can publish it as it stands.
5. **Corrections:** a correction after publishing creates a new version. Parents keep seeing the last published version until the corrected one goes out, and the old version stays on file.
6. **Early checkout:** the report can publish when the child is checked out, if the center turns that on.

### Delivery
Portal notice first. Email or text with a link only, never the report contents, and only to guardians who consented. Delivery, open, and first-view times are stored, so the front office can see who has not opened a report.

## 10. Classroom supply ordering and the office workflow

This is separate from section 8. Section 8 is a family's personal items for one child. This section is materials the classroom uses: paper, paint, toys, cleaning supplies.

### Teacher marketplace
- Browse categories or search the catalog (`catalog_items`). Each item shows the unit, an estimated price, and a photo.
- For items the center stocks, the card shows "On the shelf: 6" with a **Take from stockroom** button, so nobody orders what is already in the closet. Taking an item records a stockroom movement and lowers the count.
- Add items to a cart, set priority (normal, soon, urgent), an optional needed-by date, and a note about why. Submit sends the whole cart as one request.
- **Custom items:** if something is not listed, the teacher taps "Add an item not listed" and enters a name, description, link, quantity, and estimated price. The line is marked custom so the office knows to check it.
- **Food:** a custom item marked as food or a drink is put on hold and routed to the cook and director. Food must first be entered and approved in the vendor product database, so the kitchen has ingredient lists and crediting documents. Catalog items that are food must link to an approved product.

### Statuses (each line has its own)
`pending` → `approved` → `ordered` → `shipped` → `received`, plus `on hold` (the office needs information), `denied` (a reason is required and the teacher sees it), and `cancelled`.
- Only listed moves are allowed (`request_status_transitions`). A denied line can be reopened. Received and cancelled are final.
- Every change is written to the history with who made it and when. Comments from either side appear on the same timeline.
- A teacher can cancel their own pending line or edit it, which returns it to pending and records the edit.
- "Received" means it reached the center. The teacher then confirms it reached the classroom, which records `classroom_confirmed_at`.

### Front office dashboard
- **Approval queue** (`v_office_approval_queue`): pending and on-hold lines with the classroom, requester, quantity, estimated cost, how long it has waited, the classroom's remaining budget, and the stockroom count. Filters for classroom, priority, custom, and food.
- **Actions:** approve (optionally at a smaller quantity), deny with a reason, hold with a question, or approve in bulk. Lines over the director threshold, and food lines, need an extra approval (`line_approvals`) before they count as approved.
- **Combine into purchase orders:** approved lines from several classrooms can be grouped into one vendor order. `v_pending_by_item` highlights the same item requested in more than one room.
- **Order tracking:** marking the purchase order **ordered** moves every line on it to ordered. Adding a carrier and tracking number and marking it **shipped** moves them to shipped. Marking it **delivered** moves them to received, and teachers are told to pick up. Nobody updates lines one by one.
- **Promote to catalog:** a good custom item can be added to the catalog in one click, and the teacher is told.
- **Budgets:** each classroom can have a budget per period. Overspending warns rather than blocks, and the director can override.

### Notification triggers
| Trigger | Who | Channel |
|---|---|---|
| Request submitted | Front office (new items waiting); teacher gets a confirmation | In-app |
| Auto-approved (under the policy limit) | Teacher | In-app |
| Approved, denied (with reason), or put on hold (with question) | Requesting teacher | In-app, push for urgent |
| Teacher replies to a hold or comment | Front office | In-app |
| Line needs director or cook approval | Director or cook | In-app |
| Ordered, shipped (with tracking), delivered | Requesting teacher | In-app; delivery says where to pick it up |
| Waiting longer than the policy allows | Front office, then director | In-app |
| Past expected delivery | Front office | In-app |
| Received but not confirmed after 5 days | Teacher | In-app |
| Classroom passes 80% of budget | Front office, director | In-app |
| Custom item added to the catalog | Requesting teacher | In-app |
| Stockroom item at reorder level | Front office | In-app |
| Weekly summary | Director | Email or in-app |

### Rules that keep it honest
- The app records requests and approvals. It does not place orders with vendors by itself; the office does that, then updates the purchase order.
- A denial always has a reason, so teachers are never left guessing.
- Every approval, denial, and status change has an actor and a timestamp.
- Teachers see only their own requests and their classroom's board. The office sees everything.

## 11. Facility purchasing master list

This is the office's single list of everything the facility needs to buy: paper goods, cleaning supplies, general operating materials, and anything the other parts of the system turn up.

### What lands on the list (`purchase_needs`, with a `source`)
- **Office entries:** anyone in the office adds an item, or picks one from the catalog. Custom items are allowed.
- **Classroom requests:** the office can move an approved classroom line onto the master list (`adopt_request_line`) so it is bought together with everything else. It arrives already approved, so nobody approves it twice, and the teacher's status keeps updating.
- **Stock reorders:** the stockroom and the center's backup child-supply stock add a proposed item automatically when a count reaches its reorder level.
- **Recurring purchases:** monthly or weekly items are added on schedule.
- **Kitchen and maintenance:** non-food kitchen supplies and repair materials.
Food is not bought through this list. It must be an approved product in the vendor product database, with its ingredient list and certificates.

### The workflow
1. **Proposed:** the office builds the list, grouping items into a review batch (for example, "Weekly purchasing review").
2. **Submit:** submitting an item checks the policy. Under the auto-approve limit (default: none) it is approved immediately. Otherwise it goes to the director. Above a second limit, the owner must approve as well.
3. **Review:** the director or administrator sees the queue with each item's cost, category budget remaining, and how long it has waited. They can approve, deny (a reason is required), or hold with a question, one item at a time or the whole batch.
4. **Controls:** nobody can approve an item they entered. The approver must hold the required role. On an item needing two approvals, the two must be different people. Every change is logged with who and when.
5. **Purchasing:** the buyer works from "to order by vendor" (`v_needs_to_order_by_vendor`), creates a purchase order from the approved items, and marks it **ordered**. Adding carrier and tracking and marking it **shipped**, then **delivered**, updates every item on it, including the linked classroom request lines, so teachers see the change too.
6. **Receiving:** the receiving person records quantities. Short deliveries appear in `v_po_receiving_gaps`.
7. **Invoice:** the vendor's invoice is attached and compared to the order. A difference over 2% is flagged. Then it goes for approval and is marked paid. Keep food invoices, since state reviewers may ask for them.

### Screens
- **Master list:** filter by category, status, source, vendor, and priority. Quick-add row, bulk select, add to batch, submit.
- **Director review:** the queue with budget, aging, and approve, deny, or hold controls.
- **Purchasing pipeline:** approved, ordered, and shipped items with order number, tracking, and days late.
- **Budgets and spending:** category budgets against committed spend, and monthly spending by category.

### Notification triggers
| Trigger | Who | Channel |
|---|---|---|
| Batch submitted for review | Director or administrator | In-app, plus email |
| Items still waiting on the review day | Director, then owner | In-app |
| Approved, denied (with reason), or held (with question) | The person who entered it | In-app |
| Item needs a second approval | Owner | In-app |
| Category passes 80% of budget, or an item would exceed it | Director | In-app |
| Order placed, shipped, delivered | The buyer; linked teachers through their request lines | In-app |
| Order late, or delivery short | Office | In-app |
| Invoice differs from the order by more than 2% | Office and owner | In-app |
| Invoice due within 5 days | Owner or billing | In-app |
| Recurring item or stock reorder added to the list | Office | In-app |

## 12. Enrollment: current and future

### Two tracks
- **Future (pipeline):** a family inquires, and each child gets an application that moves through stages until the child is enrolled. Prospective children are **not** in the `children` table, so they never appear on rosters, meal counts, attendance, or ratios. Their data can be anonymized on a schedule.
- **Current (enrolled):** `enrollments` records each child's status, and `child_classroom_assignments` records their room over time. `roster_on(center, date)` and `v_active_roster` are the single source of who is here. Attendance expectations, meal services, and ratio checks read from them.
- **Between them:** when a family is ready, `convert_application` creates the child, guardians, billing account, room, and scheduled start in one step. The child begins as `scheduled`: paperwork, allergies, and contacts are on file, but they stay off rosters until the start date.

### Future pipeline: stage transitions (`pipeline_transitions`)
| From | Can move to |
|---|---|
| Inquiry | Tour scheduled, Applied, Waitlisted, Lost contact, Family declined |
| Tour scheduled | Toured, Inquiry (no-show), Lost contact, Family declined |
| Toured | Applied, Waitlisted, Lost contact, Family declined |
| Applied | Waitlisted, Offered, Center declined, Family declined, Lost contact |
| Waitlisted | Offered, Family declined, Center declined, Lost contact |
| Offered | Accepted, Family declined, Offer expired, Waitlisted |
| Offer expired | Waitlisted, Offered (re-offer), Family declined |
| Accepted | Ready to start, Family declined, Center declined |
| Ready to start | Enrolled, Family declined |
| Lost contact, Family declined, Center declined | Inquiry (reopened) |

Enforced rules:
- An **offer** must name a classroom, a start date, and an expiry.
- **Accepted** creates the paperwork checklist automatically.
- **Ready to start** is refused until every required checklist item is verified or waived (a waiver needs a reason).
- **Rejoining the waitlist** keeps the family's original place in line.
- Every change is logged with who and when.

### Current enrollment: status transitions (`enrollment_transitions`)
| From | Can move to |
|---|---|
| Scheduled | Active (on the start date), Cancelled |
| Active | On leave, Notice given, Withdrawn |
| On leave | Active, Notice given, Withdrawn |
| Notice given | Active (notice rescinded), Withdrawn (on the last day) |
| Withdrawn, Cancelled | Final. A returning child gets a new enrollment. |

A child has at most one open enrollment. A child on leave is off the roster; a child with notice given stays on it until the last day.

### Scheduled transitions (`scheduled_transitions`)
- **Start enrollment**, **room change**, **return from leave**, and **end enrollment** each carry an effective date and a status: proposed, planned, done, or cancelled.
- The daily job carries out everything planned and due. The system can propose room changes when a child ages out, but a person confirms each one.

### Waitlist
- Ordered by points you define (for example, a current sibling), then by the date they joined. Keep rules defensible, and do not use characteristics protected by law.
- Each waitlisted child is projected into the classroom they will fit by their desired start date. For an unborn baby, the due date stands in for the birth date until it is known.
- `v_classroom_capacity_forecast` shows enrolled children, offers in progress, and open spots by classroom for the next 12 months. `v_offer_candidates` shows who is next in line for an opening. The office decides and sends the offer.
- The forecast counts heads. If part-time schedules matter, extend it to count by day of week.

### Paperwork checklist (defaults from `seed_default_enrollment_checklist`)
Enrollment form, tuition agreement, deposit, immunization record, health form, emergency contacts, authorized pick-up list, **consent for calls and texts** (needed for the missing-child alerts), photo consent, meal program eligibility form, allergy or medical action plan, and handbook. At conversion, documents move to the child, allergies become alerts, and call and text consent carries over only when a record of when it was given exists.

### Notification triggers
| Trigger | Who | Channel |
|---|---|---|
| New inquiry | Assigned office person (task due next business day); family gets an acknowledgment if they consented | In-app, email or text |
| Tour scheduled, 24 hours and 2 hours before | Family and tour guide | Email or text, in-app |
| Tour no-show | Assigned office person | Task |
| Application started but not submitted (7 days) | Family | Email |
| Application stalled in a stage | Assigned person | Task |
| Spot opens for a waitlisted family | Office | Task with the candidate |
| Offer sent | Family | Email or text |
| Offer expiring (3 days, then 1 day) | Family and office | Email or text, in-app |
| Offer accepted | Office; family gets the checklist | In-app, email |
| Paperwork due (14, 7, 3 days) | Family and office | Email or text |
| Starting within 14 days with gaps (allergy without medical statement, no emergency contact, no meal program form) | Director and kitchen | In-app |
| Start day | Family (welcome, portal invitation); teacher; kitchen gets the allergy list | In-app, email |
| Age-up proposed | Director to confirm | In-app |
| Age-up confirmed | Teachers of both rooms; family two weeks before | In-app, email |
| Notice of withdrawal | Director and billing (final invoice, deposit) | In-app |
| Waitlist interest check | Waitlisted families | Email or text |

### Safety and compliance tie-ins
- **Meals:** a child cannot be logged for a meal before they are active. Allergies and medical statements must be on file before the start date, so the first meal is safe.
- **Missing-child alerts:** the consent for calls and texts is collected during enrollment, and the alerts only reach children on the roster.
- **Meal program eligibility:** the eligibility form is on the checklist, so a determination is on file before the first claim.
- **Privacy:** prospective data is kept only as long as the retention period, then anonymized. Contact consent is recorded with when and how it was given.

## 13. Staff time tracking with facial verification

### Read this before building
Face data is sensitive. The design below limits what is collected and makes the feature optional, but you still need an employment attorney to review the written notice, the consent form, the retention rules, and any state or local biometric rules that apply to you. Nothing here is legal advice.

### Privacy and safety choices built into the design
- **Face verification is one method among several.** Every staff member also has a PIN or badge. Nobody is forced to use their face, and a failed match never costs anyone pay.
- **Consent first.** A face template can be created only for a person whose latest consent is "granted" (`biometric_consents`, tied to a versioned written notice). Withdrawing consent queues the template for deletion immediately.
- **Templates are not in the main database.** They live in a separate encrypted store or a vetted vendor's service. The database keeps only an opaque reference (`staff_biometric_templates`). No face image is kept from a successful punch.
- **One-to-one matching.** The person picks their name (or enters a PIN or badge) and the camera confirms it is them. This is more accurate and less invasive than searching everyone's faces to find a match.
- **Liveness check.** A photo or video of a coworker must not pass. Punches without a confirmed liveness result are held for review.
- **Failure images are off by default.** If you turn them on, they are kept for a short period (30 days by default) and then deleted.
- **Deletion.** Templates are deleted within a set period after a person leaves or withdraws consent (30 days by default). Time records are kept longer, and separately, from face data.
- **Use limits.** Face data is used only to verify time punches. It is never used for any other purpose, shared, or sold, and access to it is logged.
- **Test before rollout.** Try the system on your actual staff, with your actual cameras and lighting, and watch failure rates by device (`v_verification_stats_by_device`). Verification does not always work equally well for everyone, which is another reason the alternatives matter.
- **Vendor review.** Ask any vendor about retention, subprocessors, deletion, accuracy testing, and where data is stored.

### The punch flow (kiosk tablet at the entrance or in each classroom)
1. The person selects their name, or enters a PIN or scans a badge.
2. The camera verifies it is them, with a liveness check. After three failed attempts, the kiosk offers the PIN or badge.
3. They choose an action: clock in, clock out, start break, end break, or change room.
4. The **server** records the time. The device's own clock is kept for comparison, and a large difference is flagged. Offline kiosks queue punches and sync later, and those are marked as offline.
5. The screen confirms the time and shows the day's and week's hours so far, so staff can see exactly what is being recorded.

### Rules for punches
- **Raw punches are permanent.** They are never edited or deleted. A mistake is fixed with a correction, which creates a new record and an audit entry.
- **Nothing is silently dropped.** A punch that fails a check (verification not confirmed, out of sequence, device clock off) is kept as `pending_review` with its original time. When a reviewer accepts it, it counts from the time it was made.
- **Sequence check:** two clock-ins in a row, or a clock-out with no clock-in, is held for review.
- **Punches build shifts** (`time_entries`), breaks, and room segments automatically. The live ratio monitor already reads `time_entries`, so room changes take effect at once.
- **Clock-outs are never blocked.** If leaving would put a room over ratio, the kiosk warns the person and alerts the director, but the punch still goes through.

### Exact hours
- Hours are stored as exact seconds. Rounding is off by default. If you use rounding, it must be neutral, and counsel should review it.
- A shift belongs to the day it began, in the center's time zone, and can cross midnight.
- **Breaks are paid by default.** Mark breaks unpaid only if staff are fully relieved of duty during them. In child care, staff usually stay responsible for children, so paid is the safe default.
- **Overtime** uses the fixed workweek in the time policy (default Monday to Sunday) and applies only to people marked overtime-eligible. Confirm each person's classification with your payroll advisor.

### The weekly hours report
1. **Friday after close:** a preliminary report is generated, the staff get their draft to review, and the director sees the unresolved items.
2. **Monday 7:00 AM:** the final report is built and emailed to the director, owner, and payroll contact. It shows total, regular, and overtime hours for each person, days worked, and flags for open shifts, pending punches, and pending corrections (`v_weekly_hours_report`, with day detail in `v_daily_hours`).
3. **Staff confirm:** each person reviews their hours and confirms them (`submitted`).
4. **Approval:** someone other than the staff member approves (`approved`). It cannot be approved while a shift is open or a punch is pending.
5. **Lock:** hours are locked when payroll takes them. A locked week can be changed only by reopening it with a reason, which is logged.

### Corrections
A missed punch or wrong time is fixed with a correction request that gives the reason. Someone other than the requester approves it, and an approved or locked week must be reopened first. The original punches stay as they were, and the change is written to the audit log.

### Notification triggers
| Trigger | Who | Channel |
|---|---|---|
| Scheduled start plus 15 minutes with no punch | Staff member, then the director after 30 minutes | Push or text, in-app |
| Open shift 30 minutes past its scheduled end | Staff member; the director after 2 hours | Push or text, in-app |
| Shift open more than 12 hours | Director | In-app |
| Punch waiting for review | Director; reminder and escalation after 24 hours | In-app |
| Three failed face attempts | Kiosk offers the PIN or badge; director sees it in a daily digest | On screen, in-app |
| Punch from an unknown or inactive device | Director immediately | In-app |
| Device clock differs from the server | Director | In-app |
| Approaching overtime (90%) and at the threshold | Director and the staff member (eligible staff only) | In-app |
| Clock-out would leave a room over ratio | Staff member at the kiosk; director | On screen, in-app |
| Preliminary and final weekly report | Director, owner, payroll contact; staff get their draft | Email, in-app |
| Hours not confirmed by staff by the deadline | Staff member, then the director | In-app |
| Timesheet awaiting approval | Approver (not the staff member) | In-app |
| Correction requested, approved, or denied | Reviewer; the requester | In-app |
| Consent withdrawn, or a staff member leaves | Director and IT: template deletion task with a due date | Task |
| Kiosk offline, or high failure rate | Director or IT | In-app |

## 14. Who can see what, PINs, and on-time tracking

### Who sees what (defaults you can change in `role_permissions`)
| | Owner | Director | Office | Teacher | Parent |
|---|---|---|---|---|---|
| Everything in the system | Yes | Yes | Sees everything, with a few limits below | No | No |
| Child sign-in and sign-out times | All children | All children | All children | Only children in their own room | Only their own child |
| Lunch program (menu, portions) and recording what each child ate | Yes | Yes | Yes | Their own room only, and they record what each child ate | No |
| Allergy and medical alerts | Yes | Yes | Yes | Their own room (needed to serve meals safely) | No |
| Staff hours, lateness, and pay-related records | Yes | Yes | Sees hours and lateness | Their own punches only | No |
| Billing, enrollment, purchasing, vendor records | Yes | Yes | Sees all | No | No |
| Approve purchases and timesheets | Yes | Yes | No | No | No |
| Manage users, roles, PINs, and settings | Yes | Yes | No | No | No |
| Daily report with meals and activities | Yes | Yes | Yes | Enter meals only | Off until you turn it on |

The office "sees everything" except a few things I held back by default, which you can change: creating users and roles, changing center settings, approving purchases and timesheets (approval needs someone other than the person who entered it), and the audit log. Face templates and PIN hashes are hidden from everyone, including the owner, because they are never readable by the app.

The teacher tools you asked for earlier (flagging a child's missing personal items, requesting classroom supplies, punching in and out) are kept, because they only touch the teacher's own room.

### How it is enforced
1. **Database roles.** The API switches to a role for each request: office (owner, director, office), teacher, parent, or kiosk. Teachers and parents have almost no direct table access, only specific views.
2. **Row-level security.** Even where access exists, a teacher sees only children in their own classroom, and a parent sees only their own children. A floater sees a room only while clocked into it.
3. **The request cannot choose its own role.** The user's role and center are looked up from the user account, not taken from the request.
4. **Screens follow the same matrix**, so a teacher never sees a button they cannot use.

### Parent view
Parents see only their own child's sign-in and sign-out: the times, and who dropped off and who picked up. The daily report is off by default, and turning it on is one permission.

### PINs: keeping people out
- **Every parent and authorized pick-up person has a PIN** (6 digits by default), used at the kiosk and to sign in to the portal. Only a salted hash is stored. The app should first run it through a keyed hash with a secret kept outside the database.
- **Lockout:** five wrong attempts lock the PIN for 15 minutes, and the director and office are told immediately. Staff can unlock it after checking ID.
- **Kiosk sign-in and sign-out:** the parent identifies their family by phone number or a family tag, so the kiosk never shows other families, enters their PIN, and picks their child. The system checks that the person is a guardian or an authorized pick-up person for that child.
- **No PIN, no sign-out.** Someone who is not on the list, or who forgot their PIN, is sent to the front desk. Staff check photo ID and decide, and it is recorded.
- **Release restrictions.** A person under a court order or other restriction cannot sign a child out. The kiosk shows only "Please see the front desk," and the director, office, and the child's teacher are alerted at once.
- **Every attempt is logged**, successful or not, with the device.
- **Teachers see who is coming.** When a pick-up is verified, the teacher sees the person's name and relationship, and no contact details.
- **The kiosk can do nothing else.** It can only run the sign-in and sign-out function.
- **Recommended:** a text-message code as a second step for the parent portal.

### Automatic on-time and late tracking
- **Children:** each child's expected arrival comes from their schedule. Arriving within the grace period (10 minutes by default) is on time. Later is late. A child with no sign-in becomes a no-show, unless a parent reported the absence. At 30 minutes, the missing-child alerts start (section 1).
- **Staff:** the first punch of the day is compared to the earliest scheduled shift. The grace period is 5 minutes by default.
- **A daily record** is kept for each person (`daily_punctuality`), so history survives schedule changes. A lateness can be excused with a reason, and the record then shows it as excused.
- **Who sees it:** the director, owner, and office see all of it. Teachers see only when children came in and out. Parents see only their own child's times.
- **Fairness:** lateness is information for a conversation, not an automatic penalty. The record shows the reason when there is one.

### Notification triggers
| Trigger | Who | Channel |
|---|---|---|
| Staff member past the alert threshold (10 minutes) with no punch | Director | In-app, text |
| Staff member not in by 30 minutes | Director and office, with the room and ratio impact | In-app, text |
| Child past the grace period, not yet in | Office and the child's teacher | In-app |
| Child not in at 30 minutes | Parents, by the missing-child alerts (section 1) | Text, call |
| Morning summary at 10:00 AM: who was late or absent, children and staff | Director, owner, office | In-app, email |
| Weekly lateness summary, with the weekly hours report | Director, owner, office | Email |
| Child signed in or out at the kiosk | The child's guardians, including who did it | In-app, push |
| A pick-up person is verified | The child's teacher (name and relationship) | In-app |
| Five wrong PIN attempts, PIN locked | Director and office | In-app |
| A restricted person tries to sign a child out | Director, office, and the teacher, immediately | In-app, push |
| PIN set, changed, or unlocked | The person (confirmation, text if they consented) | Text |
| First sign-out by a newly added pick-up person | The child's guardians | In-app |

## 15. Confirm before building
- Consent wording for automated calls and texts (counsel).
- Whether NJ licensing prescribes steps for a missing child.
- Which crediting documents your NJ CACFP reviewer expects (CN label, product formulation statement, or others) and how long to keep invoices and production records.
- Whether your center is sponsored or contracts directly with the state (this affects who submits claims).
- Which certificate types you require from vendors, and whether an expired one should warn or block.
- Whether NJ licensing sets the age at which a blanket is allowed (the schema defaults to 12 months).
- Consent wording for supply texts, and whether center-supplied items are free or charged.
- Photo consent wording, and whether a parent should see a meal a child refused (the schema shows "Did not eat").
- How long daily reports and photos are kept, and what happens to them when a child leaves.
- Your approval rules: the dollar limit for auto-approval, the limit that needs the director, and who approves food-related requests.
- Whether classroom budgets warn or hard-stop, and whether you buy from set vendors or anywhere.
- The purchasing limits: what the director can approve alone, when the owner must also approve, and who counts as "administrator".
- Who places orders and who receives deliveries. Where possible, those should be different people from whoever approves.
- How long to keep invoices and purchase records (food purchases are commonly kept for state review).
- Pre-admission paperwork that NJ licensing requires (health and immunization forms and their timing), so the checklist matches.
- Licensed capacity, and each room's capacity, so the forecast is accurate.
- Waitlist priority rules, how long an offer stays open, and whether deposits are refundable (have counsel review the priority rules and any fees).
- How long to keep records of families who never enroll, and the consent wording on your web inquiry form.
- Biometric rules: what the written notice, consent form, and retention period must say, and whether any state or local biometric law applies to you (counsel).
- Wage and hour: how long time records must be kept (the schema defaults to six years), each person's overtime eligibility, the workweek, and whether breaks are paid.
- Whether any staff object to face verification or cannot use it. Confirm the PIN or badge alternative is offered equally.
- Which vendor or on-device method performs the face match, where templates are stored, and how deletion is confirmed.
- Who approves timesheets when the director's own hours are being approved.
- Whether parents should also see the daily report with meals (it is off by default), and whether teachers keep every tool they had before.
- The grace periods for children and staff, the PIN length, and the lockout time.
- What the office should not see. The defaults hold back user management, settings, purchase and timesheet approval, and the audit log.
- Your process when a parent forgets their PIN or someone unlisted arrives, and how you handle court orders and custody restrictions.
- Whether to require a text-message code for the parent portal, and whether kiosks use a family tag or phone number.
