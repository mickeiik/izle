// Problem reports: the owner is usually not in the room, so what went wrong on a TV is kept for the admin page.
// TVs report their own problems (`POST /tv/problems`); the server records the ones it sees for a TV: resolves that
// found nothing playable, sources that failed before another one played, and proxy sessions whose upstream
// refused, broke or could not be reached. Companion ("Listen along") resolves and sessions are not recorded.
// Free text from the TV is redacted before it is stored, and detail is never logged.

import type { CatalogService } from "./catalog.ts";
import { HttpError } from "./errors.ts";
import { redactReportText, type Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import type { ProxyProblem, ProxyProblemCode } from "./proxy.ts";
import { RateLimiter } from "./ratelimit.ts";
import { isCompanionScope, type PlaybackSession, type Tried } from "./resolve.ts";
import type { Device, Problem, ProblemOrigin, Store } from "./store.ts";

/** Problem kinds a TV may report (`proxy` problems are only recorded by the server). */
export const TV_PROBLEM_KINDS = ["playback", "resolve", "network", "other"] as const;

export type ProblemKind = (typeof TV_PROBLEM_KINDS)[number] | "proxy";

/** A TV's problem report (`POST /tv/problems`, validated in validation.ts). */
export interface ProblemReportBody {
  kind: (typeof TV_PROBLEM_KINDS)[number];
  code: string;
  ageMs?: number;
  episodeId?: string;
  sourceId?: string;
  sessionId?: string;
  positionMs?: number;
  httpStatus?: number;
  detail?: string;
  appVersion?: string;
}

/** Problems kept per device (older ones are deleted on insert). */
export const PROBLEMS_KEPT = 100;
/** Problems older than this are purged by the housekeeping timer. */
export const PROBLEM_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** `Device.problems.recent` counts the problems of this period. */
export const RECENT_PROBLEMS_MS = 24 * 60 * 60_000;
/** Reports a TV may send per window. */
export const PROBLEM_REPORT_LIMIT = { max: 30, windowMs: 10 * 60_000 };
/** Server-origin proxy problems: at most one per device and code in this period (a flapping CDN must not flood). */
export const PROXY_PROBLEM_INTERVAL_MS = 60_000;
export const PROBLEM_LIST_DEFAULT = 50;
export const PROBLEM_LIST_MAX = 100;
const MAX_DETAIL = 500;

export interface ServerProblem {
  kind: "resolve" | "proxy";
  code: "no_playable_source" | "source_failed" | ProxyProblemCode;
  episodeId?: string | null;
  sourceId?: string | null;
  httpStatus?: number | null;
  detail?: string | null;
}

export interface ProblemServiceOptions {
  store: Store;
  catalog: CatalogService;
  log: Logger;
  now: () => number;
  /** A playback session by id: a report that names one of its TV's sessions gets the episode and source from it. */
  session?: (id: string) => PlaybackSession | undefined;
}

const cap = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text);

/** `timeout`, `error InvalidResult`, `timeout BudgetExhausted`: a failed source attempt in a few words. */
export function triedDetail(t: Tried): string {
  return t.name && !(t.code === "timeout" && t.name === "TimeoutError") ? `${t.code} ${t.name}` : t.code;
}

/**
 * The `tried` list of a `502 no_playable_source`, compact (`src-a: timeout; src-b: error InvalidResult`), plus the
 * sources the TV excluded because they had already failed on it.
 */
export function noPlayableDetail(tried: readonly Tried[], exclude: readonly string[] = []): string {
  const parts = tried.map((t) => `${t.sourceId}: ${triedDetail(t)}`);
  if (exclude.length > 0) parts.push(`excluded by the TV: ${exclude.join(", ")}`);
  return cap(parts.length > 0 ? parts.join("; ") : "the episode has no source to try");
}

export class ProblemService {
  private readonly o: ProblemServiceOptions;
  private readonly reports: RateLimiter;
  private readonly proxyProblems: RateLimiter;

  constructor(opts: ProblemServiceOptions) {
    this.o = opts;
    this.reports = new RateLimiter(PROBLEM_REPORT_LIMIT.max, PROBLEM_REPORT_LIMIT.windowMs, opts.now);
    this.proxyProblems = new RateLimiter(1, PROXY_PROBLEM_INTERVAL_MS, opts.now);
  }

  private insert(
    deviceId: string,
    origin: ProblemOrigin,
    p: Omit<Problem, "id" | "deviceId" | "origin" | "catalogId" | "itemId">,
  ): Problem {
    const ref = p.episodeId ? this.o.catalog.episode(p.episodeId) : undefined;
    return this.o.store.insertProblem(
      { ...p, deviceId, origin, catalogId: ref ? this.o.catalog.catalogId : null, itemId: ref?.item.id ?? null },
      PROBLEMS_KEPT,
    );
  }

  /** A TV's own report. Free text is redacted before it is stored; 429 beyond the rate limit. */
  report(device: Device, body: ProblemReportBody): Problem {
    const rate = this.reports.hit(device.id);
    if (!rate.ok) {
      throw new HttpError(429, "too_many_problems", "too many problem reports from this TV", {}, { "Retry-After": String(rate.retryAfterSec) });
    }
    const t = this.o.now();
    const found = body.sessionId ? this.o.session?.(body.sessionId) : undefined;
    // Only the TV's own session, and only for the episode it played.
    const session = found && found.deviceId === device.id && (body.episodeId === undefined || body.episodeId === found.episodeId) ? found : undefined;
    const text = (value: string | undefined) => (value === undefined || value.trim() === "" ? null : redactReportText(value));
    const problem = this.insert(device.id, "tv", {
      at: t - (body.ageMs ?? 0),
      kind: body.kind,
      code: redactReportText(body.code),
      episodeId: body.episodeId ?? session?.episodeId ?? null,
      sourceId: body.sourceId ?? session?.sourceId ?? null,
      positionMs: body.positionMs ?? null,
      httpStatus: body.httpStatus ?? null,
      detail: text(body.detail),
      appVersion: text(body.appVersion),
    });
    // Kind and code only: the detail may hold anything the TV saw.
    this.o.log.info("problem reported", { deviceId: device.id, kind: problem.kind, code: problem.code });
    return problem;
  }

  /** A problem the server saw for a TV. Never throws: recording must not break the request that ran into it. */
  record(deviceId: string, p: ServerProblem): void {
    try {
      this.insert(deviceId, "server", {
        at: this.o.now(),
        kind: p.kind,
        code: p.code,
        episodeId: p.episodeId ?? null,
        sourceId: p.sourceId ?? null,
        positionMs: null,
        httpStatus: p.httpStatus ?? null,
        detail: p.detail ? cap(p.detail) : null,
        appVersion: null,
      });
      this.o.log.debug("problem recorded", { deviceId, kind: p.kind, code: p.code });
    } catch (err) {
      this.o.log.warn("problem not recorded", { deviceId, kind: p.kind, code: p.code, error: err });
    }
  }

  /** A failed upstream request of a proxy session: the TV's sessions only, at most one per device and code a minute. */
  recordProxy(p: ProxyProblem): void {
    if (isCompanionScope(p.owner)) return;
    if (!this.proxyProblems.hit(`${p.owner}\u0000${p.code}`).ok) return;
    this.record(p.owner, { kind: "proxy", code: p.code, episodeId: p.episodeId, sourceId: p.sourceId, httpStatus: p.httpStatus, detail: p.detail });
  }

  /** `Device.problems`: how many happened in the last 24 hours, and when the latest one did. */
  stats(deviceId: string): { recent: number; lastAt: string | null } {
    const s = this.o.store.problemStats(deviceId, this.o.now() - RECENT_PROBLEMS_MS);
    return { recent: s.recent, lastAt: iso(s.lastAt) };
  }

  /** The admin list, newest first, with titles from the current catalog (`missing` when the episode is gone). */
  list(deviceId: string, limit: number) {
    const { catalog } = this.o;
    return this.o.store.listProblems(deviceId, limit).map((p) => {
      const ref = p.episodeId && (p.catalogId === null || p.catalogId === catalog.catalogId) ? catalog.episode(p.episodeId) : undefined;
      return {
        id: p.id,
        at: iso(p.at),
        origin: p.origin,
        kind: p.kind,
        code: p.code,
        itemId: ref?.item.id ?? p.itemId,
        itemTitle: ref?.item.title ?? null,
        // Item kind, for naming the episode (films have none to show).
        itemKind: ref?.item.kind ?? null,
        episodeId: p.episodeId,
        episodeTitle: ref?.episode.title ?? null,
        season: ref?.episode.season ?? null,
        number: ref?.episode.number ?? null,
        sourceId: p.sourceId,
        positionMs: p.positionMs,
        httpStatus: p.httpStatus,
        detail: p.detail,
        appVersion: p.appVersion,
        missing: p.episodeId !== null && !ref,
      };
    });
  }

  clear(deviceId: string): void {
    this.o.store.clearProblems(deviceId);
  }

  /** Housekeeping: drops problems older than the retention period. */
  purge(): void {
    this.o.store.purgeProblems(this.o.now() - PROBLEM_RETENTION_MS);
  }
}
