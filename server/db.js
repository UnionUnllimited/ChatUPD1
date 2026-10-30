import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,                 -- Telegram user id
  username TEXT,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT,
  photo_url TEXT,
  language_code TEXT,
  active_role TEXT NOT NULL DEFAULT 'client',
  is_blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  bot_chat_allowed INTEGER NOT NULL DEFAULT 0,  -- the platform bot may message this user
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- Open-ended role list: future roles (contractor, channel_owner, ...) are just new rows.
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS user_notify (
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  PRIMARY KEY (user_id, type)
);

-- The row always holds the published version of a card; edits wait in service_revisions.
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft',   -- draft (never published) | published
  hidden INTEGER NOT NULL DEFAULT 0,      -- hidden from the catalog by an admin
  hidden_reason TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  logo_url TEXT,
  bot_url TEXT NOT NULL,
  channel_url TEXT,
  support_contact TEXT,
  devices INTEGER NOT NULL DEFAULT 1,
  protocols TEXT NOT NULL DEFAULT '[]',
  countries TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL DEFAULT '[]',
  payments TEXT NOT NULL DEFAULT '[]',
  whitelist_bypass INTEGER NOT NULL DEFAULT 0,
  whitelist_note TEXT,
  trial INTEGER NOT NULL DEFAULT 0,
  trial_days INTEGER,
  trial_terms TEXT,
  min_monthly INTEGER,                    -- cheapest monthly price across tariffs, rubles
  base_monthly INTEGER,                   -- 1-month price, used for the market label
  published_at INTEGER,
  updated_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tariffs (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  months INTEGER NOT NULL,
  price INTEGER NOT NULL,                 -- total for the period, whole rubles
  PRIMARY KEY (service_id, months)
);

CREATE TABLE IF NOT EXISTS service_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  data TEXT NOT NULL,                     -- full card JSON as submitted
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | superseded
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  reviewed_by INTEGER,
  reviewed_at INTEGER
);
CREATE INDEX IF NOT EXISTS revisions_status ON service_revisions(status, created_at);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  link TEXT NOT NULL,
  contact TEXT NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reject_reason TEXT,
  service_id INTEGER REFERENCES services(id),
  created_at INTEGER NOT NULL,
  reviewed_by INTEGER,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  discount_percent INTEGER,
  promo_code TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired | cancelled
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  reviewed_by INTEGER,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  reviewed_by INTEGER,
  reviewed_at INTEGER,
  UNIQUE (service_id, user_id)
);

-- Every "go to bot" through the platform. Reviews and the monthly top depend on it.
CREATE TABLE IF NOT EXISTS clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clicks_service_time ON clicks(service_id, created_at);
CREATE INDEX IF NOT EXISTS clicks_user_time ON clicks(user_id, created_at);

CREATE TABLE IF NOT EXISTS stats_daily (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                      -- YYYY-MM-DD, Moscow time
  impressions INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_id, day)
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, service_id)
);

CREATE TABLE IF NOT EXISTS service_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  admin_id INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  note TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checks_service_time ON service_checks(service_id, checked_at);

CREATE TABLE IF NOT EXISTS top_snapshots (
  period TEXT PRIMARY KEY,                -- YYYY-MM the ranking covers
  weights TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  published_by INTEGER                    -- NULL when auto-published by the scheduler
);

CREATE TABLE IF NOT EXISTS top_entries (
  period TEXT NOT NULL REFERENCES top_snapshots(period) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  components TEXT NOT NULL,
  PRIMARY KEY (period, rank)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,                       -- NULL = system
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at INTEGER NOT NULL
);

-- Outbox for messages from the platform bot.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  start_param TEXT,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed | skipped
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_queue ON notifications(status, id);

-- Admin panel outside Telegram: the bot's /admin command issues a one-time login link
-- (login_tokens), which is exchanged for a 7-day session. Only hashes are stored.
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  user_agent TEXT
);

-- Reserved for monetisation (unused in v1). Paid placements are rendered apart from
-- the ranking with the "Реклама" label and never affect it.
CREATE TABLE IF NOT EXISTS ad_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  placement TEXT NOT NULL,                -- catalog_top | collection_pin | highlight | home_banner
  service_id INTEGER REFERENCES services(id) ON DELETE CASCADE,
  title TEXT,
  image_url TEXT,
  url TEXT,
  price INTEGER,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Reserved for the services market (v2+): channel ads with escrow, hosting, jobs, ready solutions.
CREATE TABLE IF NOT EXISTS market_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                     -- ad_channel | hosting | job | solution
  owner_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  // Composite score of the monthly top; editable by admins.
  top_weights: { rating: 0.4, clients: 0.3, stability: 0.3 },
  // Bayesian prior strength for the monthly rating, so one 5★ review does not win the month.
  top_rating_prior: 3,
  // Market label thresholds relative to the catalog average monthly price.
  market_band: 0.1,
  market_avg_monthly: null
};

function toParam(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  raw.exec(SCHEMA);

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const bind = (params) => params.map(toParam);
  let depth = 0;

  const db = {
    raw,
    all: (sql, ...p) => stmt(sql).all(...bind(p)),
    get: (sql, ...p) => stmt(sql).get(...bind(p)),
    run: (sql, ...p) => stmt(sql).run(...bind(p)),
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    setting(key) {
      const row = db.get('SELECT value FROM settings WHERE key = ?', key);
      return row ? JSON.parse(row.value) : DEFAULT_SETTINGS[key] ?? null;
    },
    setSetting(key, value) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    },
    close() { raw.close(); }
  };
  return db;
}
