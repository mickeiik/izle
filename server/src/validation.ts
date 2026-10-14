import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { ID_PATTERN, simplifySchemaErrors } from "@izle/contract";
import type { Context } from "hono";
import { MAX_SEEK_DELTA_MS, MESSAGE_DURATION_SEC, MESSAGE_MAX_CHARS, PLAIN_COMMANDS, type CommandBody } from "./commands.ts";
import { LANGUAGE_TAG_PATTERN } from "./config.ts";
import { HttpError } from "./errors.ts";
import { PAIR_CODE } from "./pairing.ts";
import { TV_PROBLEM_KINDS, type ProblemReportBody } from "./problems.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });

const ID = { type: "string", pattern: ID_PATTERN.source };
const LANGUAGE_TAG = { type: "string", pattern: LANGUAGE_TAG_PATTERN, maxLength: 35 };
const NAME = { type: "string", minLength: 1, maxLength: 60, pattern: "\\S" };
const MS = { type: "integer", minimum: 0, maximum: 1e12 };

function compile<T>(schema: object): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

export const approveBody = compile<{ code: string; name?: string }>({
  type: "object",
  required: ["code"],
  properties: { code: { type: "string", pattern: PAIR_CODE.source }, name: NAME },
  additionalProperties: false,
});

export const devicePatchBody = compile<{
  name?: string;
  uiLanguage?: "tr" | "en" | null;
  preferredAudioLanguage?: string | null;
  subtitlesLanguage?: string | null;
  autoplayOnStart?: boolean;
}>({
  type: "object",
  minProperties: 1,
  properties: {
    name: NAME,
    uiLanguage: { anyOf: [{ enum: ["tr", "en"] }, { type: "null" }] },
    preferredAudioLanguage: { anyOf: [LANGUAGE_TAG, { type: "null" }] },
    subtitlesLanguage: { anyOf: [LANGUAGE_TAG, { type: "null" }] },
    autoplayOnStart: { type: "boolean" },
  },
  additionalProperties: false,
});

export const homeBody = compile<{ itemIds: string[] }>({
  type: "object",
  required: ["itemIds"],
  properties: { itemIds: { type: "array", items: ID, maxItems: 1000 } },
  additionalProperties: false,
});

export const cursorBody = compile<{ itemId: string; episodeId: string }>({
  type: "object",
  required: ["itemId", "episodeId"],
  properties: { itemId: ID, episodeId: ID },
  additionalProperties: false,
});

export const commandBody = compile<CommandBody>({
  oneOf: [
    {
      type: "object",
      required: ["type", "episodeId"],
      properties: { type: { const: "play" }, episodeId: ID },
      additionalProperties: false,
    },
    { type: "object", required: ["type"], properties: { type: { enum: PLAIN_COMMANDS } }, additionalProperties: false },
    // A seek is relative (deltaMs) or absolute (positionMs), never both: each branch forbids the other field.
    {
      type: "object",
      required: ["type", "deltaMs"],
      properties: { type: { const: "seek" }, deltaMs: { type: "integer", minimum: -MAX_SEEK_DELTA_MS, maximum: MAX_SEEK_DELTA_MS } },
      additionalProperties: false,
    },
    { type: "object", required: ["type", "positionMs"], properties: { type: { const: "seek" }, positionMs: MS }, additionalProperties: false },
    {
      type: "object",
      required: ["type", "text"],
      properties: {
        type: { const: "message" },
        text: { type: "string", minLength: 1, maxLength: MESSAGE_MAX_CHARS, pattern: "\\S" },
        durationSec: { type: "integer", minimum: MESSAGE_DURATION_SEC.min, maximum: MESSAGE_DURATION_SEC.max },
      },
      additionalProperties: false,
    },
  ],
});

export const resolveBody = compile<{ episodeId: string; sourceId?: string; exclude?: string[] }>({
  type: "object",
  required: ["episodeId"],
  properties: { episodeId: ID, sourceId: ID, exclude: { type: "array", items: ID, maxItems: 64 } },
  additionalProperties: false,
});

export const diagnosticsBody = compile<{ episodeId: string; sourceId?: string; preferredAudioLanguage?: string | null; probe?: boolean }>({
  type: "object",
  required: ["episodeId"],
  properties: { episodeId: ID, sourceId: ID, preferredAudioLanguage: { anyOf: [LANGUAGE_TAG, { type: "null" }] }, probe: { type: "boolean" } },
  additionalProperties: false,
});

export const progressBody = compile<{
  sessionId?: string | null;
  episodeId: string;
  positionMs: number;
  durationMs?: number | null;
  status: "playing" | "paused" | "stopped" | "finished";
  playing?: boolean;
  ageMs?: number;
}>({
  type: "object",
  required: ["episodeId", "positionMs", "status"],
  properties: {
    sessionId: { anyOf: [{ type: "string", maxLength: 64 }, { type: "null" }] },
    episodeId: ID,
    positionMs: MS,
    durationMs: { anyOf: [MS, { type: "null" }] },
    status: { enum: ["playing", "paused", "stopped", "finished"] },
    // Listen along: whether the player was actually advancing, and how old the sample is (queue delays).
    playing: { type: "boolean" },
    ageMs: { type: "integer", minimum: 0, maximum: 60_000 },
  },
  additionalProperties: false,
});

export const problemBody = compile<ProblemReportBody>({
  type: "object",
  required: ["kind", "code"],
  properties: {
    kind: { enum: TV_PROBLEM_KINDS },
    code: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_.:-]+$" },
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
  additionalProperties: false,
});

const OFFSET_MS = { type: "integer", minimum: -21_600_000, maximum: 21_600_000 };
const RATE = { type: "number", minimum: 0.5, maximum: 2 };

export const companionLinkBody = compile<{ offsetMs: number; rate: number; language?: string | null }>({
  type: "object",
  required: ["offsetMs", "rate"],
  properties: { offsetMs: OFFSET_MS, rate: RATE, language: { anyOf: [LANGUAGE_TAG, { type: "null" }] } },
  additionalProperties: false,
});

export const companionResolveBody = compile<{ episodeId: string; sourceId: string; language?: string | null }>({
  type: "object",
  required: ["episodeId", "sourceId"],
  properties: { episodeId: ID, sourceId: ID, language: { anyOf: [LANGUAGE_TAG, { type: "null" }] } },
  additionalProperties: false,
});

/** Parses and validates a JSON request body, answering 400 with readable details otherwise. */
export async function parseBody<T>(c: Context, validate: ValidateFunction<T>): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "the request body is not valid JSON");
  }
  if (!validate(body)) {
    throw new HttpError(400, "invalid_request", "the request body does not match the API", { details: simplifySchemaErrors(validate.errors) });
  }
  return body;
}

export function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}
