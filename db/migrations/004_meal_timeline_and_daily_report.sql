-- =====================================================================
-- Cubby: migration 004 (PostgreSQL 14+)
-- Timed meal tracking, daily activity logs, photos, and the parent daily report.
-- Run after cubby_schema.sql, migration 002, and migration 003.
-- =====================================================================

CREATE TYPE meal_update_pref  AS ENUM ('realtime','end_of_day','off');
CREATE TYPE daily_entry_type  AS ENUM ('nap','diaper','potty','milestone','note','mood');
CREATE TYPE bathroom_result   AS ENUM ('wet','dirty','wet_and_dirty','dry','potty_success','potty_accident','potty_tried');
CREATE TYPE report_status     AS ENUM ('draft','published');
CREATE TYPE report_category   AS ENUM ('meal','nap','diaper','potty','milestone','note','mood','photo');

-- ---------------------------------------------------------------------
-- Settings on existing tables
-- ---------------------------------------------------------------------
ALTER TABLE centers
  ADD COLUMN daily_report_draft_time   time NOT NULL DEFAULT '15:30',   -- drafts are built and teachers are asked to review
  ADD COLUMN daily_report_publish_time time NOT NULL DEFAULT '17:00';   -- reports marked ready are published and sent

ALTER TABLE guardian_communication_prefs
  ADD COLUMN meal_updates meal_update_pref NOT NULL DEFAULT 'end_of_day';

-- A family can choose which guardian receives the daily report (for example, in shared-custody arrangements).
ALTER TABLE child_guardians
  ADD COLUMN receive_daily_reports boolean NOT NULL DEFAULT true;

-- "When did the child eat?" is separate from "when did the teacher record it?".
-- The gap between the two is reported, because records written well after the fact are weaker evidence in an audit.
ALTER TABLE child_meal_records
  ADD COLUMN ate_at timestamptz,
  ADD COLUMN share_with_parents boolean NOT NULL DEFAULT true;
UPDATE child_meal_records SET ate_at = recorded_at WHERE ate_at IS NULL;
ALTER TABLE child_meal_records
  ALTER COLUMN ate_at SET NOT NULL,
  ALTER COLUMN ate_at SET DEFAULT now();
CREATE INDEX child_meal_records_ate_idx ON child_meal_records (child_id, ate_at);

ALTER TABLE infant_feedings
  ADD COLUMN share_with_parents boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------
-- Food outside the meal program: second helpings, a birthday cupcake, a snack a parent sent in.
-- Never counted toward a state claim, but parents still see it in the timeline.
-- ---------------------------------------------------------------------
CREATE TABLE child_food_events (
  id                  uuid PRIMARY KEY,                    -- client-generated
  center_id           uuid NOT NULL REFERENCES centers(id),
  child_id            uuid NOT NULL REFERENCES children(id),
  classroom_id        uuid REFERENCES classrooms(id),
  ate_at              timestamptz NOT NULL DEFAULT now(),
  description         text NOT NULL,
  food_item_id        uuid REFERENCES food_items(id),
  amount_eaten        amount_eaten,
  supplied_by         supplied_by NOT NULL DEFAULT 'center',
  share_with_parents  boolean NOT NULL DEFAULT true,
  recorded_by         uuid REFERENCES staff(id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  notes               text                                 -- staff-only
);
CREATE INDEX child_food_events_child_idx ON child_food_events (child_id, ate_at);

-- ---------------------------------------------------------------------
-- Daily activity log: naps, diapers, potty, milestones, notes, mood
-- ---------------------------------------------------------------------
CREATE TABLE daily_log_entries (
  id                  uuid PRIMARY KEY,                    -- client-generated
  center_id           uuid NOT NULL REFERENCES centers(id),
  child_id            uuid NOT NULL REFERENCES children(id),
  classroom_id        uuid REFERENCES classrooms(id),
  entry_type          daily_entry_type NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,                         -- naps
  bathroom_result     bathroom_result,
  note                text,
  share_with_parents  boolean NOT NULL DEFAULT true,
  recorded_by         uuid REFERENCES staff(id),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR ended_at >= occurred_at),
  CHECK (entry_type NOT IN ('diaper','potty') OR bathroom_result IS NOT NULL)
);
CREATE INDEX daily_log_entries_child_idx ON daily_log_entries (child_id, occurred_at);

-- ---------------------------------------------------------------------
-- Photos. A photo can include several children; each child's sharing is controlled separately.
-- The app checks children.photo_consent before a photo can be shared.
-- ---------------------------------------------------------------------
CREATE TABLE photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id    uuid NOT NULL REFERENCES centers(id),
  document_id  uuid NOT NULL REFERENCES documents(id),     -- file lives in object storage
  taken_at     timestamptz NOT NULL DEFAULT now(),
  taken_by     uuid REFERENCES staff(id),
  caption      text,
  reviewed_by  uuid REFERENCES users(id),
  reviewed_at  timestamptz
);
CREATE TABLE photo_children (
  photo_id            uuid NOT NULL REFERENCES photos(id),
  child_id            uuid NOT NULL REFERENCES children(id),
  share_with_parents  boolean NOT NULL DEFAULT true,
  PRIMARY KEY (photo_id, child_id)
);

-- ---------------------------------------------------------------------
-- The daily report
-- Live entries stay editable during the day. Publishing freezes a snapshot (daily_report_lines),
-- so what a parent saw on a given day can always be shown again. A correction creates a new version;
-- parents keep seeing the last published version until the corrected one is published.
-- ---------------------------------------------------------------------
CREATE TABLE daily_reports (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id          uuid NOT NULL REFERENCES centers(id),
  child_id           uuid NOT NULL REFERENCES children(id),
  report_date        date NOT NULL,
  status             report_status NOT NULL DEFAULT 'draft',
  version            integer NOT NULL DEFAULT 1,
  published_version  integer,
  teacher_note       text,
  generated_at       timestamptz NOT NULL DEFAULT now(),
  ready_at           timestamptz,                           -- teacher confirmed the day is complete
  ready_by           uuid REFERENCES staff(id),
  published_at       timestamptz,
  published_by       uuid REFERENCES users(id),
  first_viewed_at    timestamptz,
  UNIQUE (child_id, report_date)
);

CREATE TABLE daily_report_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id     uuid NOT NULL REFERENCES daily_reports(id),
  version       integer NOT NULL,
  occurred_at   timestamptz NOT NULL,
  category      report_category NOT NULL,
  title         text NOT NULL,
  detail        text,
  amount_eaten  amount_eaten,
  source_type   text NOT NULL,                              -- meal_record, infant_feeding, food_event, daily_log, photo
  source_id     uuid
);
CREATE INDEX daily_report_lines_idx ON daily_report_lines (report_id, version, occurred_at);

CREATE TABLE daily_report_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id        uuid NOT NULL REFERENCES daily_reports(id),
  version          integer NOT NULL,
  guardian_id      uuid NOT NULL REFERENCES guardians(id),
  channel          notify_channel NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,                    -- report + version + guardian + channel
  status           message_status NOT NULL DEFAULT 'queued',
  sent_at          timestamptz,
  opened_at        timestamptz,
  error            text
);

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------

-- Everything a parent may see about eating, in time order. It deliberately leaves out
-- eligibility category, claim status, and staff-only notes.
CREATE VIEW v_parent_eating_timeline AS
SELECT ms.center_id, r.child_id, r.ate_at,
       CASE ms.meal_type WHEN 'breakfast' THEN 'Breakfast' WHEN 'am_snack' THEN 'Morning snack'
                         WHEN 'lunch' THEN 'Lunch' WHEN 'pm_snack' THEN 'Afternoon snack'
                         WHEN 'supper' THEN 'Supper' ELSE 'Evening snack' END AS label,
       CASE WHEN r.status = 'declined' THEN 'Did not eat' ELSE coalesce(items.description, '') END AS description,
       r.overall_amount_eaten AS amount_eaten,
       'meal_record'::text AS source_type, r.id AS source_id
FROM child_meal_records r
JOIN meal_services ms ON ms.id = r.meal_service_id
LEFT JOIN LATERAL (
  SELECT string_agg(fi.name || ' (' || cmi.amount_eaten::text || ')', ', ' ORDER BY fi.name) AS description
  FROM child_meal_items cmi
  JOIN food_items fi ON fi.id = cmi.food_item_id
  WHERE cmi.child_meal_record_id = r.id
) items ON true
WHERE r.status IN ('served','declined')
  AND r.share_with_parents
  AND NOT EXISTS (SELECT 1 FROM infant_feedings f2                  -- infants are shown through their feedings instead
                  WHERE f2.meal_service_id = r.meal_service_id AND f2.child_id = r.child_id)
UNION ALL
SELECT f.center_id, f.child_id, f.fed_at,
       CASE f.feeding_type WHEN 'breast_milk' THEN 'Breast milk' WHEN 'formula' THEN 'Bottle'
                           WHEN 'solid' THEN 'Solid food' ELSE 'Feeding' END,
       concat_ws(', ', CASE WHEN f.amount_oz IS NOT NULL THEN f.amount_oz::text || ' oz' END, fi.name),
       NULL::amount_eaten,
       'infant_feeding'::text, f.id
FROM infant_feedings f
LEFT JOIN food_items fi ON fi.id = f.food_item_id
WHERE f.share_with_parents
UNION ALL
SELECT e.center_id, e.child_id, e.ate_at, 'Extra food'::text,
       e.description,
       e.amount_eaten,
       'food_event'::text, e.id
FROM child_food_events e
WHERE e.share_with_parents;

-- What a parent sees in the portal: the last published version of the day's report.
CREATE VIEW v_parent_daily_report AS
SELECT dr.child_id, dr.report_date, dr.teacher_note, l.occurred_at, l.category, l.title, l.detail, l.amount_eaten
FROM daily_reports dr
JOIN daily_report_lines l ON l.report_id = dr.id AND l.version = dr.published_version
WHERE dr.published_version IS NOT NULL;

-- Present children whose meals have not all been logged, so teachers can finish before publishing.
CREATE VIEW v_daily_report_readiness AS
SELECT x.*, greatest(x.meals_while_present - x.meals_logged, 0) AS meals_missing
FROM (
  SELECT ar.center_id, ar.child_id, ar.classroom_id, ar.service_date,
         (SELECT count(*) FROM meal_services ms
           WHERE ms.classroom_id = ar.classroom_id AND ms.service_date = ar.service_date
             AND ms.served_at IS NOT NULL
             AND (ar.checked_in_at  IS NULL OR ms.served_at >= ar.checked_in_at)
             AND (ar.checked_out_at IS NULL OR ms.served_at <= ar.checked_out_at)) AS meals_while_present,
         (SELECT count(*) FROM child_meal_records r
            JOIN meal_services ms ON ms.id = r.meal_service_id
           WHERE r.child_id = ar.child_id AND ms.service_date = ar.service_date
             AND r.status <> 'not_present') AS meals_logged,
         dr.status AS report_status, dr.ready_at
  FROM attendance_records ar
  LEFT JOIN daily_reports dr ON dr.child_id = ar.child_id AND dr.report_date = ar.service_date
  WHERE ar.status = 'present'
) x;

-- Meals recorded long after they were eaten, for the director's quality review.
CREATE VIEW v_late_meal_entries AS
SELECT ms.center_id, r.child_id, r.id AS child_meal_record_id, r.ate_at, r.recorded_at, r.recorded_by,
       (r.recorded_at - r.ate_at) AS delay
FROM child_meal_records r
JOIN meal_services ms ON ms.id = r.meal_service_id
WHERE r.recorded_at - r.ate_at > interval '30 minutes';

-- ---------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------

-- Build (or rebuild) the draft report for a child and day from the live entries.
-- Raises an error if the current version is already published; correct a published day by
-- raising daily_reports.version and setting status back to 'draft' first.
CREATE FUNCTION build_daily_report(p_child uuid, p_date date) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_center  uuid;
  v_tz      text;
  v_report  uuid;
  v_version integer;
BEGIN
  SELECT c.center_id, ce.timezone INTO v_center, v_tz
  FROM children c JOIN centers ce ON ce.id = c.center_id
  WHERE c.id = p_child;

  INSERT INTO daily_reports (center_id, child_id, report_date)
  VALUES (v_center, p_child, p_date)
  ON CONFLICT (child_id, report_date)
  DO UPDATE SET generated_at = now() WHERE daily_reports.status = 'draft'
  RETURNING id, version INTO v_report, v_version;

  IF v_report IS NULL THEN
    RAISE EXCEPTION 'Report for % on % is already published; start a new version to correct it', p_child, p_date;
  END IF;

  DELETE FROM daily_report_lines WHERE report_id = v_report AND version = v_version;

  INSERT INTO daily_report_lines (report_id, version, occurred_at, category, title, detail, amount_eaten, source_type, source_id)
  SELECT v_report, v_version, t.ate_at, 'meal', t.label, t.description, t.amount_eaten, t.source_type, t.source_id
  FROM v_parent_eating_timeline t
  WHERE t.child_id = p_child AND (t.ate_at AT TIME ZONE v_tz)::date = p_date;

  INSERT INTO daily_report_lines (report_id, version, occurred_at, category, title, detail, source_type, source_id)
  SELECT v_report, v_version, e.occurred_at, e.entry_type::text::report_category,
         CASE e.entry_type WHEN 'nap' THEN 'Nap' WHEN 'diaper' THEN 'Diaper' WHEN 'potty' THEN 'Potty'
                           WHEN 'milestone' THEN 'Milestone' WHEN 'mood' THEN 'Mood' ELSE 'Note' END,
         concat_ws('. ',
           CASE WHEN e.entry_type = 'nap' AND e.ended_at IS NOT NULL
                THEN round(extract(epoch FROM e.ended_at - e.occurred_at) / 60)::int::text || ' minutes' END,
           replace(e.bathroom_result::text, '_', ' '),
           e.note),
         'daily_log', e.id
  FROM daily_log_entries e
  WHERE e.child_id = p_child AND e.share_with_parents
    AND (e.occurred_at AT TIME ZONE v_tz)::date = p_date;

  INSERT INTO daily_report_lines (report_id, version, occurred_at, category, title, detail, source_type, source_id)
  SELECT v_report, v_version, p.taken_at, 'photo', 'Photo', p.caption, 'photo', p.id
  FROM photos p
  JOIN photo_children pc ON pc.photo_id = p.id AND pc.child_id = p_child AND pc.share_with_parents
  JOIN children c ON c.id = p_child AND c.photo_consent
  WHERE (p.taken_at AT TIME ZONE v_tz)::date = p_date;

  RETURN v_report;
END $$;

CREATE FUNCTION publish_daily_report(p_report uuid, p_user uuid) RETURNS void
LANGUAGE sql AS $$
  UPDATE daily_reports
     SET status = 'published', published_version = version, published_at = now(), published_by = p_user
   WHERE id = p_report;
$$;
