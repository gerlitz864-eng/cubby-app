-- =====================================================================
-- Cubby: migration 007 (PostgreSQL 14+)
-- Dual-track enrollment.
--   Track 1, current: enrollments, rosters, room moves, leave, withdrawal.
--   Track 2, future: inquiries, tours, applications, waitlist, offers, paperwork checklist,
--                    and conversion into an enrolled child.
--   Between them: scheduled transitions that happen automatically on a date.
-- Run after cubby_schema.sql and migrations 002 to 006.
--
-- As in earlier migrations, run the ALTER TYPE ... ADD VALUE statement first, commit, then run the rest.
--
-- Design decisions
--   * A prospective child is NOT a row in `children`. Until the child is enrolled they cannot appear in
--     rosters, meal counts, attendance, or ratios, and their data can be purged on a schedule.
--   * At conversion, a `children` row is created in status 'scheduled'. It has its allergies, contacts,
--     and paperwork on file before the first day, but stays off rosters until the start date.
--   * `v_active_roster` / `roster_on()` are the single source of "who is here." Attendance expectations,
--     meal services, and ratio checks should read from them, not from children.status.
-- =====================================================================

ALTER TYPE child_status ADD VALUE IF NOT EXISTS 'scheduled';   -- accepted and paperwork done, start date still ahead

CREATE TYPE pipeline_stage AS ENUM ('inquiry','tour_scheduled','toured','applied','waitlisted','offered','accepted',
                                    'ready_to_start','enrolled',
                                    'family_declined','center_declined','lost_contact','offer_expired');
CREATE TYPE inquiry_channel   AS ENUM ('phone','web_form','walk_in','referral','email','event','other');
CREATE TYPE inquiry_status    AS ENUM ('open','converted','closed');
CREATE TYPE tour_status       AS ENUM ('scheduled','completed','no_show','cancelled');
CREATE TYPE checklist_status  AS ENUM ('pending','received','verified','waived');
CREATE TYPE lead_event_type   AS ENUM ('created','stage_changed','note','call','email','sms','tour','offer_sent',
                                       'document_received','reminder_sent','waitlist_confirmed');
CREATE TYPE deposit_kind      AS ENUM ('registration_fee','deposit');
CREATE TYPE enrollment_status AS ENUM ('scheduled','active','on_leave','notice_given','withdrawn','cancelled');
CREATE TYPE withdrawal_reason AS ENUM ('moved','aged_out','cost','schedule_change','child_care_arrangement',
                                       'starting_school','program_ended','other');
CREATE TYPE transition_kind   AS ENUM ('start_enrollment','classroom_change','return_from_leave','end_enrollment');
CREATE TYPE transition_status AS ENUM ('proposed','planned','done','cancelled');
CREATE TYPE task_status       AS ENUM ('open','done','cancelled');

ALTER TABLE centers
  ADD COLUMN licensed_capacity        smallint,                    -- from your license
  ADD COLUMN prospect_retention_months smallint NOT NULL DEFAULT 12,   -- closed leads are anonymized after this
  ADD COLUMN offer_hold_days          smallint NOT NULL DEFAULT 7;     -- how long an offer stays open

-- ---------------------------------------------------------------------
-- Office tasks (follow-ups the system creates and people complete)
-- ---------------------------------------------------------------------
CREATE TABLE office_tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id          uuid NOT NULL REFERENCES centers(id),
  title              text NOT NULL,
  detail             text,
  related_table      text,
  related_id         uuid,
  assigned_to        uuid REFERENCES users(id),
  due_at             timestamptz,
  status             task_status NOT NULL DEFAULT 'open',
  created_by         uuid REFERENCES users(id),
  created_by_system  boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  completed_by       uuid REFERENCES users(id)
);
CREATE INDEX office_tasks_open_idx ON office_tasks (assigned_to, due_at) WHERE status = 'open';

-- =====================================================================
-- TRACK 2: THE FUTURE PIPELINE
-- =====================================================================

-- A family reaching out. One inquiry can cover several children (see enrollment_applications).
CREATE TABLE inquiries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id       uuid NOT NULL REFERENCES centers(id),
  received_at     timestamptz NOT NULL DEFAULT now(),
  channel         inquiry_channel NOT NULL,
  source_detail   text,                                 -- website page, referring family, event name
  status          inquiry_status NOT NULL DEFAULT 'open',
  assigned_to     uuid REFERENCES users(id),
  first_response_at timestamptz,                        -- used to measure how fast the office replies
  notes           text,
  closed_at       timestamptz,
  closed_reason   text,
  anonymized_at   timestamptz,
  created_by      uuid REFERENCES users(id)
);
CREATE INDEX inquiries_open_idx ON inquiries (center_id, status, received_at);

CREATE TABLE prospect_guardians (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id            uuid NOT NULL REFERENCES inquiries(id),
  first_name            text NOT NULL,
  last_name             text NOT NULL,
  relationship          text NOT NULL DEFAULT 'Parent',
  phone                 text,
  email                 text,
  is_primary            boolean NOT NULL DEFAULT false,
  preferred_contact     text,
  -- Consent to be contacted. Recorded with when and how it was given, so it can be proven later.
  consent_calls         boolean NOT NULL DEFAULT false,
  consent_sms           boolean NOT NULL DEFAULT false,
  consent_captured_at   timestamptz,
  consent_source        text,
  existing_guardian_id  uuid REFERENCES guardians(id),  -- a current family: reuse their guardian record
  created_guardian_id   uuid REFERENCES guardians(id)   -- set at conversion so siblings do not duplicate the guardian
);

-- One application per prospective child. This is the pipeline.
CREATE TABLE enrollment_applications (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id            uuid NOT NULL REFERENCES centers(id),
  inquiry_id           uuid NOT NULL REFERENCES inquiries(id),
  child_first_name     text NOT NULL,
  child_last_name      text NOT NULL,
  date_of_birth        date,
  expected_due_date    date,                            -- families often inquire before the baby is born
  desired_start_date   date,
  schedule_type        text,                            -- full_time, part_time, specific days
  desired_days         smallint[],                      -- 1 = Monday ... 7 = Sunday
  stage                pipeline_stage NOT NULL DEFAULT 'inquiry',
  stage_changed_at     timestamptz NOT NULL DEFAULT now(),
  assigned_to          uuid REFERENCES users(id),
  sibling_child_id     uuid REFERENCES children(id),    -- a current child in the same family (waitlist priority)
  waitlist_joined_at   timestamptz,
  last_confirmed_interest_at timestamptz,               -- waitlist check-in: "are you still interested?"
  offered_classroom_id uuid REFERENCES classrooms(id),
  offered_start_date   date,
  offered_at           timestamptz,
  offer_expires_at     timestamptz,
  accepted_at          timestamptz,
  decline_reason       text,
  converted_child_id   uuid UNIQUE REFERENCES children(id),
  converted_at         timestamptz,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (date_of_birth IS NOT NULL OR expected_due_date IS NOT NULL)
);
CREATE INDEX enrollment_applications_stage_idx ON enrollment_applications (center_id, stage, stage_changed_at);
CREATE INDEX enrollment_applications_inquiry_idx ON enrollment_applications (inquiry_id);

-- Which stage changes are allowed.
CREATE TABLE pipeline_transitions (
  from_stage  pipeline_stage NOT NULL,
  to_stage    pipeline_stage NOT NULL,
  PRIMARY KEY (from_stage, to_stage)
);
INSERT INTO pipeline_transitions (from_stage, to_stage) VALUES
  ('inquiry','tour_scheduled'), ('inquiry','applied'), ('inquiry','waitlisted'), ('inquiry','lost_contact'), ('inquiry','family_declined'),
  ('tour_scheduled','toured'), ('tour_scheduled','inquiry'), ('tour_scheduled','lost_contact'), ('tour_scheduled','family_declined'),
  ('toured','applied'), ('toured','waitlisted'), ('toured','lost_contact'), ('toured','family_declined'),
  ('applied','waitlisted'), ('applied','offered'), ('applied','center_declined'), ('applied','family_declined'), ('applied','lost_contact'),
  ('waitlisted','offered'), ('waitlisted','family_declined'), ('waitlisted','center_declined'), ('waitlisted','lost_contact'),
  ('offered','accepted'), ('offered','family_declined'), ('offered','offer_expired'), ('offered','waitlisted'),
  ('accepted','ready_to_start'), ('accepted','family_declined'), ('accepted','center_declined'),
  ('ready_to_start','enrolled'), ('ready_to_start','family_declined'),
  ('offer_expired','waitlisted'), ('offer_expired','offered'), ('offer_expired','family_declined'),
  ('lost_contact','inquiry'), ('family_declined','inquiry'), ('center_declined','inquiry');

CREATE TABLE application_events (                       -- timeline: every call, email, note, tour, and stage change
  id             bigserial PRIMARY KEY,
  application_id uuid REFERENCES enrollment_applications(id),
  inquiry_id     uuid REFERENCES inquiries(id),
  event          lead_event_type NOT NULL,
  from_stage     pipeline_stage,
  to_stage       pipeline_stage,
  actor_user_id  uuid REFERENCES users(id),
  note           text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (application_id IS NOT NULL OR inquiry_id IS NOT NULL)
);
CREATE INDEX application_events_idx ON application_events (application_id, occurred_at);

CREATE TABLE tours (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id      uuid NOT NULL REFERENCES inquiries(id),
  scheduled_at    timestamptz NOT NULL,
  conducted_by    uuid REFERENCES users(id),
  status          tour_status NOT NULL DEFAULT 'scheduled',
  attendees       text,
  notes           text,
  reminder_sent_at timestamptz
);
CREATE INDEX tours_upcoming_idx ON tours (scheduled_at) WHERE status = 'scheduled';

-- Waitlist order: first come, first served, with optional points you define and can defend.
-- Keep rules to things like a current sibling. Do not use characteristics protected by law.
CREATE TABLE waitlist_priority_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id  uuid NOT NULL REFERENCES centers(id),
  code       text NOT NULL,                             -- current_sibling, staff_child
  label      text NOT NULL,
  points     smallint NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (center_id, code)
);
CREATE TABLE application_priority_flags (
  application_id uuid NOT NULL REFERENCES enrollment_applications(id),
  rule_id        uuid NOT NULL REFERENCES waitlist_priority_rules(id),
  PRIMARY KEY (application_id, rule_id)
);

-- Health information gathered during the application, copied to the child at conversion.
CREATE TABLE application_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES enrollment_applications(id),
  kind            alert_kind NOT NULL,
  name            text NOT NULL,
  allergen_code   text REFERENCES allergens(code),
  severity        alert_severity NOT NULL,
  care_plan       text
);

-- Paperwork that must be in before the first day.
CREATE TABLE checklist_item_types (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id              uuid NOT NULL REFERENCES centers(id),
  code                   text NOT NULL,
  label                  text NOT NULL,
  is_required            boolean NOT NULL DEFAULT true,
  doc_type               document_type,
  due_days_before_start  smallint NOT NULL DEFAULT 7,
  sort_order             smallint NOT NULL DEFAULT 100,
  is_active              boolean NOT NULL DEFAULT true,
  UNIQUE (center_id, code)
);
CREATE TABLE application_checklist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES enrollment_applications(id),
  item_type_id    uuid NOT NULL REFERENCES checklist_item_types(id),
  status          checklist_status NOT NULL DEFAULT 'pending',
  due_date        date,
  document_id     uuid REFERENCES documents(id),
  received_at     timestamptz,
  verified_by     uuid REFERENCES users(id),
  verified_at     timestamptz,
  waived_reason   text,
  UNIQUE (application_id, item_type_id),
  CHECK (status <> 'waived' OR waived_reason IS NOT NULL)
);

CREATE TABLE application_deposits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES enrollment_applications(id),
  kind            deposit_kind NOT NULL,
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  received_on     date NOT NULL,
  method          payment_method NOT NULL,
  reference       text,
  is_refundable   boolean NOT NULL DEFAULT false,
  applied_to_invoice_line_id uuid REFERENCES invoice_lines(id),   -- credited to the first invoice after enrollment
  refunded_on     date
);

-- Documents collected before a child exists are attached to the application, then moved to the child.
ALTER TABLE documents ADD COLUMN application_id uuid REFERENCES enrollment_applications(id);

-- =====================================================================
-- TRACK 1: CURRENT ENROLLMENT
-- =====================================================================
CREATE TABLE enrollments (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id                   uuid NOT NULL REFERENCES centers(id),
  child_id                    uuid NOT NULL REFERENCES children(id),
  status                      enrollment_status NOT NULL DEFAULT 'scheduled',
  start_date                  date NOT NULL,
  leave_started_on            date,
  planned_return_on           date,
  notice_given_on             date,
  scheduled_end_date          date,                     -- last day, once notice is given
  end_date                    date,
  withdrawal_reason           withdrawal_reason,
  withdrawal_note             text,
  created_from_application_id uuid REFERENCES enrollment_applications(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date IS NULL OR end_date >= start_date)
);
-- A child has at most one open enrollment at a time. Returning later creates a new one.
CREATE UNIQUE INDEX enrollments_one_open ON enrollments (child_id)
  WHERE status IN ('scheduled','active','on_leave','notice_given');

CREATE TABLE enrollment_transitions (
  from_status  enrollment_status NOT NULL,
  to_status    enrollment_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO enrollment_transitions (from_status, to_status) VALUES
  ('scheduled','active'), ('scheduled','cancelled'),
  ('active','on_leave'), ('active','notice_given'), ('active','withdrawn'),
  ('on_leave','active'), ('on_leave','notice_given'), ('on_leave','withdrawn'),
  ('notice_given','active'), ('notice_given','withdrawn');

CREATE TABLE enrollment_events (
  id             bigserial PRIMARY KEY,
  enrollment_id  uuid NOT NULL REFERENCES enrollments(id),
  from_status    enrollment_status,
  to_status      enrollment_status NOT NULL,
  actor_user_id  uuid REFERENCES users(id),
  note           text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

-- Changes that happen on a future date. The system can propose them (a child aging into the next room);
-- a person confirms; the daily job carries them out.
CREATE TABLE scheduled_transitions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id          uuid NOT NULL REFERENCES centers(id),
  child_id           uuid NOT NULL REFERENCES children(id),
  kind               transition_kind NOT NULL,
  effective_date     date NOT NULL,
  to_classroom_id    uuid REFERENCES classrooms(id),
  reason             text,
  status             transition_status NOT NULL DEFAULT 'proposed',
  proposed_by_system boolean NOT NULL DEFAULT false,
  created_by         uuid REFERENCES users(id),
  confirmed_by       uuid REFERENCES users(id),
  confirmed_at       timestamptz,
  executed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'classroom_change' OR to_classroom_id IS NOT NULL)
);
CREATE INDEX scheduled_transitions_due_idx ON scheduled_transitions (effective_date) WHERE status = 'planned';

-- Existing children become enrollments.
INSERT INTO enrollments (center_id, child_id, status, start_date, end_date)
SELECT c.center_id, c.id,
       CASE c.status WHEN 'withdrawn' THEN 'withdrawn'::enrollment_status ELSE 'active'::enrollment_status END,
       coalesce(c.enrolled_on, least(c.created_at::date, coalesce(c.withdrawn_on, c.created_at::date))),
       CASE WHEN c.status = 'withdrawn' THEN c.withdrawn_on END
FROM children c
WHERE c.status IN ('active','withdrawn')
ON CONFLICT DO NOTHING;

-- =====================================================================
-- FUNCTIONS AND TRIGGERS
-- =====================================================================

-- Which classroom fits a child of a given age on a given date. Used for waitlist projection and age-up planning.
CREATE FUNCTION classroom_for_age(p_center uuid, p_dob date, p_on date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT c.id FROM classrooms c
  WHERE c.center_id = p_center AND c.is_active
    AND (extract(year FROM age(p_on, p_dob)) * 12 + extract(month FROM age(p_on, p_dob)))
        BETWEEN coalesce(c.min_age_months, 0) AND coalesce(c.max_age_months, 1200)
  ORDER BY c.min_age_months NULLS FIRST
  LIMIT 1
$$;

CREATE FUNCTION application_checklist_complete(p_app uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM application_checklist c
    JOIN checklist_item_types t ON t.id = c.item_type_id
    WHERE c.application_id = p_app AND t.is_required AND c.status NOT IN ('verified','waived')
  )
$$;

-- Guard for the pipeline: only allowed moves, and the facts each stage needs.
CREATE FUNCTION application_stage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage <> OLD.stage THEN
    IF NOT EXISTS (SELECT 1 FROM pipeline_transitions t WHERE t.from_stage = OLD.stage AND t.to_stage = NEW.stage) THEN
      RAISE EXCEPTION 'An application cannot move from % to %', OLD.stage, NEW.stage;
    END IF;
    IF NEW.stage = 'offered'
       AND (NEW.offered_classroom_id IS NULL OR NEW.offered_start_date IS NULL OR NEW.offer_expires_at IS NULL) THEN
      RAISE EXCEPTION 'An offer needs a classroom, a start date, and an expiry';
    END IF;
    IF NEW.stage = 'ready_to_start' AND NOT application_checklist_complete(NEW.id) THEN
      RAISE EXCEPTION 'Required enrollment paperwork is not complete';
    END IF;
    IF NEW.stage = 'waitlisted' THEN
      NEW.waitlist_joined_at := coalesce(NEW.waitlist_joined_at, now());   -- rejoining keeps the original place in line
    END IF;
    IF NEW.stage = 'offered' THEN
      NEW.offered_at := now();
    END IF;
    IF NEW.stage = 'accepted' THEN
      NEW.accepted_at := coalesce(NEW.accepted_at, now());
    END IF;
    NEW.stage_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_stage_guard_trg BEFORE UPDATE OF stage ON enrollment_applications
  FOR EACH ROW EXECUTE FUNCTION application_stage_guard();

-- After a stage change: write the timeline, and create the paperwork checklist when an offer is accepted.
-- The application sets: SET LOCAL app.user_id = '<user uuid>'.
CREATE FUNCTION application_stage_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.stage <> OLD.stage THEN
    INSERT INTO application_events (application_id, inquiry_id, event, from_stage, to_stage, actor_user_id, note)
    VALUES (NEW.id, NEW.inquiry_id, 'stage_changed', OLD.stage, NEW.stage,
            nullif(current_setting('app.user_id', true), '')::uuid, NEW.decline_reason);

    IF NEW.stage = 'accepted' THEN
      INSERT INTO application_checklist (application_id, item_type_id, due_date)
      SELECT NEW.id, t.id, coalesce(NEW.offered_start_date, current_date) - t.due_days_before_start
      FROM checklist_item_types t
      WHERE t.center_id = NEW.center_id AND t.is_active
      ON CONFLICT (application_id, item_type_id) DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_stage_after_trg AFTER UPDATE OF stage ON enrollment_applications
  FOR EACH ROW EXECUTE FUNCTION application_stage_after();

-- Guard for current enrollment.
CREATE FUNCTION enrollment_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM enrollment_transitions t WHERE t.from_status = OLD.status AND t.to_status = NEW.status) THEN
      RAISE EXCEPTION 'An enrollment cannot move from % to %', OLD.status, NEW.status;
    END IF;
    IF NEW.status IN ('withdrawn','cancelled') THEN
      NEW.end_date := coalesce(NEW.end_date, current_date);
    END IF;
    IF NEW.status = 'on_leave' THEN
      NEW.leave_started_on := coalesce(NEW.leave_started_on, current_date);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollment_status_guard_trg BEFORE UPDATE OF status ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollment_status_guard();

-- Keep children.status in step with the enrollment, and log the change.
-- (On leave still counts as 'active' on the child; the roster view is what excludes it.)
CREATE FUNCTION enrollment_after() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE children
     SET status = CASE NEW.status WHEN 'scheduled' THEN 'scheduled'::child_status
                                  WHEN 'withdrawn' THEN 'withdrawn'::child_status
                                  WHEN 'cancelled' THEN 'withdrawn'::child_status
                                  ELSE 'active'::child_status END,
         withdrawn_on = CASE WHEN NEW.status IN ('withdrawn','cancelled') THEN coalesce(NEW.end_date, current_date) END,
         enrolled_on  = CASE WHEN NEW.status = 'cancelled' THEN NULL ELSE coalesce(enrolled_on, NEW.start_date) END
   WHERE id = NEW.child_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO enrollment_events (enrollment_id, from_status, to_status, actor_user_id)
    VALUES (NEW.id, NULL, NEW.status, nullif(current_setting('app.user_id', true), '')::uuid);
  ELSIF NEW.status <> OLD.status THEN
    INSERT INTO enrollment_events (enrollment_id, from_status, to_status, actor_user_id)
    VALUES (NEW.id, OLD.status, NEW.status, nullif(current_setting('app.user_id', true), '')::uuid);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollment_after_trg AFTER INSERT OR UPDATE OF status ON enrollments
  FOR EACH ROW EXECUTE FUNCTION enrollment_after();

-- Move a child to another classroom from a date, keeping a clean history.
CREATE FUNCTION move_child_to_classroom(p_child uuid, p_classroom uuid, p_effective date) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE child_classroom_assignments
     SET valid_during = daterange(lower(valid_during), p_effective, '[)')
   WHERE child_id = p_child AND upper_inf(valid_during) AND lower(valid_during) < p_effective;
  INSERT INTO child_classroom_assignments (child_id, classroom_id, valid_during)
  VALUES (p_child, p_classroom, daterange(p_effective, NULL, '[)'));
END $$;

-- Carry out every planned transition that is due. Called daily, just after midnight in the center's time zone,
-- and again on demand. Returns how many were done.
CREATE FUNCTION execute_scheduled_transitions(p_center uuid, p_date date) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  n integer := 0;
BEGIN
  FOR t IN
    SELECT * FROM scheduled_transitions
    WHERE center_id = p_center AND status = 'planned' AND effective_date <= p_date
    ORDER BY effective_date, created_at
  LOOP
    IF t.kind = 'start_enrollment' THEN
      UPDATE enrollments SET status = 'active' WHERE child_id = t.child_id AND status = 'scheduled';
    ELSIF t.kind = 'classroom_change' THEN
      PERFORM move_child_to_classroom(t.child_id, t.to_classroom_id, t.effective_date);
    ELSIF t.kind = 'return_from_leave' THEN
      UPDATE enrollments SET status = 'active' WHERE child_id = t.child_id AND status = 'on_leave';
    ELSIF t.kind = 'end_enrollment' THEN
      UPDATE enrollments SET status = 'withdrawn', end_date = t.effective_date
       WHERE child_id = t.child_id AND status IN ('active','notice_given','on_leave');
      UPDATE child_classroom_assignments
         SET valid_during = daterange(lower(valid_during), t.effective_date, '[)')
       WHERE child_id = t.child_id AND upper_inf(valid_during) AND lower(valid_during) < t.effective_date;
    END IF;
    UPDATE scheduled_transitions SET status = 'done', executed_at = now() WHERE id = t.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Turn an application that is ready to start into a real child, guardians, room, and scheduled start.
-- The child is created as 'scheduled': paperwork, allergies, and contacts are on file, but they stay off rosters
-- until the start date.
CREATE FUNCTION convert_application(p_app uuid, p_user uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  a          enrollment_applications%ROWTYPE;
  g          record;
  v_child    uuid;
  v_account  uuid;
  v_family   text;
  v_guardian uuid;
BEGIN
  SELECT * INTO a FROM enrollment_applications WHERE id = p_app FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Application % not found', p_app;
  END IF;
  IF a.stage <> 'ready_to_start' THEN
    RAISE EXCEPTION 'Application must be ready_to_start (it is %)', a.stage;
  END IF;
  IF a.date_of_birth IS NULL THEN
    RAISE EXCEPTION 'Enter the child''s date of birth before enrolling';
  END IF;
  IF a.offered_classroom_id IS NULL OR a.offered_start_date IS NULL THEN
    RAISE EXCEPTION 'The application has no classroom or start date';
  END IF;

  -- Reuse the family's billing account: a current sibling, or a sibling already converted from the same inquiry.
  IF a.sibling_child_id IS NOT NULL THEN
    SELECT billing_account_id INTO v_account FROM children WHERE id = a.sibling_child_id;
  END IF;
  IF v_account IS NULL THEN
    SELECT c.billing_account_id INTO v_account
    FROM enrollment_applications x JOIN children c ON c.id = x.converted_child_id
    WHERE x.inquiry_id = a.inquiry_id AND x.converted_child_id IS NOT NULL
    LIMIT 1;
  END IF;
  IF v_account IS NULL THEN
    SELECT pg.last_name INTO v_family FROM prospect_guardians pg
    WHERE pg.inquiry_id = a.inquiry_id ORDER BY pg.is_primary DESC LIMIT 1;
    INSERT INTO billing_accounts (center_id, family_name)
    VALUES (a.center_id, coalesce(v_family, a.child_last_name)) RETURNING id INTO v_account;
  END IF;

  INSERT INTO children (center_id, billing_account_id, first_name, last_name, date_of_birth, status, enrolled_on)
  VALUES (a.center_id, v_account, a.child_first_name, a.child_last_name, a.date_of_birth, 'scheduled', a.offered_start_date)
  RETURNING id INTO v_child;

  FOR g IN SELECT * FROM prospect_guardians WHERE inquiry_id = a.inquiry_id ORDER BY is_primary DESC, id LOOP
    v_guardian := coalesce(g.existing_guardian_id, g.created_guardian_id);
    IF v_guardian IS NULL THEN
      INSERT INTO guardians (center_id, first_name, last_name, email, phone_mobile)
      VALUES (a.center_id, g.first_name, g.last_name, g.email, g.phone)
      RETURNING id INTO v_guardian;
      -- Consent is carried over only when there is a record of when it was given.
      INSERT INTO guardian_communication_prefs (guardian_id, voice_consent, sms_consent, consent_captured_at, consent_source)
      VALUES (v_guardian, g.consent_calls AND g.consent_captured_at IS NOT NULL,
              g.consent_sms AND g.consent_captured_at IS NOT NULL, g.consent_captured_at, g.consent_source);
      UPDATE prospect_guardians SET created_guardian_id = v_guardian WHERE id = g.id;
    END IF;
    INSERT INTO child_guardians (child_id, guardian_id, relationship, is_primary, is_billing_responsible)
    VALUES (v_child, v_guardian, g.relationship, g.is_primary, g.is_primary)
    ON CONFLICT DO NOTHING;
  END LOOP;

  INSERT INTO child_classroom_assignments (child_id, classroom_id, valid_during)
  VALUES (v_child, a.offered_classroom_id, daterange(a.offered_start_date, NULL, '[)'));

  INSERT INTO child_alerts (child_id, kind, name, allergen_code, severity, care_plan)
  SELECT v_child, kind, name, allergen_code, severity, care_plan
  FROM application_alerts WHERE application_id = p_app;

  UPDATE documents SET child_id = v_child WHERE application_id = p_app;

  INSERT INTO enrollments (center_id, child_id, status, start_date, created_from_application_id)
  VALUES (a.center_id, v_child, 'scheduled', a.offered_start_date, p_app);

  INSERT INTO scheduled_transitions (center_id, child_id, kind, effective_date, to_classroom_id, status, created_by)
  VALUES (a.center_id, v_child, 'start_enrollment', a.offered_start_date, a.offered_classroom_id, 'planned', p_user);

  UPDATE enrollment_applications
     SET stage = 'enrolled', converted_child_id = v_child, converted_at = now()
   WHERE id = p_app;

  RETURN v_child;
END $$;

-- Default paperwork list for a new center. Confirm required health and immunization forms with NJ licensing.
CREATE FUNCTION seed_default_enrollment_checklist(p_center uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO checklist_item_types (center_id, code, label, is_required, doc_type, due_days_before_start, sort_order) VALUES
    (p_center, 'enrollment_form',       'Enrollment form',                                  true,  'enrollment_form', 14, 10),
    (p_center, 'tuition_agreement',     'Tuition agreement signed',                         true,  'enrollment_form', 14, 20),
    (p_center, 'deposit',               'Deposit or registration fee received',             true,  NULL,              14, 30),
    (p_center, 'immunization_record',   'Immunization record',                              true,  'immunization',    7,  40),
    (p_center, 'health_form',           'Health or physical form',                          true,  'other',           7,  50),
    (p_center, 'emergency_contacts',    'Emergency contacts',                               true,  NULL,              7,  60),
    (p_center, 'authorized_pickup',     'Authorized pick-up list',                          true,  NULL,              7,  70),
    (p_center, 'communication_consent', 'Consent for calls and texts (attendance alerts)',  true,  'enrollment_form', 7,  80),
    (p_center, 'photo_consent',         'Photo consent decision',                           true,  'enrollment_form', 7,  90),
    (p_center, 'meal_program_form',     'Meal program eligibility form',                    true,  'eligibility_form',7,  100),
    (p_center, 'allergy_action_plan',   'Allergy or medical action plan (if any)',          false, 'medical_statement',7, 110),
    (p_center, 'handbook_ack',          'Parent handbook acknowledged',                     false, 'other',           7,  120)
  ON CONFLICT (center_id, code) DO NOTHING;
$$;

-- =====================================================================
-- VIEWS
-- =====================================================================

-- Who is on the active roster on a given date, in which room. Excludes scheduled starts, children on leave, and withdrawn.
-- Pass the center's local date, not the server's.
CREATE FUNCTION roster_on(p_center uuid, p_date date)
RETURNS TABLE (child_id uuid, first_name text, last_name text, date_of_birth date, classroom_id uuid,
               enrollment_status enrollment_status, last_day date)
LANGUAGE sql STABLE AS $$
  SELECT c.id, c.first_name, c.last_name, c.date_of_birth, a.classroom_id, e.status,
         coalesce(e.end_date, e.scheduled_end_date)
  FROM children c
  JOIN enrollments e ON e.child_id = c.id
   AND e.status IN ('active','notice_given')
   AND e.start_date <= p_date
   AND (coalesce(e.end_date, e.scheduled_end_date) IS NULL OR coalesce(e.end_date, e.scheduled_end_date) >= p_date)
  JOIN child_classroom_assignments a ON a.child_id = c.id AND a.valid_during @> p_date
  WHERE c.center_id = p_center
$$;

CREATE VIEW v_active_roster AS
SELECT c.center_id, c.id AS child_id, c.first_name, c.last_name, c.date_of_birth, a.classroom_id,
       e.status AS enrollment_status, e.start_date, coalesce(e.end_date, e.scheduled_end_date) AS last_day
FROM children c
JOIN enrollments e ON e.child_id = c.id AND e.status IN ('active','notice_given')
JOIN child_classroom_assignments a ON a.child_id = c.id AND a.valid_during @> current_date;

-- Pipeline at a glance.
CREATE VIEW v_pipeline_summary AS
SELECT center_id, stage, count(*) AS applications, min(stage_changed_at) AS oldest_in_stage
FROM enrollment_applications
GROUP BY center_id, stage;

-- The waitlist, projected into the classroom each child will fit by their desired start date.
CREATE VIEW v_waitlist AS
SELECT y.*,
       row_number() OVER (PARTITION BY y.projected_classroom_id
                          ORDER BY y.priority_points DESC, y.waitlist_joined_at) AS position
FROM (
  SELECT ap.id AS application_id, ap.center_id, ap.child_first_name, ap.child_last_name, ap.desired_start_date,
         ap.waitlist_joined_at, ap.last_confirmed_interest_at,
         classroom_for_age(ap.center_id, coalesce(ap.date_of_birth, ap.expected_due_date),
                           coalesce(ap.desired_start_date, current_date)) AS projected_classroom_id,
         coalesce((SELECT sum(r.points) FROM application_priority_flags f
                   JOIN waitlist_priority_rules r ON r.id = f.rule_id AND r.is_active
                   WHERE f.application_id = ap.id), 0) AS priority_points
  FROM enrollment_applications ap
  WHERE ap.stage = 'waitlisted'
) y;

-- Capacity by classroom for the next 12 months: who will be there, and how many spots are open or held by offers.
-- This counts heads. If part-time schedules matter, extend it with child_schedules to count by day of week.
CREATE VIEW v_classroom_capacity_forecast AS
SELECT z.*, z.capacity - z.enrolled - z.pending_offers AS open_spots
FROM (
  SELECT c.center_id, c.id AS classroom_id, c.name AS classroom, m.month_start, c.max_group_size AS capacity,
         (SELECT count(*) FROM child_classroom_assignments a
            JOIN enrollments e ON e.child_id = a.child_id
             AND e.status IN ('scheduled','active','on_leave','notice_given')
             AND e.start_date <= m.month_start
             AND (coalesce(e.end_date, e.scheduled_end_date) IS NULL OR coalesce(e.end_date, e.scheduled_end_date) > m.month_start)
           WHERE a.classroom_id = c.id AND a.valid_during @> m.month_start) AS enrolled,
         (SELECT count(*) FROM enrollment_applications ap
           WHERE ap.offered_classroom_id = c.id AND ap.stage IN ('offered','accepted','ready_to_start')
             AND ap.offered_start_date <= m.month_start) AS pending_offers
  FROM classrooms c
  CROSS JOIN LATERAL (
    SELECT g::date AS month_start
    FROM generate_series(date_trunc('month', current_date), date_trunc('month', current_date) + interval '11 months', interval '1 month') g
  ) m
  WHERE c.is_active AND c.max_group_size IS NOT NULL
) z;

-- Waitlisted families next in line for a room that will have an opening within about three months.
-- The system suggests; a person decides and sends the offer.
CREATE VIEW v_offer_candidates AS
SELECT w.center_id, w.application_id, w.child_first_name, w.child_last_name, w.projected_classroom_id AS classroom_id,
       w.position, w.waitlist_joined_at, f.month_start, f.open_spots
FROM v_waitlist w
JOIN v_classroom_capacity_forecast f
  ON f.classroom_id = w.projected_classroom_id
 AND f.month_start <= date_trunc('month', current_date + interval '3 months')::date
 AND f.open_spots > 0
WHERE w.position <= f.open_spots;

CREATE VIEW v_expiring_offers AS
SELECT ap.center_id, ap.id AS application_id, ap.child_first_name, ap.child_last_name, ap.offer_expires_at,
       ap.offer_expires_at - now() AS time_left
FROM enrollment_applications ap
WHERE ap.stage = 'offered' AND ap.offer_expires_at < now() + interval '3 days';

-- Applications that have sat in a stage too long.
CREATE VIEW v_stalled_applications AS
SELECT ap.center_id, ap.id AS application_id, ap.child_first_name, ap.child_last_name, ap.stage, ap.stage_changed_at, ap.assigned_to,
       extract(day FROM now() - ap.stage_changed_at)::int AS days_in_stage
FROM enrollment_applications ap
WHERE ap.stage IN ('inquiry','tour_scheduled','toured','applied','accepted','ready_to_start')
  AND ap.stage_changed_at < now() - CASE ap.stage
        WHEN 'inquiry' THEN interval '2 days'
        WHEN 'tour_scheduled' THEN interval '1 day'
        WHEN 'toured' THEN interval '3 days'
        WHEN 'applied' THEN interval '7 days'
        WHEN 'accepted' THEN interval '10 days'
        ELSE interval '7 days' END;

-- The same phone or email on more than one open inquiry.
CREATE VIEW v_possible_duplicate_inquiries AS
SELECT i.center_id, lower(coalesce(pg.email, pg.phone)) AS contact_key, count(DISTINCT i.id) AS inquiries, array_agg(DISTINCT i.id) AS inquiry_ids
FROM prospect_guardians pg
JOIN inquiries i ON i.id = pg.inquiry_id AND i.status = 'open'
WHERE coalesce(pg.email, pg.phone) IS NOT NULL
GROUP BY i.center_id, lower(coalesce(pg.email, pg.phone))
HAVING count(DISTINCT i.id) > 1;

-- Children who start within two weeks, and what is still missing on the safety side before day one.
CREATE VIEW v_starting_soon AS
SELECT e.center_id, e.child_id, c.first_name, c.last_name, e.start_date, a.classroom_id,
       (SELECT count(*) FROM child_alerts ca WHERE ca.child_id = c.id AND ca.is_active) AS active_alerts,
       (SELECT count(*) FROM child_alerts ca
         WHERE ca.child_id = c.id AND ca.is_active AND ca.kind = 'allergy' AND ca.medical_statement_id IS NULL) AS allergies_without_statement,
       EXISTS (SELECT 1 FROM child_guardians cg WHERE cg.child_id = c.id) AS has_guardian,
       EXISTS (SELECT 1 FROM child_contacts cc WHERE cc.child_id = c.id AND cc.role = 'emergency') AS has_emergency_contact,
       EXISTS (SELECT 1 FROM child_contacts cc WHERE cc.child_id = c.id AND cc.role = 'authorized_pickup')
         OR EXISTS (SELECT 1 FROM child_guardians cg WHERE cg.child_id = c.id AND cg.can_pick_up) AS has_pickup_person,
       EXISTS (SELECT 1 FROM eligibility_determinations ed
               WHERE ed.child_id = c.id AND ed.expires_on > e.start_date) AS has_meal_program_eligibility
FROM enrollments e
JOIN children c ON c.id = e.child_id
LEFT JOIN child_classroom_assignments a ON a.child_id = c.id AND a.valid_during @> e.start_date
WHERE e.status = 'scheduled' AND e.start_date <= current_date + 14;

-- Children who will outgrow their room by the first of next month, with the room that fits, for a person to confirm.
CREATE VIEW v_upcoming_age_transitions AS
SELECT q.*
FROM (
  SELECT r.center_id, r.child_id, r.first_name, r.last_name, r.classroom_id AS from_classroom_id,
         classroom_for_age(r.center_id, r.date_of_birth, d.move_date) AS to_classroom_id, d.move_date
  FROM v_active_roster r
  JOIN classrooms c ON c.id = r.classroom_id AND c.max_age_months IS NOT NULL
  CROSS JOIN LATERAL (SELECT (date_trunc('month', current_date) + interval '1 month')::date AS move_date) d
  WHERE (extract(year FROM age(d.move_date, r.date_of_birth)) * 12 + extract(month FROM age(d.move_date, r.date_of_birth))) > c.max_age_months
    AND NOT EXISTS (SELECT 1 FROM scheduled_transitions st
                    WHERE st.child_id = r.child_id AND st.kind = 'classroom_change' AND st.status IN ('proposed','planned'))
) q
WHERE q.to_classroom_id IS NOT NULL AND q.to_classroom_id IS DISTINCT FROM q.from_classroom_id;

-- Closed leads past the retention period, to be anonymized by the purge job.
CREATE VIEW v_prospects_due_for_purge AS
SELECT i.id AS inquiry_id, i.center_id, i.closed_at
FROM inquiries i
JOIN centers ce ON ce.id = i.center_id
WHERE i.status = 'closed' AND i.anonymized_at IS NULL
  AND i.closed_at < now() - make_interval(months => ce.prospect_retention_months);
