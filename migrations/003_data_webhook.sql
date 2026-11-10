-- Persistent bot data (the bot's data/ folder, gzipped tar) + webhook-bridge settings.
CREATE TABLE IF NOT EXISTS bot_data (
  bot_id UUID PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  archive BYTEA NOT NULL,
  size INT NOT NULL,
  sha TEXT NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE bots ADD COLUMN IF NOT EXISTS webhook_port INT CHECK (webhook_port IS NULL OR webhook_port BETWEEN 1024 AND 65535);
ALTER TABLE bots ADD COLUMN IF NOT EXISTS webhook_path TEXT NOT NULL DEFAULT '/';
