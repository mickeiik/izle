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
//   deploy/                          example config, systemd units (server, backup) and Caddyfile (from docs/deploy)
//   LICENSE, THIRD_PARTY_LICENSES.md, README.md
//
// Usage: node scripts/pack-server.mjs [--out <dir>]
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
const readJson = async (/** @type {string} */ file) => JSON.parse(await readFile(file, "utf8"));

const { values: args } = parseArgs({ options: { out: { type: "string" } } });
const outDir = path.resolve(args.out ?? at("dist"));

const rootPackage = await readJson(at("package.json"));
const serverPackage = await readJson(at("server", "package.json"));
const { version } = serverPackage;
const nodeRange = rootPackage.engines.node;
const [, major, minor] = /^>=(\d+)\.(\d+)$/.exec(nodeRange) ?? [];
if (!minor) throw new Error(`unexpected engines.node "${nodeRange}" in package.json`);

const stage = path.join(await mkdtemp(path.join(tmpdir(), "izle-pack-")), "package");
const to = (/** @type {string[]} */ ...p) => path.join(stage, ...p);
await mkdir(stage, { recursive: true });

const result = await build({
  entryPoints: [at("server", "src", "cli.ts")],
  outfile: to("server", "dist", "izle-server.js"),
  bundle: true, platform: "node", format: "esm", target: `node${major}.${minor}`, charset: "utf8", metafile: true, logLevel: "warning",
  // CommonJS dependencies (ajv) may require() Node built-ins; ES module output has no `require` of its own.
  banner: { js: 'import { createRequire as __izleCreateRequire } from "node:module";\nconst require = __izleCreateRequire(import.meta.url);' },
  legalComments: "none", // the notices are collected in THIRD_PARTY_LICENSES.md
});

/** Copies the files of `from` (not recursing) that `keep` accepts into `into`. */
async function copyFiles(/** @type {string} */ from, /** @type {string} */ into, keep = (/** @type {string} */ _name) => true) {
  await mkdir(into, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && keep(entry.name)) await cp(path.join(from, entry.name), path.join(into, entry.name));
  }
}

await copyFiles(at("server", "admin"), to("server", "admin"), (n) => /\.(html|js|css|svg)$/.test(n));
await copyFiles(at("server", "admin", "vendor"), to("server", "admin", "vendor"), (n) => n.endsWith(".js") || n.startsWith("LICENSE-") || n === "README.md");
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
if (major < ${major} || (major === ${major} && minor < ${minor})) {
  process.stderr.write(\`izle-server needs Node.js ${major}.${minor} or newer; this is \${process.version}\\n\`);
  process.exit(1);
}
const { main } = await import("../server/dist/izle-server.js");
const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
`,
  { mode: 0o755 },
);

// Third-party notices: npm packages that ended up in the bundle (workspace packages resolve outside node_modules),
// then the files vendored into the admin page (server/admin/vendor/README.md lists versions and hashes).
const fence = (/** @type {string} */ heading, /** @type {string} */ text) => `## ${heading}\n\n\`\`\`\n${text.trim()}\n\`\`\``;
const packageDirs = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m) packageDirs.add(path.resolve(m[1]));
}
const notices = [];
const bundled = [];
for (const dir of [...packageDirs].sort()) {
  const pkg = await readJson(path.join(dir, "package.json"));
  bundled.push(`${pkg.name}@${pkg.version}`);
  const licenseFile = (await readdir(dir)).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (!licenseFile) throw new Error(`${pkg.name} has no LICENSE file; add its notice by hand`);
  notices.push(fence(`${pkg.name} ${pkg.version} (${pkg.license})`, await readFile(path.join(dir, licenseFile), "utf8")));
}
const vendored = [];
for (const name of (await readdir(at("server", "admin", "vendor"))).filter((n) => n.startsWith("LICENSE-")).sort()) {
  const text = await readFile(at("server", "admin", "vendor", name), "utf8");
  vendored.push(fence(`${name.slice("LICENSE-".length)} (vendored in server/admin/vendor/)`, text));
}
await writeFile(
  to("THIRD_PARTY_LICENSES.md"),
  `# Third-party licenses\n\n\`server/dist/izle-server.js\` includes the following npm packages.\n\n${notices.join("\n\n")}\n\n` +
    `The admin page (\`server/admin/\`) vendors the following files; see \`server/admin/vendor/README.md\`.\n\n${vendored.join("\n\n")}\n`,
);

const { name, description, license } = serverPackage;
const manifest = {
  name, version, private: true, // never published to a registry; installed from the release tarball
  description, license, repository: rootPackage.repository, type: "module", engines: { node: nodeRange },
  bin: { "izle-server": "bin/izle-server.js" }, files: ["bin", "server", "sample-catalog", "deploy", "THIRD_PARTY_LICENSES.md"],
};
await writeFile(to("package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const guide = "https://github.com/mickeiik/izle/blob/main/docs/deploy/self-hosting.md";
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
data in \`./data\`. \`deploy/\` holds an example config, systemd units for the server and a daily database backup, and
a Caddyfile; the setup is described in the self-hosting guide: ${guide}

Licenses: [LICENSE](LICENSE) (MIT), bundled npm packages in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), the
sample catalog's media and posters in [sample-catalog/NOTICE.md](sample-catalog/NOTICE.md).
`,
);

await mkdir(outDir, { recursive: true });
const npmPack = execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], { cwd: stage, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const [packed] = JSON.parse(npmPack);
const tarball = path.join(outDir, packed.filename);
const digest = createHash("sha256").update(await readFile(tarball)).digest("hex");
const kib = (/** @type {number} */ n) => `${Math.round(n / 1024)} KiB`;
process.stdout.write(
  `${path.relative(process.cwd(), tarball)}\n  ${packed.entryCount} files, ${kib((await stat(tarball)).size)} (${kib(packed.unpackedSize)} unpacked)\n` +
    `  bundled: ${bundled.join(", ")}\n  sha256 ${digest}\n`,
);

await rm(path.dirname(stage), { recursive: true, force: true });
