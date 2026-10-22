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
  // 5 — remote management: access tokens with scopes, the stored event log, the permanent viewing history (viewings
  // outlive the TV and the catalog, so no foreign keys), the owner's seen marks, and who sent each command with
  // what the TV made of it. The saved positions become the first viewings ("imported"), one per position.
  `
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
  CREATE TABLE viewings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,                -- no foreign key, no cascade: viewings outlive the TV
    device_name TEXT NOT NULL,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_kind TEXT,
    item_title TEXT,
    episode_id TEXT NOT NULL,
    episode_title TEXT,
    season INTEGER,
    number INTEGER,
    source_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,                       -- NULL while the viewing runs
    start_position_ms INTEGER,
    end_position_ms INTEGER,
    duration_ms INTEGER,
    watched_ms INTEGER,
    end_reason TEXT,                        -- finished | stopped | replaced | lost; NULL while running
    seen INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL,                  -- viewer | autoplay | next | command | unknown
    actor_json TEXT NOT NULL,
    command_id INTEGER,
    imported INTEGER NOT NULL DEFAULT 0,
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
  ALTER TABLE commands ADD COLUMN actor_json TEXT;                -- who sent it; NULL for commands from before
  ALTER TABLE commands ADD COLUMN result TEXT;                    -- done | ignored | failed, as the TV reported
  ALTER TABLE commands ADD COLUMN reason TEXT;
  ALTER TABLE commands ADD COLUMN result_at INTEGER;
  INSERT INTO viewings (device_id, device_name, catalog_id, item_id, episode_id, started_at, ended_at, end_position_ms, duration_ms,
                        end_reason, seen, trigger, actor_json, imported)
    SELECT p.device_id, d.name, p.catalog_id, p.item_id, p.episode_id, p.updated_at, p.updated_at, p.position_ms, p.duration_ms,
           CASE p.status WHEN 'finished' THEN 'finished' ELSE 'stopped' END, CASE p.status WHEN 'finished' THEN 1 ELSE 0 END,
           'unknown', '{"type":"tv","deviceId":"' || p.device_id || '"}', 1
    FROM progress p JOIN devices d ON d.id = p.device_id
    ORDER BY p.updated_at, p.device_id, p.episode_id;
  `,
  // 6 — TV app updates: the one APK the server offers its TVs (its bytes are a file in <dataDir>/app named by its
  // sha256), and the app version each TV reports in its User-Agent.
  `
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
  ALTER TABLE devices ADD COLUMN app_version TEXT;          -- as the TV's User-Agent says; NULL until it does
  ALTER TABLE devices ADD COLUMN app_version_code INTEGER;
  ALTER TABLE devices ADD COLUMN android_sdk INTEGER;
  ALTER TABLE devices ADD COLUMN update_capability TEXT;    -- silent | guided
  ALTER TABLE devices ADD COLUMN app_reported_at INTEGER;   -- when the TV first reported this version
  `,
  // 7 — pairing codes remember who asked for them, so one client cannot hold every open code.
  `
  ALTER TABLE pair_codes ADD COLUMN client_hash TEXT;       -- sha256 of the client address that started it; NULL before
  `,
  // 8 — the per-TV home grid: how many columns and rows of cards one screen of Home shows (more scroll).
  `
  ALTER TABLE devices ADD COLUMN home_columns INTEGER NOT NULL DEFAULT 4;
  ALTER TABLE devices ADD COLUMN home_rows INTEGER NOT NULL DEFAULT 2;
  `,
  // 9 — live channels: now_playing and viewings may name a channel (an item alone: episode_id and the positions
  // become nullable, which SQLite only allows by rebuilding the table; the viewing ids and their sequence are kept),
  // and the catalog history records when each channel first appeared, by item id (channels have no episodes).
  `
  CREATE TABLE now_playing_new (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    episode_id TEXT,                        -- NULL for a channel
    source_id TEXT,
    position_ms INTEGER,                    -- NULL for a channel (no timeline)
    duration_ms INTEGER,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    playing INTEGER NOT NULL DEFAULT 0,
    anchor_at INTEGER,
    seq INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO now_playing_new (device_id, catalog_id, item_id, episode_id, source_id, position_ms, duration_ms, state, updated_at, playing, anchor_at, seq)
    SELECT device_id, catalog_id, item_id, episode_id, source_id, position_ms, duration_ms, state, updated_at, playing, anchor_at, seq FROM now_playing;
  DROP TABLE now_playing;
  ALTER TABLE now_playing_new RENAME TO now_playing;
  CREATE TABLE viewings_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL,
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_kind TEXT,
    item_title TEXT,
    episode_id TEXT,                        -- NULL for a channel
    episode_title TEXT,
    season INTEGER,
    number INTEGER,
    source_id TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    start_position_ms INTEGER,
    end_position_ms INTEGER,
    duration_ms INTEGER,
    watched_ms INTEGER,
    end_reason TEXT,
    seen INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    command_id INTEGER,
    imported INTEGER NOT NULL DEFAULT 0,
    last_report_at INTEGER,
    last_position_ms INTEGER,
    last_playing INTEGER,
    last_anchor_at INTEGER,
    last_state TEXT
  );
  INSERT INTO viewings_new SELECT id, device_id, device_name, catalog_id, item_id, item_kind, item_title, episode_id, episode_title, season, number,
    source_id, started_at, ended_at, start_position_ms, end_position_ms, duration_ms, watched_ms, end_reason, seen, trigger, actor_json, command_id,
    imported, last_report_at, last_position_ms, last_playing, last_anchor_at, last_state FROM viewings;
  DELETE FROM sqlite_sequence WHERE name = 'viewings_new';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'viewings_new', seq FROM sqlite_sequence WHERE name = 'viewings';
  CREATE TABLE viewing_ranges_new (
    viewing_id INTEGER NOT NULL REFERENCES viewings_new(id) ON DELETE CASCADE,
    from_ms INTEGER NOT NULL,
    to_ms INTEGER NOT NULL
  );
  INSERT INTO viewing_ranges_new (viewing_id, from_ms, to_ms) SELECT viewing_id, from_ms, to_ms FROM viewing_ranges;
  DROP TABLE viewing_ranges;
  DROP TABLE viewings;
  ALTER TABLE viewings_new RENAME TO viewings;
  ALTER TABLE viewing_ranges_new RENAME TO viewing_ranges;
  CREATE INDEX viewings_by_device ON viewings (device_id, started_at);
  CREATE INDEX viewings_by_item ON viewings (catalog_id, item_id);
  CREATE INDEX viewings_by_episode ON viewings (catalog_id, episode_id);
  CREATE INDEX viewings_by_end ON viewings (ended_at);
  CREATE INDEX viewing_ranges_by_viewing ON viewing_ranges (viewing_id);
  CREATE TABLE catalog_seen_items (
    catalog_id TEXT NOT NULL, item_id TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,                                 -- 0 for channels present at the first load ever
    build_id TEXT NOT NULL, removed_at INTEGER,                     -- set while absent from the loaded catalog
    PRIMARY KEY (catalog_id, item_id));
  `,
  // 10 — Home sections: each TV's Home is cut into sections in the owner's order, and each home entry names its
  // section (a composite key, scoped to the device like the entries; rebuilding home_entries is the only way SQLite
  // adds one). Every Home from before gets only the untitled section, holding its items in their order.
  `
  CREATE TABLE home_sections (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    section_id TEXT NOT NULL,               -- 'untitled', or 8 alphanumeric characters made by the server
    position INTEGER NOT NULL,              -- display order among the device's sections
    title TEXT,                             -- NULL for the untitled section
    layout TEXT NOT NULL DEFAULT 'grid',    -- grid | row (checked by the API, so a later layout needs no rebuild)
    PRIMARY KEY (device_id, section_id)
  );
  INSERT INTO home_sections (device_id, section_id, position, title, layout) SELECT id, 'untitled', 0, NULL, 'grid' FROM devices;
  CREATE TABLE home_entries_new (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,              -- Home order: the sections in order, each with its items in order
    catalog_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    added_at INTEGER,
    section_id TEXT NOT NULL DEFAULT 'untitled',
    PRIMARY KEY (device_id, position),
    FOREIGN KEY (device_id, section_id) REFERENCES home_sections (device_id, section_id)
  );
  INSERT INTO home_entries_new (device_id, position, catalog_id, item_id, added_at)
    SELECT device_id, position, catalog_id, item_id, added_at FROM home_entries;
  DROP TABLE home_entries;
  ALTER TABLE home_entries_new RENAME TO home_entries;
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
