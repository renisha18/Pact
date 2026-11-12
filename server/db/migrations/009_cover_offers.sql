-- PRIVATE to the two people involved: a coverer's offer to cover a need_time member's share.
-- The covers row (and the PayPal cover hold) exist only after the member accepts AND the coverer approves.
CREATE TABLE IF NOT EXISTS cover_offers (
  id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id      INT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  coverer_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  covered_id   INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  status       TEXT NOT NULL DEFAULT 'offered'
               CHECK (status IN ('offered', 'accepted', 'declined', 'covered')),
  installments INT CHECK (installments BETWEEN 1 AND 3), -- chosen by the member on accept
  responded_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (coverer_id <> covered_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cover_offers_one_per_member_idx
  ON cover_offers(trip_id, covered_id) WHERE status IN ('offered', 'accepted', 'covered');
CREATE UNIQUE INDEX IF NOT EXISTS cover_offers_one_open_per_coverer_idx
  ON cover_offers(trip_id, coverer_id) WHERE status IN ('offered', 'accepted');

-- PRIVATE: the repayment plan (member repays coverer after the trip).
CREATE TABLE IF NOT EXISTS cover_installments (
  id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  offer_id     INT NOT NULL REFERENCES cover_offers(id) ON DELETE CASCADE,
  n            INT NOT NULL CHECK (n BETWEEN 1 AND 3),
  amount_cents INT NOT NULL CHECK (amount_cents > 0),
  due_date     DATE NOT NULL,
  paid_at      TIMESTAMPTZ,
  UNIQUE (offer_id, n)
);
