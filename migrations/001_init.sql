-- Majid Bot Manager V2 — initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT ''
);
INSERT INTO roles(name, description) VALUES
  ('admin','Full platform access'), ('subadmin','Permissions granted by an admin'), ('user','Manages own bots')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS permissions (
  key TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT ''
);
INSERT INTO permissions(key, description) VALUES
  ('users.view','View users'), ('users.manage','Create/edit users'), ('users.suspend','Suspend/activate users'),
  ('bots.view_all','View all bots'), ('bots.manage_all','Control any bot'),
  ('deployments.view_all','View all deployments'), ('settings.manage','Edit system settings & limits'),
  ('audit.view','View audit logs'), ('killswitch.use','Use the global kill switch'), ('subadmins.manage','Manage sub-admins')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' REFERENCES roles(name),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  bot_quota INT NOT NULL DEFAULT 1 CHECK (bot_quota >= 0),
  failed_logins INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  ip TEXT, user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_enc TEXT NOT NULL,
  telegram_id BIGINT,
  telegram_username TEXT,
  language TEXT CHECK (language IN ('python','node','php')),
  entry_point TEXT,
  entry_point_override TEXT,
  manifest JSONB,
  plan TEXT NOT NULL DEFAULT '1c-2g',
  egress_domains TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','queued','deploying','running','stopped','failed','released')),
  sandbox_id TEXT,
  current_deployment_id UUID,
  out_offset BIGINT NOT NULL DEFAULT 0,
  err_offset BIGINT NOT NULL DEFAULT 0,
  stopped_at TIMESTAMPTZ,
  last_deployed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bots_owner_idx ON bots(owner_id);
CREATE INDEX IF NOT EXISTS bots_status_idx ON bots(status);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
  archive_name TEXT,
  file_count INT NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Source of truth for project files (sandboxes are ephemeral). Directories are rows with path ending in '/'.
CREATE TABLE IF NOT EXISTS project_files (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 512),
  content BYTEA NOT NULL DEFAULT ''::bytea,
  size INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'deploy' CHECK (kind IN ('deploy','rebuild','redeploy','restart')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  stage TEXT,
  error TEXT,
  manifest JSONB,
  sandbox_id TEXT,
  pid INT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS deployments_bot_idx ON deployments(bot_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS deployments_status_idx ON deployments(status);

CREATE TABLE IF NOT EXISTS sandbox_instances (
  sandbox_id TEXT PRIMARY KEY,
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  deployment_id UUID REFERENCES deployments(id) ON DELETE SET NULL,
  plan TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sandbox_bot_idx ON sandbox_instances(bot_id);

CREATE TABLE IF NOT EXISTS environment_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  value_enc TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bot_id, key)
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  bot_id UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('system','build','stdout','stderr')),
  text TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS logs_bot_idx ON logs(bot_id, id);
CREATE INDEX IF NOT EXISTS logs_dep_idx ON logs(deployment_id, id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT, target_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit_logs(ts DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO system_settings(key, value) VALUES
  ('registration_open', 'true'),
  ('max_concurrent_sandboxes', '1'),
  ('default_bot_quota', '1'),
  ('allowed_plans', '["1c-2g"]'),
  ('auto_release_minutes', '30'),
  ('kill_switch', 'false'),
  ('budget_warning_usd', '40')
ON CONFLICT DO NOTHING;
