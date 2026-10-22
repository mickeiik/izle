// The database schema. A new database gets SCHEMA and PRAGMA user_version = INITIAL_VERSION; a later change is
// appended to MIGRATIONS (never edit one once released), and user_version counts INITIAL_VERSION plus the migrations
// that ran. A database below INITIAL_VERSION was made by a pre-release izle and is refused, not migrated.
export const INITIAL_VERSION = 11;

export const SCHEMA = `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT UNIQUE,                 -- sha256 of the device token; NULL while pairing is not completed
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    ui_language TEXT,                       -- NULL = server/catalog default
    preferred_audio_language TEXT,
    subtitles_language TEXT,                -- NULL = subtitles off
    state_version INTEGER NOT NULL DEFAULT 1,
    autoplay_on_start INTEGER NOT NULL DEFAULT 0,
    app_version TEXT,                       -- as the TV's User-Agent says; NULL until it does
    app_version_code INTEGER,
    android_sdk INTEGER,
    update_capability TEXT,                 -- silent | guided
    app_reported_at INTEGER,                -- when the TV first reported this version
    home_columns INTEGER NOT NULL DEFAULT 4,
    home_rows INTEGER NOT NULL DEFAULT 2
  );
  CREATE TABLE pair_codes (
    code TEXT PRIMARY KEY,
    pair_token_hash TEXT NOT NULL,
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_at INTEGER,
    delivered_at INTEGER,
    client_hash TEXT NOT NULL               -- sha256 of the client address that started it
  );

  -- Each TV's Home: sections in the owner's order, each entry naming its section (scoped to the device).
  CREATE TABLE home_sections (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    section_id TEXT NOT NULL,               -- 'untitled', or 8 alphanumeric characters made by the server
    position INTEGER NOT NULL,              -- display order among the device's sections
    title TEXT,                             -- NULL for the untitled section
    layout TEXT NOT NULL DEFAULT 'grid',    -- grid | row (checked by the API, so a later layout needs no rebuild)
    PRIMARY KEY (device_id, section_id)
  );
  CREATE TABLE home_entries (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,              -- Home order: the sections in order, each with its items in order
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,              -- when the item first went on this TV's list (epoch ms)
    section_id TEXT NOT NULL,
    PRIMARY KEY (device_id, position),
    FOREIGN KEY (device_id, section_id) REFERENCES home_sections (device_id, section_id)
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
    wrapped INTEGER NOT NULL DEFAULT 0,     -- 1: placed by the wrap after the last episode (new episodes then play first)
    PRIMARY KEY (device_id, catalog_id, item_id)
  );

  CREATE TABLE commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    acked_at INTEGER,
    actor_json TEXT NOT NULL,               -- who sent it
    result TEXT,                            -- done | ignored | failed, as the TV reported
    reason TEXT,
    result_at INTEGER
  );
  CREATE INDEX commands_by_device ON commands (device_id, acked_at);

  -- What each TV plays now; a channel is an item alone (no episode, no timeline).
  CREATE TABLE now_playing (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT,                        -- NULL for a channel
    source_id TEXT,
    position_ms INTEGER,                    -- NULL for a channel (no timeline)
    duration_ms INTEGER,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    playing INTEGER NOT NULL DEFAULT 0,     -- the player was actually advancing
    anchor_at INTEGER NOT NULL,             -- when position_ms was sampled (epoch ms)
    seq INTEGER NOT NULL DEFAULT 0          -- bumped on every write (admin long-polls)
  );

  -- "Listen along": the owner's companion links.
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

  -- What went wrong on a TV, for the remote owner.
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

  -- Catalog history: a record per loaded build, which build first carried each episode, and when each channel first
  -- appeared (by item id: channels have no episodes).
  CREATE TABLE catalog_builds (
    catalog_id TEXT NOT NULL,
    build_id TEXT NOT NULL,
    built_at TEXT NOT NULL,
    loaded_at INTEGER NOT NULL,
    baseline INTEGER NOT NULL DEFAULT 0,
    items INTEGER NOT NULL,
    episodes INTEGER NOT NULL,
    items_added INTEGER NOT NULL,
    items_removed INTEGER NOT NULL,
    episodes_added INTEGER NOT NULL,
    episodes_removed INTEGER NOT NULL,
    changes_json TEXT NOT NULL,             -- lists capped at 500 each; counts exact
    PRIMARY KEY (catalog_id, build_id)
  );
  CREATE INDEX catalog_builds_by_time ON catalog_builds (catalog_id, loaded_at);
  CREATE TABLE catalog_seen (
    catalog_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,         -- 0 for episodes present at the first load ever
    build_id TEXT NOT NULL,
    removed_at INTEGER,                     -- set while absent from the loaded catalog
    PRIMARY KEY (catalog_id, episode_id)
  );
  CREATE INDEX catalog_seen_by_item ON catalog_seen (catalog_id, item_id, first_seen_at);
  CREATE TABLE catalog_seen_items (
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,         -- 0 for channels present at the first load ever
    build_id TEXT NOT NULL,
    removed_at INTEGER,                     -- set while absent from the loaded catalog
    PRIMARY KEY (catalog_id, item_id)
  );

  CREATE TABLE access_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('read', 'control', 'manage')),
    secret_hash TEXT NOT NULL UNIQUE,       -- sha256 of the secret; the secret itself is shown once and never kept
    created_at INTEGER NOT NULL,
    last_used_at INTEGER                    -- written at most once a minute
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,   -- strictly increasing: the order the changes were stored in
    at INTEGER NOT NULL,
    type TEXT NOT NULL,
    device_id TEXT,                         -- no foreign key: events outlive devices
    actor_json TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE INDEX events_by_device ON events (device_id, id);
  CREATE INDEX events_by_type ON events (type, id);

  -- The permanent viewing history: viewings outlive the TV and the catalog, so no foreign keys.
  CREATE TABLE viewings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_kind TEXT NOT NULL,
    item_title TEXT NOT NULL,
    episode_id TEXT,                        -- NULL for a channel
    episode_title TEXT,
    season INTEGER,
    number INTEGER,
    source_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,                       -- NULL while the viewing runs
    start_position_ms INTEGER,
    end_position_ms INTEGER,
    duration_ms INTEGER,
    watched_ms INTEGER NOT NULL,
    end_reason TEXT,                        -- finished | stopped | replaced | lost; NULL while running
    seen INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL,                  -- viewer | autoplay | next | command | unknown
    actor_json TEXT NOT NULL,
    command_id INTEGER,
    last_report_at INTEGER,                 -- running state, kept by the history: the last report and its anchor
    last_position_ms INTEGER,
    last_playing INTEGER,
    last_anchor_at INTEGER,
    last_state TEXT
  );
  CREATE INDEX viewings_by_device ON viewings (device_id, started_at);
  CREATE INDEX viewings_by_item ON viewings (catalog_id, item_id);
  CREATE INDEX viewings_by_episode ON viewings (catalog_id, episode_id);
  CREATE INDEX viewings_by_end ON viewings (ended_at);
  CREATE TABLE viewing_ranges (
    viewing_id INTEGER NOT NULL REFERENCES viewings(id) ON DELETE CASCADE,
    from_ms INTEGER NOT NULL,
    to_ms INTEGER NOT NULL
  );
  CREATE INDEX viewing_ranges_by_viewing ON viewing_ranges (viewing_id);
  CREATE TABLE episode_marks (
    catalog_id TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    seen INTEGER NOT NULL,                  -- the owner's word: 1 seen, 0 not seen (a mark wins over the viewings)
    at INTEGER NOT NULL,
    PRIMARY KEY (catalog_id, episode_id)
  );

  -- TV app updates: the one APK the server offers its TVs (its bytes are a file in <dataDir>/app named by its sha256).
  CREATE TABLE app_apk (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- a single row: the current APK
    version_name TEXT NOT NULL,
    version_code INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('github', 'upload')),
    release_tag TEXT,                       -- the GitHub release it came from; NULL for an upload
    stored_at INTEGER NOT NULL
  );
`;

/** Schema changes after the initial schema, applied in order: MIGRATIONS[i] takes a database to INITIAL_VERSION + i + 1. */
export const MIGRATIONS: string[] = [];

export const SCHEMA_VERSION = INITIAL_VERSION + MIGRATIONS.length;
