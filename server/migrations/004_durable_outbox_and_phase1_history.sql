CREATE TABLE IF NOT EXISTS supplier_failure_outbox (
  id text PRIMARY KEY, plan_id text NOT NULL REFERENCES plans(id), session_id text NOT NULL REFERENCES sessions(id), plan_version integer NOT NULL,
  reason text NOT NULL, dependency_item_ids_json jsonb NOT NULL, selected_offering_ids_json jsonb NOT NULL, created_at timestamptz NOT NULL,
  dispatched_at timestamptz, UNIQUE(plan_id, plan_version)
);

CREATE TABLE IF NOT EXISTS transactions (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id), supplier_name text NOT NULL, service_name text NOT NULL,
  includes text NOT NULL, currency text NOT NULL, amount text NOT NULL, status text NOT NULL, paypal_order_id text UNIQUE,
  paypal_authorization_id text UNIQUE, paypal_capture_id text UNIQUE, reconciliation_required boolean NOT NULL DEFAULT false,
  active_operation text, last_error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS operation_attempts (
  id text PRIMARY KEY, transaction_id text NOT NULL REFERENCES transactions(id), operation text NOT NULL, request_id text NOT NULL,
  outcome text NOT NULL, paypal_status text, error_code text, error_message text, started_at timestamptz NOT NULL, finished_at timestamptz,
  UNIQUE(transaction_id, operation)
);
CREATE TABLE IF NOT EXISTS activity_events (
  id text PRIMARY KEY, transaction_id text NOT NULL REFERENCES transactions(id), event_type text NOT NULL,
  message text NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_failure_outbox_pending ON supplier_failure_outbox(dispatched_at, created_at);
CREATE INDEX IF NOT EXISTS idx_transactions_session ON transactions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_attempts_transaction ON operation_attempts(transaction_id, started_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_transaction ON activity_events(transaction_id, created_at);
