import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { ID_PATTERN, simplifySchemaErrors } from "@izle/contract";
import type { Context } from "hono";
import { COMMAND_RESULTS, MAX_SEEK_DELTA_MS, MESSAGE_DURATION_SEC, MESSAGE_MAX_CHARS, PLAIN_COMMANDS, type CommandBody, type CommandResult } from "./commands.ts";
import type { CompanionResolveInput, LinkInput } from "./companion.ts";
import { LANGUAGE_TAG_PATTERN, objectSchema as object } from "./config.ts";
import type { DiagnosticsInput } from "./diagnostics.ts";
import { HttpError } from "./errors.ts";
import { HOME_COLUMNS, HOME_ROWS } from "./home.ts";
import { PAIR_CODE } from "./pairing.ts";
import { LIVE_REPORT_STATUSES, PROGRESS_REPORT_STATUSES } from "./playback.ts";
import type { ProgressInput } from "./playing.ts";
import { TV_PROBLEM_KINDS, type ProblemReportBody } from "./problems.ts";
import type { ResolveInput } from "./resolve.ts";
import type { DevicePatch } from "./store.ts";
import { SCOPES, type Scope } from "./tokens.ts";
import { VIEWING_TRIGGERS } from "./viewings.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });

const ID = { type: "string", pattern: ID_PATTERN.source };
const NULL = { type: "null" };
const BOOLEAN = { type: "boolean" };
const LANGUAGE_TAG_OR_NULL = { anyOf: [{ type: "string", pattern: LANGUAGE_TAG_PATTERN, maxLength: 35 }, NULL] };
const NAME = { type: "string", minLength: 1, maxLength: 60, pattern: "\\S" };
const MS = { type: "integer", minimum: 0, maximum: 1e12 };

export const approveBody = ajv.compile<{ code: string; name?: string; replaces?: string }>(
  object({ code: { type: "string", pattern: PAIR_CODE.source }, name: NAME, replaces: ID }, ["code"]),
);

export const adoptBody = ajv.compile<{ fromDeviceId: string }>(object({ fromDeviceId: ID }, ["fromDeviceId"]));

export const devicePatchBody = ajv.compile<DevicePatch>({
  ...object({
    name: NAME, uiLanguage: { anyOf: [{ enum: ["tr", "en"] }, NULL] }, preferredAudioLanguage: LANGUAGE_TAG_OR_NULL,
    subtitlesLanguage: LANGUAGE_TAG_OR_NULL, autoplayOnStart: BOOLEAN,
    homeColumns: { type: "integer", minimum: HOME_COLUMNS.min, maximum: HOME_COLUMNS.max },
    homeRows: { type: "integer", minimum: HOME_ROWS.min, maximum: HOME_ROWS.max },
  }),
  minProperties: 1,
});

export const tokenBody = ajv.compile<{ name: string; scope: Scope }>(object({ name: NAME, scope: { enum: SCOPES } }, ["name", "scope"]));

/** One branch's own fields, and which of them it requires. */
type Branch = { properties?: object; required?: string[] };

/**
 * A body naming an episode by its id or a channel by its item id, with the `shared` fields on both branches and
 * each branch's own extras. Each branch forbids the other's id, so a body matches one.
 */
const episodeOrChannel = (shared: object, episode: Branch = {}, channel: Branch = {}) => ({
  oneOf: [
    object({ episodeId: ID, ...shared, ...episode.properties }, ["episodeId", ...(episode.required ?? [])]),
    object({ itemId: ID, ...shared, ...channel.properties }, ["itemId", ...(channel.required ?? [])]),
  ],
});

const ITEM_IDS = { type: "array", items: ID, maxItems: 1000 };
const POSITION = { type: "integer", minimum: 0 };

export const homeBody = ajv.compile<{ itemIds: string[]; expected?: string[] }>(object({ itemIds: ITEM_IDS, expected: ITEM_IDS }, ["itemIds"]));

export const homeItemBody = ajv.compile<{ itemId: string; position?: number }>(object({ itemId: ID, position: POSITION }, ["itemId"]));

export const homeMoveBody = ajv.compile<{ position: number }>(object({ position: POSITION }, ["position"]));

export const cursorBody = ajv.compile<{ itemId: string; episodeId: string }>(object({ itemId: ID, episodeId: ID }, ["itemId", "episodeId"]));

const CODE = { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.:-]+$" };

export const commandResultBody = ajv.compile<{ result: CommandResult; reason?: string }>(object({ result: { enum: COMMAND_RESULTS }, reason: CODE }, ["result"]));

const SEEK_DELTA = { type: "integer", minimum: -MAX_SEEK_DELTA_MS, maximum: MAX_SEEK_DELTA_MS };
const MESSAGE = { type: "string", minLength: 1, maxLength: MESSAGE_MAX_CHARS, pattern: "\\S" };
const DURATION_SEC = { type: "integer", minimum: MESSAGE_DURATION_SEC.min, maximum: MESSAGE_DURATION_SEC.max };

export const commandBody = ajv.compile<CommandBody>({
  oneOf: [
    // By item (what OK would play, or the episode given with it) or by episode alone: the second branch forbids
    // itemId, so a body matches one branch. positionMs instead of the saved position.
    object({ type: { const: "play" }, itemId: ID, episodeId: ID, positionMs: MS }, ["type", "itemId"]),
    object({ type: { const: "play" }, episodeId: ID, positionMs: MS }, ["type", "episodeId"]),
    object({ type: { enum: PLAIN_COMMANDS } }, ["type"]),
    // A seek is relative (deltaMs) or absolute (positionMs), never both: each branch forbids the other field.
    object({ type: { const: "seek" }, deltaMs: SEEK_DELTA }, ["type", "deltaMs"]),
    object({ type: { const: "seek" }, positionMs: MS }, ["type", "positionMs"]),
    object({ type: { const: "message" }, text: MESSAGE, durationSec: DURATION_SEC }, ["type", "text"]),
    object({ type: { const: "update" } }, ["type"]),
  ],
});

const RESOLVE_FIELDS = {
  sourceId: ID, exclude: { type: "array", items: ID, maxItems: 64 },
  // The viewing history: what started this playback, and the command when it was a remote one.
  trigger: { enum: VIEWING_TRIGGERS }, commandId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
};

export const resolveBody = ajv.compile<ResolveInput>(episodeOrChannel(RESOLVE_FIELDS));

export const marksBody = ajv.compile<{ episodeIds: string[]; seen: boolean | null }>(
  object({ episodeIds: { type: "array", items: ID, minItems: 1, maxItems: 500 }, seen: { anyOf: [BOOLEAN, NULL] } }, ["episodeIds", "seen"]),
);

const DIAGNOSTICS_FIELDS = { sourceId: ID, preferredAudioLanguage: LANGUAGE_TAG_OR_NULL, probe: BOOLEAN };

export const diagnosticsBody = ajv.compile<DiagnosticsInput>(episodeOrChannel(DIAGNOSTICS_FIELDS));

const REPORT_FIELDS = {
  sessionId: { anyOf: [{ type: "string", maxLength: 64 }, NULL] },
  // Listen along: whether the player was actually advancing, and how old the sample is (queue delays).
  playing: BOOLEAN,
  ageMs: { type: "integer", minimum: 0, maximum: 60_000 },
};

// An episode's report carries its position; a channel's carries none (a channel is never paused and never
// finishes), so each branch also forbids the other's fields.
export const progressBody = ajv.compile<ProgressInput>(
  episodeOrChannel(
    REPORT_FIELDS,
    { properties: { positionMs: MS, durationMs: { anyOf: [MS, NULL] }, status: { enum: PROGRESS_REPORT_STATUSES } }, required: ["positionMs", "status"] },
    { properties: { status: { enum: LIVE_REPORT_STATUSES } }, required: ["status"] },
  ),
);

export const problemBody = ajv.compile<ProblemReportBody>(
  object(
    {
      kind: { enum: TV_PROBLEM_KINDS },
      code: CODE,
      // How long ago it happened: a report queued while the server was unreachable keeps its time.
      ageMs: { type: "integer", minimum: 0, maximum: 86_400_000 },
      itemId: ID,
      episodeId: ID,
      sourceId: ID,
      sessionId: { type: "string", maxLength: 64 },
      positionMs: MS,
      httpStatus: { type: "integer", minimum: 100, maximum: 599 },
      detail: { type: "string", maxLength: 500 },
      appVersion: { type: "string", maxLength: 40 },
    },
    ["kind", "code"],
  ),
);

const OFFSET_MS = { type: "integer", minimum: -21_600_000, maximum: 21_600_000 };
const RATE = { type: "number", minimum: 0.5, maximum: 2 };

export const companionLinkBody = ajv.compile<LinkInput>(object({ offsetMs: OFFSET_MS, rate: RATE, language: LANGUAGE_TAG_OR_NULL }, ["offsetMs", "rate"]));

export const companionResolveBody = ajv.compile<CompanionResolveInput>(
  object({ episodeId: ID, sourceId: ID, language: LANGUAGE_TAG_OR_NULL }, ["episodeId", "sourceId"]),
);

/** Parses and validates a JSON request body, answering 400 with readable details otherwise. */
export async function parseBody<T>(c: Context, validate: ValidateFunction<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "the request body is not valid JSON");
  }
  if (!validate(body)) throw new HttpError(400, "invalid_request", "the request body does not match the API", { details: simplifySchemaErrors(validate.errors) });
  return body;
}

export function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** The `wait=<seconds>` query parameter of the long-poll routes. */
export function parseWait(param: string | undefined, defaultSec: number, maxSec: number): number {
  const sec = param === undefined ? defaultSec : Number(param);
  if (!Number.isInteger(sec) || sec < 0 || sec > maxSec) throw new HttpError(400, "invalid_request", `wait must be an integer between 0 and ${maxSec}`);
  return sec;
}

/** A positive integer id in a route path (`:id`); 404 `code` for anything else. */
export function intParam(value: string | undefined, code: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, code);
  return n;
}

/** An optional integer query parameter of at least `min`; 400 `invalid_request` for anything else. */
export function intQuery(value: string | undefined, name: string, min: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) throw new HttpError(400, "invalid_request", `${name} must be an integer of at least ${min}`);
  return n;
}

/** `?limit=`: clamped into 1..max, `fallback` when absent or not a number. */
export function limitQuery(value: string | undefined, fallback: number, max: number): number {
  const asked = Math.trunc(Number(value ?? fallback)) || fallback;
  return Math.min(Math.max(asked, 1), max);
}

/** A comma-separated query parameter (at most 100 entries, each checked by `ok`); undefined when absent. */
export function listQuery(value: string | undefined, name: string, ok: (v: string) => boolean): string[] | undefined {
  if (value === undefined) return undefined;
  const list = value.split(",").map((v) => v.trim()).filter((v) => v !== "");
  if (list.length === 0 || list.length > 100 || list.some((v) => !ok(v))) throw new HttpError(400, "invalid_request", `${name} must be a comma-separated list of ${name}`);
  return list;
}
