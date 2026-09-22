-- =====================================================================
-- Cubby: migration 002 (PostgreSQL 14+)
-- Run after cubby_schema.sql.
--
--   A. Expected attendance and missing-child alerts
--   B. Vendors, products, ingredient lists, deliveries, lot traceability
--   C. Vendor and manufacturer certificates
--   D. Recipes, crediting, portion standards, production
--   E. Views and helper functions
--
-- Note: ALTER TYPE ... ADD VALUE cannot be used inside the same
-- transaction that adds it, so run the three statements below first,
-- commit, then run the rest.
-- =====================================================================

ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'vendor_certificate';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'product_label';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'recipe_card';

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
CREATE TYPE expected_status      AS ENUM ('expected','arrived','excused','closed');
CREATE TYPE expected_source      AS ENUM ('schedule','one_time');
CREATE TYPE report_channel       AS ENUM ('portal','sms_reply','phone_call','staff_entry');
CREATE TYPE alert_status         AS ENUM ('open','parent_responded','resolved_arrived','resolved_absent','resolved_by_staff','cancelled');
CREATE TYPE notify_channel       AS ENUM ('sms','voice','push','email');
CREATE TYPE notify_target        AS ENUM ('primary_guardian','other_guardians','emergency_contacts','director');
CREATE TYPE attempt_status       AS ENUM ('queued','sent','delivered','answered','no_answer','busy','failed','blocked_no_consent');
CREATE TYPE parent_response      AS ENUM ('arriving_late','absent_today','call_me','unrecognized');
CREATE TYPE product_status       AS ENUM ('pending_review','approved','blocked','discontinued');
CREATE TYPE declaration_type     AS ENUM ('contains','may_contain','shared_facility');
CREATE TYPE crediting_basis      AS ENUM ('cn_label','product_formulation_statement','usda_food_buying_guide',
                                          'standardized_recipe','manufacturer_spec','calculated');
CREATE TYPE certificate_type     AS ENUM ('cn_label','product_formulation_statement','allergen_control','haccp_plan',
                                          'gfsi_audit','food_safety_inspection','organic','kosher','halal',
                                          'gluten_free','non_gmo','vendor_license','insurance','other');
CREATE TYPE verification_status  AS ENUM ('pending','verified','rejected','expired');
CREATE TYPE measure_unit         AS ENUM ('piece','oz','fl_oz','cup','tbsp','tsp','g','ml','lb','oz_eq','cup_eq');
CREATE TYPE plan_status          AS ENUM ('draft','confirmed','produced');

-- =====================================================================
-- A. EXPECTED ATTENDANCE AND MISSING-CHILD ALERTS
-- =====================================================================
CREATE TABLE guardian_communication_prefs (
  guardian_id         uuid PRIMARY KEY REFERENCES guardians(id),
  voice_consent       boolean NOT NULL DEFAULT false,   -- automated or prerecorded calls
  sms_consent         boolean NOT NULL DEFAULT false,
  consent_captured_at timestamptz,
  consent_source      text,                             -- enrollment form, portal checkbox, reply to text
  consent_document_id uuid REFERENCES documents(id),
  opted_out_at        timestamptz,                      -- honored immediately by every sender
  phone_verified_at   timestamptz,
  preferred_language  text NOT NULL DEFAULT 'en'
);

CREATE TABLE child_schedules (                          -- the recurring plan: which days, what time
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id          uuid NOT NULL REFERENCES children(id),
  days_of_week      smallint[] NOT NULL,                -- 1 = Monday ... 7 = Sunday
  expected_arrival  time,                               -- NULL = use the center's program start
  expected_departure time,
  valid_during      daterange NOT NULL
);

CREATE TABLE closure_calendar (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  closure_date  date NOT NULL,
  reason        text NOT NULL,                          -- holiday, snow day, staff training
  opens_at      time,                                   -- set for a delayed opening; NULL = closed all day
  UNIQUE (center_id, closure_date)
);

CREATE TABLE planned_absences (                         -- parent says "not coming"; suppresses the alert
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_id              uuid NOT NULL REFERENCES children(id),
  absent_from           date NOT NULL,
  absent_to             date NOT NULL,
  reason                text,
  reported_by_guardian  uuid REFERENCES guardians(id),
  reported_via          report_channel NOT NULL,
  reported_at           timestamptz NOT NULL DEFAULT now(),
  recorded_by           uuid REFERENCES users(id),
  CHECK (absent_to >= absent_from)
);

-- One row per child per open day, generated each night. This is what the scanner compares
-- against actual check-ins.
CREATE TABLE expected_attendance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id         uuid NOT NULL REFERENCES centers(id),
  child_id          uuid NOT NULL REFERENCES children(id),
  service_date      date NOT NULL,
  expected_arrival  time NOT NULL,
  source            expected_source NOT NULL DEFAULT 'schedule',
  status            expected_status NOT NULL DEFAULT 'expected',
  UNIQUE (child_id, service_date)
);
CREATE INDEX expected_attendance_scan_idx ON expected_attendance (service_date, status);

CREATE TABLE message_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id  uuid NOT NULL REFERENCES centers(id),
  code       text NOT NULL,                             -- missing_child_check_voice, missing_child_check_sms, ...
  channel    notify_channel NOT NULL,
  language   text NOT NULL DEFAULT 'en',
  body       text NOT NULL,                             -- placeholders like {child_first_name}, {center_name}
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (center_id, code, channel, language)
);

CREATE TABLE alert_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id      uuid NOT NULL REFERENCES centers(id),
  classroom_id   uuid REFERENCES classrooms(id),        -- NULL = center default; a room-specific policy wins
  name           text NOT NULL,
  grace_minutes  smallint NOT NULL DEFAULT 30 CHECK (grace_minutes >= 0),
  is_active      boolean NOT NULL DEFAULT true
);
CREATE TABLE alert_policy_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id           uuid NOT NULL REFERENCES alert_policies(id),
  step_no             smallint NOT NULL,
  wait_minutes        smallint NOT NULL DEFAULT 0,      -- delay after the previous step
  channel             notify_channel NOT NULL,
  target              notify_target NOT NULL,
  template_id         uuid REFERENCES message_templates(id),
  requires_staff_ok   boolean NOT NULL DEFAULT false,   -- hold this step until a staff member approves it
  UNIQUE (policy_id, step_no)
);

CREATE TABLE attendance_alerts (                        -- one per child per day, enforced by the unique key
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id              uuid NOT NULL REFERENCES centers(id),
  child_id               uuid NOT NULL REFERENCES children(id),
  service_date           date NOT NULL,
  expected_attendance_id uuid REFERENCES expected_attendance(id),
  policy_id              uuid NOT NULL REFERENCES alert_policies(id),
  status                 alert_status NOT NULL DEFAULT 'open',
  opened_at              timestamptz NOT NULL DEFAULT now(),
  current_step           smallint NOT NULL DEFAULT 0,
  next_action_at         timestamptz,
  resolved_at            timestamptz,
  resolved_by            uuid REFERENCES users(id),
  resolution_note        text,
  attendance_record_id   uuid REFERENCES attendance_records(id),
  UNIQUE (child_id, service_date)
);
CREATE INDEX attendance_alerts_open_idx ON attendance_alerts (next_action_at) WHERE status IN ('open','parent_responded');

CREATE TABLE notification_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id            uuid NOT NULL REFERENCES attendance_alerts(id),
  step_no             smallint NOT NULL,
  channel             notify_channel NOT NULL,
  guardian_id         uuid REFERENCES guardians(id),
  contact_id          uuid REFERENCES contacts(id),
  staff_id            uuid REFERENCES staff(id),
  to_address          text NOT NULL,                    -- phone number or email used
  template_id         uuid REFERENCES message_templates(id),
  idempotency_key     text NOT NULL UNIQUE,             -- alert + step + recipient; a retried job cannot call twice
  provider            text,
  provider_message_id text,
  status              attempt_status NOT NULL DEFAULT 'queued',
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  completed_at        timestamptz,
  response_code       text,                             -- keypad digit or reply text
  response_meaning    parent_response,
  duration_seconds    integer,
  error               text,
  CHECK (num_nonnulls(guardian_id, contact_id, staff_id) = 1)
);
CREATE INDEX notification_attempts_alert_idx ON notification_attempts (alert_id, step_no);
CREATE UNIQUE INDEX notification_attempts_provider_idx ON notification_attempts (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Every scheduled job updates its heartbeat. A watchdog pages the director if the
-- missing-child scanner goes quiet, because a silent failure is the dangerous case.
CREATE TABLE job_heartbeats (
  job_name                  text PRIMARY KEY,
  expected_interval_seconds integer NOT NULL,
  last_started_at           timestamptz,
  last_succeeded_at         timestamptz,
  last_error                text
);

-- =====================================================================
-- B. VENDORS, PRODUCTS, INGREDIENTS, DELIVERIES
-- =====================================================================
CREATE TABLE vendors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id       uuid NOT NULL REFERENCES centers(id),
  name            text NOT NULL,
  account_number  text,
  contact_name    text,
  phone           text,
  email           text,
  address_line1   text,
  city            text,
  state           char(2),
  postal_code     text,
  is_active       boolean NOT NULL DEFAULT true,
  approved_on     date,
  notes           text
);

CREATE TABLE products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id          uuid NOT NULL REFERENCES centers(id),
  vendor_id          uuid NOT NULL REFERENCES vendors(id),
  vendor_sku         text NOT NULL,
  name               text NOT NULL,
  brand              text,
  manufacturer       text,
  gtin               text,                              -- UPC or GS1 barcode
  category           text,
  pack_size          text,
  status             product_status NOT NULL DEFAULT 'pending_review',
  current_version_id uuid,                              -- foreign key added below
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, vendor_sku)
);

-- A product's formulation changes over time. Each version keeps the ingredient list exactly as
-- printed, so you can prove what a child could have eaten on a given date.
CREATE TABLE product_versions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id             uuid NOT NULL REFERENCES products(id),
  version_no             integer NOT NULL,
  effective_from         date NOT NULL,
  effective_to           date,
  ingredient_statement   text NOT NULL,                 -- verbatim from the label
  allergen_statement     text,                          -- verbatim "Contains: ..." and "May contain: ..."
  label_document_id      uuid REFERENCES documents(id),
  serving_size_desc      text,
  serving_size_grams     numeric(8,2),
  servings_per_container numeric(8,2),
  calories               numeric(7,2),
  total_fat_g            numeric(7,2),
  saturated_fat_g        numeric(7,2),
  sodium_mg              numeric(8,2),
  total_sugars_g         numeric(7,2),
  added_sugars_g         numeric(7,2),
  fiber_g                numeric(7,2),
  protein_g              numeric(7,2),
  whole_grain_rich       boolean,
  verified_by            uuid REFERENCES users(id),
  verified_at            timestamptz,
  notes                  text,
  UNIQUE (product_id, version_no),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE products
  ADD CONSTRAINT products_current_version_fk FOREIGN KEY (current_version_id) REFERENCES product_versions(id);

CREATE TABLE ingredients (                              -- canonical ingredient names, shared by products and recipes
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name    text NOT NULL UNIQUE                          -- "wheat flour", "soybean oil", "salt"
);
CREATE TABLE ingredient_allergens (
  ingredient_id  uuid NOT NULL REFERENCES ingredients(id),
  allergen_code  text NOT NULL REFERENCES allergens(code),
  PRIMARY KEY (ingredient_id, allergen_code)
);

-- The label's ingredient list, parsed in order, including sub-ingredients ("enriched flour (wheat flour, niacin, ...)").
CREATE TABLE product_ingredients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_version_id  uuid NOT NULL REFERENCES product_versions(id),
  position            smallint NOT NULL,
  parent_position     smallint,                          -- set for sub-ingredients
  name_as_printed     text NOT NULL,
  ingredient_id       uuid REFERENCES ingredients(id),
  UNIQUE (product_version_id, position)
);
CREATE TABLE product_allergens (
  product_version_id  uuid NOT NULL REFERENCES product_versions(id),
  allergen_code       text NOT NULL REFERENCES allergens(code),
  declaration         declaration_type NOT NULL,
  PRIMARY KEY (product_version_id, allergen_code, declaration)
);

-- How much of a meal component one serving of the product credits, and the paperwork behind it.
CREATE TABLE product_crediting (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_version_id  uuid NOT NULL REFERENCES product_versions(id),
  component_code      text NOT NULL REFERENCES food_components(code),
  credited_quantity   numeric(6,2) NOT NULL,
  credited_unit       measure_unit NOT NULL,
  per_serving_desc    text,                              -- "1 patty", "2 crackers"
  basis               crediting_basis NOT NULL,
  document_id         uuid REFERENCES documents(id),     -- CN label or manufacturer formulation statement
  verified_by         uuid REFERENCES users(id),
  verified_at         timestamptz
);

CREATE TABLE deliveries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id            uuid NOT NULL REFERENCES centers(id),
  vendor_id            uuid NOT NULL REFERENCES vendors(id),
  invoice_number       text,
  received_at          timestamptz NOT NULL,
  received_by          uuid REFERENCES staff(id),
  invoice_document_id  uuid REFERENCES documents(id),  -- scanned invoice, kept for state review
  notes                text
);
CREATE TABLE delivery_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id         uuid NOT NULL REFERENCES deliveries(id),
  product_version_id  uuid NOT NULL REFERENCES product_versions(id),
  quantity            numeric(10,2) NOT NULL,
  unit                text NOT NULL,                     -- case, lb, each
  lot_code            text,
  best_by             date,
  unit_cost_cents     integer,
  temperature_f       numeric(4,1),                      -- required for cold and frozen items
  accepted            boolean NOT NULL DEFAULT true,
  rejection_reason    text,
  storage_location    text
);
CREATE INDEX delivery_lines_lot_idx ON delivery_lines (lot_code) WHERE lot_code IS NOT NULL;

-- =====================================================================
-- C. VENDOR AND MANUFACTURER CERTIFICATES
-- =====================================================================
CREATE TABLE vendor_certificates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id           uuid NOT NULL REFERENCES centers(id),
  vendor_id           uuid REFERENCES vendors(id),
  manufacturer_name   text,                              -- when the certificate is the manufacturer's, not the vendor's
  cert_type           certificate_type NOT NULL,
  title               text NOT NULL,
  certificate_number  text,
  issuing_body        text,                              -- who audited or certified
  issued_on           date,
  expires_on          date,
  document_id         uuid NOT NULL REFERENCES documents(id),
  status              verification_status NOT NULL DEFAULT 'pending',
  verified_by         uuid REFERENCES users(id),
  verified_at         timestamptz,
  notes               text,
  CHECK (vendor_id IS NOT NULL OR manufacturer_name IS NOT NULL)
);
CREATE INDEX vendor_certificates_expiry_idx ON vendor_certificates (expires_on);

-- One certificate can cover many products; a facility-wide certificate simply lists them all.
CREATE TABLE certificate_products (
  certificate_id  uuid NOT NULL REFERENCES vendor_certificates(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  PRIMARY KEY (certificate_id, product_id)
);

-- =====================================================================
-- D. RECIPES, CREDITING, PORTION STANDARDS, PRODUCTION
-- =====================================================================
CREATE TABLE recipes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id          uuid NOT NULL REFERENCES centers(id),
  name               text NOT NULL,
  category           text,
  description        text,
  is_active          boolean NOT NULL DEFAULT true,
  current_version_id uuid,                               -- foreign key added below
  created_by         uuid REFERENCES users(id)
);
CREATE TABLE recipe_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id         uuid NOT NULL REFERENCES recipes(id),
  version_no        integer NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date,
  yield_quantity    numeric(10,2) NOT NULL,
  yield_unit        measure_unit NOT NULL,
  portions_yielded  numeric(8,2) NOT NULL CHECK (portions_yielded > 0),   -- servings the base batch makes
  portion_size_desc text,                                -- "3 nuggets", "#8 scoop"
  instructions      text,
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,
  UNIQUE (recipe_id, version_no)
);
ALTER TABLE recipes
  ADD CONSTRAINT recipes_current_version_fk FOREIGN KEY (current_version_id) REFERENCES recipe_versions(id);

CREATE TABLE recipe_lines (                             -- exact ingredient quantities for the base batch
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_version_id  uuid NOT NULL REFERENCES recipe_versions(id),
  line_no            smallint NOT NULL,
  product_id         uuid REFERENCES products(id),        -- a specific vendor product ...
  ingredient_id      uuid REFERENCES ingredients(id),     -- ... or a generic ingredient (salt, water)
  quantity           numeric(10,3) NOT NULL CHECK (quantity > 0),
  unit               measure_unit NOT NULL,
  prep_note          text,
  UNIQUE (recipe_version_id, line_no),
  CHECK (num_nonnulls(product_id, ingredient_id) = 1)
);

-- What one standard portion of the recipe credits toward the meal pattern.
CREATE TABLE recipe_credits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_version_id  uuid NOT NULL REFERENCES recipe_versions(id),
  component_code     text NOT NULL REFERENCES food_components(code),
  credited_quantity  numeric(6,2) NOT NULL,
  credited_unit      measure_unit NOT NULL,
  basis              crediting_basis NOT NULL,
  document_id        uuid REFERENCES documents(id)
);

-- Link menu foods to the recipe or product they come from.
ALTER TABLE food_items
  ADD COLUMN recipe_id  uuid REFERENCES recipes(id),
  ADD COLUMN product_id uuid REFERENCES products(id),
  ADD CONSTRAINT food_items_one_source CHECK (recipe_id IS NULL OR product_id IS NULL);

-- Exact serving size per food, per age group. "3 pieces" and "2 oz" both live here.
CREATE TABLE portion_standards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id           uuid NOT NULL REFERENCES centers(id),
  food_item_id        uuid NOT NULL REFERENCES food_items(id),
  age_group_id        smallint NOT NULL REFERENCES cacfp_age_groups(id),
  meal_type           meal_type,                          -- NULL = any meal
  serving_quantity    numeric(8,2) NOT NULL CHECK (serving_quantity > 0),
  serving_unit        measure_unit NOT NULL,
  piece_count         smallint,                           -- when the standard is a count of pieces
  serving_tool        text,                               -- "#8 scoop", "2 oz ladle", "kitchen scale"
  credited_component  text NOT NULL REFERENCES food_components(code),
  credited_quantity   numeric(6,2),
  credited_unit       measure_unit,
  min_quantity_to_credit numeric(8,2),                    -- below this the item does not count toward the meal
  effective_from      date NOT NULL,
  effective_to        date,
  approved_by         uuid REFERENCES users(id),
  notes               text
);
CREATE UNIQUE INDEX portion_standards_uniq_meal
  ON portion_standards (food_item_id, age_group_id, meal_type, effective_from) WHERE meal_type IS NOT NULL;
CREATE UNIQUE INDEX portion_standards_uniq_any
  ON portion_standards (food_item_id, age_group_id, effective_from) WHERE meal_type IS NULL;

ALTER TABLE menu_meal_items
  ADD COLUMN portion_standard_id uuid REFERENCES portion_standards(id);

-- Record exactly which version of a recipe or product was served, and against which standard.
ALTER TABLE meal_service_items
  ADD COLUMN portion_standard_id uuid REFERENCES portion_standards(id),
  ADD COLUMN recipe_version_id   uuid REFERENCES recipe_versions(id),
  ADD COLUMN product_version_id  uuid REFERENCES product_versions(id),
  ADD COLUMN pieces_served       numeric(6,2);

-- Which delivered lots went into a meal, so a recall can be traced to the children who ate it.
CREATE TABLE meal_service_item_lots (
  meal_service_item_id  uuid NOT NULL REFERENCES meal_service_items(id),
  delivery_line_id      uuid NOT NULL REFERENCES delivery_lines(id),
  PRIMARY KEY (meal_service_item_id, delivery_line_id)
);

-- Kitchen planning: headcount by age group in, scaled recipe quantities out.
CREATE TABLE production_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  menu_meal_id  uuid NOT NULL REFERENCES menu_meals(id),
  status        plan_status NOT NULL DEFAULT 'draft',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (menu_meal_id)
);
CREATE TABLE production_plan_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL REFERENCES production_plans(id),
  food_item_id       uuid NOT NULL REFERENCES food_items(id),
  recipe_version_id  uuid REFERENCES recipe_versions(id),
  age_group_id       smallint NOT NULL REFERENCES cacfp_age_groups(id),
  headcount          smallint NOT NULL,
  portions_needed    numeric(8,2) NOT NULL,
  total_quantity     numeric(10,2),
  unit               measure_unit,
  UNIQUE (plan_id, food_item_id, age_group_id)
);
CREATE TABLE production_records (                       -- what was actually prepared and left over
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_service_id    uuid NOT NULL REFERENCES meal_services(id),
  food_item_id       uuid NOT NULL REFERENCES food_items(id),
  recipe_version_id  uuid REFERENCES recipe_versions(id),
  prepared_quantity  numeric(10,2) NOT NULL,
  leftover_quantity  numeric(10,2),
  unit               measure_unit NOT NULL,
  recorded_by        uuid REFERENCES users(id),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  notes              text
);

-- =====================================================================
-- E. VIEWS AND FUNCTIONS
-- =====================================================================

-- Children who should be here, are not, and have no open alert yet. The scanner job reads this
-- every minute and opens one alert per row. Times are compared in the center's own time zone.
CREATE VIEW v_missing_child_candidates AS
SELECT ea.id AS expected_attendance_id, ea.center_id, ea.child_id, ea.service_date,
       ea.expected_arrival, p.id AS policy_id
FROM expected_attendance ea
JOIN centers ce ON ce.id = ea.center_id
JOIN LATERAL (
  SELECT ap.id, ap.grace_minutes
  FROM alert_policies ap
  WHERE ap.center_id = ea.center_id AND ap.is_active
    AND (ap.classroom_id IS NULL
         OR ap.classroom_id = (SELECT a.classroom_id FROM child_classroom_assignments a
                               WHERE a.child_id = ea.child_id AND a.valid_during @> ea.service_date LIMIT 1))
  ORDER BY (ap.classroom_id IS NOT NULL) DESC
  LIMIT 1
) p ON true
WHERE ea.status = 'expected'
  AND ea.service_date = (now() AT TIME ZONE ce.timezone)::date
  AND (now() AT TIME ZONE ce.timezone)::time >= ea.expected_arrival + make_interval(mins => p.grace_minutes)
  AND NOT EXISTS (SELECT 1 FROM attendance_records ar
                  WHERE ar.child_id = ea.child_id AND ar.service_date = ea.service_date)
  AND NOT EXISTS (SELECT 1 FROM attendance_alerts al
                  WHERE al.child_id = ea.child_id AND al.service_date = ea.service_date);

-- Allergens in each product version, from the manufacturer's declaration and from parsed ingredients.
CREATE VIEW v_product_allergens AS
SELECT product_version_id, allergen_code, declaration::text AS source
FROM product_allergens
UNION
SELECT pi.product_version_id, ia.allergen_code, 'ingredient' AS source
FROM product_ingredients pi
JOIN ingredient_allergens ia ON ia.ingredient_id = pi.ingredient_id;

-- Allergens in each recipe version: its generic ingredients plus the current version of each product it uses.
CREATE VIEW v_recipe_allergens AS
SELECT rl.recipe_version_id, ia.allergen_code
FROM recipe_lines rl
JOIN ingredient_allergens ia ON ia.ingredient_id = rl.ingredient_id
UNION
SELECT rl.recipe_version_id, pa.allergen_code
FROM recipe_lines rl
JOIN products p ON p.id = rl.product_id
JOIN v_product_allergens pa ON pa.product_version_id = p.current_version_id;

-- Scale a recipe to any number of portions.
CREATE FUNCTION scale_recipe(p_recipe_version uuid, p_portions numeric)
RETURNS TABLE (line_no smallint, item text, quantity numeric, unit measure_unit, prep_note text)
LANGUAGE sql STABLE AS $$
  SELECT rl.line_no,
         coalesce(pr.name, ing.name),
         round(rl.quantity * p_portions / rv.portions_yielded, 3),
         rl.unit,
         rl.prep_note
  FROM recipe_lines rl
  JOIN recipe_versions rv ON rv.id = rl.recipe_version_id
  LEFT JOIN products pr ON pr.id = rl.product_id
  LEFT JOIN ingredients ing ON ing.id = rl.ingredient_id
  WHERE rl.recipe_version_id = p_recipe_version
  ORDER BY rl.line_no
$$;

-- Approved products with no verified, unexpired crediting document or certificate.
CREATE VIEW v_products_missing_documents AS
SELECT p.id AS product_id, p.name, v.name AS vendor,
       NOT EXISTS (SELECT 1 FROM product_crediting pc
                   WHERE pc.product_version_id = p.current_version_id AND pc.document_id IS NOT NULL) AS no_crediting_document,
       NOT EXISTS (SELECT 1 FROM certificate_products cp
                   JOIN vendor_certificates vc ON vc.id = cp.certificate_id
                   WHERE cp.product_id = p.id AND vc.status = 'verified'
                     AND (vc.expires_on IS NULL OR vc.expires_on >= current_date)) AS no_valid_certificate
FROM products p
JOIN vendors v ON v.id = p.vendor_id
WHERE p.status = 'approved';

-- Recall trace: for a delivered lot, every meal that used it and every child who was served.
CREATE VIEW v_lot_exposure AS
SELECT dl.lot_code, dl.id AS delivery_line_id, ms.service_date, ms.meal_type, ms.classroom_id,
       r.child_id
FROM delivery_lines dl
JOIN meal_service_item_lots l ON l.delivery_line_id = dl.id
JOIN meal_service_items msi ON msi.id = l.meal_service_item_id
JOIN meal_services ms ON ms.id = msi.meal_service_id
JOIN child_meal_records r ON r.meal_service_id = ms.id AND r.status = 'served';
