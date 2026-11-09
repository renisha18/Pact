-- Concurrency-safe planning. Idempotent.
-- trips.plan_version: run claim counter (bumped when a plan starts; 60s guard only).
-- trips.active_version: version of the last SUCCESSFUL save. Proposals, votes and
-- negotiations are valid only when their plan_version = active_version.
ALTER TABLE trips        ADD COLUMN IF NOT EXISTS plan_version        INT NOT NULL DEFAULT 0;
ALTER TABLE trips        ADD COLUMN IF NOT EXISTS active_version      INT NOT NULL DEFAULT 0;
ALTER TABLE trips        ADD COLUMN IF NOT EXISTS planning_started_at TIMESTAMPTZ;
ALTER TABLE proposals    ADD COLUMN IF NOT EXISTS plan_version        INT NOT NULL DEFAULT 0;
ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS plan_version        INT NOT NULL DEFAULT 0;
-- Snapshot of the member's private_inputs.updated_at when the ask was written.
ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS input_updated_at    TIMESTAMPTZ;
-- When the member accepted/declined: a plan that started earlier is stale.
ALTER TABLE negotiations ADD COLUMN IF NOT EXISTS responded_at        TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS proposals_trip_version_idx ON proposals(trip_id, plan_version);
