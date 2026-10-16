// The viewing history for the owner and agents: the viewings (paged, filtered), one viewing with its played
// ranges, the titles and their status, an item's episodes, the day counts, the owner's marks, and the deletions
// (owner token only; the scope table in the middleware says so).

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { dayCounts, mergeRanges, TITLE_SORTS, TITLE_STATUSES, titleDetail, titleSummaries, viewingJson, type TitleSort, type TitleStatus } from "../../viewing-summaries.ts";
import { isId, marksBody, parseBody } from "../../validation.ts";
import type { Env } from "../middleware.ts";

const VIEWINGS_DEFAULT = 50;
const VIEWINGS_MAX = 200;
const TITLES_DEFAULT = 100;
const TITLES_MAX = 500;

/** `?device=`: a device id (the TV need not exist any more: its viewings outlive it), or null. */
function parseDevice(c: Context): string | null {
  const id = c.req.query("device");
  if (id === undefined) return null;
  if (!isId(id)) throw new HttpError(400, "invalid_request", "device must be a device id");
  return id;
}

/** An optional id query parameter (`item`, `episode`). */
function parseIdParam(c: Context, name: string): string | undefined {
  const id = c.req.query(name);
  if (id !== undefined && !isId(id)) throw new HttpError(400, "invalid_request", `${name} must be an id`);
  return id;
}

/** An optional ISO 8601 instant query parameter, as epoch ms. */
function parseTime(c: Context, name: string): number | undefined {
  const value = c.req.query(name);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new HttpError(400, "invalid_request", `${name} must be an ISO 8601 date-time`);
  return ms;
}

/** `?limit=`: clamped into 1..max, `fallback` when absent or not a number. */
function parseLimit(c: Context, fallback: number, max: number): number {
  const asked = Math.trunc(Number(c.req.query("limit") ?? fallback)) || fallback;
  return Math.min(Math.max(asked, 1), max);
}

/** `:id` of a viewing route: a positive integer, else 404 `unknown_viewing`. */
function viewingId(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(404, "unknown_viewing");
  return id;
}

/** A comma-separated choice among `allowed`; absent = null. */
function parseChoices<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T[] | null {
  if (value === undefined) return null;
  const list = value.split(",").map((v) => v.trim()).filter((v) => v !== "");
  if (list.length === 0 || list.some((v) => !allowed.includes(v as T))) throw new HttpError(400, "invalid_request", `${name} must be among ${allowed.join(", ")}`);
  return list as T[];
}

export function registerAdminHistory(app: Hono<Env>, ctx: AppContext): void {
  const { store, catalog, viewings } = ctx;

  app.get("/api/v1/admin/history/viewings", (c) => {
    const limit = parseLimit(c, VIEWINGS_DEFAULT, VIEWINGS_MAX);
    const before = c.req.query("before");
    if (before !== undefined && (!Number.isSafeInteger(Number(before)) || Number(before) < 1)) throw new HttpError(400, "invalid_request", "before must be a viewing id");
    const filter = {
      catalogId: catalog.catalogId, deviceId: parseDevice(c) ?? undefined, itemId: parseIdParam(c, "item"), episodeId: parseIdParam(c, "episode"),
      from: parseTime(c, "from"), to: parseTime(c, "to"), before: before === undefined ? undefined : Number(before), limit: limit + 1,
    };
    // One more than asked tells whether a next page exists.
    const page = store.listViewings(filter);
    const shown = page.slice(0, limit);
    return c.json({ viewings: shown.map(viewingJson), next: page.length > limit ? shown.at(-1)!.id : null });
  });

  app.get("/api/v1/admin/history/viewings/:id", (c) => {
    const v = store.getViewing(viewingId(c));
    if (!v) throw new HttpError(404, "unknown_viewing");
    return c.json({ viewing: viewingJson(v), ranges: mergeRanges(store.viewingRanges(v.id)) });
  });

  app.get("/api/v1/admin/history/titles", (c) => {
    const statuses = parseChoices<TitleStatus>(c.req.query("status"), TITLE_STATUSES, "status");
    const sort = parseChoices<TitleSort>(c.req.query("sort"), TITLE_SORTS, "sort");
    if (sort && sort.length !== 1) throw new HttpError(400, "invalid_request", "sort takes one value");
    return c.json({ titles: titleSummaries(ctx, { deviceId: parseDevice(c), statuses, sort: sort?.[0] ?? "recent", limit: parseLimit(c, TITLES_DEFAULT, TITLES_MAX) }) });
  });

  app.get("/api/v1/admin/history/titles/:itemId", (c) => {
    const itemId = c.req.param("itemId");
    if (!isId(itemId)) throw new HttpError(404, "unknown_item");
    return c.json(titleDetail(ctx, itemId, parseDevice(c)));
  });

  app.get("/api/v1/admin/history/days", (c) => {
    const { tz = null, from = null, to = null } = c.req.query();
    return c.json(dayCounts(ctx, { deviceId: parseDevice(c), tz, from, to }));
  });

  app.post("/api/v1/admin/history/marks", async (c) => {
    const body = await parseBody(c, marksBody);
    return c.json({ updated: viewings.setMarks(body.episodeIds, body.seen, c.get("actor")) });
  });

  app.delete("/api/v1/admin/history", (c) => {
    const olderThan = parseTime(c, "olderThan");
    return c.json({ deleted: viewings.deleteViewings(parseDevice(c), olderThan ?? null, c.get("actor")) });
  });

  app.delete("/api/v1/admin/history/viewings/:id", (c) => {
    if (!viewings.deleteViewing(viewingId(c), c.get("actor"))) throw new HttpError(404, "unknown_viewing");
    return c.body(null, 204);
  });
}
