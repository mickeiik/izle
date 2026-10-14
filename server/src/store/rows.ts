// SQLite rows (snake_case columns, loosely typed values) to the store's types.

import type { CommandType } from "../commands.ts";
import type { ProblemKind } from "../problems.ts";
import type {
  CatalogBuild,
  CompanionLink,
  Command,
  Cursor,
  Device,
  NowPlaying,
  NowPlayingState,
  PairCode,
  Problem,
  ProblemOrigin,
  Progress,
  ProgressStatus,
  SeenEpisode,
} from "../store.ts";

export type Row = Record<string, unknown>;
export const str = (v: unknown) => v as string;
export const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));
export const num = (v: unknown) => Number(v);
export const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function toDevice(r: Row): Device {
  return {
    id: str(r.id),
    name: str(r.name),
    tokenHash: strOrNull(r.token_hash),
    createdAt: num(r.created_at),
    lastSeenAt: numOrNull(r.last_seen_at),
    uiLanguage: strOrNull(r.ui_language),
    preferredAudioLanguage: strOrNull(r.preferred_audio_language),
    subtitlesLanguage: strOrNull(r.subtitles_language),
    stateVersion: num(r.state_version),
    autoplayOnStart: num(r.autoplay_on_start) === 1,
  };
}

export function toPairCode(r: Row): PairCode {
  return {
    code: str(r.code),
    pairTokenHash: str(r.pair_token_hash),
    deviceId: strOrNull(r.device_id),
    createdAt: num(r.created_at),
    expiresAt: num(r.expires_at),
    approvedAt: numOrNull(r.approved_at),
    deliveredAt: numOrNull(r.delivered_at),
  };
}

export function toProgress(r: Row): Progress {
  return {
    catalogId: str(r.catalog_id),
    itemId: str(r.item_id),
    episodeId: str(r.episode_id),
    positionMs: num(r.position_ms),
    durationMs: numOrNull(r.duration_ms),
    status: str(r.status) as ProgressStatus,
    updatedAt: num(r.updated_at),
  };
}

export function toCompanionLink(r: Row): CompanionLink {
  return {
    catalogId: str(r.catalog_id),
    itemId: str(r.item_id),
    episodeId: str(r.episode_id),
    sourceId: str(r.source_id),
    language: strOrNull(r.language),
    offsetMs: num(r.offset_ms),
    rate: num(r.rate),
    updatedAt: num(r.updated_at),
  };
}

export function toCursor(r: Row): Cursor {
  return {
    catalogId: str(r.catalog_id),
    itemId: str(r.item_id),
    episodeId: str(r.episode_id),
    updatedAt: num(r.updated_at),
    wrapped: num(r.wrapped) === 1,
  };
}

export function toSeenEpisode(r: Row): SeenEpisode {
  return {
    episodeId: str(r.episode_id),
    itemId: str(r.item_id),
    firstSeenAt: num(r.first_seen_at),
    buildId: str(r.build_id),
    removedAt: numOrNull(r.removed_at),
  };
}

export function toCatalogBuild(r: Row): CatalogBuild {
  return {
    catalogId: str(r.catalog_id),
    buildId: str(r.build_id),
    builtAt: str(r.built_at),
    loadedAt: num(r.loaded_at),
    baseline: num(r.baseline) === 1,
    items: num(r.items),
    episodes: num(r.episodes),
    itemsAdded: num(r.items_added),
    itemsRemoved: num(r.items_removed),
    episodesAdded: num(r.episodes_added),
    episodesRemoved: num(r.episodes_removed),
  };
}

export function toCommand(r: Row): Command {
  return {
    id: num(r.id),
    deviceId: str(r.device_id),
    type: str(r.type) as CommandType,
    payload: JSON.parse(str(r.payload_json)) as Record<string, unknown>,
    createdAt: num(r.created_at),
    ackedAt: numOrNull(r.acked_at),
  };
}

export function toProblem(r: Row): Problem {
  return {
    id: num(r.id),
    deviceId: str(r.device_id),
    at: num(r.at),
    origin: str(r.origin) as ProblemOrigin,
    kind: str(r.kind) as ProblemKind,
    code: str(r.code),
    catalogId: strOrNull(r.catalog_id),
    itemId: strOrNull(r.item_id),
    episodeId: strOrNull(r.episode_id),
    sourceId: strOrNull(r.source_id),
    positionMs: numOrNull(r.position_ms),
    httpStatus: numOrNull(r.http_status),
    detail: strOrNull(r.detail),
    appVersion: strOrNull(r.app_version),
  };
}

export function toNowPlaying(r: Row): NowPlaying {
  return {
    catalogId: str(r.catalog_id),
    itemId: str(r.item_id),
    episodeId: str(r.episode_id),
    sourceId: strOrNull(r.source_id),
    positionMs: num(r.position_ms),
    durationMs: numOrNull(r.duration_ms),
    state: str(r.state) as NowPlayingState,
    updatedAt: num(r.updated_at),
    playing: num(r.playing) === 1,
    anchorAt: numOrNull(r.anchor_at),
    seq: num(r.seq),
  };
}
