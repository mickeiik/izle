import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { simplifySchemaErrors } from "@izle/contract";
import type { Context } from "hono";
import { HttpError } from "./errors.ts";

const ajv = new Ajv2020({ strict: true, allErrors: true });

const ID = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$" };
const LANGUAGE_TAG = { type: "string", pattern: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$", maxLength: 35 };
const NAME = { type: "string", minLength: 1, maxLength: 60, pattern: "\\S" };
const MS = { type: "integer", minimum: 0, maximum: 1e12 };

function compile<T>(schema: object): ValidateFunction<T> {
  return ajv.compile<T>(schema);
}

export const approveBody = compile<{ code: string; name?: string }>({
  type: "object",
  required: ["code"],
  properties: { code: { type: "string", pattern: "^[0-9]{6}$" }, name: NAME },
  additionalProperties: false,
});

export const devicePatchBody = compile<{
  name?: string;
  uiLanguage?: "tr" | "en" | null;
  preferredAudioLanguage?: string | null;
  subtitlesLanguage?: string | null;
}>({
  type: "object",
  minProperties: 1,
  properties: {
    name: NAME,
    uiLanguage: { anyOf: [{ enum: ["tr", "en"] }, { type: "null" }] },
    preferredAudioLanguage: { anyOf: [LANGUAGE_TAG, { type: "null" }] },
    subtitlesLanguage: { anyOf: [LANGUAGE_TAG, { type: "null" }] },
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

export const commandBody = compile<{ type: "play"; episodeId: string } | { type: "stop" }>({
  oneOf: [
    {
      type: "object",
      required: ["type", "episodeId"],
      properties: { type: { const: "play" }, episodeId: ID },
      additionalProperties: false,
    },
    { type: "object", required: ["type"], properties: { type: { const: "stop" } }, additionalProperties: false },
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
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,119}$/.test(value);
}
