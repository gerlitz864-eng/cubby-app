-- =====================================================================
-- Cubby: migration 006 (PostgreSQL 14+)
-- Office and administrative purchasing: one master list for everything the facility needs to buy
-- (paper goods, cleaning supplies, general materials), a review-and-approve workflow for the
-- director or administrator, tracking through ordering and delivery, budgets, and vendor invoices.
-- Run after cubby_schema.sql and migrations 002 to 005.
--
-- How it fits with migration 005 (classroom requests):
--   * Classroom requests keep their own approval flow and teacher-facing status.
--   * The office can move an approved classroom line onto this master list (adopt_request_line)
--     so it is bought together with everything else. It arrives already approved.
--   * Purchase orders (from 005) carry both, and one status change on the order updates
--     the master-list item and the teacher's request line together.
-- =====================================================================

CREATE TYPE need_status    AS ENUM ('proposed','pending_approval','on_hold','approved','ordered','shipped','received','denied','cancelled');
CREATE TYPE need_source    AS ENUM ('office','classroom_request','stockroom_reorder','child_supply_reorder','recurring','kitchen','maintenance');
CREATE TYPE batch_status   AS ENUM ('open','submitted','reviewed','closed');
CREATE TYPE invoice_review AS ENUM ('received','matched','disputed','approved_for_payment','paid');
CREATE TYPE need_event     AS ENUM ('created','submitted','status_changed','comment','edited','reminder_sent','escalated');

-- ---------------------------------------------------------------------
-- Policy, budgets, batches
-- ---------------------------------------------------------------------
CREATE TABLE purchasing_policies (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id                 uuid NOT NULL REFERENCES centers(id),
  category_id               uuid REFERENCES catalog_categories(id),   -- NULL = every category
  auto_approve_under_cents  integer NOT NULL DEFAULT 0,               -- 0 = a person reviews everything
  owner_also_over_cents     integer,                                  -- above this, the owner must approve too (two different people)
  review_day_of_week        smallint CHECK (review_day_of_week BETWEEN 1 AND 7)   -- weekly review day, 1 = Monday
);
CREATE UNIQUE INDEX purchasing_policies_uniq
  ON purchasing_policies (center_id, coalesce(category_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE purchasing_budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  category_id   uuid NOT NULL REFERENCES catalog_categories(id),
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (center_id, category_id, period_start),
  CHECK (period_end >= period_start)
);

-- A review batch: "Weekly purchasing review, September 22." The office builds the list, submits the batch,
-- and the director or administrator works through it.
CREATE TABLE purchasing_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid NOT NULL REFERENCES centers(id),
  title         text NOT NULL,
  status        batch_status NOT NULL DEFAULT 'open',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  reviewed_by   uuid REFERENCES users(id),
  reviewed_at   timestamptz,
  notes         text
);

CREATE TABLE recurring_purchases (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id             uuid NOT NULL REFERENCES centers(id),
  catalog_item_id       uuid REFERENCES catalog_items(id),
  custom_name           text,
  category_id           uuid REFERENCES catalog_categories(id),
  quantity              integer NOT NULL CHECK (quantity > 0),
  unit_label            text,
  estimated_unit_cents  integer,
  preferred_vendor_id   uuid REFERENCES vendors(id),
  interval_days         smallint NOT NULL CHECK (interval_days > 0),
  next_due_on           date NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,
  created_by            uuid REFERENCES users(id),
  CHECK (catalog_item_id IS NOT NULL OR custom_name IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- The master list
-- ---------------------------------------------------------------------
CREATE TABLE purchase_needs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id             uuid NOT NULL REFERENCES centers(id),
  batch_id              uuid REFERENCES purchasing_batches(id),
  catalog_item_id       uuid REFERENCES catalog_items(id),
  custom_name           text,
  custom_description    text,
  vendor_url            text,
  category_id           uuid REFERENCES catalog_categories(id),
  quantity              integer NOT NULL CHECK (quantity > 0),
  unit_label            text,
  estimated_unit_cents  integer CHECK (estimated_unit_cents >= 0),
  preferred_vendor_id   uuid REFERENCES vendors(id),
  needed_by             date,
  priority              request_priority NOT NULL DEFAULT 'normal',
  reason                text,
  source                need_source NOT NULL DEFAULT 'office',
  request_line_id       uuid UNIQUE REFERENCES supply_request_lines(id),     -- set when adopted from a classroom request
  recurring_purchase_id uuid REFERENCES recurring_purchases(id),
  pre_approved          boolean NOT NULL DEFAULT false,                      -- already approved elsewhere (a classroom request)
  entered_by            uuid NOT NULL REFERENCES users(id),
  entered_at            timestamptz NOT NULL DEFAULT now(),
  submitted_at          timestamptz,
  status                need_status NOT NULL DEFAULT 'proposed',
  assigned_buyer        uuid REFERENCES users(id),
  reviewed_by           uuid REFERENCES users(id),
  reviewed_at           timestamptz,
  decision_note         text,                                                -- required when denied
  expected_delivery     date,
  CHECK (catalog_item_id IS NOT NULL OR custom_name IS NOT NULL),
  CHECK (status <> 'denied' OR decision_note IS NOT NULL)
);
CREATE INDEX purchase_needs_status_idx ON purchase_needs (center_id, status);
CREATE INDEX purchase_needs_batch_idx ON purchase_needs (batch_id);

CREATE TABLE need_status_transitions (
  from_status  need_status NOT NULL,
  to_status    need_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);
INSERT INTO need_status_transitions (from_status, to_status) VALUES
  ('proposed','pending_approval'), ('proposed','approved'), ('proposed','cancelled'),
  ('pending_approval','approved'), ('pending_approval','denied'), ('pending_approval','on_hold'), ('pending_approval','cancelled'),
  ('on_hold','pending_approval'), ('on_hold','denied'), ('on_hold','cancelled'),
  ('approved','ordered'), ('approved','on_hold'), ('approved','cancelled'),
  ('ordered','approved'), ('ordered','shipped'), ('ordered','received'), ('ordered','cancelled'),
  ('shipped','received'),
  ('denied','proposed');

-- Approvals. Above the policy limit, the owner must approve as well as the director, and they must be two different people.
CREATE TABLE need_approvals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  need_id        uuid NOT NULL REFERENCES purchase_needs(id),
  required_role  user_role NOT NULL,
  decision       approval_decision,
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  note           text,
  UNIQUE (need_id, required_role),
  CHECK (decision IS DISTINCT FROM 'denied' OR note IS NOT NULL)
);

CREATE TABLE purchase_need_events (
  id             bigserial PRIMARY KEY,
  need_id        uuid NOT NULL REFERENCES purchase_needs(id),
  event          need_event NOT NULL,
  actor_user_id  uuid REFERENCES users(id),
  from_status    need_status,
  to_status      need_status,
  note           text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_need_events_idx ON purchase_need_events (need_id, occurred_at);

-- ---------------------------------------------------------------------
-- Purchase orders carry master-list items too, and partial deliveries
-- ---------------------------------------------------------------------
ALTER TABLE purchase_order_lines
  ADD COLUMN need_id            uuid UNIQUE REFERENCES purchase_needs(id),
  ADD COLUMN quantity_received  integer NOT NULL DEFAULT 0,
  ADD COLUMN received_at        timestamptz;
ALTER TABLE purchase_order_lines DROP CONSTRAINT IF EXISTS purchase_order_lines_check;
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT po_lines_has_source CHECK (num_nonnulls(request_line_id, catalog_item_id, need_id) >= 1);

CREATE TABLE vendor_invoices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id            uuid NOT NULL REFERENCES centers(id),
  vendor_id            uuid NOT NULL REFERENCES vendors(id),
  purchase_order_id    uuid REFERENCES purchase_orders(id),
  invoice_number       text NOT NULL,
  invoice_date         date NOT NULL,
  due_date             date,
  total_cents          integer NOT NULL,
  document_id          uuid REFERENCES documents(id),      -- scanned invoice; food invoices are kept for state review
  status               invoice_review NOT NULL DEFAULT 'received',
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  paid_on              date,
  payment_reference    text,
  notes                text,
  UNIQUE (vendor_id, invoice_number)
);
CREATE INDEX vendor_invoices_due_idx ON vendor_invoices (due_date) WHERE status <> 'paid';

-- ---------------------------------------------------------------------
-- Functions and triggers
-- ---------------------------------------------------------------------

-- Refuse status changes the workflow does not allow.
CREATE FUNCTION need_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status
     AND NOT EXISTS (SELECT 1 FROM need_status_transitions t
                     WHERE t.from_status = OLD.status AND t.to_status = NEW.status) THEN
    RAISE EXCEPTION 'A purchase item cannot move from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER need_status_guard_trg BEFORE UPDATE OF status ON purchase_needs
  FOR EACH ROW EXECUTE FUNCTION need_status_guard();

-- History of every status change. The application sets: SET LOCAL app.user_id = '<user uuid>'.
CREATE FUNCTION need_status_log() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status THEN
    INSERT INTO purchase_need_events (need_id, event, actor_user_id, from_status, to_status, note)
    VALUES (NEW.id, 'status_changed', nullif(current_setting('app.user_id', true), '')::uuid,
            OLD.status, NEW.status, NEW.decision_note);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER need_status_log_trg AFTER UPDATE OF status ON purchase_needs
  FOR EACH ROW EXECUTE FUNCTION need_status_log();

-- Separation of duties: nobody approves their own item, the approver must hold the required role
-- (an owner may stand in), and one person cannot supply both approvals on a dual-approval item.
CREATE FUNCTION need_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entered uuid;
  v_role    user_role;
BEGIN
  IF NEW.decided_by IS NOT NULL THEN
    SELECT n.entered_by INTO v_entered FROM purchase_needs n WHERE n.id = NEW.need_id;
    IF NEW.decided_by = v_entered THEN
      RAISE EXCEPTION 'The person who entered an item cannot approve it';
    END IF;
    SELECT u.role INTO v_role FROM users u WHERE u.id = NEW.decided_by;
    IF v_role IS DISTINCT FROM NEW.required_role AND v_role IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'This approval requires the % role', NEW.required_role;
    END IF;
    IF EXISTS (SELECT 1 FROM need_approvals a
               WHERE a.need_id = NEW.need_id AND a.id <> NEW.id AND a.decided_by = NEW.decided_by) THEN
      RAISE EXCEPTION 'A second approval must come from a different person';
    END IF;
    NEW.decided_at := coalesce(NEW.decided_at, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER need_approval_guard_trg BEFORE INSERT OR UPDATE ON need_approvals
  FOR EACH ROW EXECUTE FUNCTION need_approval_guard();

-- When approvals come in: any denial denies the item; when every required approval is in, the item is approved.
CREATE FUNCTION need_approval_apply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision = 'denied' THEN
    UPDATE purchase_needs
       SET status = 'denied', decision_note = coalesce(NEW.note, decision_note),
           reviewed_by = NEW.decided_by, reviewed_at = now()
     WHERE id = NEW.need_id AND status = 'pending_approval';
  ELSIF NEW.decision = 'approved'
        AND NOT EXISTS (SELECT 1 FROM need_approvals a
                        WHERE a.need_id = NEW.need_id AND a.decision IS DISTINCT FROM 'approved') THEN
    UPDATE purchase_needs
       SET status = 'approved', reviewed_by = NEW.decided_by, reviewed_at = now()
     WHERE id = NEW.need_id AND status = 'pending_approval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER need_approval_apply_trg AFTER INSERT OR UPDATE OF decision ON need_approvals
  FOR EACH ROW EXECUTE FUNCTION need_approval_apply();

-- Send an item for review. Under the auto-approve limit it is approved at once; otherwise it needs the director,
-- and the owner as well above the dual-approval limit.
CREATE FUNCTION submit_need_for_approval(p_need uuid) RETURNS need_status
LANGUAGE plpgsql AS $$
DECLARE
  v_center uuid;
  v_cat    uuid;
  v_total  bigint;
  v_auto   integer;
  v_dual   integer;
BEGIN
  SELECT n.center_id, n.category_id, n.quantity::bigint * coalesce(n.estimated_unit_cents, 0)
    INTO v_center, v_cat, v_total
  FROM purchase_needs n
  WHERE n.id = p_need AND n.status = 'proposed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item % is not waiting to be submitted', p_need;
  END IF;

  SELECT p.auto_approve_under_cents, p.owner_also_over_cents INTO v_auto, v_dual
  FROM purchasing_policies p
  WHERE p.center_id = v_center AND (p.category_id = v_cat OR p.category_id IS NULL)
  ORDER BY (p.category_id IS NOT NULL) DESC
  LIMIT 1;
  v_auto := coalesce(v_auto, 0);

  IF v_total < v_auto THEN
    UPDATE purchase_needs SET status = 'approved', submitted_at = now(), reviewed_at = now() WHERE id = p_need;
  ELSE
    INSERT INTO need_approvals (need_id, required_role) VALUES (p_need, 'director') ON CONFLICT DO NOTHING;
    IF v_dual IS NOT NULL AND v_total >= v_dual THEN
      INSERT INTO need_approvals (need_id, required_role) VALUES (p_need, 'owner') ON CONFLICT DO NOTHING;
    END IF;
    UPDATE purchase_needs SET status = 'pending_approval', submitted_at = now() WHERE id = p_need;
  END IF;

  RETURN (SELECT status FROM purchase_needs WHERE id = p_need);
END $$;

-- Put an approved classroom line on the master list, already approved, so it is bought with everything else.
CREATE FUNCTION adopt_request_line(p_line uuid, p_user uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_need uuid;
BEGIN
  INSERT INTO purchase_needs
    (center_id, catalog_item_id, custom_name, custom_description, vendor_url, category_id, quantity, unit_label,
     estimated_unit_cents, needed_by, priority, reason, source, request_line_id, pre_approved, entered_by, status)
  SELECT r.center_id, l.catalog_item_id, l.custom_name, l.custom_description, l.custom_url, ci.category_id,
         coalesce(l.approved_quantity, l.quantity), l.unit_label, l.estimated_unit_cents,
         r.needed_by, r.priority, l.reason, 'classroom_request', l.id, true, p_user, 'approved'
  FROM supply_request_lines l
  JOIN supply_requests r ON r.id = l.request_id
  LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id
  WHERE l.id = p_line AND l.status = 'approved'
  RETURNING id INTO v_need;

  IF v_need IS NULL THEN
    RAISE EXCEPTION 'Request line % does not exist or is not approved', p_line;
  END IF;
  RETURN v_need;
END $$;

-- Replaces the version from migration 005. One status change on a purchase order now moves
-- both the classroom request lines and the master-list items on it.
CREATE OR REPLACE FUNCTION po_status_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'ordered' THEN
    UPDATE supply_request_lines l
       SET status = 'ordered', expected_delivery = coalesce(NEW.expected_delivery, l.expected_delivery)
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status = 'approved';
    UPDATE purchase_needs n
       SET status = 'ordered', expected_delivery = coalesce(NEW.expected_delivery, n.expected_delivery)
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.need_id = n.id AND n.status = 'approved';

  ELSIF NEW.status = 'shipped' THEN
    UPDATE supply_request_lines l
       SET status = 'shipped', carrier = NEW.carrier, tracking_number = NEW.tracking_number,
           expected_delivery = coalesce(NEW.expected_delivery, l.expected_delivery)
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status = 'ordered';
    UPDATE purchase_needs n
       SET status = 'shipped', expected_delivery = coalesce(NEW.expected_delivery, n.expected_delivery)
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.need_id = n.id AND n.status = 'ordered';

  ELSIF NEW.status = 'delivered' THEN
    UPDATE supply_request_lines l
       SET status = 'received', received_at = now()
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status IN ('ordered','shipped');
    UPDATE purchase_needs n
       SET status = 'received'
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.need_id = n.id AND n.status IN ('ordered','shipped');
    UPDATE purchase_order_lines
       SET quantity_received = quantity, received_at = coalesce(received_at, now())
     WHERE purchase_order_id = NEW.id AND quantity_received = 0;

  ELSIF NEW.status = 'cancelled' THEN
    UPDATE supply_request_lines l
       SET status = 'approved'
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.request_line_id = l.id AND l.status = 'ordered';
    UPDATE purchase_needs n
       SET status = 'approved'
      FROM purchase_order_lines pl
     WHERE pl.purchase_order_id = NEW.id AND pl.need_id = n.id AND n.status = 'ordered';
  END IF;

  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------

-- The master list: everything open, with source, category, vendor, and who still has to approve it.
CREATE VIEW v_master_purchase_list AS
SELECT n.id AS need_id, n.center_id,
       coalesce(ci.name, n.custom_name) AS item,
       cc.name AS category, n.source, n.status, n.priority,
       n.quantity, n.unit_label, n.estimated_unit_cents,
       n.quantity::bigint * coalesce(n.estimated_unit_cents, 0) AS estimated_total_cents,
       v.name AS vendor, n.needed_by, n.batch_id, b.title AS batch_title,
       n.entered_at, u.email AS entered_by_email,
       (SELECT string_agg(a.required_role::text, ', ')
          FROM need_approvals a WHERE a.need_id = n.id AND a.decision IS NULL) AS awaiting_approval_from
FROM purchase_needs n
JOIN users u ON u.id = n.entered_by
LEFT JOIN catalog_items ci ON ci.id = n.catalog_item_id
LEFT JOIN catalog_categories cc ON cc.id = coalesce(n.category_id, ci.category_id)
LEFT JOIN vendors v ON v.id = coalesce(n.preferred_vendor_id, ci.vendor_id)
LEFT JOIN purchasing_batches b ON b.id = n.batch_id
WHERE n.status NOT IN ('received','cancelled','denied');

-- Budget position by category.
CREATE VIEW v_purchasing_budget_status AS
SELECT x.*, x.amount_cents - x.committed_cents AS remaining_cents
FROM (
  SELECT b.id AS budget_id, b.center_id, b.category_id, b.period_start, b.period_end, b.amount_cents,
         coalesce(sum(coalesce(pl.unit_cost_cents, n.estimated_unit_cents, 0)::bigint * n.quantity)
                  FILTER (WHERE n.status IN ('approved','ordered','shipped','received')), 0)::bigint AS committed_cents
  FROM purchasing_budgets b
  LEFT JOIN purchase_needs n
         ON n.center_id = b.center_id AND n.category_id = b.category_id
        AND coalesce(n.needed_by, n.entered_at::date) BETWEEN b.period_start AND b.period_end
  LEFT JOIN purchase_order_lines pl ON pl.need_id = n.id
  GROUP BY b.id
) x;

-- The director's review queue, with the budget left in each item's category.
CREATE VIEW v_director_review_queue AS
SELECT m.need_id, m.center_id, m.item, m.category, m.source, m.priority, m.quantity,
       m.estimated_total_cents, m.vendor, m.needed_by, m.batch_title, m.awaiting_approval_from,
       round(extract(epoch FROM now() - n.submitted_at) / 3600) AS hours_waiting,
       bs.remaining_cents AS category_budget_remaining_cents
FROM v_master_purchase_list m
JOIN purchase_needs n ON n.id = m.need_id AND n.status = 'pending_approval'
LEFT JOIN v_purchasing_budget_status bs
       ON bs.category_id = n.category_id AND current_date BETWEEN bs.period_start AND bs.period_end;

-- The buyer's list: approved items not yet on a purchase order, grouped by vendor.
CREATE VIEW v_needs_to_order_by_vendor AS
SELECT n.center_id, coalesce(n.preferred_vendor_id, ci.vendor_id) AS vendor_id, v.name AS vendor,
       count(*) AS items, sum(n.quantity::bigint * coalesce(n.estimated_unit_cents, 0)) AS estimated_total_cents
FROM purchase_needs n
LEFT JOIN catalog_items ci ON ci.id = n.catalog_item_id
LEFT JOIN vendors v ON v.id = coalesce(n.preferred_vendor_id, ci.vendor_id)
WHERE n.status = 'approved'
  AND NOT EXISTS (SELECT 1 FROM purchase_order_lines pl WHERE pl.need_id = n.id)
GROUP BY n.center_id, coalesce(n.preferred_vendor_id, ci.vendor_id), v.name;

-- Items in the purchasing stage: order number, tracking, expected date, and days late.
CREATE VIEW v_purchasing_pipeline AS
SELECT n.id AS need_id, n.center_id, coalesce(ci.name, n.custom_name) AS item, n.status,
       po.po_number, po.status AS po_status, v.name AS vendor, po.ordered_at,
       coalesce(po.expected_delivery, n.expected_delivery) AS expected_delivery,
       po.carrier, po.tracking_number,
       greatest(current_date - coalesce(po.expected_delivery, n.expected_delivery), 0) AS days_late
FROM purchase_needs n
LEFT JOIN catalog_items ci ON ci.id = n.catalog_item_id
LEFT JOIN purchase_order_lines pl ON pl.need_id = n.id
LEFT JOIN purchase_orders po ON po.id = pl.purchase_order_id
LEFT JOIN vendors v ON v.id = po.vendor_id
WHERE n.status IN ('approved','ordered','shipped');

-- Order lines where less arrived than was ordered.
CREATE VIEW v_po_receiving_gaps AS
SELECT po.center_id, po.po_number, pl.description, pl.quantity AS ordered, pl.quantity_received AS received,
       pl.quantity - pl.quantity_received AS short_by
FROM purchase_order_lines pl
JOIN purchase_orders po ON po.id = pl.purchase_order_id
WHERE po.status = 'delivered' AND pl.quantity_received < pl.quantity;

-- Does the vendor's invoice agree with the purchase order? A difference over 2% is flagged.
CREATE VIEW v_invoice_po_match AS
SELECT y.*, y.invoice_total_cents - y.po_total_cents AS difference_cents,
       abs(y.invoice_total_cents - y.po_total_cents) <= 0.02 * greatest(y.po_total_cents, 1) AS within_tolerance
FROM (
  SELECT vi.id AS invoice_id, vi.center_id, vi.vendor_id, vi.invoice_number, vi.due_date, vi.status,
         po.po_number, vi.total_cents AS invoice_total_cents,
         (SELECT coalesce(sum(pl.quantity::bigint * coalesce(pl.unit_cost_cents, 0)), 0)
            FROM purchase_order_lines pl WHERE pl.purchase_order_id = po.id)
         + coalesce(po.shipping_cents, 0) + coalesce(po.tax_cents, 0) AS po_total_cents
  FROM vendor_invoices vi
  JOIN purchase_orders po ON po.id = vi.purchase_order_id
) y;

-- Spending by category and month, from purchase orders.
CREATE VIEW v_spend_by_category_month AS
SELECT po.center_id, date_trunc('month', po.ordered_at)::date AS month, cc.name AS category,
       sum(pl.quantity::bigint * coalesce(pl.unit_cost_cents, 0)) AS spend_cents
FROM purchase_order_lines pl
JOIN purchase_orders po ON po.id = pl.purchase_order_id AND po.status <> 'cancelled' AND po.ordered_at IS NOT NULL
LEFT JOIN catalog_items ci ON ci.id = pl.catalog_item_id
LEFT JOIN purchase_needs n ON n.id = pl.need_id
LEFT JOIN catalog_categories cc ON cc.id = coalesce(n.category_id, ci.category_id)
GROUP BY po.center_id, date_trunc('month', po.ordered_at)::date, cc.name;
