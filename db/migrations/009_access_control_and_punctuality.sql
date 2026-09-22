-- =====================================================================
-- Cubby: migration 009 (PostgreSQL 14+)
-- 1. Who can see and do what (owner, director, office, teacher, parent), enforced in the database.
-- 2. PINs for parents and authorized pick-up people, with lockout, so unauthorized people cannot get in.
-- 3. Automatic on-time and late tracking for staff and children, with a daily record.
-- Run after cubby_schema.sql and migrations 002 to 008.
--
-- How access is enforced (three layers, so one mistake does not expose data)
--   a. The API sets the database role per request:   SET LOCAL ROLE cubby_teacher;
--                                                    SET LOCAL app.user_id = '<the signed-in user>';
--      The role and center are then looked up from the users table, not trusted from the request.
--   b. Table grants: teachers and parents get almost no direct table access, only specific views and functions.
--   c. Row-level security: even where access exists, a teacher sees only their own classroom's children,
--      and a parent sees only their own children.
--   The permission matrix (role_permissions) drives the app's screens and finer rules for the office roles.
--
-- Assumption: one database per center is the strongest isolation. Where a table has center_id, policies also
-- filter by center, so several centers in one database do not see each other.
-- =====================================================================

CREATE TYPE permission_scope AS ENUM ('all','own_classroom','own_children','own_record');
CREATE TYPE arrival_status   AS ENUM ('on_time','late','no_show','excused_absence','unscheduled','not_yet_due');

-- ---------------------------------------------------------------------
-- Database roles (no passwords here; your API's login role is granted membership)
-- ---------------------------------------------------------------------
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['cubby_office','cubby_teacher','cubby_parent','cubby_kiosk'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
  -- The API connects as cubby_app (give it LOGIN and a password outside this file). NOINHERIT means it has
  -- no privileges of its own; it must SET ROLE to one of the four roles above for each request.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_app') THEN
    CREATE ROLE cubby_app NOLOGIN NOINHERIT;
  END IF;
  GRANT cubby_office, cubby_teacher, cubby_parent, cubby_kiosk TO cubby_app;
END $$;

-- ---------------------------------------------------------------------
-- Who is asking? Looked up from the users table, never taken from the request.
-- ---------------------------------------------------------------------
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
CREATE FUNCTION app_center_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.center_id FROM users u WHERE u.id = app_user_id() AND u.is_active
$$;
CREATE FUNCTION app_role() RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.role FROM users u WHERE u.id = app_user_id() AND u.is_active
$$;
CREATE FUNCTION app_staff_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.staff_id FROM users u WHERE u.id = app_user_id() AND u.is_active
$$;
CREATE FUNCTION app_guardian_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.guardian_id FROM users u WHERE u.id = app_user_id() AND u.is_active
$$;

-- Which classrooms a teacher belongs to: assigned rooms, plus any room they are clocked into right now
-- (so a floater covering a room can see that room, and only while they are there).
CREATE TABLE staff_classroom_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  classroom_id  uuid NOT NULL REFERENCES classrooms(id),
  valid_during  daterange NOT NULL DEFAULT daterange(current_date, NULL, '[)'),
  is_primary    boolean NOT NULL DEFAULT true
);
CREATE INDEX staff_classroom_assignments_idx ON staff_classroom_assignments (staff_id);
INSERT INTO staff_classroom_assignments (staff_id, classroom_id)
SELECT s.id, s.default_classroom_id FROM staff s WHERE s.default_classroom_id IS NOT NULL AND s.terminated_on IS NULL;

CREATE FUNCTION my_classroom_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT sca.classroom_id FROM staff_classroom_assignments sca
   WHERE sca.staff_id = app_staff_id() AND sca.valid_during @> current_date
  UNION
  SELECT te.classroom_id FROM time_entries te
   WHERE te.staff_id = app_staff_id() AND te.clock_out_at IS NULL AND te.classroom_id IS NOT NULL
$$;

-- Children currently on the active roster in the teacher's classrooms.
CREATE FUNCTION my_classroom_child_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.child_id FROM v_active_roster r WHERE r.classroom_id IN (SELECT my_classroom_ids())
$$;

-- A parent's own children, only where the family has allowed portal access for that guardian.
CREATE FUNCTION my_child_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT cg.child_id FROM child_guardians cg
   WHERE cg.guardian_id = app_guardian_id() AND cg.can_view_portal
$$;

-- ---------------------------------------------------------------------
-- Permission matrix
-- ---------------------------------------------------------------------
CREATE TABLE permissions (
  code         text PRIMARY KEY,
  area         text NOT NULL,
  description  text NOT NULL
);
INSERT INTO permissions (code, area, description) VALUES
  ('attendance.view',        'Attendance',  'See when children sign in and out'),
  ('attendance.record',      'Attendance',  'Sign children in and out, mark absences'),
  ('attendance.checkout',    'Attendance',  'Release a child to a person, including overriding a PIN'),
  ('children.view',          'Children',    'See child profiles'),
  ('children.manage',        'Children',    'Edit child profiles, guardians, contacts'),
  ('children.health_alerts', 'Children',    'See allergy and medical alerts (needed to serve meals safely)'),
  ('meals.view',             'Meals',       'See the meal program and what children ate'),
  ('meals.record',           'Meals',       'Record what each child ate'),
  ('meals.claims',           'Meals',       'See and prepare state food program claims'),
  ('food_products.manage',   'Meals',       'Manage vendor products and certificates'),
  ('recipes.manage',         'Meals',       'Manage recipes and portion standards'),
  ('daily_report.view',      'Reports',     'See daily parent reports'),
  ('daily_report.publish',   'Reports',     'Publish daily parent reports'),
  ('supplies.flag',          'Supplies',    'Flag a child''s missing personal items'),
  ('supplies.review',        'Supplies',    'Respond to child supply flags'),
  ('orders.request',         'Ordering',    'Request classroom supplies'),
  ('orders.review',          'Ordering',    'Approve or deny classroom requests'),
  ('purchasing.view',        'Purchasing',  'See the purchasing master list'),
  ('purchasing.approve',     'Purchasing',  'Approve purchases'),
  ('enrollment.view',        'Enrollment',  'See the enrollment pipeline and waitlist'),
  ('enrollment.manage',      'Enrollment',  'Manage inquiries, offers, and enrollments'),
  ('billing.view',           'Billing',     'See invoices and payments'),
  ('billing.manage',         'Billing',     'Create invoices, record payments'),
  ('staff.view',             'Staff',       'See staff records and certifications'),
  ('staff.manage',           'Staff',       'Edit staff records'),
  ('time.punch',             'Staff time',  'Punch in and out and see your own hours'),
  ('time.view_all',          'Staff time',  'See everyone''s hours and punctuality'),
  ('time.approve',           'Staff time',  'Approve timesheets and corrections'),
  ('punctuality.view',       'Attendance',  'See who arrives on time and who is late'),
  ('reports.view',           'Reports',     'See reports'),
  ('users.manage',           'Admin',       'Manage user accounts, roles, and PINs'),
  ('settings.manage',        'Admin',       'Change center settings and policies'),
  ('audit.view',             'Admin',       'See the audit log'),
  ('portal.sign_in_out',     'Parent portal','See your child''s sign-in and sign-out'),
  ('portal.daily_report',    'Parent portal','See your child''s daily report (meals and activities)');

CREATE TABLE role_permissions (
  center_id        uuid NOT NULL REFERENCES centers(id),
  role             user_role NOT NULL,
  permission_code  text NOT NULL REFERENCES permissions(code),
  scope            permission_scope NOT NULL DEFAULT 'all',
  PRIMARY KEY (center_id, role, permission_code)
);

-- The scope the signed-in user has for a permission, or NULL if they do not have it.
CREATE FUNCTION permission_scope_for(p_code text) RETURNS permission_scope
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rp.scope FROM role_permissions rp
   WHERE rp.center_id = app_center_id() AND rp.role = app_role() AND rp.permission_code = p_code
$$;

-- Defaults, as described:
--   owner and director: everything
--   office: sees everything; runs the day-to-day; does not manage users or settings, approve purchases, or approve timesheets
--   teacher: sees when their children come in and out, sees the lunch program and records what each child ate,
--            plus the tools they already use for their own room (child supply flags, classroom supply requests, their own punches)
--   parent: only their own child's sign-in and sign-out (daily report is off until you turn it on)
CREATE FUNCTION seed_default_role_permissions(p_center uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO role_permissions (center_id, role, permission_code, scope)
  SELECT p_center, r, p.code, CASE WHEN p.code = 'time.punch' THEN 'own_record'::permission_scope ELSE 'all'::permission_scope END
  FROM permissions p, unnest(ARRAY['owner','director']::user_role[]) r
  WHERE p.code NOT LIKE 'portal.%'
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (center_id, role, permission_code, scope)
  SELECT p_center, 'front_office', p.code, 'all'
  FROM permissions p
  WHERE (p.code LIKE '%.view' AND p.code <> 'audit.view')
     OR p.code IN ('children.health_alerts','meals.claims','attendance.record','attendance.checkout','children.manage',
                   'enrollment.manage','supplies.review','orders.review','billing.manage','time.view_all','punctuality.view')
  ON CONFLICT DO NOTHING;
  INSERT INTO role_permissions (center_id, role, permission_code, scope)
  VALUES (p_center, 'front_office', 'time.punch', 'own_record') ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (center_id, role, permission_code, scope) VALUES
    (p_center, 'teacher', 'attendance.view',        'own_classroom'),
    (p_center, 'teacher', 'children.view',          'own_classroom'),
    (p_center, 'teacher', 'children.health_alerts', 'own_classroom'),
    (p_center, 'teacher', 'meals.view',             'own_classroom'),
    (p_center, 'teacher', 'meals.record',           'own_classroom'),
    (p_center, 'teacher', 'supplies.flag',          'own_classroom'),
    (p_center, 'teacher', 'orders.request',         'own_classroom'),
    (p_center, 'teacher', 'time.punch',             'own_record'),
    (p_center, 'cook',    'meals.view',             'all'),
    (p_center, 'cook',    'children.health_alerts', 'all'),
    (p_center, 'cook',    'food_products.manage',   'all'),
    (p_center, 'cook',    'recipes.manage',         'all'),
    (p_center, 'cook',    'time.punch',             'own_record'),
    (p_center, 'billing', 'billing.view',           'all'),
    (p_center, 'billing', 'billing.manage',         'all'),
    (p_center, 'billing', 'enrollment.view',        'all'),
    (p_center, 'billing', 'time.punch',             'own_record'),
    (p_center, 'parent',  'portal.sign_in_out',     'own_children')
  ON CONFLICT DO NOTHING;
END $$;

-- =====================================================================
-- PINs for parents and authorized pick-up people
-- =====================================================================
CREATE TABLE access_policies (
  center_id                  uuid PRIMARY KEY REFERENCES centers(id),
  pin_length                 smallint NOT NULL DEFAULT 6,
  max_failed_attempts        smallint NOT NULL DEFAULT 5,
  lockout_minutes            smallint NOT NULL DEFAULT 15,
  must_change_pin_first_use  boolean NOT NULL DEFAULT true,
  portal_requires_pin        boolean NOT NULL DEFAULT true
);

-- One PIN per person per purpose. The PIN is never stored: only a salted hash of the value the API sends.
-- The API should first run the PIN through a keyed hash (HMAC with a secret kept outside the database),
-- because a six-digit PIN is easy to guess from a stolen hash alone.
CREATE TABLE family_access_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id        uuid NOT NULL REFERENCES centers(id),
  guardian_id      uuid REFERENCES guardians(id),
  contact_id       uuid REFERENCES contacts(id),        -- an authorized pick-up person who is not a guardian
  purpose          text NOT NULL CHECK (purpose IN ('kiosk','portal')),
  pin_hash         text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  failed_attempts  smallint NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_used_at     timestamptz,
  last_failed_at   timestamptz,
  must_change      boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at       timestamptz,
  CHECK (num_nonnulls(guardian_id, contact_id) = 1)
);
CREATE UNIQUE INDEX one_active_pin_guardian ON family_access_credentials (guardian_id, purpose) WHERE is_active AND guardian_id IS NOT NULL;
CREATE UNIQUE INDEX one_active_pin_contact  ON family_access_credentials (contact_id, purpose)  WHERE is_active AND contact_id IS NOT NULL;

CREATE TABLE family_access_attempts (                   -- every attempt, successful or not
  id             bigserial PRIMARY KEY,
  credential_id  uuid NOT NULL REFERENCES family_access_credentials(id),
  center_id      uuid NOT NULL REFERENCES centers(id),
  device_id      uuid REFERENCES time_devices(id),
  action         text NOT NULL,
  child_id       uuid REFERENCES children(id),
  succeeded      boolean NOT NULL,
  reason         text NOT NULL,
  attempted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX family_access_attempts_idx ON family_access_attempts (credential_id, attempted_at DESC);

-- People who must not be given a child, for example under a court order. Staff see this, and the PIN check refuses.
CREATE TABLE release_restrictions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id               uuid NOT NULL REFERENCES centers(id),
  child_id                uuid NOT NULL REFERENCES children(id),
  guardian_id             uuid REFERENCES guardians(id),
  contact_id              uuid REFERENCES contacts(id),
  person_name             text,                                  -- for someone who is not in the system
  note                    text,
  court_order_document_id uuid REFERENCES documents(id),
  effective_from          date NOT NULL DEFAULT current_date,
  effective_to            date,
  is_active               boolean NOT NULL DEFAULT true,
  created_by              uuid REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(guardian_id, contact_id, person_name) >= 1)
);
CREATE INDEX release_restrictions_child_idx ON release_restrictions (child_id) WHERE is_active;

-- How each sign-in and sign-out happened.
ALTER TABLE attendance_records
  ADD COLUMN checked_in_method  text CHECK (checked_in_method  IN ('kiosk_pin','staff','portal')),
  ADD COLUMN checked_out_method text CHECK (checked_out_method IN ('kiosk_pin','staff','portal'));

-- Set or replace someone's PIN. Only the hash is stored.
CREATE FUNCTION set_family_pin(p_center uuid, p_guardian uuid, p_contact uuid, p_purpose text, p_pin_proof text, p_user uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE family_access_credentials
     SET is_active = false, rotated_at = now()
   WHERE is_active AND purpose = p_purpose
     AND guardian_id IS NOT DISTINCT FROM p_guardian AND contact_id IS NOT DISTINCT FROM p_contact;
  INSERT INTO family_access_credentials (center_id, guardian_id, contact_id, purpose, pin_hash, created_by, must_change)
  VALUES (p_center, p_guardian, p_contact, p_purpose, crypt(p_pin_proof, gen_salt('bf', 10)), p_user, true)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE FUNCTION unlock_family_pin(p_credential uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE family_access_credentials SET failed_attempts = 0, locked_until = NULL WHERE id = p_credential;
  INSERT INTO audit_log (center_id, user_id, action, table_name, record_id, reason)
  SELECT center_id, p_user, 'unlock', 'family_access_credentials', id, 'PIN unlocked by staff'
  FROM family_access_credentials WHERE id = p_credential;
END $$;

-- The one door for checking a PIN. Counts failures, locks the PIN after too many, refuses anyone under a release
-- restriction, and confirms the person is actually allowed to bring or take this child. It tells the kiosk only
-- "ok" or a short reason. The kiosk should show the generic message "Please see the front desk" for any failure.
CREATE FUNCTION check_family_pin(p_credential uuid, p_pin_proof text, p_child uuid, p_action text, p_device uuid)
RETURNS TABLE (result_ok boolean, result_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cr      family_access_credentials%ROWTYPE;
  pol     access_policies%ROWTYPE;
  v_max   integer;
  v_mins  integer;
  v_valid boolean;
BEGIN
  SELECT * INTO cr FROM family_access_credentials WHERE id = p_credential FOR UPDATE;
  IF NOT FOUND OR NOT cr.is_active THEN
    RETURN QUERY SELECT false, 'no active PIN'::text;
    RETURN;
  END IF;
  SELECT * INTO pol FROM access_policies WHERE center_id = cr.center_id;
  v_max  := coalesce(pol.max_failed_attempts, 5);
  v_mins := coalesce(pol.lockout_minutes, 15);

  IF cr.locked_until IS NOT NULL AND cr.locked_until > now() THEN
    INSERT INTO family_access_attempts (credential_id, center_id, device_id, action, child_id, succeeded, reason)
    VALUES (cr.id, cr.center_id, p_device, p_action, p_child, false, 'locked');
    RETURN QUERY SELECT false, 'locked'::text;
    RETURN;
  END IF;

  IF p_action = 'check_out' AND EXISTS (
       SELECT 1 FROM release_restrictions rr
       WHERE rr.child_id = p_child AND rr.is_active AND rr.effective_from <= current_date
         AND (rr.effective_to IS NULL OR rr.effective_to >= current_date)
         AND ((rr.guardian_id IS NOT NULL AND rr.guardian_id = cr.guardian_id)
           OR (rr.contact_id  IS NOT NULL AND rr.contact_id  = cr.contact_id))) THEN
    INSERT INTO family_access_attempts (credential_id, center_id, device_id, action, child_id, succeeded, reason)
    VALUES (cr.id, cr.center_id, p_device, p_action, p_child, false, 'release restriction');
    INSERT INTO in_app_notifications (center_id, for_role, kind, title, body, source_table, source_id)
    SELECT cr.center_id, r, 'release_restriction_attempt', 'Restricted person tried to sign a child out',
           'A person under a release restriction tried to sign a child out at a kiosk. Go to the front desk now.',
           'family_access_credentials', cr.id
    FROM unnest(ARRAY['director','front_office']::user_role[]) r;
    RETURN QUERY SELECT false, 'restricted'::text;
    RETURN;
  END IF;

  v_valid := EXISTS (SELECT 1 FROM child_guardians cg
                     WHERE cg.child_id = p_child AND cg.guardian_id = cr.guardian_id
                       AND (p_action = 'check_in' OR cg.can_pick_up))
          OR EXISTS (SELECT 1 FROM child_contacts cc
                     WHERE cc.child_id = p_child AND cc.contact_id = cr.contact_id AND cc.role = 'authorized_pickup');
  IF NOT v_valid THEN
    INSERT INTO family_access_attempts (credential_id, center_id, device_id, action, child_id, succeeded, reason)
    VALUES (cr.id, cr.center_id, p_device, p_action, p_child, false, 'not authorized for this child');
    RETURN QUERY SELECT false, 'not authorized'::text;
    RETURN;
  END IF;

  IF crypt(p_pin_proof, cr.pin_hash) = cr.pin_hash THEN
    UPDATE family_access_credentials SET failed_attempts = 0, locked_until = NULL, last_used_at = now() WHERE id = cr.id;
    INSERT INTO family_access_attempts (credential_id, center_id, device_id, action, child_id, succeeded, reason)
    VALUES (cr.id, cr.center_id, p_device, p_action, p_child, true, 'ok');
    RETURN QUERY SELECT true, 'ok'::text;
    RETURN;
  END IF;

  UPDATE family_access_credentials
     SET failed_attempts = failed_attempts + 1, last_failed_at = now(),
         locked_until = CASE WHEN failed_attempts + 1 >= v_max THEN now() + make_interval(mins => v_mins) ELSE locked_until END
   WHERE id = cr.id;
  INSERT INTO family_access_attempts (credential_id, center_id, device_id, action, child_id, succeeded, reason)
  VALUES (cr.id, cr.center_id, p_device, p_action, p_child, false, 'incorrect PIN');
  IF cr.failed_attempts + 1 >= v_max THEN
    INSERT INTO in_app_notifications (center_id, for_role, kind, title, body, source_table, source_id)
    SELECT cr.center_id, r, 'pin_locked', 'A family PIN was locked',
           'A parent or pick-up PIN was locked after repeated wrong attempts. Check the sign-in log.',
           'family_access_credentials', cr.id
    FROM unnest(ARRAY['director','front_office']::user_role[]) r;
    RETURN QUERY SELECT false, 'locked'::text;
  ELSE
    RETURN QUERY SELECT false, 'incorrect PIN'::text;
  END IF;
END $$;

-- The kiosk's only door: check the PIN, then record the sign-in or sign-out. Kiosks can run nothing else.
CREATE FUNCTION kiosk_child_sign(p_device uuid, p_credential uuid, p_pin_proof text, p_child uuid, p_action text)
RETURNS TABLE (result_ok boolean, result_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_center   uuid;
  v_tz       text;
  v_date     date;
  v_class    uuid;
  v_guardian uuid;
  v_contact  uuid;
  v_ok       boolean;
  v_reason   text;
BEGIN
  IF p_action NOT IN ('check_in','check_out') THEN
    RETURN QUERY SELECT false, 'invalid action'::text;
    RETURN;
  END IF;
  SELECT d.center_id INTO v_center FROM time_devices d WHERE d.id = p_device AND d.is_active;
  IF v_center IS NULL THEN
    RETURN QUERY SELECT false, 'unknown device'::text;
    RETURN;
  END IF;

  SELECT c.result_ok, c.result_reason INTO v_ok, v_reason FROM check_family_pin(p_credential, p_pin_proof, p_child, p_action, p_device) c;
  IF NOT v_ok THEN
    RETURN QUERY SELECT false, v_reason;
    RETURN;
  END IF;

  SELECT ce.timezone INTO v_tz FROM centers ce WHERE ce.id = v_center;
  v_date := (now() AT TIME ZONE v_tz)::date;
  SELECT f.guardian_id, f.contact_id INTO v_guardian, v_contact FROM family_access_credentials f WHERE f.id = p_credential;

  IF p_action = 'check_in' THEN
    SELECT r.classroom_id INTO v_class FROM roster_on(v_center, v_date) r WHERE r.child_id = p_child;
    IF v_class IS NULL THEN
      RETURN QUERY SELECT false, 'child is not on the roster today'::text;
      RETURN;
    END IF;
    INSERT INTO attendance_records (center_id, child_id, classroom_id, service_date, status, checked_in_at,
                                    dropped_off_by_guardian, checked_in_method)
    VALUES (v_center, p_child, v_class, v_date, 'present', now(), v_guardian, 'kiosk_pin')
    ON CONFLICT (child_id, service_date) DO UPDATE
      SET status = 'present', checked_in_at = coalesce(attendance_records.checked_in_at, now()),
          dropped_off_by_guardian = coalesce(attendance_records.dropped_off_by_guardian, EXCLUDED.dropped_off_by_guardian),
          checked_in_method = coalesce(attendance_records.checked_in_method, 'kiosk_pin');
    UPDATE expected_attendance SET status = 'arrived'
     WHERE child_id = p_child AND service_date = v_date AND status = 'expected';
  ELSE
    UPDATE attendance_records
       SET checked_out_at = now(), picked_up_by_guardian = v_guardian, picked_up_by_contact = v_contact,
           checked_out_method = 'kiosk_pin'
     WHERE child_id = p_child AND service_date = v_date AND checked_in_at IS NOT NULL AND checked_out_at IS NULL;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 'child is not signed in'::text;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT true, 'ok'::text;
END $$;

-- =====================================================================
-- ON-TIME AND LATE, AUTOMATICALLY
-- =====================================================================
CREATE TABLE punctuality_policies (
  center_id                       uuid PRIMARY KEY REFERENCES centers(id),
  child_grace_minutes             smallint NOT NULL DEFAULT 10,   -- arrive within this many minutes and you are on time
  staff_grace_minutes             smallint NOT NULL DEFAULT 5,
  staff_late_alert_after_minutes  smallint NOT NULL DEFAULT 10,   -- when the director is told
  digest_time                     time NOT NULL DEFAULT '10:00'   -- the morning summary of who was late or absent
);

-- One row per person per day, so the record is kept even if a schedule changes later.
CREATE TABLE daily_punctuality (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id      uuid NOT NULL REFERENCES centers(id),
  subject_type   text NOT NULL CHECK (subject_type IN ('child','staff')),
  child_id       uuid REFERENCES children(id),
  staff_id       uuid REFERENCES staff(id),
  service_date   date NOT NULL,
  expected_time  time,
  actual_time    time,
  minutes_late   integer,
  status         arrival_status NOT NULL,
  excused        boolean NOT NULL DEFAULT false,      -- a person can excuse a lateness and add a reason
  excuse_note    text,
  excused_by     uuid REFERENCES users(id),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'child' AND child_id IS NOT NULL AND staff_id IS NULL)
      OR (subject_type = 'staff' AND staff_id IS NOT NULL AND child_id IS NULL))
);
CREATE UNIQUE INDEX daily_punctuality_child_uniq ON daily_punctuality (child_id, service_date) WHERE child_id IS NOT NULL;
CREATE UNIQUE INDEX daily_punctuality_staff_uniq ON daily_punctuality (staff_id, service_date) WHERE staff_id IS NOT NULL;
CREATE INDEX daily_punctuality_day_idx ON daily_punctuality (center_id, service_date, status);

-- Work out on-time, late, absent, and no-show for one day. Run every few minutes during the morning and once at closing.
-- Times are compared in the center's own time zone. Returns the number of rows written.
CREATE FUNCTION compute_daily_punctuality(p_center uuid, p_date date) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v_tz         text;
  v_today      date;
  v_now        time;
  v_child_gr   integer;
  v_staff_gr   integer;
  v_n1         integer;
  v_n2         integer;
BEGIN
  SELECT ce.timezone INTO v_tz FROM centers ce WHERE ce.id = p_center;
  v_today := (now() AT TIME ZONE v_tz)::date;
  v_now   := (now() AT TIME ZONE v_tz)::time;
  v_child_gr := coalesce((SELECT pp.child_grace_minutes FROM punctuality_policies pp WHERE pp.center_id = p_center), 10);
  v_staff_gr := coalesce((SELECT pp.staff_grace_minutes FROM punctuality_policies pp WHERE pp.center_id = p_center), 5);

  -- Children
  INSERT INTO daily_punctuality (center_id, subject_type, child_id, service_date, expected_time, actual_time, minutes_late, status)
  SELECT ea.center_id, 'child', ea.child_id, ea.service_date, ea.expected_arrival,
         (ar.checked_in_at AT TIME ZONE v_tz)::time,
         CASE WHEN ar.checked_in_at IS NOT NULL
              THEN greatest(round(extract(epoch FROM ((ar.checked_in_at AT TIME ZONE v_tz)::time - ea.expected_arrival)) / 60), 0)::int END,
         CASE
           WHEN ar.status = 'present' AND ar.checked_in_at IS NOT NULL THEN
             CASE WHEN extract(epoch FROM ((ar.checked_in_at AT TIME ZONE v_tz)::time - ea.expected_arrival)) / 60 > v_child_gr
                  THEN 'late'::arrival_status ELSE 'on_time'::arrival_status END
           WHEN ar.status = 'absent' OR ea.status = 'excused' THEN 'excused_absence'::arrival_status
           WHEN p_date = v_today AND v_now < ea.expected_arrival + make_interval(mins => v_child_gr) THEN 'not_yet_due'::arrival_status
           ELSE 'no_show'::arrival_status
         END
  FROM expected_attendance ea
  LEFT JOIN attendance_records ar ON ar.child_id = ea.child_id AND ar.service_date = ea.service_date
  WHERE ea.center_id = p_center AND ea.service_date = p_date AND ea.status <> 'closed'
  ON CONFLICT (child_id, service_date) WHERE child_id IS NOT NULL
  DO UPDATE SET expected_time = EXCLUDED.expected_time, actual_time = EXCLUDED.actual_time,
                minutes_late = EXCLUDED.minutes_late, status = EXCLUDED.status, computed_at = now();
  GET DIAGNOSTICS v_n1 = ROW_COUNT;

  -- Staff: the earliest scheduled shift of the day against the first punch-in
  WITH sched AS (
    SELECT ss.staff_id, min(ss.starts_at) AS starts_at
    FROM staff_shifts ss JOIN staff st ON st.id = ss.staff_id
    WHERE st.center_id = p_center AND ss.work_date = p_date AND st.terminated_on IS NULL
    GROUP BY ss.staff_id
  ), act AS (
    SELECT te.staff_id, min((te.clock_in_at AT TIME ZONE v_tz)::time) AS first_in
    FROM time_entries te
    WHERE (te.clock_in_at AT TIME ZONE v_tz)::date = p_date
    GROUP BY te.staff_id
  )
  INSERT INTO daily_punctuality (center_id, subject_type, staff_id, service_date, expected_time, actual_time, minutes_late, status)
  SELECT p_center, 'staff', s.staff_id, p_date, s.starts_at, a.first_in,
         CASE WHEN a.first_in IS NOT NULL
              THEN greatest(round(extract(epoch FROM (a.first_in - s.starts_at)) / 60), 0)::int END,
         CASE
           WHEN a.first_in IS NOT NULL THEN
             CASE WHEN extract(epoch FROM (a.first_in - s.starts_at)) / 60 > v_staff_gr
                  THEN 'late'::arrival_status ELSE 'on_time'::arrival_status END
           WHEN p_date = v_today AND v_now < s.starts_at + make_interval(mins => v_staff_gr) THEN 'not_yet_due'::arrival_status
           ELSE 'no_show'::arrival_status
         END
  FROM sched s LEFT JOIN act a ON a.staff_id = s.staff_id
  ON CONFLICT (staff_id, service_date) WHERE staff_id IS NOT NULL
  DO UPDATE SET expected_time = EXCLUDED.expected_time, actual_time = EXCLUDED.actual_time,
                minutes_late = EXCLUDED.minutes_late, status = EXCLUDED.status, computed_at = now();
  GET DIAGNOSTICS v_n2 = ROW_COUNT;

  RETURN v_n1 + v_n2;
END $$;

-- Who is late or did not show today, children and staff, for the morning summary. Office, director, and owner only.
CREATE VIEW v_arrivals_today AS
SELECT dp.center_id, dp.subject_type,
       coalesce(c.first_name || ' ' || c.last_name, s.first_name || ' ' || s.last_name) AS person,
       coalesce(cl.name, sc.name) AS classroom,
       dp.expected_time, dp.actual_time, dp.minutes_late, dp.status, dp.excused, dp.excuse_note
FROM daily_punctuality dp
LEFT JOIN children c ON c.id = dp.child_id
LEFT JOIN staff s ON s.id = dp.staff_id
LEFT JOIN child_classroom_assignments a ON a.child_id = dp.child_id AND a.valid_during @> dp.service_date
LEFT JOIN classrooms cl ON cl.id = a.classroom_id
LEFT JOIN classrooms sc ON sc.id = s.default_classroom_id
WHERE dp.service_date = current_date AND dp.status IN ('late','no_show');

-- A person's record over the last 28 days. Staff lateness is HR information: director, owner, and office only.
CREATE VIEW v_punctuality_summary AS
SELECT dp.center_id, dp.subject_type, dp.child_id, dp.staff_id,
       count(*) FILTER (WHERE dp.status IN ('on_time','late','no_show'))                AS days_expected,
       count(*) FILTER (WHERE dp.status = 'on_time')                                    AS on_time_days,
       count(*) FILTER (WHERE dp.status = 'late' AND NOT dp.excused)                    AS late_days,
       count(*) FILTER (WHERE dp.status = 'no_show' AND NOT dp.excused)                 AS no_show_days,
       round(avg(dp.minutes_late) FILTER (WHERE dp.status = 'late'))                    AS avg_minutes_late
FROM daily_punctuality dp
WHERE dp.service_date >= current_date - 28
GROUP BY dp.center_id, dp.subject_type, dp.child_id, dp.staff_id;

CREATE FUNCTION seed_access_defaults(p_center uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_default_role_permissions(p_center);
  INSERT INTO access_policies (center_id) VALUES (p_center) ON CONFLICT DO NOTHING;
  INSERT INTO punctuality_policies (center_id) VALUES (p_center) ON CONFLICT DO NOTHING;
END $$;

-- =====================================================================
-- WHAT EACH ROLE SEES: teacher and parent views
-- These views are the doors for teachers and parents. Each one filters to that person's own classroom or children.
-- =====================================================================

-- Teacher: when each child in my room came in and went out today. Nothing else about the child.
CREATE VIEW v_teacher_arrivals AS
SELECT r.child_id, r.first_name, r.last_name, r.classroom_id,
       ar.status AS attendance_status, ar.checked_in_at, ar.checked_out_at,
       EXISTS (SELECT 1 FROM child_alerts ca WHERE ca.child_id = r.child_id AND ca.is_active) AS has_alert
FROM v_active_roster r
LEFT JOIN attendance_records ar ON ar.child_id = r.child_id AND ar.service_date = current_date
WHERE r.child_id IN (SELECT my_classroom_child_ids());

-- Teacher: who is here to be fed, with the allergy and medical alerts needed to serve safely.
CREATE VIEW v_teacher_meal_roster AS
SELECT r.child_id, r.first_name, r.last_name, r.classroom_id, ar.checked_in_at,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('name', ca.name, 'kind', ca.kind, 'severity', ca.severity, 'plan', ca.care_plan)), '[]'::jsonb)
          FROM child_alerts ca WHERE ca.child_id = r.child_id AND ca.is_active) AS alerts
FROM v_active_roster r
JOIN attendance_records ar ON ar.child_id = r.child_id AND ar.service_date = current_date
 AND ar.status = 'present' AND ar.checked_out_at IS NULL
WHERE r.child_id IN (SELECT my_classroom_child_ids());

-- Teacher: today's lunch program for my room: the foods and the portion for each age group.
CREATE VIEW v_teacher_meal_service_items AS
SELECT ms.id AS meal_service_id, ms.classroom_id, ms.service_date, ms.meal_type, ms.status,
       msi.id AS item_id, fi.name AS food, msi.component_code, msi.age_group_id, msi.portion_quantity, msi.portion_unit
FROM meal_services ms
JOIN meal_service_items msi ON msi.meal_service_id = ms.id
JOIN food_items fi ON fi.id = msi.food_item_id
WHERE ms.classroom_id IN (SELECT my_classroom_ids()) AND ms.service_date = current_date;

-- Teacher: when someone is signing a child out, the name of the person, so staff can greet and confirm. No phone numbers.
CREATE VIEW v_teacher_pickup_prompt AS
SELECT fa.child_id, fa.attempted_at,
       coalesce(g.first_name || ' ' || g.last_name, ct.first_name || ' ' || ct.last_name) AS person,
       coalesce(cg.relationship, cc.relationship) AS relationship
FROM family_access_attempts fa
JOIN family_access_credentials f ON f.id = fa.credential_id
LEFT JOIN guardians g ON g.id = f.guardian_id
LEFT JOIN contacts ct ON ct.id = f.contact_id
LEFT JOIN child_guardians cg ON cg.child_id = fa.child_id AND cg.guardian_id = f.guardian_id
LEFT JOIN child_contacts cc ON cc.child_id = fa.child_id AND cc.contact_id = f.contact_id AND cc.role = 'authorized_pickup'
WHERE fa.succeeded AND fa.action = 'check_out' AND fa.attempted_at > now() - interval '10 minutes'
  AND fa.child_id IN (SELECT my_classroom_child_ids());

-- Parent: their own child's sign-in and sign-out, and who did it. Nothing more.
CREATE VIEW v_parent_sign_in_out AS
SELECT ar.child_id, c.first_name AS child_first_name, ar.service_date, ar.checked_in_at, ar.checked_out_at,
       gi.first_name || ' ' || gi.last_name AS dropped_off_by,
       coalesce(go.first_name || ' ' || go.last_name, co.first_name || ' ' || co.last_name) AS picked_up_by
FROM attendance_records ar
JOIN children c ON c.id = ar.child_id
LEFT JOIN guardians gi ON gi.id = ar.dropped_off_by_guardian
LEFT JOIN guardians go ON go.id = ar.picked_up_by_guardian
LEFT JOIN contacts co ON co.id = ar.picked_up_by_contact
WHERE ar.status = 'present' AND ar.child_id IN (SELECT my_child_ids())
  AND permission_scope_for('portal.sign_in_out') IS NOT NULL;

-- Parent: the daily report, empty unless the center has switched that permission on for parents.
CREATE VIEW v_parent_daily_report_secure AS
SELECT d.*
FROM v_parent_daily_report d
WHERE d.child_id IN (SELECT my_child_ids())
  AND permission_scope_for('portal.daily_report') IS NOT NULL;

-- =====================================================================
-- ROW-LEVEL SECURITY AND GRANTS
-- =====================================================================

-- Trigger functions must keep working when a low-privilege role causes them to fire, so they run as their owner.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER SET search_path = public', f.sig);
  END LOOP;
END $$;

-- Turn on row-level security everywhere except pure reference tables. Office roles get a center-scoped policy.
-- Teachers and parents get no generic policy, so they see nothing unless a specific policy below allows it.
DO $$
DECLARE
  t record;
  office_roles text := '(''owner'',''director'',''front_office'',''billing'',''cook'')';
BEGIN
  FOR t IN
    SELECT c.relname,
           EXISTS (SELECT 1 FROM information_schema.columns col
                   WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'center_id') AS has_center
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname NOT IN ('permissions','cacfp_age_groups','food_components','allergens','meal_patterns','reimbursement_rates',
                            'request_status_transitions','need_status_transitions','pipeline_transitions','enrollment_transitions',
                            'users','role_permissions')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.relname);
    IF t.has_center THEN
      EXECUTE format('CREATE POLICY office_access ON %I TO cubby_office USING (center_id = app_center_id() AND app_role()::text IN %s) WITH CHECK (center_id = app_center_id() AND app_role()::text IN %s)',
                     t.relname, office_roles, office_roles);
    ELSE
      EXECUTE format('CREATE POLICY office_access ON %I TO cubby_office USING (app_role()::text IN %s) WITH CHECK (app_role()::text IN %s)',
                     t.relname, office_roles, office_roles);
    END IF;
  END LOOP;
END $$;

-- users: everyone can read their own row; the office sees their center; only owner and director create or change accounts.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users FOR SELECT TO cubby_office, cubby_teacher, cubby_parent, cubby_kiosk USING (id = app_user_id());
CREATE POLICY users_office_read ON users FOR SELECT TO cubby_office USING (center_id = app_center_id());
CREATE POLICY users_admin_write ON users FOR ALL TO cubby_office
  USING (center_id = app_center_id() AND app_role()::text IN ('owner','director'))
  WITH CHECK (center_id = app_center_id() AND app_role()::text IN ('owner','director'));

-- role_permissions: the office reads all rows for the center, others read only their own role's rows.
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_read ON role_permissions FOR SELECT TO cubby_office, cubby_teacher, cubby_parent
  USING (center_id = app_center_id() AND (role = app_role() OR app_role()::text IN ('owner','director','front_office')));
CREATE POLICY role_permissions_write ON role_permissions FOR ALL TO cubby_office
  USING (center_id = app_center_id() AND app_role()::text IN ('owner','director'))
  WITH CHECK (center_id = app_center_id() AND app_role()::text IN ('owner','director'));

-- Teachers: their own classroom only.
CREATE POLICY teacher_meals_svc ON meal_services FOR ALL TO cubby_teacher
  USING (classroom_id IN (SELECT my_classroom_ids())) WITH CHECK (classroom_id IN (SELECT my_classroom_ids()));
CREATE POLICY teacher_meal_records ON child_meal_records FOR ALL TO cubby_teacher
  USING (child_id IN (SELECT my_classroom_child_ids()))
  WITH CHECK (child_id IN (SELECT my_classroom_child_ids())
              AND EXISTS (SELECT 1 FROM meal_services ms WHERE ms.id = meal_service_id AND ms.classroom_id IN (SELECT my_classroom_ids())));
CREATE POLICY teacher_meal_items ON child_meal_items FOR ALL TO cubby_teacher
  USING (child_meal_record_id IN (SELECT id FROM child_meal_records))
  WITH CHECK (child_meal_record_id IN (SELECT id FROM child_meal_records));
CREATE POLICY teacher_infant_feedings ON infant_feedings FOR ALL TO cubby_teacher
  USING (child_id IN (SELECT my_classroom_child_ids())) WITH CHECK (child_id IN (SELECT my_classroom_child_ids()));
CREATE POLICY teacher_food_events ON child_food_events FOR ALL TO cubby_teacher
  USING (child_id IN (SELECT my_classroom_child_ids())) WITH CHECK (child_id IN (SELECT my_classroom_child_ids()));
CREATE POLICY teacher_supply_flags ON supply_flags FOR ALL TO cubby_teacher
  USING (child_id IN (SELECT my_classroom_child_ids())) WITH CHECK (child_id IN (SELECT my_classroom_child_ids()));
CREATE POLICY teacher_supply_requests ON supply_requests FOR ALL TO cubby_teacher
  USING (classroom_id IN (SELECT my_classroom_ids()) AND requested_by = app_staff_id())
  WITH CHECK (classroom_id IN (SELECT my_classroom_ids()) AND requested_by = app_staff_id());
CREATE POLICY teacher_supply_request_lines ON supply_request_lines FOR ALL TO cubby_teacher
  USING (request_id IN (SELECT id FROM supply_requests)) WITH CHECK (request_id IN (SELECT id FROM supply_requests));
CREATE POLICY teacher_catalog ON catalog_items FOR SELECT TO cubby_teacher USING (center_id = app_center_id() AND is_active);
CREATE POLICY teacher_catalog_cat ON catalog_categories FOR SELECT TO cubby_teacher USING (center_id = app_center_id());
CREATE POLICY teacher_supply_types ON supply_item_types FOR SELECT TO cubby_teacher USING (center_id = app_center_id() AND is_active);
CREATE POLICY teacher_supply_profiles ON child_supply_profiles FOR SELECT TO cubby_teacher
  USING (child_id IN (SELECT my_classroom_child_ids()));

-- Ordinary views should be filtered by row-level security for whoever queries them (PostgreSQL 15 and later).
-- The teacher and parent doors stay as they are: they run with their owner's rights and filter themselves.
-- On PostgreSQL 14, views bypass row-level security, so for those versions keep one center per database.
DO $$
DECLARE v record;
BEGIN
  IF current_setting('server_version_num')::int >= 150000 THEN
    FOR v IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind = 'v'
               AND c.relname !~ '^v_teacher_' AND c.relname NOT IN ('v_parent_sign_in_out','v_parent_daily_report_secure')
    LOOP
      EXECUTE format('ALTER VIEW %I SET (security_invoker = true)', v.relname);
    END LOOP;
  END IF;
END $$;

-- Table grants. Start from nothing, then give each role only what it needs.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM cubby_office, cubby_teacher, cubby_parent, cubby_kiosk;
GRANT USAGE ON SCHEMA public TO cubby_office, cubby_teacher, cubby_parent, cubby_kiosk;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cubby_office;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cubby_office, cubby_teacher;
GRANT SELECT ON permissions, cacfp_age_groups, food_components, allergens TO cubby_office, cubby_teacher;

GRANT SELECT ON users TO cubby_teacher, cubby_parent, cubby_kiosk;
GRANT SELECT ON role_permissions TO cubby_teacher, cubby_parent;
GRANT SELECT ON v_teacher_arrivals, v_teacher_meal_roster, v_teacher_meal_service_items, v_teacher_pickup_prompt TO cubby_teacher;
GRANT SELECT, INSERT, UPDATE ON meal_services, child_meal_records, child_meal_items, infant_feedings, child_food_events,
      supply_flags, supply_requests, supply_request_lines TO cubby_teacher;
GRANT SELECT ON catalog_items, catalog_categories, supply_item_types, child_supply_profiles TO cubby_teacher;
GRANT SELECT ON v_parent_sign_in_out, v_parent_daily_report_secure TO cubby_parent;

-- Secrets never leave the database: hide hashes and template references even from the office.
REVOKE SELECT, INSERT, UPDATE, DELETE ON family_access_credentials FROM cubby_office;
GRANT SELECT (id, center_id, guardian_id, contact_id, purpose, is_active, failed_attempts, locked_until, last_used_at,
              last_failed_at, must_change, created_by, created_at, rotated_at) ON family_access_credentials TO cubby_office;
REVOKE SELECT, INSERT, UPDATE, DELETE ON staff_punch_credentials FROM cubby_office;
GRANT SELECT (id, staff_id, kind, is_active, created_at, rotated_at) ON staff_punch_credentials TO cubby_office;
REVOKE SELECT, INSERT, UPDATE, DELETE ON time_devices FROM cubby_office;
GRANT SELECT (id, center_id, name, location_note, classroom_id, is_active, registered_by, registered_at, last_seen_at, app_version)
      ON time_devices TO cubby_office;
GRANT INSERT, UPDATE (name, location_note, classroom_id, is_active) ON time_devices TO cubby_office;
REVOKE SELECT, INSERT, UPDATE, DELETE ON staff_biometric_templates FROM cubby_office;
GRANT SELECT (id, staff_id, consent_id, vendor, algorithm_version, created_at, deletion_requested_at, deleted_at, deletion_reason)
      ON staff_biometric_templates TO cubby_office;

-- Functions: only the intended roles can call the sensitive ones.
REVOKE EXECUTE ON FUNCTION set_family_pin(uuid, uuid, uuid, text, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION unlock_family_pin(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION check_family_pin(uuid, text, uuid, text, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION kiosk_child_sign(uuid, uuid, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_family_pin(uuid, uuid, uuid, text, text, uuid) TO cubby_office;
GRANT EXECUTE ON FUNCTION unlock_family_pin(uuid, uuid) TO cubby_office;
GRANT EXECUTE ON FUNCTION kiosk_child_sign(uuid, uuid, text, uuid, text) TO cubby_kiosk;
