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

-- Service health from client signals («Работает у меня» / «Не работает у меня»).
-- One row per account and service; a repeat within the cooldown replaces it.
CREATE TABLE IF NOT EXISTS status_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  value INTEGER NOT NULL,                 -- 1 = works for me, 0 = does not work for me
  network TEXT,                           -- wifi | mts | beeline | megafon | tele2 (optional)
  base_weight REAL NOT NULL,              -- 1 after a click-through to this VPN's bot, else 0.3 (settings)
  excluded TEXT,                          -- never counted: new_account | owner; NULL = counted
  created_at INTEGER NOT NULL,
  trust_checked_at INTEGER                -- when it was compared with the outcome (trust_score update)
);
CREATE INDEX IF NOT EXISTS status_votes_service_time ON status_votes(service_id, created_at);
CREATE INDEX IF NOT EXISTS status_votes_user_time ON status_votes(user_id, created_at);
CREATE INDEX IF NOT EXISTS status_votes_trust ON status_votes(trust_checked_at, created_at);

-- Current status per service; no row means "operational".
CREATE TABLE IF NOT EXISTS service_status (
  service_id INTEGER PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL,                   -- operational | issues | outage
  since INTEGER NOT NULL,
  cleared_at INTEGER,                     -- admin cleared the status: earlier votes no longer count
  confirmed_by INTEGER,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Every status change; incident intervals (availability bar, monthly top) are derived from it.
CREATE TABLE IF NOT EXISTS status_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  reason TEXT NOT NULL,                   -- votes | recovered | timeout | admin_clear
  admin_id INTEGER
);
CREATE INDEX IF NOT EXISTS status_changes_service_time ON status_changes(service_id, changed_at);

-- Owner disputes a status; anomalies are raised automatically. Both reach admins via the bot.
CREATE TABLE IF NOT EXISTS status_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,                   -- the disputed status
  comment TEXT,
  state TEXT NOT NULL DEFAULT 'open',     -- open | cleared | confirmed
  created_at INTEGER NOT NULL,
  resolved_by INTEGER,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS status_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                     -- low_trust | spike
  details TEXT,
  state TEXT NOT NULL DEFAULT 'open',     -- open | cleared | confirmed
  created_at INTEGER NOT NULL,
  resolved_by INTEGER,
  resolved_at INTEGER
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

-- Ad exchange: channel admins (sellers) list ad slots, VPN owners (buyers) book them.
-- For now deals are free and settled directly in Telegram; an escrow will sit on ad_deals later.
CREATE TABLE IF NOT EXISTS ad_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  link TEXT NOT NULL,                      -- https://t.me/<username> or an invite link
  username TEXT,                           -- lowercase public username, used for verification
  title TEXT NOT NULL,
  photo_url TEXT,
  topic TEXT NOT NULL,
  subscribers INTEGER NOT NULL,
  reach_24 INTEGER NOT NULL,
  reach_48 INTEGER NOT NULL,
  stats_url TEXT,                          -- Telemetr / TGStat page; without it reach is the seller's word
  formats TEXT NOT NULL DEFAULT '{}',      -- {"1/24": 6000, "pin": 9000, ...}, whole rubles
  free_dates TEXT NOT NULL DEFAULT '[]',   -- ["2026-11-05", ...], Moscow dates
  had_vpn INTEGER NOT NULL DEFAULT 0,
  contact TEXT NOT NULL,                   -- shown to a buyer only after the seller agrees
  tg_chat_id INTEGER,
  verified_at INTEGER,                     -- the seller added the bot as a channel admin
  subscribers_at INTEGER,                  -- subscribers last taken from Telegram itself
  status TEXT NOT NULL DEFAULT 'active',   -- active | hidden (by seller) | review (complaints) | blocked (admin)
  block_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_channels_owner ON ad_channels(owner_id);
CREATE INDEX IF NOT EXISTS ad_channels_username ON ad_channels(username);

CREATE TABLE IF NOT EXISTS ad_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES ad_channels(id) ON DELETE CASCADE,
  seller_id INTEGER NOT NULL REFERENCES users(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  format TEXT NOT NULL,
  date TEXT NOT NULL,                      -- Moscow date of the post
  price INTEGER NOT NULL,                  -- at the time of booking
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'requested', -- requested | agreed | published | reviewed | declined | cancelled | failed
  decline_reason TEXT,
  cancelled_by INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  published_at INTEGER,
  review_asked_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_deals_channel ON ad_deals(channel_id, status);
CREATE INDEX IF NOT EXISTS ad_deals_buyer ON ad_deals(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS ad_deals_seller ON ad_deals(seller_id, created_at);

-- Only a buyer whose deal actually happened can rate a channel.
CREATE TABLE IF NOT EXISTS ad_reviews (
  deal_id INTEGER PRIMARY KEY REFERENCES ad_deals(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES ad_channels(id) ON DELETE CASCADE,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  came INTEGER,                            -- new subscribers / users from the post
  payments INTEGER,
  reach_match TEXT,                        -- yes | partly | no
  text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_reviews_channel ON ad_reviews(channel_id, created_at);

CREATE TABLE IF NOT EXISTS ad_complaints (
  channel_id INTEGER NOT NULL REFERENCES ad_channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  text TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS ad_favorites (
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel_id INTEGER NOT NULL REFERENCES ad_channels(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

-- «Забрать свою карточку»: cards Линза added itself are claimed by their real owners.
CREATE TABLE IF NOT EXISTS service_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),     -- NULL for an invitation link nobody has opened yet
  method TEXT NOT NULL,                     -- link | code | channel | manual: how ownership is (being) proven
  code TEXT,                                -- LINZA-XXXXXX for the bot profile check
  token_hash TEXT,                          -- invitation links: sha256 of the secret, never the secret itself
  status TEXT NOT NULL,                     -- invited | pending | manual | dispute | approved | rejected | expired | superseded
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  decided_at INTEGER,
  decided_by INTEGER REFERENCES users(id),  -- NULL when proven automatically
  note TEXT
);
CREATE INDEX IF NOT EXISTS service_claims_service ON service_claims(service_id, status);
CREATE INDEX IF NOT EXISTS service_claims_user ON service_claims(user_id, status);

-- Bot profile checks, for the per-user hourly limit and the per-claim cooldown.
CREATE TABLE IF NOT EXISTS claim_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES service_claims(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  found INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claim_checks_user ON claim_checks(user_id, created_at);

-- Reserved for the services market (v2+): hosting, jobs, ready solutions.
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
  market_avg_monthly: null,
  // Service health from client signals; every number is editable in the admin panel.
  status_config: {
    window_min: 120,          // votes considered for the status
    issues_votes: 3,          // «Есть сообщения о сбоях»: at least N "down" votes...
    issues_weight: 2,         // ...with at least this total weight, outweighing "works"
    outage_votes: 8,          // «Массовый сбой»
    outage_weight: 5,
    clear_after_min: 360,     // a failure status ends after this long without new "down" votes
    weight_clicked: 1,        // base weight when the voter went to this VPN's bot through Линза
    weight_other: 0.3,
    trust_min: 0.1,
    trust_max: 2,
    trust_up: 0.05,           // vote agreed with the outcome
    trust_down: 0.15,         // vote disagreed with the outcome
    trust_delay_min: 120,     // when a vote is compared with the outcome
    trust_quorum: 1,          // minimum weight of other votes needed to judge a vote
    cooldown_h: 12,           // one vote per service per account in this period
    daily_services: 5,        // services one account can vote on per 24 h
    new_account_h: 24,        // votes from younger accounts are not counted
    anomaly_trust: 0.5,       // anomaly: share of "down" votes from accounts below this trust...
    anomaly_share: 0.5,       // ...exceeds this share
    spike_votes: 10,          // anomaly: this many votes...
    spike_min: 5,             // ...within these minutes
    networks_h: 24,           // network breakdown period
    networks_min_votes: 5,    // shown once this many votes name a network
    radar_window_min: 120,    // «Радар сбоев»: what counts as "now"
    radar_min_votes: 2,       // a VPN shows up on a network from this many "down" votes naming it...
    radar_min_weight: 1.5,    // ...with at least this total weight, outweighing "works" there
    radar_operator: 3         // this many VPNs failing on one network looks like the operator, not the VPNs
  },
  // Ad exchange: CPM traffic light (₽ per 1000 views), complaints before a channel goes to review,
  // and when a buyer is asked for a review after the post date.
  ad_config: { cpm_good: 250, cpm_ok: 350, complaints_review: 3, review_after_h: 48 }
};

// Columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them to old databases.
const COLUMNS = [
  ['users', 'trust_score', 'REAL NOT NULL DEFAULT 1.0'],
  // Bot messages: the text of the button that opens the Mini App ("Заполнить карточку", ...).
  ['notifications', 'button', 'TEXT'],
  // One-time nudges, so a reminder is never sent twice.
  ['services', 'fill_reminded_at', 'INTEGER'],
  ['ad_channels', 'verify_reminded_at', 'INTEGER'],
  ['ad_deals', 'seller_reminded_at', 'INTEGER'],
  ['ad_deals', 'day_reminded_at', 'INTEGER'],
  // Cards Линза added itself and their path to an owner. The backfill runs once, when the column appears.
  ['services', 'added_by', "TEXT NOT NULL DEFAULT 'owner'", "UPDATE services SET added_by = 'admin' WHERE owner_id IS NULL"],
  ['services', 'claim_status', "TEXT NOT NULL DEFAULT 'claimed'",
    `UPDATE services SET claim_status = 'unclaimed' WHERE owner_id IS NULL;
     UPDATE users SET active_role = 'vpn_owner' WHERE active_role = 'client' AND id IN (SELECT owner_id FROM services WHERE owner_id IS NOT NULL)`],
  ['services', 'data_checked_at', 'INTEGER', "UPDATE services SET data_checked_at = COALESCE(updated_at, created_at) WHERE added_by = 'admin'"]
];
function migrate(raw) {
  for (const [table, column, ddl, backfill] of COLUMNS) {
    const has = raw.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      if (backfill) raw.exec(backfill);
    }
  }
}

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
  migrate(raw);

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
