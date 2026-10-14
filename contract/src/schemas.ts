import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { BundleManifest, ItemsFile } from "./bundle.ts";
import type { ResolveResult } from "./resolver.ts";

export const SCHEMA_IDS = {
  common: "urn:izle:schema:common:v1",
  bundle: "urn:izle:schema:bundle:v1",
  items: "urn:izle:schema:items:v1",
  resolveResult: "urn:izle:schema:resolve-result:v1",
} as const;

const loadSchema = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../schema/${file}`, import.meta.url), "utf8"));

const ajv = new Ajv2020({ strict: true, allErrors: true, discriminator: true });
ajv.addSchema(loadSchema("common.v1.schema.json"));

export const validateManifestSchema = ajv.compile(loadSchema("bundle.v1.schema.json")) as ValidateFunction<BundleManifest>;
export const validateItemsSchema = ajv.compile(loadSchema("items.v1.schema.json")) as ValidateFunction<ItemsFile>;
export const validateResolveResultsSchema = ajv.compile(loadSchema("resolve-result.v1.schema.json")) as ValidateFunction<
  ResolveResult[]
>;

/** One-line, human-readable description of an ajv error. */
function describeSchemaError(err: ErrorObject): string {
  const p = err.params as Record<string, unknown>;
  switch (err.keyword) {
    case "additionalProperties":
      return `unknown property "${String(p.additionalProperty)}"`;
    case "required":
      return `missing required property "${String(p.missingProperty)}"`;
    case "const":
      return `must be ${JSON.stringify(p.allowedValue)}`;
    case "enum":
      return `must be one of ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "propertyNames":
      return `invalid property name "${String(p.propertyName)}"`;
    default:
      return err.message ?? err.keyword;
  }
}

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
