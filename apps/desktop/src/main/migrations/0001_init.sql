-- 0001_init.sql · 与 TDD §11.2 对齐
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  source_lang     TEXT NOT NULL DEFAULT 'zh',
  target_lang     TEXT NOT NULL,
  source_path     TEXT NOT NULL,
  source_size_bytes INTEGER,
  source_dur_ms   INTEGER,
  status          TEXT NOT NULL,
  current_stage   TEXT,
  config_json     TEXT NOT NULL,
  cost_total_cents INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_updated ON projects(updated_at DESC);

CREATE TABLE stages (
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage           TEXT NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  inputs_hash     TEXT,
  outputs_json    TEXT,
  error_json      TEXT,
  PRIMARY KEY (project_id, stage)
);

CREATE TABLE segments (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,
  scene_idx       INTEGER,
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  speaker_id      TEXT,
  character_id    TEXT,
  src_text        TEXT,
  src_text_edited TEXT,
  ocr_text        TEXT,
  tgt_text        TEXT,
  tgt_text_edited TEXT,
  tgt_audio_path  TEXT,
  tgt_dur_ms      INTEGER,
  align_decision_json TEXT,
  locked          INTEGER NOT NULL DEFAULT 0,
  emotion         TEXT,
  flag            TEXT,
  UNIQUE (project_id, idx)
);
CREATE INDEX idx_segments_project ON segments(project_id);
CREATE INDEX idx_segments_character ON segments(character_id);

CREATE TABLE characters (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT,
  speaker_id      TEXT NOT NULL,
  gender          TEXT,
  age_band        TEXT,
  voice_id        TEXT,
  voice_status    TEXT,
  voice_expires_at INTEGER,
  needs_reclone   INTEGER NOT NULL DEFAULT 0,
  sample_path     TEXT,
  sample_score    REAL,
  embedding_blob  BLOB
);
CREATE INDEX idx_characters_project ON characters(project_id);

CREATE TABLE voice_assets (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  voice_id        TEXT NOT NULL UNIQUE,
  provider        TEXT NOT NULL DEFAULT 'MiniMax',
  status          TEXT NOT NULL,
  expires_at      INTEGER,
  tags_json       TEXT,
  origin_project_id TEXT,
  sample_path     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_voice_assets_status ON voice_assets(status);

CREATE TABLE term_glossary (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  src             TEXT NOT NULL,
  tgt             TEXT NOT NULL,
  target_lang     TEXT NOT NULL,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE (scope, src, target_lang)
);

CREATE TABLE cost_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT,
  stage           TEXT,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  units           INTEGER NOT NULL,
  unit_kind       TEXT NOT NULL,
  cents           INTEGER NOT NULL,
  request_id      TEXT,
  ts              INTEGER NOT NULL
);
CREATE INDEX idx_cost_project ON cost_entries(project_id);
CREATE INDEX idx_cost_ts ON cost_entries(ts);

CREATE TABLE batches (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  template_json   TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE batch_items (
  batch_id        TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL,
  ord             INTEGER NOT NULL,
  status          TEXT NOT NULL,
  PRIMARY KEY (batch_id, project_id)
);

CREATE VIEW v_project_cost AS
SELECT project_id, SUM(cents) AS total_cents,
       SUM(CASE WHEN provider='MiniMax' AND unit_kind='tokens' THEN cents ELSE 0 END) AS llm_cents,
       SUM(CASE WHEN provider='MiniMax' AND unit_kind='chars'  THEN cents ELSE 0 END) AS tts_cents,
       SUM(CASE WHEN provider='volcengine' THEN cents ELSE 0 END) AS asr_cents
FROM cost_entries GROUP BY project_id;
