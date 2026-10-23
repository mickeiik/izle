// Problem reports, kept for the owner: what a TV reports itself, and what the server sees for a TV (resolves with
// nothing playable, sources it fell back past, failing proxy upstreams; never "Listen along" ones). Free text from
// the TV is redacted before it is stored, and detail is never logged.

import { SERVER, tvActor } from "./actor.ts";
import { playingKey, type CatalogService, type PlayingKey } from "./catalog.ts";
import { tooManyRequests } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import { redactReportText, type Logger } from "./log.ts";
import { iso } from "./presenters.ts";
import type { ProxyProblem, ProxyProblemCode } from "./proxy.ts";
import { RateLimiter } from "./ratelimit.ts";
import { isCheckScope, isCompanionScope, type PlaybackSessions, type Tried } from "./resolve.ts";
import type { Device, Problem, ProblemOrigin, Store } from "./store.ts";

/** Problem kinds a TV may report (`proxy` problems are only recorded by the server). */
export const TV_PROBLEM_KINDS = ["playback", "resolve", "network", "other"] as const;

export type ProblemKind = (typeof TV_PROBLEM_KINDS)[number] | "proxy";

/** A TV's problem report (validated in validation.ts). */
export interface ProblemReportBody {
  kind: (typeof TV_PROBLEM_KINDS)[number];
  code: string;
  ageMs?: number;
  /** The item (a channel's only name; with an episode, the episode's item wins). */
  itemId?: string;
  episodeId?: string;
  sourceId?: string;
  sessionId?: string;
  positionMs?: number;
  httpStatus?: number;
  detail?: string;
  appVersion?: string;
}

/** Problems kept per device (older ones are deleted on insert). */
const PROBLEMS_KEPT = 100;
const PROBLEM_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** `Device.problems.recent` counts the problems of this period. */
const RECENT_PROBLEMS_MS = 24 * 60 * 60_000;
const PROBLEM_REPORT_LIMIT = { max: 30, windowMs: 10 * 60_000 };
/** Server-origin proxy problems: at most one per device and code in this period (a flapping CDN must not flood). */
const PROXY_PROBLEM_INTERVAL_MS = 60_000;
export const PROBLEM_LIST_DEFAULT = 50;
export const PROBLEM_LIST_MAX = 100;
const MAX_DETAIL = 500;

interface ServerProblem {
  kind: "resolve" | "proxy";
  code: "no_playable_source" | "source_failed" | ProxyProblemCode;
  /** The channel's item, or the episode's (taken from the episode when both are given). */
  itemId?: string | null;
  episodeId?: string | null;
  sourceId?: string | null;
  httpStatus?: number | null;
  detail?: string | null;
}

interface ProblemDeps {
  store: Store;
  catalog: CatalogService;
  sessions: PlaybackSessions;
  eventLog: EventLog;
  log: Logger;
  now: () => number;
}

/** What a problem names; null when it names nothing, or an episode alone the catalog does not know. */
function problemKey(catalog: CatalogService, p: Pick<Problem, "itemId" | "episodeId">): PlayingKey | null {
  if (p.itemId !== null) return { itemId: p.itemId, episodeId: p.episodeId };
  const ref = p.episodeId !== null ? catalog.episode(p.episodeId) : undefined;
  return ref ? playingKey(ref) : null;
}

const cap = (text: string) => (text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text);

/** `timeout`, `error InvalidResult`, `timeout BudgetExhausted`: a failed source attempt in a few words. */
export function triedDetail(t: Tried): string {
  return t.name && !(t.code === "timeout" && t.name === "TimeoutError") ? `${t.code} ${t.name}` : t.code;
}

/** A `502 no_playable_source`'s `tried` list (`src-a: timeout; src-b: error InvalidResult`) and the TV's exclusions. */
export function noPlayableDetail(tried: readonly Tried[], exclude: readonly string[] = []): string {
  const parts = tried.map((t) => `${t.sourceId}: ${triedDetail(t)}`);
  if (exclude.length > 0) parts.push(`excluded by the TV: ${exclude.join(", ")}`);
  return cap(parts.length > 0 ? parts.join("; ") : "no source to try");
}

export class ProblemService {
  private readonly o: ProblemDeps;
  private readonly reports: RateLimiter;
  private readonly proxyProblems: RateLimiter;

  constructor(opts: ProblemDeps) {
    this.o = opts;
    this.reports = new RateLimiter(PROBLEM_REPORT_LIMIT.max, PROBLEM_REPORT_LIMIT.windowMs, opts.now);
    this.proxyProblems = new RateLimiter(1, PROXY_PROBLEM_INTERVAL_MS, opts.now);
  }

  /** Stores a problem; `catalogId` is set when the episode (or, for a channel, the item) is in the catalog. */
  private insert(deviceId: string, origin: ProblemOrigin, p: Omit<Problem, "id" | "deviceId" | "origin" | "catalogId">): Problem {
    const key = problemKey(this.o.catalog, p);
    const about = key && this.o.catalog.describe(key);
    // The item kind is null exactly when the item is unknown to this catalog.
    const catalogId = about && about.itemKind !== null ? this.o.catalog.catalogId : null;
    return this.o.store.transaction(() => {
      const problem = this.o.store.insertProblem({ ...p, deviceId, origin, catalogId, itemId: about?.itemId ?? p.itemId }, PROBLEMS_KEPT);
      // Ids, kind and code only: the detail stays in the problem list.
      const data = { problemId: problem.id, origin, kind: problem.kind, code: problem.code, itemId: problem.itemId, episodeId: problem.episodeId };
      this.o.eventLog.append("problem.recorded", deviceId, origin === "tv" ? tvActor(deviceId) : SERVER, data);
      return problem;
    });
  }

  /** A TV's own report. Free text is redacted before it is stored. */
  report(device: Device, body: ProblemReportBody): Problem {
    const rate = this.reports.hit(device.id);
    if (!rate.ok) throw tooManyRequests("too_many_problems", "too many problem reports from this TV", rate.retryAfterSec);
    // Only the TV's own session, and only for what the report says it played (an episode, or a channel's item).
    const session = this.o.sessions.owned(body.sessionId, device.id, { itemId: body.itemId, episodeId: body.episodeId });
    const text = (value: string | undefined) => (value === undefined || value.trim() === "" ? null : redactReportText(value));
    const problem = this.insert(device.id, "tv", {
      at: this.o.now() - (body.ageMs ?? 0), kind: body.kind, code: redactReportText(body.code),
      itemId: body.itemId ?? session?.itemId ?? null, episodeId: body.episodeId ?? session?.episodeId ?? null, sourceId: body.sourceId ?? session?.sourceId ?? null,
      positionMs: body.positionMs ?? null, httpStatus: body.httpStatus ?? null, detail: text(body.detail), appVersion: text(body.appVersion),
    });
    // Kind and code only: the detail may hold anything the TV saw.
    this.o.log.info("problem reported", { deviceId: device.id, kind: problem.kind, code: problem.code });
    return problem;
  }

  /** A problem the server saw for a TV. Never throws: recording must not break the request that ran into it. */
  record(deviceId: string, p: ServerProblem): void {
    try {
      const { kind, code, itemId = null, episodeId = null, sourceId = null, httpStatus = null } = p;
      const detail = p.detail ? cap(p.detail) : null;
      this.insert(deviceId, "server", { at: this.o.now(), kind, code, itemId, episodeId, sourceId, positionMs: null, httpStatus, detail, appVersion: null });
      this.o.log.debug("problem recorded", { deviceId, kind: p.kind, code: p.code });
    } catch (err) {
      this.o.log.warn("problem not recorded", { deviceId, kind: p.kind, code: p.code, error: err });
    }
  }

  /** A failed upstream request of a proxy session: the TV's sessions only, at most one per device and code a minute. */
  recordProxy(p: ProxyProblem): void {
    if (isCompanionScope(p.owner) || isCheckScope(p.owner)) return;
    if (!this.proxyProblems.hit(`${p.owner}\u0000${p.code}`).ok) return;
    this.record(p.owner, { kind: "proxy", code: p.code, itemId: p.itemId, episodeId: p.episodeId, sourceId: p.sourceId, httpStatus: p.httpStatus, detail: p.detail });
  }

  stats(deviceId: string): { recent: number; lastAt: string | null } {
    const s = this.o.store.problemStats(deviceId, this.o.now() - RECENT_PROBLEMS_MS);
    return { recent: s.recent, lastAt: iso(s.lastAt) };
  }

  /** The admin list, newest first, with titles from the current catalog. */
  list(deviceId: string, limit: number) {
    const { catalog } = this.o;
    return this.o.store.listProblems(deviceId, limit).map((p) => {
      // Ids recorded under another catalog name nothing in this one.
      const sameCatalog = p.catalogId === null || p.catalogId === catalog.catalogId;
      const key = sameCatalog ? problemKey(catalog, p) : null;
      const { id, origin, kind, code, itemId, episodeId, sourceId, positionMs, httpStatus, detail, appVersion } = p;
      // The item kind names the episode (films have none to show) or says that this is a channel.
      const about = key
        ? catalog.describe(key)
        : { itemId, itemTitle: null, itemKind: null, episodeId, episodeTitle: null, season: null, number: null, missing: itemId !== null || episodeId !== null };
      return { id, at: iso(p.at), origin, kind, code, ...about, sourceId, positionMs, httpStatus, detail, appVersion };
    });
  }

  clear(deviceId: string): void {
    this.o.store.clearProblems(deviceId);
    this.o.log.info("problems cleared", { deviceId });
  }

  purge(): void {
    this.o.store.purgeProblems(this.o.now() - PROBLEM_RETENTION_MS);
  }
}
