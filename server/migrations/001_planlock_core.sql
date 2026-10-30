CREATE TABLE sessions (id text PRIMARY KEY, created_at timestamptz NOT NULL);
CREATE TABLE catalogue_offerings (
  id text PRIMARY KEY, supplier_id text NOT NULL, supplier_name text NOT NULL, name text NOT NULL, service_category text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0), currency text NOT NULL, slots_json jsonb NOT NULL, capacity integer NOT NULL CHECK (capacity >= 0),
  capabilities_json jsonb NOT NULL, requirements_json jsonb NOT NULL, availability_status text NOT NULL, version integer NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE plans (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), user_request text NOT NULL, event_date date NOT NULL, opening_time text NOT NULL,
  timezone text NOT NULL, budget_cents integer NOT NULL CHECK (budget_cents > 0), currency text NOT NULL, required_services_json jsonb NOT NULL,
  constraints_json jsonb NOT NULL, selected_offering_ids_json jsonb NOT NULL, dependencies_json jsonb NOT NULL, validation_issues_json jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0), approval_state text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE plan_reservations (
  id text PRIMARY KEY, plan_id text NOT NULL REFERENCES plans(id), offering_id text NOT NULL REFERENCES catalogue_offerings(id), event_date date NOT NULL,
  slot_id text NOT NULL, quantity integer NOT NULL CHECK (quantity > 0), state text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE plan_events (id text PRIMARY KEY, plan_id text NOT NULL REFERENCES plans(id), event_type text NOT NULL, message text NOT NULL, affected_item_ids_json jsonb NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE plan_ai_proposals (id text PRIMARY KEY, plan_id text NOT NULL REFERENCES plans(id), proposal_json jsonb NOT NULL, created_at timestamptz NOT NULL);
CREATE TABLE plan_bookings (plan_id text PRIMARY KEY REFERENCES plans(id), session_id text NOT NULL REFERENCES sessions(id), plan_version integer NOT NULL, status text NOT NULL, recovery_message text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE TABLE plan_payment_transactions (
  id text PRIMARY KEY, plan_id text NOT NULL REFERENCES plans(id), session_id text NOT NULL REFERENCES sessions(id), plan_version integer NOT NULL, plan_item_id text NOT NULL,
  offering_id text NOT NULL, supplier_id text NOT NULL, supplier_name text NOT NULL, seller_key text NOT NULL, reservation_id text NOT NULL REFERENCES plan_reservations(id),
  service_name text NOT NULL, currency text NOT NULL, amount_cents integer NOT NULL CHECK (amount_cents > 0), status text NOT NULL,
  paypal_order_id text UNIQUE, paypal_authorization_id text UNIQUE, paypal_capture_id text UNIQUE, paypal_refund_id text UNIQUE, refunded_cents integer NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  reconciliation_required boolean NOT NULL DEFAULT false, last_error text, financial_operation text, financial_lock_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE (plan_id, plan_version, plan_item_id)
);
CREATE TABLE plan_payment_events (id text PRIMARY KEY, payment_id text NOT NULL REFERENCES plan_payment_transactions(id), event_type text NOT NULL, message text NOT NULL, created_at timestamptz NOT NULL);
CREATE INDEX idx_plans_session ON plans(session_id, created_at DESC);
CREATE INDEX idx_reservations_capacity ON plan_reservations(offering_id, event_date, slot_id, state, expires_at);
CREATE INDEX idx_payment_plan ON plan_payment_transactions(plan_id, session_id, plan_version);
