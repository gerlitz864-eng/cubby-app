-- =====================================================================
-- Cubby: migration 008 (PostgreSQL 14+)
-- Staff time tracking with facial-recognition verification.
--
-- Read this first
--   * Face data is legally sensitive. This design treats the face TEMPLATE as data that lives in a separate
--     encrypted store; this database keeps only an opaque reference, the consent record, and match results.
--     It never stores face images from successful punches.
--   * Face verification is one punch method among several (PIN, badge, supervisor entry). Nobody is forced
--     to use it, and it is only enabled for a person who has a recorded, unwithdrawn consent.
--   * Have an employment attorney review the notice, consent, retention, and any state or local biometric
--     rules that apply to you before this goes live. Nothing here is legal advice.
--
-- Design decisions
--   * Raw punches are append-only. They can be reviewed, but never edited or deleted. Fixes are new records.
--   * Punches are never silently dropped. A punch that fails a check is kept as 'pending_review'.
--   * Hours are stored as exact seconds. Rounding is off by default.
--   * Punches feed time_entries (from migration 001), which the live ratio monitor already reads.
--   * Time is decided by the server. A device's own clock is recorded, and a large difference is flagged.
--
-- Run after cubby_schema.sql and migrations 002 to 007.
-- =====================================================================

CREATE TYPE punch_type          AS ENUM ('clock_in','clock_out','break_start','break_end','room_change');
CREATE TYPE punch_method        AS ENUM ('face','pin','badge','supervisor_manual','system');
CREATE TYPE verification_result AS ENUM ('verified','failed','low_confidence','liveness_failed','not_attempted');
CREATE TYPE punch_status        AS ENUM ('accepted','pending_review','rejected','voided');
CREATE TYPE timesheet_status    AS ENUM ('open','submitted','approved','locked');
CREATE TYPE correction_status   AS ENUM ('pending','approved','denied');
CREATE TYPE time_exception_type AS ENUM ('missed_clock_in','missed_clock_out','duplicate_punch','failed_verification',
                                         'unrecognized_device','early_or_late_punch','long_shift','near_overtime',
                                         'clock_skew','left_room_over_ratio');
CREATE TYPE exception_status    AS ENUM ('open','resolved','dismissed');
CREATE TYPE consent_status      AS ENUM ('granted','withdrawn');
CREATE TYPE credential_kind     AS ENUM ('pin','badge');

-- ---------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------
CREATE TABLE time_policies (
  center_id                       uuid PRIMARY KEY REFERENCES centers(id),
  week_starts_on                  smallint NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 1 AND 7),   -- 1 = Monday
  overtime_after_seconds          integer NOT NULL DEFAULT 144000,     -- 40 hours in a workweek
  near_overtime_percent           smallint NOT NULL DEFAULT 90,
  rounding_seconds                smallint NOT NULL DEFAULT 0,         -- 0 = exact. Rounding must be neutral; get counsel's advice.
  breaks_are_unpaid               boolean NOT NULL DEFAULT false,      -- true ONLY if staff are fully relieved of duty on breaks
  min_face_score                  numeric(5,4) NOT NULL DEFAULT 0.9000,
  max_face_attempts               smallint NOT NULL DEFAULT 3,         -- then offer the alternative method
  early_punch_window_minutes      smallint NOT NULL DEFAULT 15,
  missed_clock_in_after_minutes   smallint NOT NULL DEFAULT 15,
  missed_clock_out_after_minutes  smallint NOT NULL DEFAULT 30,
  long_shift_hours                smallint NOT NULL DEFAULT 12,
  max_clock_skew_seconds          integer NOT NULL DEFAULT 300,
  store_failure_images            boolean NOT NULL DEFAULT false,      -- keep an image only when a match fails, for review
  failure_image_retention_days    smallint NOT NULL DEFAULT 30,
  template_retention_days_after_exit smallint NOT NULL DEFAULT 30,
  time_record_retention_years     smallint NOT NULL DEFAULT 6          -- confirm the period that applies to you
);

-- Overtime is calculated only for people who are eligible for it. Set this for each person with your payroll advisor.
ALTER TABLE staff ADD COLUMN overtime_eligible boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------
-- Consent, templates, and other ways to punch
-- ---------------------------------------------------------------------
CREATE TABLE biometric_policy_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id    uuid NOT NULL REFERENCES centers(id),
  version      integer NOT NULL,
  effective_on date NOT NULL,
  document_id  uuid REFERENCES documents(id),   -- the written notice: what is collected, why, how long, who sees it
  summary      text,
  UNIQUE (center_id, version)
);

-- Append-only. The latest row for a person is their current consent.
CREATE TABLE biometric_consents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id           uuid NOT NULL REFERENCES staff(id),
  policy_version_id  uuid NOT NULL REFERENCES biometric_policy_versions(id),
  status             consent_status NOT NULL,
  method             text NOT NULL,             -- signed_form, in_app
  document_id        uuid REFERENCES documents(id),
  recorded_by        uuid REFERENCES users(id),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  note               text
);
CREATE INDEX biometric_consents_staff_idx ON biometric_consents (staff_id, recorded_at DESC);

-- A pointer to the template held in the separate encrypted store. No image or template data lives here.
CREATE TABLE staff_biometric_templates (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id               uuid NOT NULL REFERENCES staff(id),
  consent_id             uuid NOT NULL REFERENCES biometric_consents(id),
  vendor                 text NOT NULL,
  template_ref           text NOT NULL,
  algorithm_version      text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid REFERENCES users(id),
  deletion_requested_at  timestamptz,           -- set automatically when consent is withdrawn
  deleted_at             timestamptz,           -- set when the secure store confirms deletion
  deletion_reason        text
);
CREATE UNIQUE INDEX one_active_template_per_staff ON staff_biometric_templates (staff_id) WHERE deleted_at IS NULL;

-- Every staff member also has a non-biometric way to punch. PINs are hashed, never stored.
CREATE TABLE staff_punch_credentials (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id         uuid NOT NULL REFERENCES staff(id),
  kind             credential_kind NOT NULL,
  credential_hash  text NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  rotated_at       timestamptz
);
CREATE UNIQUE INDEX one_active_credential_per_kind ON staff_punch_credentials (staff_id, kind) WHERE is_active;

-- Kiosk tablets and classroom devices that are allowed to record punches.
CREATE TABLE time_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id      uuid NOT NULL REFERENCES centers(id),
  name           text NOT NULL,
  location_note  text,
  classroom_id   uuid REFERENCES classrooms(id),
  token_hash     text NOT NULL,                 -- device credential, hashed
  is_active      boolean NOT NULL DEFAULT true,
  registered_by  uuid REFERENCES users(id),
  registered_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz,
  app_version    text,
  latitude       numeric(9,6),
  longitude      numeric(9,6),
  geofence_meters integer
);

-- ---------------------------------------------------------------------
-- Punches (append-only) and the shifts built from them
-- ---------------------------------------------------------------------
CREATE TABLE punch_events (
  id                        uuid PRIMARY KEY,           -- client-generated so an offline kiosk cannot create duplicates
  center_id                 uuid NOT NULL REFERENCES centers(id),
  staff_id                  uuid NOT NULL REFERENCES staff(id),   -- the person claiming the punch (verified one-to-one)
  device_id                 uuid REFERENCES time_devices(id),
  punch_type                punch_type NOT NULL,
  occurred_at               timestamptz NOT NULL DEFAULT now(),   -- the time that counts; the server's clock when online
  device_reported_at        timestamptz,
  received_at               timestamptz NOT NULL DEFAULT now(),
  was_offline               boolean NOT NULL DEFAULT false,
  clock_skew_seconds        integer,
  method                    punch_method NOT NULL,
  verification_result       verification_result,
  match_score               numeric(5,4),
  liveness_passed           boolean,
  attempts                  smallint NOT NULL DEFAULT 1,
  classroom_id              uuid REFERENCES classrooms(id),
  status                    punch_status NOT NULL DEFAULT 'accepted',
  flag_reason               text,
  reviewed_by               uuid REFERENCES users(id),
  reviewed_at               timestamptz,
  review_note               text,
  failure_image_document_id uuid REFERENCES documents(id),        -- only when the policy allows it, and deleted on schedule
  notes                     text,
  CHECK (punch_type <> 'room_change' OR classroom_id IS NOT NULL),
  CHECK (method <> 'face' OR verification_result IS NOT NULL),
  CHECK (status <> 'accepted' OR method <> 'face' OR verification_result = 'verified' OR reviewed_by IS NOT NULL)
);
CREATE INDEX punch_events_staff_idx ON punch_events (staff_id, occurred_at);
CREATE INDEX punch_events_review_idx ON punch_events (center_id, status) WHERE status = 'pending_review';

-- time_entries already exists (migration 001) and feeds the live ratio monitor. It now records which punches built it.
ALTER TABLE time_entries
  ADD COLUMN clock_in_punch_id   uuid REFERENCES punch_events(id),
  ADD COLUMN clock_out_punch_id  uuid REFERENCES punch_events(id),
  ADD COLUMN source              text NOT NULL DEFAULT 'punch' CHECK (source IN ('punch','correction','manual')),
  ADD COLUMN note                text;

-- Where a person worked during a shift, so ratio compliance can be shown after the fact.
CREATE TABLE time_entry_segments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id  uuid NOT NULL REFERENCES time_entries(id),
  classroom_id   uuid REFERENCES classrooms(id),
  start_at       timestamptz NOT NULL,
  end_at         timestamptz,
  CHECK (end_at IS NULL OR end_at >= start_at)
);
CREATE INDEX time_entry_segments_idx ON time_entry_segments (time_entry_id);

CREATE TABLE time_entry_breaks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  time_entry_id   uuid NOT NULL REFERENCES time_entries(id),
  break_start_at  timestamptz NOT NULL,
  break_end_at    timestamptz,
  is_paid         boolean NOT NULL DEFAULT true,     -- unpaid only when the policy says staff are fully relieved of duty
  CHECK (break_end_at IS NULL OR break_end_at >= break_start_at)
);
CREATE INDEX time_entry_breaks_idx ON time_entry_breaks (time_entry_id);

-- ---------------------------------------------------------------------
-- Corrections and exceptions
-- ---------------------------------------------------------------------
CREATE TABLE time_corrections (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id               uuid NOT NULL REFERENCES centers(id),
  staff_id                uuid NOT NULL REFERENCES staff(id),
  target_time_entry_id    uuid REFERENCES time_entries(id),    -- NULL = add a missing shift
  classroom_id            uuid REFERENCES classrooms(id),
  requested_clock_in      timestamptz NOT NULL,
  requested_clock_out     timestamptz,
  reason                  text NOT NULL,
  requested_by            uuid NOT NULL REFERENCES users(id),
  requested_at            timestamptz NOT NULL DEFAULT now(),
  status                  correction_status NOT NULL DEFAULT 'pending',
  reviewed_by             uuid REFERENCES users(id),
  reviewed_at             timestamptz,
  review_note             text,
  resulting_time_entry_id uuid REFERENCES time_entries(id),
  CHECK (requested_clock_out IS NULL OR requested_clock_out > requested_clock_in),
  CHECK (status <> 'denied' OR review_note IS NOT NULL)
);

CREATE TABLE time_exceptions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id        uuid NOT NULL REFERENCES centers(id),
  staff_id         uuid NOT NULL REFERENCES staff(id),
  exception        time_exception_type NOT NULL,
  related_punch_id uuid REFERENCES punch_events(id),
  time_entry_id    uuid REFERENCES time_entries(id),
  dedupe_key       text NOT NULL UNIQUE,                   -- set by the detecting job so it never raises the same one twice
  detected_at      timestamptz NOT NULL DEFAULT now(),
  status           exception_status NOT NULL DEFAULT 'open',
  resolved_by      uuid REFERENCES users(id),
  resolved_at      timestamptz,
  note             text
);
CREATE INDEX time_exceptions_open_idx ON time_exceptions (center_id, detected_at) WHERE status = 'open';

-- ---------------------------------------------------------------------
-- Weekly timesheets
-- ---------------------------------------------------------------------
CREATE TABLE timesheets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id            uuid NOT NULL REFERENCES centers(id),
  staff_id             uuid NOT NULL REFERENCES staff(id),
  week_start           date NOT NULL,
  status               timesheet_status NOT NULL DEFAULT 'open',
  total_seconds        bigint NOT NULL DEFAULT 0,
  regular_seconds      bigint NOT NULL DEFAULT 0,
  overtime_seconds     bigint NOT NULL DEFAULT 0,
  has_open_entry       boolean NOT NULL DEFAULT false,    -- a shift with no clock-out
  has_pending_punches  boolean NOT NULL DEFAULT false,    -- punches waiting for review
  generated_at         timestamptz,
  staff_attested_at    timestamptz,                       -- the staff member confirmed their hours
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  locked_at            timestamptz,
  note                 text,
  UNIQUE (staff_id, week_start)
);

CREATE TABLE timesheet_days (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id          uuid NOT NULL REFERENCES timesheets(id),
  work_date             date NOT NULL,                     -- the date the shift began, in the center's time zone
  entries               integer NOT NULL,
  first_in              timestamptz,
  last_out              timestamptz,
  gross_seconds         bigint NOT NULL,
  unpaid_break_seconds  bigint NOT NULL DEFAULT 0,
  worked_seconds        bigint NOT NULL,
  UNIQUE (timesheet_id, work_date)
);

CREATE TABLE weekly_hours_reports (                     -- each generated and delivered report
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  week_start    date NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  recipients    text[],
  document_id   uuid REFERENCES documents(id),
  UNIQUE (center_id, week_start)
);

-- =====================================================================
-- FUNCTIONS AND TRIGGERS
-- =====================================================================

-- A face template can be created only for someone whose latest consent is "granted".
CREATE FUNCTION template_requires_consent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status consent_status;
  v_at     timestamptz;
BEGIN
  SELECT c.status, c.recorded_at INTO v_status, v_at FROM biometric_consents c WHERE c.id = NEW.consent_id;
  IF v_status IS DISTINCT FROM 'granted' THEN
    RAISE EXCEPTION 'A face template needs a granted consent';
  END IF;
  IF EXISTS (SELECT 1 FROM biometric_consents c2 WHERE c2.staff_id = NEW.staff_id AND c2.recorded_at > v_at) THEN
    RAISE EXCEPTION 'A newer consent record exists; use the latest one';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_requires_consent_trg BEFORE INSERT ON staff_biometric_templates
  FOR EACH ROW EXECUTE FUNCTION template_requires_consent();

-- Withdrawing consent queues the person's template for deletion right away.
CREATE FUNCTION consent_withdrawn_queue_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE staff_biometric_templates
     SET deletion_requested_at = coalesce(deletion_requested_at, now()), deletion_reason = 'consent_withdrawn'
   WHERE staff_id = NEW.staff_id AND deleted_at IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_withdrawn_trg AFTER INSERT ON biometric_consents
  FOR EACH ROW WHEN (NEW.status = 'withdrawn') EXECUTE FUNCTION consent_withdrawn_queue_deletion();

-- Checks every new punch. Nothing is thrown away: a punch that fails a check is kept and sent for review.
CREATE FUNCTION punch_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_last   punch_type;
  v_policy time_policies%ROWTYPE;
BEGIN
  NEW.clock_skew_seconds := extract(epoch FROM (NEW.received_at - coalesce(NEW.device_reported_at, NEW.received_at)))::integer;
  SELECT * INTO v_policy FROM time_policies WHERE center_id = NEW.center_id;

  IF NEW.method = 'face' AND NEW.verification_result IS DISTINCT FROM 'verified' THEN
    NEW.status := 'pending_review';
    NEW.flag_reason := coalesce(NEW.flag_reason, 'face verification ' || coalesce(NEW.verification_result::text, 'missing'));
  END IF;

  IF NEW.method = 'face' AND NEW.verification_result = 'verified' AND NEW.liveness_passed IS DISTINCT FROM true THEN
    NEW.status := 'pending_review';
    NEW.flag_reason := coalesce(NEW.flag_reason, 'liveness check not confirmed');
  END IF;

  IF NOT NEW.was_offline AND v_policy.max_clock_skew_seconds IS NOT NULL
     AND abs(NEW.clock_skew_seconds) > v_policy.max_clock_skew_seconds THEN
    NEW.status := 'pending_review';
    NEW.flag_reason := coalesce(NEW.flag_reason, 'device clock differs from the server');
  END IF;

  IF NEW.status = 'accepted' THEN
    SELECT p.punch_type INTO v_last FROM punch_events p
    WHERE p.staff_id = NEW.staff_id AND p.status = 'accepted'
    ORDER BY p.occurred_at DESC LIMIT 1;

    IF (NEW.punch_type = 'clock_in' AND v_last IN ('clock_in','break_start','break_end','room_change'))
       OR (NEW.punch_type <> 'clock_in' AND (v_last IS NULL OR v_last = 'clock_out')) THEN
      NEW.status := 'pending_review';
      NEW.flag_reason := coalesce(NEW.flag_reason, 'punch out of sequence');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER punch_before_insert_trg BEFORE INSERT ON punch_events
  FOR EACH ROW EXECUTE FUNCTION punch_before_insert();

-- Raw punches are a permanent record: no deletes, and no edits to what was recorded.
CREATE FUNCTION punch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Punch records cannot be deleted; void the punch instead';
  END IF;
  IF (NEW.center_id, NEW.staff_id, NEW.device_id, NEW.punch_type, NEW.occurred_at, NEW.method, NEW.verification_result)
     IS DISTINCT FROM
     (OLD.center_id, OLD.staff_id, OLD.device_id, OLD.punch_type, OLD.occurred_at, OLD.method, OLD.verification_result) THEN
    RAISE EXCEPTION 'Punch records cannot be edited; void the punch and record a correction';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER punch_immutable_trg BEFORE UPDATE OR DELETE ON punch_events
  FOR EACH ROW EXECUTE FUNCTION punch_immutable();

-- Builds shifts, breaks, and room segments from accepted punches. Runs when a punch is accepted on arrival,
-- and again when a reviewer accepts a pending one.
CREATE FUNCTION punch_apply() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid;
BEGIN
  IF NEW.punch_type = 'clock_in' THEN
    INSERT INTO time_entries (staff_id, classroom_id, clock_in_at, clock_in_punch_id, source)
    VALUES (NEW.staff_id, NEW.classroom_id, NEW.occurred_at, NEW.id, 'punch')
    RETURNING id INTO v_entry;
    INSERT INTO time_entry_segments (time_entry_id, classroom_id, start_at)
    VALUES (v_entry, NEW.classroom_id, NEW.occurred_at);
    RETURN NEW;
  END IF;

  SELECT te.id INTO v_entry FROM time_entries te WHERE te.staff_id = NEW.staff_id AND te.clock_out_at IS NULL;
  IF v_entry IS NULL THEN
    RETURN NEW;                                   -- nothing is open; the sequence check has already flagged it
  END IF;

  IF NEW.punch_type = 'clock_out' THEN
    UPDATE time_entries SET clock_out_at = NEW.occurred_at, clock_out_punch_id = NEW.id WHERE id = v_entry;
    UPDATE time_entry_segments SET end_at = NEW.occurred_at WHERE time_entry_id = v_entry AND end_at IS NULL;
    UPDATE time_entry_breaks SET break_end_at = NEW.occurred_at WHERE time_entry_id = v_entry AND break_end_at IS NULL;
  ELSIF NEW.punch_type = 'break_start' THEN
    INSERT INTO time_entry_breaks (time_entry_id, break_start_at, is_paid)
    VALUES (v_entry, NEW.occurred_at,
            NOT coalesce((SELECT p.breaks_are_unpaid FROM time_policies p WHERE p.center_id = NEW.center_id), false));
  ELSIF NEW.punch_type = 'break_end' THEN
    UPDATE time_entry_breaks SET break_end_at = NEW.occurred_at WHERE time_entry_id = v_entry AND break_end_at IS NULL;
  ELSIF NEW.punch_type = 'room_change' THEN
    UPDATE time_entry_segments SET end_at = NEW.occurred_at WHERE time_entry_id = v_entry AND end_at IS NULL;
    INSERT INTO time_entry_segments (time_entry_id, classroom_id, start_at) VALUES (v_entry, NEW.classroom_id, NEW.occurred_at);
    UPDATE time_entries SET classroom_id = NEW.classroom_id WHERE id = v_entry;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER punch_apply_insert_trg AFTER INSERT ON punch_events
  FOR EACH ROW WHEN (NEW.status = 'accepted') EXECUTE FUNCTION punch_apply();
CREATE TRIGGER punch_apply_review_trg AFTER UPDATE OF status ON punch_events
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'accepted') EXECUTE FUNCTION punch_apply();

-- Any edit to a completed shift, or its deletion, is written to the audit log.
-- The application sets: SET LOCAL app.user_id = '<user uuid>'.
CREATE FUNCTION time_entries_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_log (center_id, user_id, action, table_name, record_id, before_data)
    VALUES ((SELECT s.center_id FROM staff s WHERE s.id = OLD.staff_id),
            nullif(current_setting('app.user_id', true), '')::uuid, 'delete', 'time_entries', OLD.id, to_jsonb(OLD));
    RETURN OLD;
  END IF;
  IF OLD.clock_out_at IS NOT NULL
     AND (OLD.clock_in_at, OLD.clock_out_at, OLD.classroom_id) IS DISTINCT FROM (NEW.clock_in_at, NEW.clock_out_at, NEW.classroom_id) THEN
    INSERT INTO audit_log (center_id, user_id, action, table_name, record_id, before_data, after_data)
    VALUES ((SELECT s.center_id FROM staff s WHERE s.id = NEW.staff_id),
            nullif(current_setting('app.user_id', true), '')::uuid, 'update', 'time_entries', NEW.id, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER time_entries_audit_trg AFTER UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION time_entries_audit();

-- Rules for a timesheet's life: open, submitted (the staff member confirms), approved (someone else), locked (payroll).
CREATE FUNCTION timesheet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'open' AND NEW.status = 'submitted')
         OR (OLD.status = 'submitted' AND NEW.status IN ('open','approved'))
         OR (OLD.status = 'approved' AND NEW.status IN ('submitted','locked'))) THEN
      RAISE EXCEPTION 'A timesheet cannot move from % to %', OLD.status, NEW.status;
    END IF;
    IF NEW.status = 'submitted' THEN
      NEW.staff_attested_at := now();
    END IF;
    IF NEW.status = 'approved' THEN
      IF NEW.has_open_entry OR NEW.has_pending_punches THEN
        RAISE EXCEPTION 'Resolve open shifts and pending punches before approving';
      END IF;
      IF NEW.approved_by IS NULL THEN
        RAISE EXCEPTION 'An approver is required';
      END IF;
      IF EXISTS (SELECT 1 FROM users u WHERE u.id = NEW.approved_by AND u.staff_id = NEW.staff_id) THEN
        RAISE EXCEPTION 'A timesheet cannot be approved by the person it belongs to';
      END IF;
      NEW.approved_at := now();
    END IF;
    IF NEW.status = 'locked' THEN
      NEW.locked_at := now();
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER timesheet_guard_trg BEFORE UPDATE OF status ON timesheets
  FOR EACH ROW EXECUTE FUNCTION timesheet_guard();

-- Build or rebuild a staff member's timesheet for a week from their completed shifts.
-- A shift belongs to the day it began (in the center's time zone). Hours are exact seconds.
CREATE FUNCTION build_timesheet(p_staff uuid, p_week_start date) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_center  uuid;
  v_tz      text;
  v_elig    boolean;
  v_over    integer;
  v_ts      uuid;
  v_status  timesheet_status;
  v_total   bigint;
  v_open    boolean;
  v_pending boolean;
BEGIN
  SELECT s.center_id, ce.timezone, s.overtime_eligible INTO v_center, v_tz, v_elig
  FROM staff s JOIN centers ce ON ce.id = s.center_id WHERE s.id = p_staff;
  IF v_center IS NULL THEN
    RAISE EXCEPTION 'Staff member % not found', p_staff;
  END IF;
  v_over := coalesce((SELECT tp.overtime_after_seconds FROM time_policies tp WHERE tp.center_id = v_center), 144000);

  SELECT t.id, t.status INTO v_ts, v_status FROM timesheets t WHERE t.staff_id = p_staff AND t.week_start = p_week_start;
  IF v_status IS NOT NULL AND v_status <> 'open' THEN
    RAISE EXCEPTION 'This timesheet is % and cannot be rebuilt; reopen it first', v_status;
  END IF;
  IF v_ts IS NULL THEN
    INSERT INTO timesheets (center_id, staff_id, week_start) VALUES (v_center, p_staff, p_week_start) RETURNING id INTO v_ts;
  END IF;

  DELETE FROM timesheet_days WHERE timesheet_id = v_ts;
  INSERT INTO timesheet_days (timesheet_id, work_date, entries, first_in, last_out, gross_seconds, unpaid_break_seconds, worked_seconds)
  SELECT v_ts, d.work_date, count(*), min(d.clock_in_at), max(d.clock_out_at),
         sum(d.gross), sum(d.unpaid), sum(d.gross - d.unpaid)
  FROM (
    SELECT (te.clock_in_at AT TIME ZONE v_tz)::date AS work_date, te.clock_in_at, te.clock_out_at,
           extract(epoch FROM te.clock_out_at - te.clock_in_at)::bigint AS gross,
           coalesce((SELECT sum(extract(epoch FROM b.break_end_at - b.break_start_at))
                     FROM time_entry_breaks b
                     WHERE b.time_entry_id = te.id AND NOT b.is_paid AND b.break_end_at IS NOT NULL), 0)::bigint AS unpaid
    FROM time_entries te
    WHERE te.staff_id = p_staff AND te.clock_out_at IS NOT NULL
      AND (te.clock_in_at AT TIME ZONE v_tz)::date BETWEEN p_week_start AND p_week_start + 6
  ) d
  GROUP BY d.work_date;

  SELECT coalesce(sum(td.worked_seconds), 0) INTO v_total FROM timesheet_days td WHERE td.timesheet_id = v_ts;

  SELECT EXISTS (SELECT 1 FROM time_entries te
                 WHERE te.staff_id = p_staff AND te.clock_out_at IS NULL
                   AND (te.clock_in_at AT TIME ZONE v_tz)::date BETWEEN p_week_start AND p_week_start + 6)
    INTO v_open;
  SELECT EXISTS (SELECT 1 FROM punch_events pe
                 WHERE pe.staff_id = p_staff AND pe.status = 'pending_review'
                   AND (pe.occurred_at AT TIME ZONE v_tz)::date BETWEEN p_week_start AND p_week_start + 6)
    INTO v_pending;

  UPDATE timesheets
     SET total_seconds = v_total,
         regular_seconds = v_total - CASE WHEN v_elig THEN greatest(v_total - v_over, 0) ELSE 0 END,
         overtime_seconds = CASE WHEN v_elig THEN greatest(v_total - v_over, 0) ELSE 0 END,
         has_open_entry = v_open, has_pending_punches = v_pending, generated_at = now()
   WHERE id = v_ts;
  RETURN v_ts;
END $$;

-- Approve a correction and apply it to the shifts. The reviewer must be someone other than the requester,
-- and an approved or locked week must be reopened first. The original punches are never changed.
CREATE FUNCTION apply_time_correction(p_id uuid, p_user uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  c        time_corrections%ROWTYPE;
  v_entry  uuid;
  v_tz     text;
  v_status timesheet_status;
BEGIN
  SELECT * INTO c FROM time_corrections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correction % not found', p_id;
  END IF;
  IF c.status <> 'pending' THEN
    RAISE EXCEPTION 'This correction is already %', c.status;
  END IF;
  IF c.requested_by = p_user THEN
    RAISE EXCEPTION 'A correction must be approved by someone other than the person who requested it';
  END IF;

  SELECT ce.timezone INTO v_tz FROM staff s JOIN centers ce ON ce.id = s.center_id WHERE s.id = c.staff_id;
  SELECT t.status INTO v_status FROM timesheets t
  WHERE t.staff_id = c.staff_id AND (c.requested_clock_in AT TIME ZONE v_tz)::date BETWEEN t.week_start AND t.week_start + 6;
  IF v_status IN ('approved','locked') THEN
    RAISE EXCEPTION 'That week is %; reopen the timesheet first', v_status;
  END IF;

  IF c.target_time_entry_id IS NULL THEN
    INSERT INTO time_entries (staff_id, classroom_id, clock_in_at, clock_out_at, source, note)
    VALUES (c.staff_id, c.classroom_id, c.requested_clock_in, c.requested_clock_out, 'correction', c.reason)
    RETURNING id INTO v_entry;
  ELSE
    UPDATE time_entries
       SET clock_in_at = c.requested_clock_in, clock_out_at = c.requested_clock_out,
           classroom_id = coalesce(c.classroom_id, classroom_id), source = 'correction', note = c.reason
     WHERE id = c.target_time_entry_id
    RETURNING id INTO v_entry;
  END IF;

  UPDATE time_corrections
     SET status = 'approved', reviewed_by = p_user, reviewed_at = now(), resulting_time_entry_id = v_entry
   WHERE id = p_id;
  RETURN v_entry;
END $$;

-- =====================================================================
-- VIEWS
-- =====================================================================

-- Who is clocked in right now.
CREATE VIEW v_who_is_clocked_in AS
SELECT s.center_id, s.id AS staff_id, s.first_name, s.last_name, te.classroom_id, te.clock_in_at,
       EXISTS (SELECT 1 FROM time_entry_breaks b WHERE b.time_entry_id = te.id AND b.break_end_at IS NULL) AS on_break,
       round(extract(epoch FROM now() - te.clock_in_at) / 60) AS minutes_on_shift
FROM time_entries te
JOIN staff s ON s.id = te.staff_id
WHERE te.clock_out_at IS NULL;

-- Scheduled shifts with no punch, and open shifts that ran long or past their scheduled end.
CREATE VIEW v_missing_punches AS
SELECT st.center_id, ss.staff_id, ss.work_date, ss.starts_at AS scheduled_time, 'missed_clock_in'::text AS problem
FROM staff_shifts ss
JOIN staff st ON st.id = ss.staff_id AND st.terminated_on IS NULL
JOIN centers ce ON ce.id = st.center_id
LEFT JOIN time_policies p ON p.center_id = ce.id
WHERE ss.work_date = (now() AT TIME ZONE ce.timezone)::date
  AND (now() AT TIME ZONE ce.timezone)::time >= ss.starts_at + make_interval(mins => coalesce(p.missed_clock_in_after_minutes, 15))
  AND NOT EXISTS (SELECT 1 FROM time_entries te
                  WHERE te.staff_id = ss.staff_id AND (te.clock_in_at AT TIME ZONE ce.timezone)::date = ss.work_date)
UNION ALL
SELECT st.center_id, te.staff_id, (te.clock_in_at AT TIME ZONE ce.timezone)::date, NULL::time, 'missed_clock_out'::text
FROM time_entries te
JOIN staff st ON st.id = te.staff_id
JOIN centers ce ON ce.id = st.center_id
LEFT JOIN time_policies p ON p.center_id = ce.id
WHERE te.clock_out_at IS NULL
  AND ((te.clock_in_at AT TIME ZONE ce.timezone)::date < (now() AT TIME ZONE ce.timezone)::date
       OR te.clock_in_at < now() - make_interval(hours => coalesce(p.long_shift_hours, 12))
       OR EXISTS (SELECT 1 FROM staff_shifts ss
                  WHERE ss.staff_id = te.staff_id AND ss.work_date = (now() AT TIME ZONE ce.timezone)::date
                    AND (now() AT TIME ZONE ce.timezone)::time >= ss.ends_at + make_interval(mins => coalesce(p.missed_clock_out_after_minutes, 30))));

-- The weekly hours report: exactly how many hours each person worked, and what is still unresolved.
CREATE VIEW v_weekly_hours_report AS
SELECT t.center_id, t.week_start, t.week_start + 6 AS week_end, t.staff_id, s.first_name, s.last_name, s.job_title,
       round(t.total_seconds / 3600.0, 2)    AS total_hours,
       round(t.regular_seconds / 3600.0, 2)  AS regular_hours,
       round(t.overtime_seconds / 3600.0, 2) AS overtime_hours,
       (SELECT count(*) FROM timesheet_days d WHERE d.timesheet_id = t.id) AS days_worked,
       t.status, t.has_open_entry, t.has_pending_punches,
       EXISTS (SELECT 1 FROM time_corrections c WHERE c.staff_id = t.staff_id AND c.status = 'pending') AS pending_corrections
FROM timesheets t
JOIN staff s ON s.id = t.staff_id;

-- Day-by-day detail behind each weekly total.
CREATE VIEW v_daily_hours AS
SELECT t.center_id, t.staff_id, t.week_start, d.work_date, d.entries, d.first_in, d.last_out,
       round(d.worked_seconds / 3600.0, 2) AS worked_hours,
       round(d.unpaid_break_seconds / 60.0) AS unpaid_break_minutes
FROM timesheet_days d
JOIN timesheets t ON t.id = d.timesheet_id;

-- Planned against actual, for lateness and unscheduled work.
CREATE VIEW v_scheduled_vs_actual AS
SELECT st.center_id, ss.staff_id, ss.work_date, ss.classroom_id, ss.starts_at, ss.ends_at,
       x.first_in_local, x.last_out_local,
       CASE WHEN x.first_in_local IS NULL THEN NULL
            ELSE greatest(round(extract(epoch FROM (x.first_in_local - ss.starts_at)) / 60), 0) END AS late_minutes
FROM staff_shifts ss
JOIN staff st ON st.id = ss.staff_id
JOIN centers ce ON ce.id = st.center_id
LEFT JOIN LATERAL (
  SELECT min((te.clock_in_at AT TIME ZONE ce.timezone)::time)  AS first_in_local,
         max((te.clock_out_at AT TIME ZONE ce.timezone)::time) AS last_out_local
  FROM time_entries te
  WHERE te.staff_id = ss.staff_id AND (te.clock_in_at AT TIME ZONE ce.timezone)::date = ss.work_date
) x ON true;

-- Punches waiting for a person to look at them.
CREATE VIEW v_punch_review_queue AS
SELECT pe.center_id, pe.id AS punch_id, pe.staff_id, s.first_name, s.last_name, pe.punch_type, pe.occurred_at,
       pe.method, pe.verification_result, pe.flag_reason, d.name AS device,
       round(extract(epoch FROM now() - pe.received_at) / 3600) AS hours_waiting
FROM punch_events pe
JOIN staff s ON s.id = pe.staff_id
LEFT JOIN time_devices d ON d.id = pe.device_id
WHERE pe.status = 'pending_review';

-- Face verification health by device over 30 days. A device with a high failure rate needs its camera or lighting checked.
CREATE VIEW v_verification_stats_by_device AS
SELECT pe.center_id, pe.device_id, d.name AS device,
       count(*) AS face_attempts,
       count(*) FILTER (WHERE pe.verification_result = 'verified') AS verified,
       count(*) FILTER (WHERE pe.verification_result <> 'verified') AS not_verified,
       round(100.0 * count(*) FILTER (WHERE pe.verification_result <> 'verified') / count(*), 1) AS failure_percent
FROM punch_events pe
LEFT JOIN time_devices d ON d.id = pe.device_id
WHERE pe.method = 'face' AND pe.occurred_at >= now() - interval '30 days'
GROUP BY pe.center_id, pe.device_id, d.name;

-- Where each person worked, by day, for cost allocation and to show ratio compliance later.
CREATE VIEW v_hours_by_room_day AS
SELECT st.center_id, seg.classroom_id, (seg.start_at AT TIME ZONE ce.timezone)::date AS work_date,
       round(sum(extract(epoch FROM seg.end_at - seg.start_at)) / 3600.0, 2) AS staff_hours
FROM time_entry_segments seg
JOIN time_entries te ON te.id = seg.time_entry_id
JOIN staff st ON st.id = te.staff_id
JOIN centers ce ON ce.id = st.center_id
WHERE seg.end_at IS NOT NULL
GROUP BY st.center_id, seg.classroom_id, (seg.start_at AT TIME ZONE ce.timezone)::date;

-- Biometric data that should be deleted: consent withdrawn, staff who have left, and old failure images.
CREATE VIEW v_biometric_deletions_due AS
SELECT 'template'::text AS kind, s.center_id, t.staff_id, t.id AS record_id,
       CASE WHEN t.deletion_requested_at IS NOT NULL THEN 'consent withdrawn or deletion requested'
            ELSE 'staff member left more than the retention period ago' END AS reason
FROM staff_biometric_templates t
JOIN staff s ON s.id = t.staff_id
LEFT JOIN time_policies p ON p.center_id = s.center_id
WHERE t.deleted_at IS NULL
  AND (t.deletion_requested_at IS NOT NULL
       OR (s.terminated_on IS NOT NULL
           AND s.terminated_on < current_date - coalesce(p.template_retention_days_after_exit, 30)))
UNION ALL
SELECT 'failure_image'::text, pe.center_id, pe.staff_id, pe.failure_image_document_id,
       'older than the failure image retention period'
FROM punch_events pe
JOIN documents doc ON doc.id = pe.failure_image_document_id
LEFT JOIN time_policies p ON p.center_id = pe.center_id
WHERE doc.uploaded_at < now() - make_interval(days => coalesce(p.failure_image_retention_days, 30));
