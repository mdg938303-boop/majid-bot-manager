-- Cost guard: terminate any sandbox that has been alive longer than this many hours (0 = off).
INSERT INTO system_settings(key, value) VALUES ('max_run_hours', '8') ON CONFLICT DO NOTHING;
