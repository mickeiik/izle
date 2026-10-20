import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ValidateFunction } from "ajv/dist/2020.js";
import { BUNDLE_ASSETS_DIR, BUNDLE_ITEMS_FILE, BUNDLE_MANIFEST_FILE } from "./bundle.ts";
import type { Bundle, BundleManifest, CatalogItem } from "./bundle.ts";
import { simplifySchemaErrors, validateItemsSchema, validateManifestSchema } from "./schemas.ts";

export interface ValidationIssue {
  severity: "error" | "warning";
  /** File the issue is about, relative to the bundle directory. */
  file: string;
  /** JSON pointer inside the file; "" for file-level issues. */
  path: string;
  message: string;
}

export interface BundleStats {
  items: number;
  movies: number;
  series: number;
  episodes: number;
  playableEpisodes: number;
  sources: number;
  posters: number;
  backdrops: number;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Present when `ok` is true. */
  bundle?: Bundle;
  stats?: BundleStats;
}

export class BundleValidationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(dir: string, issues: ValidationIssue[]) {
    const errors = issues.filter((i) => i.severity === "error");
    super(`invalid catalog bundle ${dir}: ${errors.length} error(s); first: ${errors[0] ? formatIssue(errors[0]) : "?"}`);
    this.name = "BundleValidationError";
    this.issues = issues;
  }
}

const MAX_JSON_BYTES = 64 * 1024 * 1024;
const IMAGE_WARN_BYTES = 1024 * 1024;

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (b) => b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
};

export function formatIssue(issue: ValidationIssue): string {
  return `${issue.path ? `${issue.file} ${issue.path}` : issue.file}: ${issue.message}`;
}

const issue = (severity: ValidationIssue["severity"], file: string, pointer: string, message: string) =>
  ({ severity, file, path: pointer, message });

/** The parsed file, or undefined when it cannot be read. */
async function readJson(dir: string, file: string, issues: ValidationIssue[]): Promise<unknown> {
  const abs = path.join(dir, file);
  const fail = (message: string) => void issues.push(issue("error", file, "", message));
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) return fail("file is missing");
  if (st.size > MAX_JSON_BYTES) return fail(`file is larger than ${MAX_JSON_BYTES} bytes`);
  try {
    return JSON.parse(await readFile(abs, "utf8"));
  } catch (err) {
    return fail(`invalid JSON (${(err as Error).name})`);
  }
}

/** The parsed file when it matches its schema; otherwise its schema errors become issues. */
function matching<T>(value: unknown, check: ValidateFunction<T>, file: string, issues: ValidationIssue[]): T | undefined {
  if (value === undefined) return undefined;
  if (check(value)) return value;
  for (const e of simplifySchemaErrors(check.errors)) issues.push(issue("error", file, e.path, e.message));
  return undefined;
}

/** Calendar check on top of the schema's ISO 8601 pattern (Date.parse accepts e.g. February 31st). */
function isValidDateTime(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s = "0", oh = "0", om = "0"] = m.slice(1);
  const daysInMonth = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  return (
    Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= daysInMonth &&
    Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59 && Number(oh) <= 23 && Number(om) <= 59
  );
}

/** Validates a bundle directory: JSON Schema plus the semantic rules of catalog-bundle-v1. */
export async function validateBundle(dir: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const absDir = path.resolve(dir);
  if (!(await stat(absDir).catch(() => null))?.isDirectory()) {
    return { ok: false, issues: [issue("error", ".", "", "bundle directory does not exist")] };
  }

  const manifestJson = await readJson(absDir, BUNDLE_MANIFEST_FILE, issues);
  const itemsJson = await readJson(absDir, BUNDLE_ITEMS_FILE, issues);
  const manifest = matching(manifestJson, validateManifestSchema, BUNDLE_MANIFEST_FILE, issues);
  if (manifest && !isValidDateTime(manifest.builtAt)) {
    issues.push(issue("error", BUNDLE_MANIFEST_FILE, "/builtAt", "not a valid date-time"));
  }
  const items = matching(itemsJson, validateItemsSchema, BUNDLE_ITEMS_FILE, issues)?.items;
  if (!manifest || !items) return { ok: false, issues };

  const walk = checkItems(manifest, items, issues);
  for (const a of new Set(manifest.adapters)) {
    if (walk.adapters.has(a)) continue;
    issues.push(issue("warning", BUNDLE_MANIFEST_FILE, "/adapters", `adapter "${a}" is not used by any source`));
  }
  const found = await checkImages(absDir, walk.images, issues);
  const counted = (field: ImageField) => found.filter((rel) => walk.images.get(rel)!.some(([f]) => f === field)).length;
  walk.stats.posters = counted("poster");
  walk.stats.backdrops = counted("backdrop");
  // Unreferenced assets are harmless but usually a sign of a stale build.
  for (const f of await readdir(path.join(absDir, BUNDLE_ASSETS_DIR)).catch(() => [])) {
    const rel = `${BUNDLE_ASSETS_DIR}/${f}`;
    if (walk.images.has(rel) || f.startsWith(".")) continue;
    issues.push(issue("warning", rel, "", "asset is not referenced by any item"));
  }
  const ok = !issues.some((i) => i.severity === "error");
  return ok ? { ok, issues, stats: walk.stats, bundle: { dir: absDir, manifest, items } } : { ok, issues, stats: walk.stats };
}

/** The item fields that name an image asset. */
const IMAGE_FIELDS = ["poster", "backdrop"] as const;
type ImageField = (typeof IMAGE_FIELDS)[number];
/** Each image path with the fields (and their JSON pointers) that name it. */
type ImageRefs = Map<string, Array<[ImageField, string]>>;

/**
 * The semantic rules for items, episodes and sources (no I/O). Returns every count but `posters` and `backdrops`,
 * the image paths with the JSON pointers that reference them, and the adapter ids the sources use.
 */
function checkItems(manifest: BundleManifest, items: CatalogItem[], issues: ValidationIssue[]) {
  const error = (pointer: string, message: string) => void issues.push(issue("error", BUNDLE_ITEMS_FILE, pointer, message));
  const checkUrl = (url: string, pointer: string) => {
    if (!["http:", "https:"].includes(URL.parse(url)?.protocol ?? "")) error(pointer, "not a valid http(s) URL");
  };
  const stats: BundleStats = { items: items.length, movies: 0, series: 0, episodes: 0, playableEpisodes: 0, sources: 0, posters: 0, backdrops: 0 };
  const itemIds = new Map<string, number>();
  const episodeOwners = new Map<string, string>();
  const declaredAdapters = new Set(manifest.adapters);
  const adapters = new Set<string>();
  const images: ImageRefs = new Map();

  items.forEach((item, i) => {
    const ip = `/items/${i}`;
    stats[item.kind === "movie" ? "movies" : "series"]++;

    const firstIndex = itemIds.get(item.id);
    if (firstIndex !== undefined) error(`${ip}/id`, `duplicate item id "${item.id}" (also /items/${firstIndex})`);
    else itemIds.set(item.id, i);

    if (item.kind === "movie" && item.episodes.length !== 1) {
      error(`${ip}/episodes`, `a movie must have exactly one episode (found ${item.episodes.length})`);
    }
    for (const field of IMAGE_FIELDS) {
      const rel = item[field];
      if (rel) images.set(rel, [...(images.get(rel) ?? []), [field, `${ip}/${field}`]]);
    }

    let playable = 0;
    item.episodes.forEach((ep, e) => {
      const ep_ = `${ip}/episodes/${e}`;
      stats.episodes++;
      if (ep.playbackAllowed) playable++;

      const owner = episodeOwners.get(ep.id);
      if (owner !== undefined) error(`${ep_}/id`, `duplicate episode id "${ep.id}" (episode ids must be unique in the bundle; also used in item "${owner}")`);
      else episodeOwners.set(ep.id, item.id);
      if (ep.sources.length === 0 && ep.playbackAllowed) error(`${ep_}/playbackAllowed`, "must be false when sources is empty");

      const sourceIds = new Set<string>();
      ep.sources.forEach((src, s) => {
        const sp = `${ep_}/sources/${s}`;
        stats.sources++;
        if (sourceIds.has(src.id)) error(`${sp}/id`, `duplicate source id "${src.id}" within the episode`);
        sourceIds.add(src.id);
        if (src.type === "direct") checkUrl(src.media.url, `${sp}/media/url`);
        else {
          adapters.add(src.adapter);
          if (!declaredAdapters.has(src.adapter)) error(`${sp}/adapter`, `adapter "${src.adapter}" is not listed in ${BUNDLE_MANIFEST_FILE} "adapters"`);
        }
        src.subtitleTracks?.forEach((t, k) => checkUrl(t.url, `${sp}/subtitleTracks/${k}/url`));
      });
    });
    stats.playableEpisodes += playable;
    if (playable === 0) issues.push(issue("warning", BUNDLE_ITEMS_FILE, ip, `item "${item.id}" has no episode with playbackAllowed: true`));
  });

  return { stats, images, adapters };
}

/**
 * Posters and backdrops: present, content-addressed (sha256 of the bytes), and of the type their extension says. A
 * file named by both fields is checked once. Returns the paths that exist.
 */
async function checkImages(dir: string, images: ImageRefs, issues: ValidationIssue[]): Promise<string[]> {
  const found: string[] = [];
  for (const [rel, uses] of images) {
    const bytes = await readFile(path.join(dir, rel)).catch(() => null);
    if (!bytes) {
      for (const [field, r] of uses) issues.push(issue("error", BUNDLE_ITEMS_FILE, r, `${field} file ${rel} is missing`));
      continue;
    }
    found.push(rel);
    const [, name = "", ext = ""] = /^assets\/([0-9a-f]{64})\.(\w+)$/.exec(rel) ?? [];
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== name) issues.push(issue("error", rel, "", `sha256 of the content is ${digest}, not the file name`));
    if (!MAGIC[ext]?.(bytes)) issues.push(issue("error", rel, "", `content is not a ${ext} image`));
    if (bytes.length > IMAGE_WARN_BYTES) issues.push(issue("warning", rel, "", `${uses[0]![0]} is larger than ${IMAGE_WARN_BYTES} bytes`));
  }
  return found;
}

/** Loads a bundle, throwing BundleValidationError when it has errors. Warnings are returned alongside. */
export async function loadBundle(dir: string): Promise<{ bundle: Bundle; warnings: ValidationIssue[]; stats: BundleStats }> {
  const result = await validateBundle(dir);
  if (!result.ok || !result.bundle || !result.stats) throw new BundleValidationError(dir, result.issues);
  return { bundle: result.bundle, warnings: result.issues, stats: result.stats };
}
