import { parseArgs } from "node:util";
import { probeBundle } from "./probe.ts";
import { formatIssue, validateBundle } from "./validate.ts";

const USAGE = `usage: izle-validate <bundleDir> [--probe] [--json]

Validates an izle catalog bundle (bundle.json, items.json, assets/) against catalog-bundle-v1.
  --probe   also range-GET every direct media and subtitle URL (network) to detect link rot
  --json    print the result as JSON
Exit status: 0 valid, 1 invalid or unreachable URLs, 2 usage error.`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { probe: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
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
    const out = {
      ok,
      issues: result.issues,
      stats: result.stats ?? null,
      probes: probes?.map((p) => ({
        itemId: p.target.itemId,
        episodeId: p.target.episodeId,
        sourceId: p.target.sourceId,
        what: p.target.what,
        host: hostOf(p.target.url),
        ok: p.ok,
        status: p.status ?? null,
        error: p.error ?? null,
        ms: p.ms,
      })),
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return ok ? 0 : 1;
  }

  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  for (const e of errors) process.stdout.write(`✖ ${formatIssue(e)}\n`);
  for (const w of warnings) process.stdout.write(`⚠ ${formatIssue(w)}\n`);

  if (result.ok && result.bundle && result.stats) {
    const { manifest } = result.bundle;
    const s = result.stats;
    process.stdout.write(
      `✔ ${dir}: valid izle-bundle v1 "${manifest.name}" (catalog ${manifest.catalogId}, build ${manifest.buildId})\n` +
        `  ${s.items} items (${s.movies} movies, ${s.series} series), ${s.episodes} episodes (${s.playableEpisodes} playable), ` +
        `${s.sources} sources, ${s.posters} posters` +
        (warnings.length ? `, ${warnings.length} warning(s)` : "") +
        "\n",
    );
  } else {
    process.stdout.write(`✖ ${dir}: invalid (${errors.length} error(s), ${warnings.length} warning(s))\n`);
  }

  if (probes) {
    for (const p of probes) {
      const t = p.target;
      const outcome = p.ok ? `${p.status}` : p.status !== undefined ? `HTTP ${p.status}` : p.error;
      process.stdout.write(
        `${p.ok ? "  ✔" : "  ✖"} ${t.itemId}/${t.episodeId}/${t.sourceId} ${t.what} ${hostOf(t.url)} ${outcome} ${p.ms}ms\n`,
      );
    }
    process.stdout.write(
      failedProbes.length === 0
        ? `✔ probe: all ${probes.length} URLs reachable\n`
        : `✖ probe: ${failedProbes.length} of ${probes.length} URLs unreachable\n`,
    );
  }
  return ok ? 0 : 1;
}
