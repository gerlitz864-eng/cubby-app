-- =====================================================================
-- Cubby: migration 010. Small additions the running application needed,
-- found while building and testing the API against the schema.
-- =====================================================================

-- Password sign-in for staff and office users. Hidden from every database role except the API's owner connection.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
REVOKE SELECT ON users FROM cubby_office;
GRANT SELECT (id, center_id, email, auth_subject, role, is_active, last_login_at, created_at, staff_id, guardian_id) ON users TO cubby_office;

-- When the program opens and which days, so expected arrivals can default sensibly.
ALTER TABLE centers ADD COLUMN IF NOT EXISTS program_start_time time NOT NULL DEFAULT '08:00';
ALTER TABLE centers ADD COLUMN IF NOT EXISTS days_open smallint[] NOT NULL DEFAULT '{1,2,3,4,5}';

-- These read tables a teacher cannot touch directly, so they run with the owner's rights.
ALTER FUNCTION supply_item_allowed(uuid, uuid) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION eligibility_on(uuid, date)      SECURITY DEFINER SET search_path = public;
ALTER FUNCTION cacfp_age_group_on(uuid, date)  SECURITY DEFINER SET search_path = public;

-- A teacher's own classroom requests with their status, tracking, and the office's latest note.
CREATE VIEW v_teacher_my_requests AS
SELECT r.id AS request_id, l.id AS line_id, r.classroom_id, r.submitted_at, r.priority, r.needed_by,
       coalesce(ci.name, l.custom_name) AS item, l.quantity, l.status, l.approved_quantity, l.decision_note,
       l.expected_delivery, l.carrier, l.tracking_number, l.received_at, l.classroom_confirmed_at
FROM supply_request_lines l
JOIN supply_requests r ON r.id = l.request_id AND r.status <> 'draft'
LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id
WHERE r.requested_by = app_staff_id();
GRANT SELECT ON v_teacher_my_requests TO cubby_office, cubby_teacher;

-- The teacher views must not depend on views that run with the caller's rights (a teacher cannot read children directly).
-- They use the same-room helper function, which runs with the owner's rights, and read the tables themselves.
CREATE OR REPLACE VIEW v_teacher_arrivals AS
SELECT ch.id AS child_id, ch.first_name, ch.last_name, a.classroom_id,
       ar.status AS attendance_status, ar.checked_in_at, ar.checked_out_at,
       EXISTS (SELECT 1 FROM child_alerts ca WHERE ca.child_id = ch.id AND ca.is_active) AS has_alert
FROM children ch
JOIN child_classroom_assignments a ON a.child_id = ch.id AND a.valid_during @> current_date
LEFT JOIN attendance_records ar ON ar.child_id = ch.id AND ar.service_date = current_date
WHERE ch.id IN (SELECT my_classroom_child_ids());

CREATE OR REPLACE VIEW v_teacher_meal_roster AS
SELECT ch.id AS child_id, ch.first_name, ch.last_name, a.classroom_id, ar.checked_in_at,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('name', ca.name, 'kind', ca.kind, 'severity', ca.severity, 'plan', ca.care_plan)), '[]'::jsonb)
          FROM child_alerts ca WHERE ca.child_id = ch.id AND ca.is_active) AS alerts
FROM children ch
JOIN child_classroom_assignments a ON a.child_id = ch.id AND a.valid_during @> current_date
JOIN attendance_records ar ON ar.child_id = ch.id AND ar.service_date = current_date
 AND ar.status = 'present' AND ar.checked_out_at IS NULL
WHERE ch.id IN (SELECT my_classroom_child_ids());

-- The parent daily report door reads this view; it must run with the owner's rights (parents have no direct table access).
-- Only the wrapper v_parent_daily_report_secure is granted to parents, and it filters to their own children.
ALTER VIEW v_parent_daily_report SET (security_invoker = false);
