-- EAI 2026 · Session 0 pre-flight seed data.
--
-- Runs once, on the first start of an empty pgdata volume. The doctor script
-- reads the marker back out; that read is what proves the database is not
-- merely running but actually usable.

CREATE TABLE preflight (
    id      integer     PRIMARY KEY,
    marker  text        NOT NULL,
    seeded  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO preflight (id, marker) VALUES (1, 'EAI-2026-S0-OK');
