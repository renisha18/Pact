-- Adds private negotiations and private_inputs.allowed_room_types. Idempotent.
ALTER TABLE private_inputs ADD COLUMN IF NOT EXISTS allowed_room_types TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS negotiations (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  change_json JSONB NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS negotiations_trip_idx ON negotiations(trip_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS negotiations_one_pending_idx
  ON negotiations(trip_id, user_id) WHERE status = 'pending';
