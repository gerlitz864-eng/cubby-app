-- =====================================================================
-- Cubby: migration 003 (PostgreSQL 14+)
-- Teacher supply flags, notification rules, in-app notifications, center stock.
-- Run after cubby_schema.sql and cubby_schema_002_automation_products_recipes.sql.
--
-- As in migration 002, run the ALTER TYPE ... ADD VALUE statements first,
-- commit, then run the rest.
-- =====================================================================

ALTER TYPE notify_channel ADD VALUE IF NOT EXISTS 'in_app';          -- parent portal or app, and the staff dashboard
ALTER TYPE notify_target  ADD VALUE IF NOT EXISTS 'front_office';
ALTER TYPE notify_target  ADD VALUE IF NOT EXISTS 'all_guardians';
ALTER TYPE user_role      ADD VALUE IF NOT EXISTS 'front_office';

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
CREATE TYPE supply_level      AS ENUM ('low','out');
CREATE TYPE supply_urgency    AS ENUM ('routine','urgent');
CREATE TYPE supply_status     AS ENUM ('open','acknowledged','resolved','cancelled');
CREATE TYPE supply_resolution AS ENUM ('parent_delivered','center_supplied','teacher_confirmed_restock',
                                       'no_longer_needed','child_withdrew','duplicate');
CREATE TYPE supply_response   AS ENUM ('bringing_today','bringing_tomorrow','please_supply','already_sent','question');
CREATE TYPE supply_event_type AS ENUM ('flagged','level_raised','undone','notified','acknowledged','parent_responded',
                                       'center_supplied','resolved','reopened','escalated','reminded','note');
CREATE TYPE message_status    AS ENUM ('queued','sent','delivered','read','failed','blocked_no_consent','suppressed_quiet_hours');
CREATE TYPE stock_reason      AS ENUM ('received','given_to_child','loss','correction');

-- ---------------------------------------------------------------------
-- Settings on existing tables
-- ---------------------------------------------------------------------
ALTER TABLE centers
  ADD COLUMN notification_quiet_start time NOT NULL DEFAULT '21:00',   -- routine texts wait until quiet hours end
  ADD COLUMN notification_quiet_end   time NOT NULL DEFAULT '07:00';

-- Lets a family decide who gets supply notices (for example, one household receives them, the other does not).
ALTER TABLE child_guardians
  ADD COLUMN receive_supply_alerts boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------
-- What can be flagged
-- ---------------------------------------------------------------------
CREATE TABLE supply_item_types (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id            uuid NOT NULL REFERENCES centers(id),
  code                 text NOT NULL,             -- diapers, wipes, bottles, formula, baby_food, blanket, ...
  label                text NOT NULL,
  category             text NOT NULL,             -- diapering, feeding, sleep, clothing, health, other
  min_age_months       smallint,                  -- items outside a child's age range are hidden and rejected
  max_age_months       smallint,
  default_urgency      supply_urgency NOT NULL DEFAULT 'routine',
  affects_meal_service boolean NOT NULL DEFAULT false,   -- formula, bottles, baby food: links to infant feeding records
  allergy_check        boolean NOT NULL DEFAULT false,   -- show the child's allergy alerts when supplying this item
  unit_label           text,                      -- pack, can, jar
  sort_order           smallint NOT NULL DEFAULT 100,
  is_active            boolean NOT NULL DEFAULT true,
  notes                text,
  UNIQUE (center_id, code)
);

-- Which items a family supplies for a child, with details such as size or brand.
-- The teacher screen shows only these items for each child.
CREATE TABLE child_supply_profiles (
  child_id          uuid NOT NULL REFERENCES children(id),
  item_type_id      uuid NOT NULL REFERENCES supply_item_types(id),
  parent_supplies   boolean NOT NULL DEFAULT true,
  details           text,                          -- "size 4", "sensitive formula", "soy formula"
  PRIMARY KEY (child_id, item_type_id)
);

-- ---------------------------------------------------------------------
-- The flag itself
-- ---------------------------------------------------------------------
CREATE TABLE supply_flags (
  id                   uuid PRIMARY KEY,           -- client-generated so an offline tap cannot create duplicates
  center_id            uuid NOT NULL REFERENCES centers(id),
  child_id             uuid NOT NULL REFERENCES children(id),
  classroom_id         uuid REFERENCES classrooms(id),
  item_type_id         uuid NOT NULL REFERENCES supply_item_types(id),
  level                supply_level NOT NULL DEFAULT 'low',
  urgency              supply_urgency NOT NULL,
  status               supply_status NOT NULL DEFAULT 'open',
  flagged_by           uuid REFERENCES staff(id),
  flagged_at           timestamptz NOT NULL DEFAULT now(),
  note                 text,
  needed_by            date,                       -- next scheduled day for this child
  acknowledged_by      uuid REFERENCES users(id),
  acknowledged_at      timestamptz,
  ack_due_at           timestamptz,                -- when the front office must respond, or the director is told
  parent_response      supply_response,
  parent_responded_at  timestamptz,
  parent_response_by   uuid REFERENCES guardians(id),
  parent_eta           date,
  resolution           supply_resolution,
  resolved_at          timestamptz,
  resolved_by          uuid REFERENCES users(id),
  invoice_line_id      uuid REFERENCES invoice_lines(id),   -- set when the center supplied the item and charged for it
  CHECK (status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
-- A second tap on the same item raises the level of the open flag instead of creating another one.
CREATE UNIQUE INDEX supply_flags_one_open
  ON supply_flags (child_id, item_type_id) WHERE status IN ('open','acknowledged');
CREATE INDEX supply_flags_queue_idx ON supply_flags (center_id, status, urgency, flagged_at);

CREATE TABLE supply_flag_events (                  -- timeline shown to teachers and the front office
  id                 bigserial PRIMARY KEY,
  flag_id            uuid NOT NULL REFERENCES supply_flags(id),
  event              supply_event_type NOT NULL,
  actor_user_id      uuid REFERENCES users(id),
  actor_guardian_id  uuid REFERENCES guardians(id),
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  detail             text,
  CHECK (NOT (actor_user_id IS NOT NULL AND actor_guardian_id IS NOT NULL))
);
CREATE INDEX supply_flag_events_flag_idx ON supply_flag_events (flag_id, occurred_at);

-- Reject a flag for an item that does not apply to the child's age (for example, a blanket for a child under 12 months).
CREATE FUNCTION supply_item_allowed(p_child uuid, p_item uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT (t.min_age_months IS NULL OR m.months >= t.min_age_months)
        AND (t.max_age_months IS NULL OR m.months <= t.max_age_months)
     FROM supply_item_types t,
          LATERAL (SELECT extract(year FROM age(current_date, c.date_of_birth)) * 12
                        + extract(month FROM age(current_date, c.date_of_birth)) AS months
                   FROM children c WHERE c.id = p_child) m
     WHERE t.id = p_item),
    false)
$$;

CREATE FUNCTION supply_flags_check_age() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT supply_item_allowed(NEW.child_id, NEW.item_type_id) THEN
    RAISE EXCEPTION 'This item does not apply to this child''s age';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supply_flags_age_check BEFORE INSERT ON supply_flags
  FOR EACH ROW EXECUTE FUNCTION supply_flags_check_age();

-- ---------------------------------------------------------------------
-- Notification rules and delivery
-- ---------------------------------------------------------------------
-- Editable triggers. Example rows: every flag goes to all guardians and the front office in-app immediately;
-- an urgent item that is out also texts the primary guardian; unresolved flags remind the family once the evening before.
CREATE TABLE supply_notification_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id            uuid NOT NULL REFERENCES centers(id),
  item_type_id         uuid REFERENCES supply_item_types(id),      -- NULL = every item
  min_level            supply_level NOT NULL DEFAULT 'low',
  urgency              supply_urgency,                             -- NULL = any
  target               notify_target NOT NULL,
  channel              notify_channel NOT NULL,
  delay_minutes        smallint NOT NULL DEFAULT 0,
  repeat_after_hours   smallint,
  max_repeats          smallint NOT NULL DEFAULT 0,
  only_if_child_present boolean NOT NULL DEFAULT false,
  respect_quiet_hours  boolean NOT NULL DEFAULT true,
  template_id          uuid REFERENCES message_templates(id),
  is_active            boolean NOT NULL DEFAULT true
);

CREATE TABLE in_app_notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  guardian_id   uuid REFERENCES guardians(id),
  user_id       uuid REFERENCES users(id),
  for_role      user_role,                                 -- broadcast to everyone with a role, such as front_office
  kind          text NOT NULL,                             -- supply_flagged, supply_reminder, supply_center_supplied, ...
  title         text NOT NULL,
  body          text NOT NULL,
  source_table  text,
  source_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  CHECK (num_nonnulls(guardian_id, user_id, for_role) = 1)
);
CREATE INDEX in_app_unread_idx ON in_app_notifications (guardian_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE supply_notifications (                      -- delivery log for every send
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_id              uuid NOT NULL REFERENCES supply_flags(id),
  rule_id              uuid REFERENCES supply_notification_rules(id),
  guardian_id          uuid REFERENCES guardians(id),
  user_id              uuid REFERENCES users(id),
  for_role             user_role,
  channel              notify_channel NOT NULL,
  to_address           text,
  template_id          uuid REFERENCES message_templates(id),
  idempotency_key      text NOT NULL UNIQUE,               -- flag + rule + recipient + repeat number
  status               message_status NOT NULL DEFAULT 'queued',
  provider             text,
  provider_message_id  text,
  queued_at            timestamptz NOT NULL DEFAULT now(),
  send_after           timestamptz,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  error                text,
  CHECK (num_nonnulls(guardian_id, user_id, for_role) = 1)
);
CREATE INDEX supply_notifications_due_idx ON supply_notifications (send_after) WHERE status = 'queued';
CREATE UNIQUE INDEX supply_notifications_provider_idx ON supply_notifications (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- The center's own backup stock (for example, emergency diapers and wipes)
-- ---------------------------------------------------------------------
CREATE TABLE center_supply_stock (
  center_id       uuid NOT NULL REFERENCES centers(id),
  item_type_id    uuid NOT NULL REFERENCES supply_item_types(id),
  on_hand         integer NOT NULL DEFAULT 0,
  reorder_level   integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (center_id, item_type_id)
);
CREATE TABLE stock_movements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  item_type_id  uuid NOT NULL REFERENCES supply_item_types(id),
  delta         integer NOT NULL,                          -- negative when given to a child
  reason        stock_reason NOT NULL,
  flag_id       uuid REFERENCES supply_flags(id),
  child_id      uuid REFERENCES children(id),
  recorded_by   uuid REFERENCES users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  note          text
);

-- ---------------------------------------------------------------------
-- Default item list for a new center
-- ---------------------------------------------------------------------
CREATE FUNCTION seed_default_supply_items(p_center uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO supply_item_types
    (center_id, code, label, category, min_age_months, default_urgency, affects_meal_service, allergy_check, unit_label, sort_order, notes)
  VALUES
    (p_center, 'diapers',           'Diapers',             'diapering', NULL, 'urgent',  false, false, 'pack', 10, NULL),
    (p_center, 'wipes',             'Wipes',               'diapering', NULL, 'routine', false, false, 'pack', 20, NULL),
    (p_center, 'diaper_cream',      'Diaper cream',        'diapering', NULL, 'routine', false, false, 'tube', 30, NULL),
    (p_center, 'bottles',           'Bottles',             'feeding',   NULL, 'urgent',  true,  false, 'each', 40, NULL),
    (p_center, 'formula',           'Formula',             'feeding',   NULL, 'urgent',  true,  true,  'can',  50, NULL),
    (p_center, 'baby_food',         'Baby food',           'feeding',   NULL, 'urgent',  true,  true,  'jar',  60, NULL),
    (p_center, 'blanket',           'Blanket',             'sleep',     12,   'routine', false, false, 'each', 70,
       'Hidden for children under 12 months to follow safe-sleep practice. Confirm the NJ licensing rule.'),
    (p_center, 'change_of_clothes', 'Change of clothes',   'clothing',  NULL, 'routine', false, false, 'set',  80, NULL),
    (p_center, 'sunscreen',         'Sunscreen',           'health',    NULL, 'routine', false, false, 'each', 90, NULL),
    (p_center, 'pacifier',          'Pacifier',            'feeding',   NULL, 'routine', false, false, 'each', 100, NULL)
  ON CONFLICT (center_id, code) DO NOTHING;
$$;

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------

-- The front office queue: open flags, most urgent first, with whether the child is in the building now.
CREATE VIEW v_office_supply_queue AS
SELECT f.id AS flag_id, f.center_id, f.child_id, c.first_name, c.last_name, cl.name AS classroom,
       t.label AS item, t.affects_meal_service, t.allergy_check,
       f.level, f.urgency, f.status, f.flagged_at, f.needed_by, f.note,
       f.parent_response, f.parent_eta, f.ack_due_at,
       (f.acknowledged_at IS NULL AND f.ack_due_at IS NOT NULL AND f.ack_due_at < now()) AS ack_overdue,
       EXISTS (SELECT 1 FROM attendance_records ar
               WHERE ar.child_id = f.child_id AND ar.service_date = current_date
                 AND ar.status = 'present' AND ar.checked_out_at IS NULL) AS child_here_now
FROM supply_flags f
JOIN children c ON c.id = f.child_id
JOIN supply_item_types t ON t.id = f.item_type_id
LEFT JOIN classrooms cl ON cl.id = f.classroom_id
WHERE f.status IN ('open','acknowledged');

-- Today's bring-list: what each child who is expected today still needs from home.
CREATE VIEW v_todays_bring_list AS
SELECT ea.center_id, ea.child_id, c.first_name, c.last_name,
       string_agg(t.label || CASE WHEN f.level = 'out' THEN ' (out)' ELSE '' END, ', ' ORDER BY t.sort_order) AS items_needed
FROM expected_attendance ea
JOIN children c ON c.id = ea.child_id
JOIN supply_flags f ON f.child_id = ea.child_id AND f.status IN ('open','acknowledged')
JOIN supply_item_types t ON t.id = f.item_type_id
WHERE ea.service_date = current_date AND ea.status IN ('expected','arrived')
GROUP BY ea.center_id, ea.child_id, c.first_name, c.last_name;

-- Children flagged for the same item three or more times in 30 days, for the director's weekly digest.
CREATE VIEW v_frequent_supply_flags AS
SELECT f.center_id, f.child_id, c.first_name, c.last_name, t.label AS item, count(*) AS times_flagged
FROM supply_flags f
JOIN children c ON c.id = f.child_id
JOIN supply_item_types t ON t.id = f.item_type_id
WHERE f.flagged_at >= now() - interval '30 days' AND f.status <> 'cancelled'
GROUP BY f.center_id, f.child_id, c.first_name, c.last_name, t.label
HAVING count(*) >= 3;

-- Center stock at or below its reorder level.
CREATE VIEW v_low_center_stock AS
SELECT s.center_id, t.label AS item, s.on_hand, s.reorder_level
FROM center_supply_stock s
JOIN supply_item_types t ON t.id = s.item_type_id
WHERE s.on_hand <= s.reorder_level;
