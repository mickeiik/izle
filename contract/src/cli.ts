import { parseArgs } from "node:util";
import { probeBundle } from "./probe.ts";
import { formatIssue, validateBundle } from "./validate.ts";

const USAGE = `usage: izle-validate <bundleDir> [--probe] [--json]

Validates an izle catalog bundle (bundle.json, items.json, assets/) against catalog-bundle-v1.
  --probe   also range-GET every direct media and subtitle URL (network) to detect link rot
  --json    print the result as JSON
Exit status: 0 valid, 1 invalid or unreachable URLs, 2 usage error.`;

const OPTIONS = { probe: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;
const hostOf = (url: string): string => URL.parse(url)?.host ?? "?";
const out = (text: string) => void process.stdout.write(`${text}\n`);

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const dir = positionals[0]!;
  const result = await validateBundle(dir);
  const probes = values.probe && result.bundle ? await probeBundle(result.bundle) : undefined;
  const failedProbes = probes?.filter((p) => !p.ok) ?? [];
  const ok = result.ok && failedProbes.length === 0;

  if (values.json) {
    const probeJson = probes?.map(({ target: t, ...p }) => ({
      itemId: t.itemId, episodeId: t.episodeId, sourceId: t.sourceId, what: t.what, host: hostOf(t.url),
      ok: p.ok, status: p.status ?? null, error: p.error ?? null, ms: p.ms,
    }));
    out(JSON.stringify({ ok, issues: result.issues, stats: result.stats ?? null, probes: probeJson }, null, 2));
    return ok ? 0 : 1;
  }

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  for (const e of errors) out(`✖ ${formatIssue(e)}`);
  for (const w of warnings) out(`⚠ ${formatIssue(w)}`);

  if (result.ok && result.bundle && result.stats) {
    const { manifest } = result.bundle;
    const s = result.stats;
    out(
      `✔ ${dir}: valid izle-bundle v1 "${manifest.name}" (catalog ${manifest.catalogId}, build ${manifest.buildId})\n` +
        `  ${s.items} items (${s.movies} movies, ${s.series} series), ${s.episodes} episodes (${s.playableEpisodes} playable), ` +
        `${s.sources} sources, ${s.posters} posters, ${s.backdrops} backdrops` +
        (warnings.length ? `, ${warnings.length} warning(s)` : ""),
    );
  } else {
    out(`✖ ${dir}: invalid (${errors.length} error(s), ${warnings.length} warning(s))`);
  }

  if (probes) {
    for (const { target: t, ...p } of probes) {
      const outcome = p.ok ? `${p.status}` : p.status !== undefined ? `HTTP ${p.status}` : p.error;
      const where = `${t.itemId}/${t.episodeId}/${t.sourceId} ${t.what} ${hostOf(t.url)}`;
      out(`${p.ok ? "  ✔" : "  ✖"} ${where} ${outcome} ${p.ms}ms`);
    }
    out(
      failedProbes.length === 0
        ? `✔ probe: all ${probes.length} URLs reachable`
        : `✖ probe: ${failedProbes.length} of ${probes.length} URLs unreachable`,
    );
  }
  return ok ? 0 : 1;
}
