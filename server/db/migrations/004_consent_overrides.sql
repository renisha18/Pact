-- Consent from an accepted negotiation, scoped to ONE listing. Accepting never edits
-- private_inputs. PRIVATE: rows are only ever used server-side. Idempotent.
-- (private_inputs.allowed_room_types is no longer read or written; kept, not dropped.)
CREATE TABLE IF NOT EXISTS consent_overrides (
  id                      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id                 INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id                 INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  negotiation_id          INT NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  plan_version            INT NOT NULL,
  listing_id              INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind                    TEXT NOT NULL CHECK (kind IN ('budget', 'room_type')),
  accepted_max_share_cents INT CHECK (accepted_max_share_cents >= 0),
  room_type               TEXT,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  accepted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'budget' OR accepted_max_share_cents IS NOT NULL),
  CHECK (kind <> 'room_type' OR room_type IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS consent_overrides_trip_idx ON consent_overrides(trip_id, status);
