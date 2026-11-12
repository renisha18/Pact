ALTER TABLE private_inputs ADD COLUMN IF NOT EXISTS must_have_chips TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE private_inputs ADD COLUMN IF NOT EXISTS nice_to_have_chips TEXT[] NOT NULL DEFAULT '{}';
