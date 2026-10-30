CREATE TABLE recovery_cases (
  id text PRIMARY KEY, plan_id text NOT NULL REFERENCES plans(id), session_id text NOT NULL REFERENCES sessions(id), plan_version integer NOT NULL,
  state text NOT NULL, reason text NOT NULL, dependency_item_ids_json jsonb NOT NULL, pause_captures boolean NOT NULL DEFAULT true,
  original_plan_json jsonb NOT NULL, proposed_plan_json jsonb, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE recovery_approvals (
  id text PRIMARY KEY, recovery_case_id text NOT NULL REFERENCES recovery_cases(id), plan_id text NOT NULL REFERENCES plans(id), plan_version integer NOT NULL,
  scope text NOT NULL, actions_json jsonb NOT NULL, transaction_ids_json jsonb NOT NULL, amount_limit_cents integer CHECK (amount_limit_cents IS NULL OR amount_limit_cents >= 0),
  approved_at timestamptz NOT NULL, expires_at timestamptz, invalidated_at timestamptz
);
CREATE TABLE recovery_actions (
  id text PRIMARY KEY, recovery_case_id text NOT NULL REFERENCES recovery_cases(id), payment_id text NOT NULL REFERENCES plan_payment_transactions(id), action_type text NOT NULL,
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents > 0), requires_approval boolean NOT NULL, status text NOT NULL,
  idempotency_key text NOT NULL UNIQUE, provider_id text, error_message text, attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE NULLS NOT DISTINCT (recovery_case_id, payment_id, action_type, amount_cents)
);
CREATE TABLE incoming_provider_events (
  id text PRIMARY KEY, provider text NOT NULL, provider_event_id text NOT NULL, event_type text NOT NULL, payload_json jsonb NOT NULL,
  received_at timestamptz NOT NULL, accepted_at timestamptz, processed_at timestamptz, rejection_reason text, UNIQUE(provider, provider_event_id)
);
CREATE TABLE background_job_attempts (
  id text PRIMARY KEY, job_key text NOT NULL UNIQUE, job_type text NOT NULL, recovery_case_id text REFERENCES recovery_cases(id), payload_json jsonb NOT NULL,
  status text NOT NULL, attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL, next_attempt_at timestamptz NOT NULL, locked_at timestamptz,
  checkpoint_json jsonb NOT NULL, last_error text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE INDEX idx_recovery_case_plan ON recovery_cases(plan_id, session_id, created_at DESC);
CREATE INDEX idx_recovery_actions_ready ON recovery_actions(recovery_case_id, status, next_attempt_at);
CREATE INDEX idx_jobs_due ON background_job_attempts(status, next_attempt_at);
