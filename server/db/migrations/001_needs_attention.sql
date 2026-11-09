-- Adds trip status 'needs_attention', payment status 'refunded', and
-- payments.covers_user_id. Idempotent: safe to run on every migrate.
ALTER TABLE trips DROP CONSTRAINT IF EXISTS trips_status_check;
ALTER TABLE trips ADD CONSTRAINT trips_status_check
  CHECK (status IN ('collecting', 'planning', 'voting', 'committing', 'needs_attention', 'booked', 'cancelled'));

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('created', 'approved', 'authorized', 'captured', 'voided', 'paid', 'failed', 'refunded'));

ALTER TABLE payments ADD COLUMN IF NOT EXISTS covers_user_id INT REFERENCES users(id) ON DELETE SET NULL;
