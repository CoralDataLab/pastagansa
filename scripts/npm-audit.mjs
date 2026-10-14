// Fails on high or critical npm advisories, except reviewed ones without a patched release.
import { execFileSync } from "node:child_process";

const allowed = new Map([
  [
    "GHSA-vfj7-8cjw-p6xm",
    "braces <=3.0.3 has no patched release; only lint tooling reaches it (eslint-config-next > fast-glob > micromatch). Reviewed 2026-10-14.",
  ],
]);
const blockingSeverities = new Set(["high", "critical"]);

let output;
try {
  output = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  // npm audit exits non-zero when it finds vulnerabilities; the report is still on stdout.
  output = error.stdout;
}
const report = JSON.parse(output);
if (report.error) throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);

const advisories = new Map();
for (const vulnerability of Object.values(report.vulnerabilities ?? {}))
  for (const via of vulnerability.via)
    if (typeof via === "object" && blockingSeverities.has(via.severity))
      advisories.set(via.url.split("/").pop(), via);

for (const [id, reason] of allowed)
  console.log(advisories.has(id)
    ? `Allowed ${id}: ${reason}`
    : `Allowed ${id} no longer appears; remove it from scripts/npm-audit.mjs.`);

const failures = [...advisories].filter(([id]) => !allowed.has(id));
for (const [, advisory] of failures)
  console.error(`${advisory.severity} ${advisory.name} ${advisory.range}: ${advisory.title} ${advisory.url}`);
process.exitCode = failures.length ? 1 : 0;
