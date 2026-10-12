-- Short links: the links, their clicks per day, settings and the request limiter.

-- Slugs are matched ignoring case (COLLATE NOCASE): /Promo and /promo are the same link, and they can't
-- both exist. The slug keeps the case it was typed with.
CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  clicks INTEGER NOT NULL DEFAULT 0,
  last_click_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX links_created_at ON links (created_at);

-- One row per link and UTC day ('YYYY-MM-DD') with at least one click.
CREATE TABLE clicks_daily (
  link_id INTEGER NOT NULL REFERENCES links (id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, day)
);
CREATE INDEX clicks_daily_day ON clicks_daily (day);

-- Values the owner edits in the admin.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('home_url', '');

-- An example so the redirect works on first open: /bohr
INSERT INTO links (slug, url, title) VALUES ('bohr', 'https://bohr.io/', 'bohr');

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
