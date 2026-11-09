ALTER TABLE groups ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
DO $$ BEGIN
  ALTER TABLE groups ADD CONSTRAINT groups_description_len CHECK (length(description) <= 160);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
