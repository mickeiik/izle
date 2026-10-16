// The viewing history for the owner and agents: the viewings (paged, filtered), one viewing with its played
// ranges, the titles and their status, an item's episodes, the day counts, the owner's marks, and the deletions
// (owner token only; the scope table in the middleware says so).

import type { Context, Hono } from "hono";
import type { AppContext } from "../../context.ts";
import { HttpError } from "../../errors.ts";
import { dayCounts, mergeRanges, TITLE_SORTS, TITLE_STATUSES, titleDetail, titleSummaries, viewingJson, type TitleSort, type TitleStatus } from "../../viewing-summaries.ts";
import { intParam, intQuery, isId, limitQuery, listQuery, marksBody, parseBody } from "../../validation.ts";
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

/** `:id` of a viewing route: a positive integer, else 404 `unknown_viewing`. */
const viewingId = (c: Context) => intParam(c.req.param("id"), "unknown_viewing");

/** A comma-separated choice among `allowed`; absent = null. */
function parseChoices<T extends string>(c: Context, name: string, allowed: readonly T[]): T[] | null {
  return (listQuery(c.req.query(name), name, (v) => allowed.includes(v as T)) as T[] | undefined) ?? null;
}

export function registerAdminHistory(app: Hono<Env>, ctx: AppContext): void {
  const { store, catalog, viewings } = ctx;

  app.get("/api/v1/admin/history/viewings", (c) => {
    const limit = limitQuery(c.req.query("limit"), VIEWINGS_DEFAULT, VIEWINGS_MAX);
    const filter = {
      catalogId: catalog.catalogId, deviceId: parseDevice(c) ?? undefined, itemId: parseIdParam(c, "item"), episodeId: parseIdParam(c, "episode"),
      from: parseTime(c, "from"), to: parseTime(c, "to"), before: intQuery(c.req.query("before"), "before", 1), limit: limit + 1,
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
    const statuses = parseChoices<TitleStatus>(c, "status", TITLE_STATUSES);
    const sort = parseChoices<TitleSort>(c, "sort", TITLE_SORTS);
    if (sort && sort.length !== 1) throw new HttpError(400, "invalid_request", "sort takes one value");
    const limit = limitQuery(c.req.query("limit"), TITLES_DEFAULT, TITLES_MAX);
    return c.json({ titles: titleSummaries(ctx, { deviceId: parseDevice(c), statuses, sort: sort?.[0] ?? "recent", limit }) });
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
