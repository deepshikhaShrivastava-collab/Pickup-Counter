-- All money is stored as integer paise (1 INR = 100 paise). Never floats.

CREATE TABLE products (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku           TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  price_paise   INTEGER NOT NULL CHECK (price_paise > 0),
  -- Physical units on the shelf. Only decremented when an order is picked up.
  stock_on_hand INTEGER NOT NULL CHECK (stock_on_hand >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE order_status AS ENUM (
  'pending_payment', -- holding stock, waiting for a payment webhook
  'paid',            -- paid in full, stock committed until pickup
  'needs_review',    -- payment received but something is off (amount mismatch, late payment)
  'expired',         -- hold window passed without payment, holds released
  'picked_up'        -- handed over, stock permanently deducted
);

CREATE TABLE orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status        order_status NOT NULL DEFAULT 'pending_payment',
  total_paise   INTEGER NOT NULL CHECK (total_paise > 0),
  expires_at    TIMESTAMPTZ NOT NULL,
  review_reason TEXT,
  paid_at       TIMESTAMPTZ,
  picked_up_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX orders_pending_expiry_idx ON orders (expires_at) WHERE status = 'pending_payment';

CREATE TABLE order_items (
  order_id         UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products (id),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise > 0),
  PRIMARY KEY (order_id, product_id)
);

CREATE TYPE hold_status AS ENUM (
  'active',    -- time-limited reservation for an unpaid order (expires_at set)
  'committed', -- reservation for a paid / under-review order, no expiry
  'released',  -- returned to available stock
  'consumed'   -- turned into a permanent stock deduction at pickup
);

CREATE TABLE holds (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products (id),
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  status      hold_status NOT NULL DEFAULT 'active',
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  CHECK (status <> 'active' OR expires_at IS NOT NULL)
);

CREATE INDEX holds_reserving_idx ON holds (product_id) WHERE status IN ('active', 'committed');
CREATE INDEX holds_order_idx ON holds (order_id);

-- Available = on hand minus every hold that still reserves stock. An 'active' hold whose
-- expires_at has passed no longer counts, even if the expiry sweeper has not run yet.
CREATE VIEW product_availability AS
SELECT p.id AS product_id,
       p.stock_on_hand,
       COALESCE(SUM(h.quantity), 0)::int                   AS held,
       (p.stock_on_hand - COALESCE(SUM(h.quantity), 0))::int AS available
FROM products p
LEFT JOIN holds h
  ON h.product_id = p.id
 AND (h.status = 'committed' OR (h.status = 'active' AND h.expires_at > now()))
GROUP BY p.id;

-- One row per payment provider event. The primary key makes webhook processing idempotent.
CREATE TABLE payment_events (
  event_id     TEXT PRIMARY KEY,
  order_id     UUID,          -- not a FK: events for unknown orders are still recorded
  amount_paise INTEGER NOT NULL,
  outcome      TEXT NOT NULL DEFAULT 'processing',
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payment_events_order_idx ON payment_events (order_id);
