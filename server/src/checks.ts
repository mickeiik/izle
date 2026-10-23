// Catalog check runs (admin): every allowed episode of a show, a channel, or a TV's Home (what OK plays on each
// entry, or every episode) through the same deep check as a single one (diagnostics.ts), two at a time. One run at a
// time server-wide, in memory: a restart forgets it. The event log gets its start and its end, never an event per
// episode.

import { isLiveItem, type CatalogItem, type Episode } from "@izle/contract";
import { SERVER, type Actor } from "./actor.ts";
import { newId } from "./auth.ts";
import { episodeIdOf, liveRef, type CatalogService, type PlayableRef } from "./catalog.ts";
import type { ServerConfig } from "./config.ts";
import { effectiveSettings } from "./devices.ts";
import { CheckAborted, playableIdOf, type SourceChecker, type Verdict } from "./diagnostics.ts";
import { errorName, HttpError } from "./errors.ts";
import type { EventLog } from "./eventlog.ts";
import type { HomeService } from "./home.ts";
import type { Logger } from "./log.ts";
import { requireItem } from "./lookup.ts";
import { iso } from "./presenters.ts";
import type { Device, Store } from "./store.ts";
import { Waiters } from "./waiters.ts";

export const MAX_CHECK_WAIT_MS = 25_000;
/** Episodes or channels checked at the same time. */
const CONCURRENCY = 2;

export const CHECK_MODES = ["quick", "full"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];

/** `POST /admin/checks`: a show or a channel, or a TV's Home (`quick`: what OK plays; `full`: every episode). */
export type CheckTarget = { itemId: string } | { deviceId: string; mode: CheckMode };

interface Skipped {
  itemId: string;
  title: string | null;
  reason: "missing" | "not_playable";
}

interface RunResult {
  playableId: string;
  itemId: string;
  episodeId: string | null;
  title: string;
  label: string | null;
  verdict: Verdict;
}

export interface Run {
  id: string;
  target: CheckTarget;
  title: string;
  state: "running" | "done" | "cancelled";
  /** Grows on every change, for long-polling. */
  seq: number;
  total: number;
  done: number;
  failed: number;
  warned: number;
  startedAt: string;
  finishedAt: string | null;
  skipped: Skipped[];
  /** In completion order. */
  results: RunResult[];
}

interface RunState {
  run: Run;
  deviceId: string | null;
  actor: Actor;
  controller: AbortController;
  settled: Promise<void>;
}

interface CheckDeps {
  config: ServerConfig;
  store: Store;
  catalog: CatalogService;
  home: HomeService;
  checker: SourceChecker;
  eventLog: EventLog;
  log: Logger;
  now: () => number;
}

/** Every episode of an item that may be played, or the channel itself if it may. */
function allowed(item: CatalogItem): PlayableRef[] {
  if (isLiveItem(item)) return item.playbackAllowed ? [liveRef(item)] : [];
  return item.episodes.flatMap((episode, index) => (episode.playbackAllowed ? [{ kind: "episode" as const, item, episode, index }] : []));
}

/** How a run's result names an episode (`S1 E2 · Pilot`); null for a film's or a channel's. */
function episodeLabel(item: CatalogItem, episode: Episode | null): string | null {
  if (!episode || item.kind !== "series") return null;
  const { season, number } = episode;
  const position = number === undefined ? null : season === undefined ? `E${number}` : `S${season} E${number}`;
  return [position, episode.title ?? episode.label ?? null].filter((p) => p !== null).join(" · ") || null;
}

export class CheckService {
  private readonly o: CheckDeps;
  /** The running run, else the last one that ended. */
  private last: RunState | null = null;
  private readonly waiters = new Waiters<string>();

  constructor(deps: CheckDeps) {
    this.o = deps;
  }

  /** What a target checks, in order and without duplicates, and the Home entries left out. */
  private targets(target: CheckTarget, device: Device | null): { title: string; refs: PlayableRef[]; skipped: Skipped[] } {
    const { catalog, home } = this.o;
    if ("itemId" in target) {
      const item = requireItem(catalog, target.itemId, 404, "unknown_item");
      return { title: item.title, refs: allowed(item), skipped: [] };
    }
    const refs: PlayableRef[] = [];
    const skipped: Skipped[] = [];
    const seen = new Set<string>();
    for (const e of home.list(device!.id)) {
      if (!e.item) {
        skipped.push({ itemId: e.itemId, title: null, reason: "missing" });
        continue;
      }
      const ok = e.playable && (isLiveItem(e.item) || e.continue !== null);
      if (!ok) {
        skipped.push({ itemId: e.itemId, title: e.item.title, reason: "not_playable" });
        continue;
      }
      const quick = isLiveItem(e.item) ? [liveRef(e.item)] : [catalog.episode(e.continue!.episodeId)].filter((r) => r !== undefined);
      for (const ref of target.mode === "quick" ? quick : allowed(e.item)) {
        const key = `${ref.item.id}\u0000${episodeIdOf(ref) ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(ref);
      }
    }
    return { title: device!.name, refs, skipped };
  }

  /** Starts a run (`device`: the TV a Home target names). 409 `check_running` while one runs. */
  start(target: CheckTarget, device: Device | null, actor: Actor): Run {
    const { store, eventLog, log, now } = this.o;
    if (this.last?.run.state === "running") throw new HttpError(409, "check_running", "a check is running", { runId: this.last.run.id });
    const { title, refs, skipped } = this.targets(target, device);
    if (refs.length === 0) throw new HttpError(400, "nothing_to_check", "nothing here may be played");
    const run: Run = {
      id: newId(12), target, title, state: "running", seq: 1, total: refs.length, done: 0, failed: 0, warned: 0, startedAt: iso(now())!,
      finishedAt: null, skipped, results: [],
    };
    const deviceId = device?.id ?? null;
    store.transaction(() => eventLog.append("check.started", deviceId, actor, { runId: run.id, total: run.total }));
    log.info("check started", { runId: run.id, total: run.total, ...(deviceId ? { deviceId } : {}) });
    // A Home is checked with its TV's audio language (adapters may pick a stream by it).
    const language = device ? effectiveSettings(device, this.o.config, this.o.catalog).preferredAudioLanguage : null;
    const state: RunState = { run, deviceId, actor, controller: new AbortController(), settled: Promise.resolve() };
    this.last = state;
    state.settled = this.execute(state, refs, language);
    return run;
  }

  private async execute(state: RunState, refs: PlayableRef[], preferredAudioLanguage: string | null): Promise<void> {
    const { run, controller } = state;
    const signal = controller.signal;
    let next = 0;
    const worker = async () => {
      while (next < refs.length && !signal.aborted) {
        const ref = refs[next++]!;
        let verdict: Verdict;
        try {
          verdict = (await this.o.checker.check(ref, { preferredAudioLanguage, signal })).verdict;
        } catch (err) {
          if (err instanceof CheckAborted || signal.aborted) return;
          this.o.log.warn("check failed", { runId: run.id, itemId: ref.item.id, episodeId: episodeIdOf(ref), error: errorName(err) });
          verdict = "fail";
        }
        if (run.state !== "running") return;
        const episode = ref.kind === "episode" ? ref.episode : null;
        run.results.push({
          playableId: playableIdOf(ref), itemId: ref.item.id, episodeId: episodeIdOf(ref), title: ref.item.title, label: episodeLabel(ref.item, episode), verdict,
        });
        run.done++;
        if (verdict === "fail") run.failed++;
        if (verdict === "warn") run.warned++;
        this.changed(run);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, refs.length) }, worker));
    if (run.state === "running") this.finish(state, "done", state.actor);
  }

  private changed(run: Run): void {
    run.seq++;
    this.waiters.wake(run.id);
  }

  private finish(state: RunState, end: "done" | "cancelled", actor: Actor): void {
    const { run } = state;
    run.state = end;
    run.finishedAt = iso(this.o.now());
    const { total, failed, warned } = run;
    this.o.store.transaction(() => this.o.eventLog.append("check.finished", state.deviceId, actor, { runId: run.id, total, failed, warned, state: end }));
    this.o.log.info("check finished", { runId: run.id, state: end, total, done: run.done, failed, warned });
    this.changed(run);
  }

  /** The running run, else the last one that ended; null when there was none since the start. */
  current(): Run | null {
    return this.last?.run ?? null;
  }

  private state(id: string): RunState {
    if (this.last?.run.id !== id) throw new HttpError(404, "unknown_check");
    return this.last;
  }

  get(id: string): Run {
    return this.state(id).run;
  }

  /** The run, as soon as its `seq` is past `seq` or after `waitMs` (at most MAX_CHECK_WAIT_MS); null `seq`: at once. */
  async wait(id: string, seq: number | null, waitMs: number, signal?: AbortSignal): Promise<Run> {
    const { run } = this.state(id);
    if (seq === null || waitMs <= 0 || run.seq > seq) return run;
    await this.waiters.wait(id, Math.min(waitMs, MAX_CHECK_WAIT_MS), signal);
    return run;
  }

  /** Stops a running run (what it checked so far stays stored); a run that ended is answered as it is. */
  cancel(id: string, actor: Actor): Run {
    const state = this.state(id);
    if (state.run.state === "running") {
      state.controller.abort();
      this.finish(state, "cancelled", actor);
    }
    return state.run;
  }

  /** Cancels a running run and waits for its checks to wind down (server shutdown). */
  async stop(): Promise<void> {
    const state = this.last;
    if (!state) return;
    if (state.run.state === "running") this.cancel(state.run.id, SERVER);
    await state.settled;
  }
}
