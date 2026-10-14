import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  BUNDLE_ASSETS_DIR,
  BUNDLE_ITEMS_FILE,
  BUNDLE_MANIFEST_FILE,
  type Bundle,
  type BundleManifest,
  type CatalogItem,
  type ItemsFile,
} from "./bundle.ts";
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
const POSTER_WARN_BYTES = 1024 * 1024;

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (b) => b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
};

export function formatIssue(issue: ValidationIssue): string {
  const where = issue.path ? `${issue.file} ${issue.path}` : issue.file;
  return `${where}: ${issue.message}`;
}

function issue(severity: ValidationIssue["severity"], file: string, pointer: string, message: string): ValidationIssue {
  return { severity, file, path: pointer, message };
}

async function readJson(
  dir: string,
  file: string,
  issues: ValidationIssue[],
): Promise<{ found: true; value: unknown } | { found: false }> {
  const abs = path.join(dir, file);
  let size: number;
  try {
    const st = await stat(abs);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    issues.push(issue("error", file, "", "file is missing"));
    return { found: false };
  }
  if (size > MAX_JSON_BYTES) {
    issues.push(issue("error", file, "", `file is larger than ${MAX_JSON_BYTES} bytes`));
    return { found: false };
  }
  try {
    return { found: true, value: JSON.parse(await readFile(abs, "utf8")) };
  } catch (err) {
    issues.push(issue("error", file, "", `invalid JSON (${(err as Error).name})`));
    return { found: false };
  }
}

/** Calendar check on top of the schema's ISO 8601 pattern (Date.parse accepts e.g. February 31st). */
export function isValidDateTime(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!m) return false;
  const [y, mo, d, h, mi, s = "0", oh = "0", om = "0"] = m.slice(1);
  const daysInMonth = new Date(Date.UTC(Number(y), Number(mo), 0)).getUTCDate();
  return (
    Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= daysInMonth &&
    Number(h) <= 23 && Number(mi) <= 59 && Number(s) <= 59 && Number(oh) <= 23 && Number(om) <= 59
  );
}

function checkUrl(url: string, file: string, pointer: string, issues: ValidationIssue[]): void {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
  } catch {
    issues.push(issue("error", file, pointer, "not a valid http(s) URL"));
  }
}

/** Validates a bundle directory: JSON Schema plus the semantic rules of catalog-bundle-v1. */
export async function validateBundle(dir: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  const absDir = path.resolve(dir);

  try {
    if (!(await stat(absDir)).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, issues: [issue("error", ".", "", "bundle directory does not exist")] };
  }

  const manifestJson = await readJson(absDir, BUNDLE_MANIFEST_FILE, issues);
  const itemsJson = await readJson(absDir, BUNDLE_ITEMS_FILE, issues);

  let manifest: BundleManifest | undefined;
  if (manifestJson.found) {
    if (validateManifestSchema(manifestJson.value)) {
      manifest = manifestJson.value;
      if (!isValidDateTime(manifest.builtAt)) issues.push(issue("error", BUNDLE_MANIFEST_FILE, "/builtAt", "not a valid date-time"));
    } else {
      for (const e of simplifySchemaErrors(validateManifestSchema.errors)) issues.push(issue("error", BUNDLE_MANIFEST_FILE, e.path, e.message));
    }
  }

  let items: CatalogItem[] | undefined;
  if (itemsJson.found) {
    if (validateItemsSchema(itemsJson.value)) {
      items = (itemsJson.value as ItemsFile).items;
    } else {
      for (const e of simplifySchemaErrors(validateItemsSchema.errors)) issues.push(issue("error", BUNDLE_ITEMS_FILE, e.path, e.message));
    }
  }

  if (!manifest || !items) return { ok: false, issues };

  const walk = checkItems(manifest, items, issues);
  checkAdapters(manifest, walk.adapters, issues);
  walk.stats.posters = await checkPosters(absDir, walk.posters, issues);
  await checkAssets(absDir, walk.posters, issues);
  const ok = !issues.some((i) => i.severity === "error");
  return ok ? { ok, issues, stats: walk.stats, bundle: { dir: absDir, manifest, items } } : { ok, issues, stats: walk.stats };
}

/** What the walk over the items found besides its issues. */
interface ItemsWalk {
  /** Every count but `posters`, which only the poster check knows. */
  stats: BundleStats;
  /** Each poster path the items reference, with the JSON pointers that reference it. */
  posters: Map<string, string[]>;
  /** The adapter ids the sources use. */
  adapters: Set<string>;
}

/** The semantic rules for items, episodes and sources (no I/O). */
function checkItems(manifest: BundleManifest, items: CatalogItem[], issues: ValidationIssue[]): ItemsWalk {
  const F = BUNDLE_ITEMS_FILE;
  const stats: BundleStats = { items: items.length, movies: 0, series: 0, episodes: 0, playableEpisodes: 0, sources: 0, posters: 0 };
  const itemIds = new Map<string, number>();
  const episodeOwners = new Map<string, string>();
  const declaredAdapters = new Set(manifest.adapters);
  const adapters = new Set<string>();
  const posters = new Map<string, string[]>();

  items.forEach((item, i) => {
    const ip = `/items/${i}`;
    if (item.kind === "movie") stats.movies++;
    else stats.series++;

    const firstIndex = itemIds.get(item.id);
    if (firstIndex !== undefined) issues.push(issue("error", F, `${ip}/id`, `duplicate item id "${item.id}" (also /items/${firstIndex})`));
    else itemIds.set(item.id, i);

    if (item.kind === "movie" && item.episodes.length !== 1) {
      issues.push(issue("error", F, `${ip}/episodes`, `a movie must have exactly one episode (found ${item.episodes.length})`));
    }

    if (item.poster) {
      const refs = posters.get(item.poster) ?? [];
      refs.push(`${ip}/poster`);
      posters.set(item.poster, refs);
    }

    let playable = 0;
    item.episodes.forEach((ep, e) => {
      const ep_ = `${ip}/episodes/${e}`;
      stats.episodes++;
      if (ep.playbackAllowed) {
        playable++;
        stats.playableEpisodes++;
      }

      const owner = episodeOwners.get(ep.id);
      if (owner !== undefined) {
        issues.push(
          issue("error", F, `${ep_}/id`, `duplicate episode id "${ep.id}" (episode ids must be unique in the bundle; also used in item "${owner}")`),
        );
      } else {
        episodeOwners.set(ep.id, item.id);
      }

      if (ep.sources.length === 0 && ep.playbackAllowed) issues.push(issue("error", F, `${ep_}/playbackAllowed`, "must be false when sources is empty"));

      const sourceIds = new Set<string>();
      ep.sources.forEach((src, s) => {
        const sp = `${ep_}/sources/${s}`;
        stats.sources++;
        if (sourceIds.has(src.id)) issues.push(issue("error", F, `${sp}/id`, `duplicate source id "${src.id}" within the episode`));
        sourceIds.add(src.id);

        if (src.type === "adapter") {
          adapters.add(src.adapter);
          if (!declaredAdapters.has(src.adapter)) {
            issues.push(issue("error", F, `${sp}/adapter`, `adapter "${src.adapter}" is not listed in ${BUNDLE_MANIFEST_FILE} "adapters"`));
          }
        } else {
          checkUrl(src.media.url, F, `${sp}/media/url`, issues);
        }
        src.subtitleTracks?.forEach((t, k) => checkUrl(t.url, F, `${sp}/subtitleTracks/${k}/url`, issues));
      });
    });

    if (playable === 0) issues.push(issue("warning", F, ip, `item "${item.id}" has no episode with playbackAllowed: true`));
  });

  return { stats, posters, adapters };
}

/** Adapters the manifest declares but no source uses. */
function checkAdapters(manifest: BundleManifest, used: ReadonlySet<string>, issues: ValidationIssue[]): void {
  for (const a of new Set(manifest.adapters)) {
    if (!used.has(a)) issues.push(issue("warning", BUNDLE_MANIFEST_FILE, "/adapters", `adapter "${a}" is not used by any source`));
  }
}

/** Posters: present, content-addressed (sha256 of the bytes), and of the type their extension says. Returns how many exist. */
async function checkPosters(dir: string, posters: ReadonlyMap<string, string[]>, issues: ValidationIssue[]): Promise<number> {
  let found = 0;
  for (const [rel, refs] of posters) {
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(dir, rel));
    } catch {
      for (const r of refs) issues.push(issue("error", BUNDLE_ITEMS_FILE, r, `poster file ${rel} is missing`));
      continue;
    }
    found++;
    const [, name = "", ext = ""] = /^assets\/([0-9a-f]{64})\.(\w+)$/.exec(rel) ?? [];
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== name) issues.push(issue("error", rel, "", `sha256 of the content is ${digest}, not the file name`));
    if (!MAGIC[ext]?.(bytes)) issues.push(issue("error", rel, "", `content is not a ${ext} image`));
    if (bytes.length > POSTER_WARN_BYTES) issues.push(issue("warning", rel, "", `poster is larger than ${POSTER_WARN_BYTES} bytes`));
  }
  return found;
}

/** Unreferenced assets are harmless but usually a sign of a stale build. */
async function checkAssets(dir: string, posters: ReadonlyMap<string, string[]>, issues: ValidationIssue[]): Promise<void> {
  let assetFiles: string[] = [];
  try {
    assetFiles = await readdir(path.join(dir, BUNDLE_ASSETS_DIR));
  } catch {
    // No assets directory; missing posters were reported above.
  }
  for (const f of assetFiles) {
    const rel = `${BUNDLE_ASSETS_DIR}/${f}`;
    if (!posters.has(rel) && !f.startsWith(".")) issues.push(issue("warning", rel, "", "asset is not referenced by any item"));
  }
}

/** Loads a bundle, throwing BundleValidationError when it has errors. Warnings are returned alongside. */
export async function loadBundle(dir: string): Promise<{ bundle: Bundle; warnings: ValidationIssue[]; stats: BundleStats }> {
  const result = await validateBundle(dir);
  if (!result.ok || !result.bundle || !result.stats) throw new BundleValidationError(dir, result.issues);
  return { bundle: result.bundle, warnings: result.issues, stats: result.stats };
}
