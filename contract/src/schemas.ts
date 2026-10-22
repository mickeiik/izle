import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { BundleManifest, ItemsFile } from "./bundle.ts";
import type { ResolveResult } from "./resolver.ts";

const loadSchema = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../schema/${file}`, import.meta.url), "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(loadSchema("common.v1.schema.json"));

export const validateManifestSchema = ajv.compile(loadSchema("bundle.v1.schema.json")) as ValidateFunction<BundleManifest>;
export const validateItemsSchema = ajv.compile(loadSchema("items.v1.schema.json")) as ValidateFunction<ItemsFile>;
export const validateResolveResultsSchema = ajv.compile(loadSchema("resolve-result.v1.schema.json")) as ValidateFunction<
  ResolveResult[]
>;

/** One-line, human-readable descriptions of the ajv errors whose own message is not one. */
const DESCRIBE: Record<string, (p: Record<string, any>) => string> = {
  additionalProperties: (p) => `unknown property "${p.additionalProperty}"`,
  required: (p) => `missing required property "${p.missingProperty}"`,
  const: (p) => `must be ${JSON.stringify(p.allowedValue)}`,
  enum: (p) => `must be one of ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`,
  propertyNames: (p) => `invalid property name "${p.propertyName}"`,
};
const describeSchemaError = (err: ErrorObject) => DESCRIBE[err.keyword]?.(err.params) ?? err.message ?? err.keyword;

/**
 * Reduces ajv's error list to the useful ones: `anyOf`/`oneOf` summaries are dropped when a more specific error
 * exists at or below the same path, and duplicates are removed.
 */
export function simplifySchemaErrors(errors: ErrorObject[] | null | undefined): Array<{ path: string; message: string }> {
  if (!errors) return [];
  const isNull = (e: ErrorObject) => e.keyword === "type" && (e.params as { type?: string }).type === "null";
  const specific = errors.filter((e) => e.keyword !== "anyOf" && e.keyword !== "oneOf" && e.keyword !== "if");
  // "must be null" next to a real error on the same path comes from `anyOf [X, null]`; keep the real one.
  const realPaths = new Set(specific.filter((e) => !isNull(e)).map((e) => e.instancePath));
  const kept = specific.filter((e) => !(isNull(e) && realPaths.has(e.instancePath)));
  const list = (kept.length > 0 ? kept : errors).map((e) => ({ path: e.instancePath || "/", message: describeSchemaError(e) }));
  return [...new Map(list.map((e) => [`${e.path}\u0000${e.message}`, e])).values()];
}
