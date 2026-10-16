import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { ID_PATTERN, simplifySchemaErrors } from "@izle/contract";
import type { Context } from "hono";
import { COMMAND_RESULTS, MAX_SEEK_DELTA_MS, MESSAGE_DURATION_SEC, MESSAGE_MAX_CHARS, PLAIN_COMMANDS, type CommandBody, type CommandResult } from "./commands.ts";
import type { CompanionResolveInput, LinkInput } from "./companion.ts";
import { LANGUAGE_TAG_PATTERN, objectSchema as object } from "./config.ts";
import type { DiagnosticsInput } from "./diagnostics.ts";
import { HttpError } from "./errors.ts";
import { PAIR_CODE } from "./pairing.ts";
import { PROGRESS_REPORT_STATUSES } from "./playback.ts";
import { TV_PROBLEM_KINDS, type ProblemReportBody } from "./problems.ts";
import type { ResolveInput } from "./resolve.ts";
import type { DevicePatch } from "./store.ts";
import { SCOPES, type Scope } from "./tokens.ts";
import type { ProgressInput } from "./tv.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });

const ID = { type: "string", pattern: ID_PATTERN.source };
const NULL = { type: "null" };
const BOOLEAN = { type: "boolean" };
const LANGUAGE_TAG_OR_NULL = { anyOf: [{ type: "string", pattern: LANGUAGE_TAG_PATTERN, maxLength: 35 }, NULL] };
const NAME = { type: "string", minLength: 1, maxLength: 60, pattern: "\\S" };
const MS = { type: "integer", minimum: 0, maximum: 1e12 };

export const approveBody = ajv.compile<{ code: string; name?: string }>(object({ code: { type: "string", pattern: PAIR_CODE.source }, name: NAME }, ["code"]));

export const devicePatchBody = ajv.compile<DevicePatch>({
  ...object({
    name: NAME, uiLanguage: { anyOf: [{ enum: ["tr", "en"] }, NULL] }, preferredAudioLanguage: LANGUAGE_TAG_OR_NULL,
    subtitlesLanguage: LANGUAGE_TAG_OR_NULL, autoplayOnStart: BOOLEAN,
  }),
  minProperties: 1,
});

export const tokenBody = ajv.compile<{ name: string; scope: Scope }>(object({ name: NAME, scope: { enum: SCOPES } }, ["name", "scope"]));

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
  ],
});

export const resolveBody = ajv.compile<ResolveInput>(
  object({ episodeId: ID, sourceId: ID, exclude: { type: "array", items: ID, maxItems: 64 } }, ["episodeId"]),
);

export const diagnosticsBody = ajv.compile<DiagnosticsInput>(
  object({ episodeId: ID, sourceId: ID, preferredAudioLanguage: LANGUAGE_TAG_OR_NULL, probe: BOOLEAN }, ["episodeId"]),
);

export const progressBody = ajv.compile<ProgressInput>(
  object(
    {
      sessionId: { anyOf: [{ type: "string", maxLength: 64 }, NULL] },
      episodeId: ID,
      positionMs: MS,
      durationMs: { anyOf: [MS, NULL] },
      status: { enum: PROGRESS_REPORT_STATUSES },
      // Listen along: whether the player was actually advancing, and how old the sample is (queue delays).
      playing: BOOLEAN,
      ageMs: { type: "integer", minimum: 0, maximum: 60_000 },
    },
    ["episodeId", "positionMs", "status"],
  ),
);

export const problemBody = ajv.compile<ProblemReportBody>(
  object(
    {
      kind: { enum: TV_PROBLEM_KINDS },
      code: CODE,
      // How long ago it happened: a report queued while the server was unreachable keeps its time.
      ageMs: { type: "integer", minimum: 0, maximum: 86_400_000 },
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
