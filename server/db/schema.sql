-- Pact schema. Money columns are integer cents.
-- Tables marked PRIVATE are returned only to their owning user.

CREATE TABLE IF NOT EXISTS users (
  id                   INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                 TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  email                TEXT NOT NULL UNIQUE,
  avatar_emoji         TEXT NOT NULL DEFAULT '🙂',
  paypal_sandbox_email TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  emoji        TEXT NOT NULL DEFAULT '🏝️',
  personality  TEXT NOT NULL DEFAULT 'chill'
               CHECK (personality IN ('chill', 'wholesome', 'savage')),
  invite_token TEXT NOT NULL UNIQUE,
  created_by   INT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('organizer', 'member')),
  fun_title TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members(user_id);

CREATE TABLE IF NOT EXISTS listings (
  id                    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                  TEXT NOT NULL,
  region                TEXT NOT NULL DEFAULT 'Bali',
  area                  TEXT NOT NULL,
  price_per_night_cents INT NOT NULL CHECK (price_per_night_cents > 0),
  max_guests            INT NOT NULL CHECK (max_guests > 0),
  room_type             TEXT NOT NULL
                        CHECK (room_type IN ('private_rooms', 'shared_rooms', 'mixed_dorm')),
  amenities             TEXT[] NOT NULL DEFAULT '{}',
  vibe_tags             TEXT[] NOT NULL DEFAULT '{}',
  house_rules           TEXT NOT NULL DEFAULT '',
  emoji                 TEXT NOT NULL DEFAULT '🏠',
  description           TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS trips (
  id                INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id          INT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  region            TEXT NOT NULL DEFAULT 'Bali',
  start_date        DATE NOT NULL,
  end_date          DATE NOT NULL,
  nights            INT NOT NULL CHECK (nights > 0),
  status            TEXT NOT NULL DEFAULT 'collecting'
                    CHECK (status IN ('collecting', 'planning', 'voting', 'committing', 'booked', 'cancelled')),
  chosen_listing_id INT REFERENCES listings(id) ON DELETE SET NULL,
  booking_deadline  TIMESTAMPTZ,
  created_by        INT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date > start_date)
);
CREATE INDEX IF NOT EXISTS trips_group_idx ON trips(group_id);

CREATE TABLE IF NOT EXISTS trip_members (
  trip_id         INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'invited'
                  CHECK (status IN ('invited', 'submitted', 'committed', 'dropped')),
  commitment_type TEXT CHECK (commitment_type IN ('hold', 'pay_by_date', 'need_time')),
  roast_level     TEXT NOT NULL DEFAULT 'mild' CHECK (roast_level IN ('off', 'mild', 'savage')),
  PRIMARY KEY (trip_id, user_id)
);
CREATE INDEX IF NOT EXISTS trip_members_user_idx ON trip_members(user_id);

-- PRIVATE
CREATE TABLE IF NOT EXISTS private_inputs (
  trip_id          INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_budget_cents INT NOT NULL CHECK (max_budget_cents >= 0),
  preferences_text TEXT NOT NULL DEFAULT '',
  comfort_text     TEXT NOT NULL DEFAULT '',
  extracted_json   JSONB,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, user_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  listing_id  INT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  total_cents INT NOT NULL CHECK (total_cents >= 0),
  reason_text TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposals_trip_idx ON proposals(trip_id);

CREATE TABLE IF NOT EXISTS votes (
  trip_id     INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposal_id INT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  PRIMARY KEY (trip_id, user_id)
);

-- PRIVATE
CREATE TABLE IF NOT EXISTS shares (
  trip_id      INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (trip_id, user_id)
);

CREATE TABLE IF NOT EXISTS covers (
  id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id      INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  coverer_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  covered_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  repaid_cents INT NOT NULL DEFAULT 0 CHECK (repaid_cents >= 0),
  CHECK (coverer_id <> covered_id),
  CHECK (repaid_cents <= amount_cents)
);
CREATE INDEX IF NOT EXISTS covers_trip_idx ON covers(trip_id);

-- PRIVATE
CREATE TABLE IF NOT EXISTS payments (
  id                      INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id                 INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id                 INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                    TEXT NOT NULL
                          CHECK (kind IN ('hold', 'cover_hold', 'payment', 'installment')),
  paypal_order_id         TEXT,
  paypal_authorization_id TEXT,
  paypal_capture_id       TEXT,
  amount_cents            INT NOT NULL CHECK (amount_cents > 0),
  status                  TEXT NOT NULL DEFAULT 'created'
                          CHECK (status IN ('created', 'approved', 'authorized', 'captured', 'voided', 'paid', 'failed')),
  due_date                DATE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_trip_user_idx ON payments(trip_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS payments_paypal_order_idx
  ON payments(paypal_order_id) WHERE paypal_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_log (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id       INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  actor_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  details       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS event_log_trip_idx ON event_log(trip_id, created_at);

CREATE TABLE IF NOT EXISTS group_taste (
  group_id     INT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  summary_json JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
