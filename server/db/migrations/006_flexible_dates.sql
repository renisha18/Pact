ALTER TABLE trips ADD COLUMN IF NOT EXISTS window_start DATE;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS window_end DATE;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS dates_status TEXT NOT NULL DEFAULT 'chosen';
ALTER TABLE trips ADD COLUMN IF NOT EXISTS date_options JSONB;
DO $$ BEGIN
  ALTER TABLE trips ADD CONSTRAINT trips_dates_status_check CHECK (dates_status IN ('deciding', 'pick', 'chosen'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
