-- =====================================================================
-- Cubby: migration 005 (PostgreSQL 14+)
-- Classroom supply ordering: catalog, teacher requests (including custom items), front-office approval,
-- purchase orders, status tracking, classroom budgets, and stockroom inventory.
-- Run after cubby_schema.sql and migrations 002, 003, and 004.
--
-- Not to be confused with migration 003, which covers personal items a family sends for one child
-- (diapers, formula). This migration covers materials the classroom uses (paper, paint, toys, cleaning supplies).
-- =====================================================================

CREATE TYPE vendor_kind         AS ENUM ('food','classroom_supplies','cleaning','office','other');
CREATE TYPE request_priority    AS ENUM ('normal','soon','urgent');
CREATE TYPE request_status      AS ENUM ('draft','submitted','in_review','closed');
CREATE TYPE request_line_status AS ENUM ('pending','on_hold','approved','ordered','shipped','received','denied','cancelled');
CREATE TYPE po_status           AS ENUM ('draft','ordered','shipped','delivered','cancelled');
CREATE TYPE approval_decision   AS ENUM ('approved','denied');
CREATE TYPE request_event_type  AS ENUM ('submitted','status_changed','comment','edited','promoted_to_catalog','reminder_sent','escalated');
CREATE TYPE stockroom_reason    AS ENUM ('received','taken_by_classroom','loss','correction');

-- Vendors now cover more than food. Existing rows stay 'food'.
ALTER TABLE vendors ADD COLUMN vendor_kind vendor_kind NOT NULL DEFAULT 'food';

-- ---------------------------------------------------------------------
-- Catalog (the marketplace list teachers pick from)
-- ---------------------------------------------------------------------
CREATE TABLE catalog_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id   uuid NOT NULL REFERENCES centers(id),
  parent_id   uuid REFERENCES catalog_categories(id),
  name        text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 100
);

CREATE TABLE catalog_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id          uuid NOT NULL REFERENCES centers(id),
  category_id        uuid REFERENCES catalog_categories(id),
  name               text NOT NULL,
  description        text,
  sku                text,
  vendor_id          uuid REFERENCES vendors(id),
  vendor_url         text,
  unit_label         text,                          -- "pack of 12", "each", "ream"
  est_unit_cents     integer CHECK (est_unit_cents >= 0),
  image_document_id  uuid REFERENCES documents(id),
  track_stock        boolean NOT NULL DEFAULT false, -- if true, the marketplace shows what is on the stockroom shelf
  is_food            boolean NOT NULL DEFAULT false,
  product_id         uuid REFERENCES products(id),  -- food must link to an approved product in the vendor product database
  is_active          boolean NOT NULL DEFAULT true,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_food OR product_id IS NOT NULL)
);
CREATE UNIQUE INDEX catalog_items_sku_uniq ON catalog_items (center_id, vendor_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX catalog_items_search_idx ON catalog_items (center_id, is_active, name);

-- ---------------------------------------------------------------------
-- Budgets and approval rules
-- ---------------------------------------------------------------------
CREATE TABLE classroom_budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id  uuid NOT NULL REFERENCES classrooms(id),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (classroom_id, period_start),
  CHECK (period_end >= period_start)
);

CREATE TABLE approval_policies (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id                  uuid NOT NULL REFERENCES centers(id),
  classroom_id               uuid REFERENCES classrooms(id),   -- NULL = center default
  auto_approve_under_cents   integer NOT NULL DEFAULT 0,       -- 0 = everything is reviewed by a person
  director_over_cents        integer,                          -- lines above this also need the director
  pending_sla_hours          smallint NOT NULL DEFAULT 48,     -- reminder to the office when a request waits this long
  allow_custom_items         boolean NOT NULL DEFAULT true,
  custom_item_max_cents      integer
);
CREATE UNIQUE INDEX approval_policies_uniq
  ON approval_policies (center_id, coalesce(classroom_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------------------------------------------------------------------
-- Requests: a teacher's cart is a request; each line has its own status
-- ---------------------------------------------------------------------
CREATE TABLE supply_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  classroom_id  uuid NOT NULL REFERENCES classrooms(id),
  requested_by  uuid NOT NULL REFERENCES staff(id),
  priority      request_priority NOT NULL DEFAULT 'normal',
  needed_by     date,
  note          text,
  status        request_status NOT NULL DEFAULT 'draft',   -- draft lines are visible only to the teacher
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz
);
CREATE INDEX supply_requests_room_idx ON supply_requests (classroom_id, status);

CREATE TABLE supply_request_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                uuid NOT NULL REFERENCES supply_requests(id),
  catalog_item_id           uuid REFERENCES catalog_items(id),
  -- Custom item, when it is not in the catalog:
  custom_name               text,
  custom_description        text,
  custom_url                text,
  is_food                   boolean NOT NULL DEFAULT false,   -- teacher ticks "this is food or a drink"
  quantity                  integer NOT NULL CHECK (quantity > 0),
  unit_label                text,
  estimated_unit_cents      integer CHECK (estimated_unit_cents >= 0),
  reason                    text,                             -- why it is needed
  attachment_document_id    uuid REFERENCES documents(id),
  status                    request_line_status NOT NULL DEFAULT 'pending',
  approved_quantity         integer CHECK (approved_quantity >= 0),
  reviewed_by               uuid REFERENCES users(id),
  reviewed_at               timestamptz,
  decision_note             text,                             -- required when denied; the teacher sees it
  expected_delivery         date,
  carrier                   text,
  tracking_number           text,
  received_at               timestamptz,                      -- arrived at the center
  classroom_confirmed_at    timestamptz,                      -- teacher confirmed it reached the room
  classroom_confirmed_by    uuid REFERENCES staff(id),
  promoted_catalog_item_id  uuid REFERENCES catalog_items(id),-- set when the office adds a custom item to the catalog
  CHECK (catalog_item_id IS NOT NULL OR custom_name IS NOT NULL),
  CHECK (status <> 'denied' OR decision_note IS NOT NULL)
);
CREATE INDEX supply_request_lines_status_idx ON supply_request_lines (status);
CREATE INDEX supply_request_lines_request_idx ON supply_request_lines (request_id);

-- Which status changes are allowed. A denied line can be reopened; received and cancelled are final.
CREATE TABLE request_status_transitions (
  from_status  request_line_status NOT NULL,
  to_status    request_line_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO request_status_transitions (from_status, to_status) VALUES
  ('pending','approved'), ('pending','denied'), ('pending','on_hold'), ('pending','cancelled'),
  ('on_hold','pending'),  ('on_hold','denied'),  ('on_hold','cancelled'),
  ('approved','ordered'), ('approved','denied'), ('approved','cancelled'),
  ('ordered','approved'), ('ordered','shipped'), ('ordered','received'), ('ordered','cancelled'),
  ('shipped','received'),
  ('denied','pending');

-- Extra approvals when a line needs the director, or the cook (for food).
CREATE TABLE line_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_id        uuid NOT NULL REFERENCES supply_request_lines(id),
  required_role  user_role NOT NULL,
  decision       approval_decision,
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  note           text,
  UNIQUE (line_id, required_role)
);

-- Full history and two-way comments, shown to both the teacher and the office.
CREATE TABLE request_line_events (
  id             bigserial PRIMARY KEY,
  line_id        uuid NOT NULL REFERENCES supply_request_lines(id),
  event          request_event_type NOT NULL,
  actor_user_id  uuid REFERENCES users(id),
  from_status    request_line_status,
  to_status      request_line_status,
  note           text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_line_events_idx ON request_line_events (line_id, occurred_at);

-- ---------------------------------------------------------------------
-- Purchase orders: the office can combine lines from several teachers into one vendor order
-- ---------------------------------------------------------------------
CREATE TABLE purchase_orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id            uuid NOT NULL REFERENCES centers(id),
  vendor_id            uuid NOT NULL REFERENCES vendors(id),
  po_number            text NOT NULL UNIQUE,
  status               po_status NOT NULL DEFAULT 'draft',
  created_by           uuid REFERENCES users(id),
  ordered_by           uuid REFERENCES users(id),
  ordered_at           timestamptz,
  expected_delivery    date,
  carrier              text,
  tracking_number      text,
  order_confirmation   text,
  subtotal_cents       integer,
  shipping_cents       integer,
  tax_cents            integer,
  invoice_document_id  uuid REFERENCES documents(id),
  notes                text
);
CREATE TABLE purchase_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id  uuid NOT NULL REFERENCES purchase_orders(id),
  request_line_id    uuid UNIQUE REFERENCES supply_request_lines(id),  -- NULL for a stockroom reorder
  catalog_item_id    uuid REFERENCES catalog_items(id),
  description        text NOT NULL,
  quantity           integer NOT NULL CHECK (quantity > 0),
  unit_cost_cents    integer,
  CHECK (request_line_id IS NOT NULL OR catalog_item_id IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- Stockroom inventory (what is on the shelf in the supply closet)
-- ---------------------------------------------------------------------
CREATE TABLE stockroom_stock (
  center_id        uuid NOT NULL REFERENCES centers(id),
  catalog_item_id  uuid NOT NULL REFERENCES catalog_items(id),
  on_hand          integer NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reorder_level    integer NOT NULL DEFAULT 0,
  reorder_quantity integer,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (center_id, catalog_item_id)
);
CREATE TABLE stockroom_movements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id              uuid NOT NULL REFERENCES centers(id),
  catalog_item_id        uuid NOT NULL REFERENCES catalog_items(id),
  delta                  integer NOT NULL,             -- negative when a classroom takes items
  reason                 stockroom_reason NOT NULL,
  classroom_id           uuid REFERENCES classrooms(id),
  request_line_id        uuid REFERENCES supply_request_lines(id),
  purchase_order_line_id uuid REFERENCES purchase_order_lines(id),
  recorded_by            uuid REFERENCES users(id),
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  note                   text
);
CREATE INDEX stockroom_movements_item_idx ON stockroom_movements (catalog_item_id, recorded_at);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

-- Refuse status changes the workflow does not allow.
CREATE FUNCTION request_line_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status
     AND NOT EXISTS (SELECT 1 FROM request_status_transitions t
                     WHERE t.from_status = OLD.status AND t.to_status = NEW.status) THEN
    RAISE EXCEPTION 'A request line cannot move from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_line_status_guard_trg BEFORE UPDATE OF status ON supply_request_lines
  FOR EACH ROW EXECUTE FUNCTION request_line_status_guard();

-- Log every status change and keep the request's own status in step.
-- The application sets: SET LOCAL app.user_id = '<user uuid>' so the history shows who acted.
CREATE FUNCTION request_line_status_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    INSERT INTO request_line_events (line_id, event, actor_user_id, from_status, to_status, note)
    VALUES (NEW.id, 'status_changed', nullif(current_setting('app.user_id', true), '')::uuid,
            OLD.status, NEW.status, NEW.decision_note);

    UPDATE supply_requests r
       SET status = CASE
             WHEN NOT EXISTS (SELECT 1 FROM supply_request_lines l
                              WHERE l.request_id = r.id AND l.status NOT IN ('received','denied','cancelled'))
             THEN 'closed'::request_status
             ELSE 'in_review'::request_status END
     WHERE r.id = NEW.request_id AND r.status IN ('submitted','in_review');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER request_line_status_log_trg AFTER UPDATE OF status ON supply_request_lines
  FOR EACH ROW EXECUTE FUNCTION request_line_status_log();

-- When the office moves a purchase order forward, every request line on it moves too,
-- so teachers see "ordered", "shipped", and "received" without anyone updating each line by hand.
CREATE FUNCTION po_status_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'ordered' THEN
    UPDATE supply_request_lines l
       SET status = 'ordered', expected_delivery = coalesce(NEW.expected_delivery, l.expected_delivery)
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status = 'approved';
  ELSIF NEW.status = 'shipped' THEN
    UPDATE supply_request_lines l
       SET status = 'shipped', carrier = NEW.carrier, tracking_number = NEW.tracking_number,
           expected_delivery = coalesce(NEW.expected_delivery, l.expected_delivery)
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status = 'ordered';
  ELSIF NEW.status = 'delivered' THEN
    UPDATE supply_request_lines l
       SET status = 'received', received_at = now()
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status IN ('ordered','shipped');
  ELSIF NEW.status = 'cancelled' THEN
    UPDATE supply_request_lines l
       SET status = 'approved'
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status = 'ordered';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER po_status_sync_trg AFTER UPDATE OF status ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION po_status_sync();

-- Keep the stockroom count in step with every movement. The CHECK on on_hand stops a classroom from taking more than exists.
CREATE FUNCTION stockroom_apply_movement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Update first: an INSERT ... ON CONFLICT checks the proposed row against the on_hand >= 0 rule
  -- before it notices the conflict, which would wrongly reject taking items off a shelf that has stock.
  UPDATE stockroom_stock SET on_hand = on_hand + NEW.delta, updated_at = now()
   WHERE center_id = NEW.center_id AND catalog_item_id = NEW.catalog_item_id;
  IF NOT FOUND THEN
    INSERT INTO stockroom_stock (center_id, catalog_item_id, on_hand) VALUES (NEW.center_id, NEW.catalog_item_id, NEW.delta);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stockroom_apply_movement_trg AFTER INSERT ON stockroom_movements
  FOR EACH ROW EXECUTE FUNCTION stockroom_apply_movement();

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------

-- Spending against each classroom budget: approved, ordered, shipped, and received lines count as committed.
CREATE VIEW v_classroom_budget_status AS
SELECT x.*, x.amount_cents - x.committed_cents AS remaining_cents
FROM (
  SELECT b.id AS budget_id, b.classroom_id, b.period_start, b.period_end, b.amount_cents,
         coalesce(sum(coalesce(pl.unit_cost_cents, l.estimated_unit_cents, 0)::bigint
                      * coalesce(l.approved_quantity, l.quantity))
                  FILTER (WHERE l.status IN ('approved','ordered','shipped','received')), 0)::bigint AS committed_cents
  FROM classroom_budgets b
  LEFT JOIN supply_requests r
         ON r.classroom_id = b.classroom_id
        AND r.submitted_at::date BETWEEN b.period_start AND b.period_end
  LEFT JOIN supply_request_lines l ON l.request_id = r.id
  LEFT JOIN purchase_order_lines pl ON pl.request_line_id = l.id
  GROUP BY b.id
) x;

-- The front office approval queue: what is waiting, how long, what it costs, what is left in the budget,
-- and whether the same item is already on the stockroom shelf.
CREATE VIEW v_office_approval_queue AS
SELECT l.id AS line_id, r.center_id, r.classroom_id, cl.name AS classroom,
       s.first_name || ' ' || s.last_name AS requested_by_name,
       r.submitted_at, r.priority, r.needed_by,
       coalesce(ci.name, l.custom_name) AS item,
       (l.catalog_item_id IS NULL) AS is_custom,
       (l.is_food OR coalesce(ci.is_food, false)) AS is_food,
       l.quantity, l.estimated_unit_cents,
       l.quantity * coalesce(l.estimated_unit_cents, 0) AS estimated_total_cents,
       l.reason, l.status,
       round(extract(epoch FROM now() - r.submitted_at) / 3600) AS hours_waiting,
       bs.remaining_cents AS budget_remaining_cents,
       st.on_hand AS stockroom_on_hand
FROM supply_request_lines l
JOIN supply_requests r ON r.id = l.request_id AND r.status <> 'draft'
JOIN classrooms cl ON cl.id = r.classroom_id
JOIN staff s ON s.id = r.requested_by
LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id
LEFT JOIN v_classroom_budget_status bs
       ON bs.classroom_id = r.classroom_id AND current_date BETWEEN bs.period_start AND bs.period_end
LEFT JOIN stockroom_stock st ON st.catalog_item_id = l.catalog_item_id AND st.center_id = r.center_id
WHERE l.status IN ('pending','on_hold');

-- The teacher's own board: every line with its current status, delivery details, and the latest note from the office.
CREATE VIEW v_my_request_lines AS
SELECT r.requested_by AS staff_id, r.classroom_id, l.id AS line_id, r.submitted_at,
       coalesce(ci.name, l.custom_name) AS item, l.quantity, l.status,
       l.approved_quantity, l.decision_note, l.expected_delivery, l.carrier, l.tracking_number,
       l.received_at, l.classroom_confirmed_at,
       (SELECT e.note FROM request_line_events e
         WHERE e.line_id = l.id AND e.note IS NOT NULL
         ORDER BY e.occurred_at DESC LIMIT 1) AS latest_note
FROM supply_request_lines l
JOIN supply_requests r ON r.id = l.request_id AND r.status <> 'draft'
LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id;

-- The same item pending in several classrooms: the office can combine them into one order.
CREATE VIEW v_pending_by_item AS
SELECT r.center_id,
       coalesce(l.catalog_item_id::text, lower(trim(l.custom_name))) AS item_key,
       coalesce(ci.name, l.custom_name) AS item,
       count(DISTINCT r.classroom_id) AS classrooms,
       sum(l.quantity) AS total_quantity
FROM supply_request_lines l
JOIN supply_requests r ON r.id = l.request_id AND r.status <> 'draft'
LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id
WHERE l.status = 'pending'
GROUP BY r.center_id, coalesce(l.catalog_item_id::text, lower(trim(l.custom_name))), coalesce(ci.name, l.custom_name)
HAVING count(DISTINCT r.classroom_id) > 1;

-- Lines that have waited longer than the policy allows, or orders past their expected delivery.
CREATE VIEW v_overdue_request_lines AS
SELECT l.id AS line_id, r.center_id, r.classroom_id, l.status,
       CASE WHEN l.status = 'pending' THEN 'waiting_for_review'
            WHEN l.status IN ('ordered','shipped') THEN 'past_expected_delivery'
            WHEN l.status = 'received' THEN 'not_confirmed_by_teacher' END AS problem
FROM supply_request_lines l
JOIN supply_requests r ON r.id = l.request_id AND r.status <> 'draft'
LEFT JOIN LATERAL (                                       -- the classroom's own policy wins over the center default
  SELECT p.pending_sla_hours FROM approval_policies p
  WHERE p.center_id = r.center_id AND (p.classroom_id = r.classroom_id OR p.classroom_id IS NULL)
  ORDER BY (p.classroom_id IS NOT NULL) DESC
  LIMIT 1
) ap ON true
WHERE (l.status = 'pending' AND r.submitted_at < now() - make_interval(hours => coalesce(ap.pending_sla_hours, 48)))
   OR (l.status IN ('ordered','shipped') AND l.expected_delivery < current_date)
   OR (l.status = 'received' AND l.classroom_confirmed_at IS NULL AND l.received_at < now() - interval '5 days');

-- Stockroom items at or below their reorder level, ready to turn into a purchase order.
CREATE VIEW v_stockroom_reorder_needed AS
SELECT s.center_id, s.catalog_item_id, ci.name AS item, ci.vendor_id, s.on_hand, s.reorder_level, s.reorder_quantity
FROM stockroom_stock s
JOIN catalog_items ci ON ci.id = s.catalog_item_id
WHERE s.on_hand <= s.reorder_level AND ci.is_active;
