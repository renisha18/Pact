-- Availability is stored as date-range blocks; the per-day table is gone.
DROP TABLE IF EXISTS member_availability;
CREATE TABLE IF NOT EXISTS availability_blocks (
  trip_id   INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_day DATE NOT NULL,
  end_day   DATE NOT NULL,
  PRIMARY KEY (trip_id, user_id, start_day),
  CHECK (end_day > start_day)
);
