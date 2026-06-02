import { execFileSync } from "node:child_process";

const version = process.argv[2];

if (!version) {
  console.error("Usage: npm run release:as -- <version>");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver version: ${version}`);
  process.exit(1);
}

execFileSync(
  "git",
  [
    "commit",
    "--allow-empty",
    "-m",
    `chore: release ${version}`,
    "-m",
    `Release-As: ${version}`,
  ],
  { stdio: "inherit" },
);

execFileSync("git", ["push", "origin", "main"], { stdio: "inherit" });
