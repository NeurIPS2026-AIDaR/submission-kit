CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  author_token_hmac TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  status TEXT NOT NULL,
  repo_id INTEGER,
  repo_name TEXT,
  pr_number INTEGER,
  submission_branch TEXT NOT NULL DEFAULT 'submission',
  branch_head_sha TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  package_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS submissions_external_id_unique
ON submissions(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reviewers (
  submission_id TEXT NOT NULL,
  github_login TEXT NOT NULL,
  state TEXT NOT NULL,
  invited_at TEXT,
  accepted_at TEXT,
  review_requested_at TEXT,
  removed_at TEXT,
  PRIMARY KEY (submission_id, github_login),
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  github_comment_id INTEGER,
  reply_to_review_comment_id INTEGER,
  body_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  submission_id TEXT,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  github_object_id TEXT,
  payload_sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mock_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT NOT NULL,
  reviewer_login TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  state TEXT,
  created_at TEXT NOT NULL
);
