// Schema migrations, applied in order; PRAGMA user_version records how many ran. Never edit a shipped migration,
// append a new one.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE,                 -- sha256 of the device token; NULL while pairing is not completed
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ui_language TEXT,                       -- NULL = server/catalog default
    preferred_audio_language TEXT,
    subtitles_language TEXT,                -- NULL = subtitles off
    state_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE pair_codes (
    code TEXT PRIMARY KEY,
    pair_token_hash TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_at INTEGER,
    delivered_at INTEGER
  );
  CREATE TABLE home_entries (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (device_id, position)
  );
  CREATE TABLE progress (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position_ms INTEGER NOT NULL,
    duration_ms INTEGER,
    status TEXT NOT NULL CHECK (status IN ('watching', 'finished')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, catalog_id, episode_id)
  );
  CREATE TABLE item_cursor (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, catalog_id, item_id)
  );
  CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    acked_at INTEGER
  );
  CREATE INDEX commands_by_device ON commands (device_id, acked_at);
  CREATE TABLE now_playing (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    source_id TEXT,
    position_ms INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // 2 — "Listen along": a precise playback anchor on now_playing and the owner's companion links.
  `
  ALTER TABLE now_playing ADD COLUMN playing INTEGER NOT NULL DEFAULT 0;   -- the player was actually advancing
  ALTER TABLE now_playing ADD COLUMN anchor_at INTEGER;                    -- when position_ms was sampled (epoch ms)
  ALTER TABLE now_playing ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;       -- bumped on every write (admin long-polls)
  CREATE TABLE companion_links (
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    language TEXT,                          -- NULL = the player's default audio track
    offset_ms INTEGER NOT NULL DEFAULT 0,   -- companion position when the TV is at 0
    rate REAL NOT NULL DEFAULT 1.0,         -- companion seconds per TV second
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (catalog_id, episode_id, source_id)
  );
  CREATE INDEX companion_links_by_item ON companion_links (catalog_id, item_id);
  `,
  // 3 — problem reports (what went wrong on a TV, for the remote owner) and the per-TV "autoplay on start" setting.
  `
  CREATE TABLE problems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,                    -- when it happened (epoch ms)
    origin TEXT NOT NULL CHECK (origin IN ('tv', 'server')),
    kind TEXT NOT NULL,                     -- playback | resolve | proxy | network | other
    code TEXT NOT NULL,
    catalog_id TEXT,                        -- with item_id: set when the episode was in the catalog
    item_id TEXT,
    episode_id TEXT,
    source_id TEXT,
    position_ms INTEGER,
    http_status INTEGER,
    detail TEXT,                            -- redacted before it is stored; never logged
    app_version TEXT
  );
  CREATE INDEX problems_by_device ON problems (device_id, at);
  ALTER TABLE devices ADD COLUMN autoplay_on_start INTEGER NOT NULL DEFAULT 0;
  `,
  // 4 — catalog history: which build first carried each episode, a record per loaded build, when an item went on a
  // home list, and whether a cursor was placed by the wrap after the last episode (new episodes then play first).
  `
  ALTER TABLE home_entries ADD COLUMN added_at INTEGER;            -- when the item first went on this TV's list (epoch ms)
  UPDATE home_entries SET added_at = CAST(strftime('%s','now') AS INTEGER) * 1000;
  ALTER TABLE item_cursor ADD COLUMN wrapped INTEGER NOT NULL DEFAULT 0;   -- 1: placed by the wrap after the last episode
  CREATE TABLE catalog_builds (
    catalog_id TEXT NOT NULL, build_id TEXT NOT NULL, built_at TEXT NOT NULL, loaded_at INTEGER NOT NULL,
    baseline INTEGER NOT NULL DEFAULT 0, items INTEGER NOT NULL, episodes INTEGER NOT NULL,
    items_added INTEGER NOT NULL, items_removed INTEGER NOT NULL, episodes_added INTEGER NOT NULL, episodes_removed INTEGER NOT NULL,
    changes_json TEXT NOT NULL,                                     -- lists capped at 500 each; counts exact
    PRIMARY KEY (catalog_id, build_id));
  CREATE INDEX catalog_builds_by_time ON catalog_builds (catalog_id, loaded_at);
  CREATE TABLE catalog_seen (
    catalog_id TEXT NOT NULL, episode_id TEXT NOT NULL, item_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,                                 -- 0 for episodes present at the first load ever
    build_id TEXT NOT NULL, removed_at INTEGER,                     -- set while absent from the loaded catalog
    PRIMARY KEY (catalog_id, episode_id));
  CREATE INDEX catalog_seen_by_item ON catalog_seen (catalog_id, item_id, first_seen_at);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
