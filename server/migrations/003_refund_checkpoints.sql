ALTER TABLE plan_payment_transactions
  ADD COLUMN IF NOT EXISTS pending_refund_cents integer NOT NULL DEFAULT 0
  CHECK (pending_refund_cents >= 0);
