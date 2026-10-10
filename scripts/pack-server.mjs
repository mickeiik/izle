#!/usr/bin/env node
// @ts-check
// Builds the self-contained server package `dist/izle-server-<version>.tgz` (an `npm pack` tarball).
//
// The server and @izle/contract are bundled with their npm dependencies into one ES module, so the package has no
// dependencies, installs offline and runs exactly the dependency versions the tests ran against. The bundle finds
// its files through the same relative paths as the sources do (`../admin`, `../schema`, `../../sample-catalog`
// from `server/dist/`), which is why the package mirrors that layout:
//
//   bin/izle-server.js               checks the Node.js version, then runs the bundle
//   server/dist/izle-server.js       the bundle
//   server/admin/                    admin page
//   server/schema/                   catalog bundle and resolve-result JSON Schemas (from contract/schema)
//   sample-catalog/                  the sample bundle served when no catalog is configured
//   deploy/                          example config, systemd unit and Caddyfile (from docs/deploy)
//   LICENSE, THIRD_PARTY_LICENSES.md, README.md
//
// Usage: node scripts/pack-server.mjs [--out <dir>] [--keep-stage]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const at = (/** @type {string[]} */ ...p) => path.join(ROOT, ...p);

const { values: args } = parseArgs({ options: { out: { type: "string" }, "keep-stage": { type: "boolean" } } });
const outDir = path.resolve(args.out ?? at("dist"));

const rootPackage = JSON.parse(await readFile(at("package.json"), "utf8"));
const serverPackage = JSON.parse(await readFile(at("server", "package.json"), "utf8"));
const version = serverPackage.version;
const nodeRange = rootPackage.engines.node;
const minNode = /^>=(\d+)\.(\d+)$/.exec(nodeRange);
if (!minNode) throw new Error(`unexpected engines.node "${nodeRange}" in package.json`);

const stage = path.join(await mkdtemp(path.join(tmpdir(), "izle-pack-")), "package");
const to = (/** @type {string[]} */ ...p) => path.join(stage, ...p);
await mkdir(stage, { recursive: true });

// --- the bundle ------------------------------------------------------------------------------------------------

const result = await build({
  entryPoints: [at("server", "src", "cli.ts")],
  outfile: to("server", "dist", "izle-server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: `node${minNode[1]}.${minNode[2]}`,
  // CommonJS dependencies (ajv) may require() Node built-ins; ES module output has no `require` of its own.
  banner: { js: 'import { createRequire as __izleCreateRequire } from "node:module";\nconst require = __izleCreateRequire(import.meta.url);' },
  legalComments: "none", // the notices are collected in THIRD_PARTY_LICENSES.md
  charset: "utf8",
  metafile: true,
  logLevel: "warning",
});

// --- files next to the bundle ----------------------------------------------------------------------------------

/** Copies the files of `from` (not recursing) that `keep` accepts into `into`. */
async function copyFiles(/** @type {string} */ from, /** @type {string} */ into, keep = (/** @type {string} */ _name) => true) {
  await mkdir(into, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && keep(entry.name)) await cp(path.join(from, entry.name), path.join(into, entry.name));
  }
}

await copyFiles(at("server", "admin"), to("server", "admin"), (n) => /\.(html|js|css|svg)$/.test(n));
await copyFiles(at("contract", "schema"), to("server", "schema"), (n) => n.endsWith(".schema.json"));
await copyFiles(at("sample-catalog"), to("sample-catalog"), (n) => n.endsWith(".json") || n === "NOTICE.md");
await copyFiles(at("sample-catalog", "assets"), to("sample-catalog", "assets"));
await copyFiles(at("docs", "deploy"), to("deploy"), (n) => !n.endsWith(".md"));
await cp(at("LICENSE"), to("LICENSE"));

await mkdir(to("bin"));
await writeFile(
  to("bin", "izle-server.js"),
  `#!/usr/bin/env node
// izle-server ${version}: checks the Node.js version, then runs the bundled server.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < ${minNode[1]} || (major === ${minNode[1]} && minor < ${minNode[2]})) {
  process.stderr.write(\`izle-server needs Node.js ${minNode[1]}.${minNode[2]} or newer; this is \${process.version}\\n\`);
  process.exit(1);
}
const { main } = await import("../server/dist/izle-server.js");
const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
`,
  { mode: 0o755 },
);

// --- third-party notices ---------------------------------------------------------------------------------------

/** npm packages that ended up in the bundle (workspace packages are ours and resolve outside node_modules). */
const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) packageDirs.add(path.resolve(m[1]));
}
const notices = [];
const bundled = [];
for (const dir of [...packageDirs].sort()) {
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  bundled.push(`${pkg.name}@${pkg.version}`);
  const licenseFile = (await readdir(dir)).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (!licenseFile) throw new Error(`${pkg.name} has no LICENSE file; add its notice by hand`);
  const text = (await readFile(path.join(dir, licenseFile), "utf8")).trim();
  notices.push(`## ${pkg.name} ${pkg.version} (${pkg.license})\n\n\`\`\`\n${text}\n\`\`\``);
}
await writeFile(
  to("THIRD_PARTY_LICENSES.md"),
  `# Third-party licenses\n\n\`server/dist/izle-server.js\` includes the following npm packages.\n\n${notices.join("\n\n")}\n`,
);

// --- package.json and README -----------------------------------------------------------------------------------

await writeFile(
  to("package.json"),
  `${JSON.stringify(
    {
      name: serverPackage.name,
      version,
      private: true, // never published to a registry; installed from the release tarball
      description: serverPackage.description,
      license: serverPackage.license,
      repository: rootPackage.repository,
      type: "module",
      engines: { node: nodeRange },
      bin: { "izle-server": "bin/izle-server.js" },
      files: ["bin", "server", "sample-catalog", "deploy", "THIRD_PARTY_LICENSES.md"],
    },
    null,
    2,
  )}\n`,
);

const docs = "https://github.com/mickeiik/izle/blob/main/docs/deploy/self-hosting.md";
await writeFile(
  to("README.md"),
  `# izle-server ${version}

The self-hosted server of [izle](https://github.com/mickeiik/izle), a senior-first Android TV player: catalog,
pairing, TV and admin APIs, media proxy and the admin page at \`/admin/\`. Needs Node.js ${nodeRange.slice(2)} or
newer; the package has no dependencies.

\`\`\`bash
sudo npm install --global --prefix /opt/izle ./izle-server-${version}.tgz
/opt/izle/bin/izle-server --version
/opt/izle/bin/izle-server --config /etc/izle/izle.json
\`\`\`

Without \`--config\` the server listens on port 8787, serves the sample catalog in \`sample-catalog/\` and keeps its
data in \`./data\`. \`deploy/\` holds an example config, a systemd unit and a Caddyfile; the setup is described in
the self-hosting guide: ${docs}

Licenses: [LICENSE](LICENSE) (MIT), bundled npm packages in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), the
sample catalog's media and posters in [sample-catalog/NOTICE.md](sample-catalog/NOTICE.md).
`,
);

// --- pack ------------------------------------------------------------------------------------------------------

await mkdir(outDir, { recursive: true });
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], { cwd: stage, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
);
const tarball = path.join(outDir, packed.filename);
const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
const kib = (/** @type {number} */ n) => `${Math.round(n / 1024)} KiB`;
process.stdout.write(
  `${path.relative(process.cwd(), tarball)}\n  ${packed.entryCount} files, ${kib((await stat(tarball)).size)} (${kib(packed.unpackedSize)} unpacked)\n` +
    `  bundled: ${bundled.join(", ")}\n  sha256 ${digest}\n`,
);

if (args["keep-stage"]) process.stdout.write(`  stage kept in ${stage}\n`);
else await rm(path.dirname(stage), { recursive: true, force: true });
