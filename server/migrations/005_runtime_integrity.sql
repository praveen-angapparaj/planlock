-- Runtime invariants used by the PostgreSQL repositories. Existing data is preserved.
ALTER TABLE plan_payment_transactions
  ADD CONSTRAINT plan_payment_refund_total_check
  CHECK (refunded_cents + pending_refund_cents <= amount_cents) NOT VALID;
ALTER TABLE plan_payment_transactions VALIDATE CONSTRAINT plan_payment_refund_total_check;

CREATE UNIQUE INDEX IF NOT EXISTS idx_recovery_one_open_case_per_plan_version
  ON recovery_cases(plan_id, plan_version) WHERE state <> 'RESOLVED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_reservation_per_plan_item
  ON plan_reservations(plan_id, offering_id, event_date, slot_id) WHERE state = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_plan_payment_operation_claim
  ON plan_payment_transactions(id) WHERE financial_operation IS NULL AND reconciliation_required = false;
CREATE INDEX IF NOT EXISTS idx_provider_events_unprocessed
  ON incoming_provider_events(provider, provider_event_id) WHERE processed_at IS NULL AND rejection_reason IS NULL;
