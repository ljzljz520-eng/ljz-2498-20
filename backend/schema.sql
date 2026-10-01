-- PostgreSQL reference schema for the Catalpa publishing gate.
-- All tables include the rule/document/version dimensions needed to make
-- a proof result invalid without comparing document.updated_at.

CREATE TABLE IF NOT EXISTS rule_versions (
  version        text PRIMARY KEY,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id                    text PRIMARY KEY,
  title                 text NOT NULL,
  current_version_id    text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id                    text PRIMARY KEY,
  document_id           text NOT NULL REFERENCES documents(id),
  number                bigint NOT NULL,
  content               text NOT NULL,
  content_hash          text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, content_hash),
  UNIQUE (document_id, number)
);

ALTER TABLE documents
  ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id);

CREATE TABLE IF NOT EXISTS resources (
  document_id     text NOT NULL REFERENCES documents(id),
  resource_id     text NOT NULL,
  status          text NOT NULL CHECK (status IN ('active', 'revoked', 'deleted')),
  description     text NOT NULL DEFAULT '',
  version         bigint NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, resource_id)
);

CREATE TABLE IF NOT EXISTS comments (
  document_id     text NOT NULL REFERENCES documents(id),
  id              text NOT NULL,
  line            integer NOT NULL CHECK (line > 0),
  text            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('open', 'resolved')),
  version         bigint NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, id)
);

CREATE TABLE IF NOT EXISTS permissions (
  document_id     text NOT NULL REFERENCES documents(id),
  user_id         text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner', 'author', 'reviewer', 'viewer')),
  version         bigint NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);

-- Attestations returned by the resource checker. A row is only usable when
-- content_hash and resource_version both match the transaction snapshot.
CREATE TABLE IF NOT EXISTS resource_checks (
  document_id       text NOT NULL REFERENCES documents(id),
  resource_id       text NOT NULL,
  document_version  text NOT NULL REFERENCES document_versions(id),
  content_hash      text NOT NULL,
  resource_version  bigint NOT NULL,
  status            text NOT NULL CHECK (status IN ('pending', 'pass', 'fail')),
  evidence_hash     text NOT NULL,
  checked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, resource_id)
);

CREATE TABLE IF NOT EXISTS exemptions (
  id                text PRIMARY KEY,
  document_id       text NOT NULL REFERENCES documents(id),
  document_version  text NOT NULL REFERENCES document_versions(id),
  rule_version      text NOT NULL REFERENCES rule_versions(version),
  code              text NOT NULL,
  fingerprint       text NOT NULL,
  reason            text NOT NULL CHECK (length(btrim(reason)) > 0),
  actor             text NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_exemption_current
  ON exemptions (document_id, document_version, rule_version, fingerprint)
  WHERE active;

-- Complete, immutable validator output. Manifest_hash is a function of content,
-- AST locations, resource versions, comments, permission, resource evidence and
-- matched exemptions; it intentionally excludes timestamps.
CREATE TABLE IF NOT EXISTS validation_runs (
  id                text PRIMARY KEY,
  document_id       text NOT NULL REFERENCES documents(id),
  document_version  text NOT NULL REFERENCES document_versions(id),
  content_hash      text NOT NULL,
  rule_version      text NOT NULL REFERENCES rule_versions(version),
  status            text NOT NULL CHECK (status IN ('passed', 'failed', 'stale')),
  manifest          jsonb NOT NULL,
  manifest_hash     text NOT NULL,
  findings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking_count    integer NOT NULL DEFAULT 0,
  snapshot_id       text,
  stale_reason      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_document
  ON validation_runs (document_id, created_at DESC);

-- One row per deterministic publishable state. It is not a draft copy: content
-- and manifest_hash make the snapshot stable and independent of request timing.
CREATE TABLE IF NOT EXISTS published_snapshots (
  id                text PRIMARY KEY,
  document_id       text NOT NULL REFERENCES documents(id),
  document_version  text NOT NULL REFERENCES document_versions(id),
  content           text NOT NULL,
  content_hash      text NOT NULL,
  rule_version      text NOT NULL REFERENCES rule_versions(version),
  manifest          jsonb NOT NULL,
  manifest_hash     text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, content_hash, manifest_hash, rule_version)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'validation_runs_snapshot_fk'
  ) THEN
    ALTER TABLE validation_runs
      ADD CONSTRAINT validation_runs_snapshot_fk
      FOREIGN KEY (snapshot_id) REFERENCES published_snapshots(id);
  END IF;
END $$;

-- A document has exactly one live release pointer.
CREATE TABLE IF NOT EXISTS publication_pointers (
  document_id     text PRIMARY KEY REFERENCES documents(id),
  snapshot_id     text NOT NULL REFERENCES published_snapshots(id),
  request_id      text NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id              text PRIMARY KEY,
  document_id     text NOT NULL REFERENCES documents(id),
  response        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
