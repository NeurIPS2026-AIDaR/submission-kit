import { randomBytes } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";

const program = new Command();
program
  .requiredOption("--app-id <id>", "GitHub App ID")
  .requiredOption("--installation-id <id>", "GitHub App installation ID")
  .requiredOption("--org <name>", "GitHub organization")
  .requiredOption("--private-key <path>", "GitHub App private-key path")
  .option("--output <path>", "dotenv output path", ".env")
  .option("--public-archive-repo <name>", "accepted-submission archive repository", "aidar-2026-submissions")
  .parse();

const options = program.opts<{
  appId: string;
  installationId: string;
  org: string;
  privateKey: string;
  output: string;
  publicArchiveRepo: string;
}>();

if (!/^\d+$/.test(options.appId)) throw new Error("GitHub App ID must be numeric");
if (!/^\d+$/.test(options.installationId)) throw new Error("GitHub installation ID must be numeric");
if (!/^[A-Za-z0-9-]{1,39}$/.test(options.org)) throw new Error("GitHub organization name is invalid");
if (!/^[A-Za-z0-9._-]{1,100}$/.test(options.publicArchiveRepo)) throw new Error("Archive repository name is invalid");

const outputPath = resolve(options.output);
const keyPath = resolve(options.privateKey);
if (existsSync(outputPath)) throw new Error(`${outputPath} already exists; move it or update it manually`);
if (!existsSync(keyPath) || !statSync(keyPath).isFile()) throw new Error("GitHub App private key was not found");
if ((statSync(keyPath).mode & 0o077) !== 0) throw new Error("GitHub App private key must have owner-only permissions");

const hmacSecret = randomBytes(48).toString("base64url");
const adminToken = randomBytes(32).toString("base64url");
const values: Array<[string, string]> = [
  ["AIDAR_BASE_URL", "http://localhost:3000"],
  ["AIDAR_DATABASE_PATH", "./data/aidar-live.sqlite"],
  ["AIDAR_TOKEN_HMAC_SECRET", hmacSecret],
  ["AIDAR_ADMIN_TOKEN", adminToken],
  ["AIDAR_TEMP_ROOT", "./data/tmp"],
  ["AIDAR_GITHUB_MODE", "live"],
  ["GITHUB_APP_ID", options.appId],
  ["GITHUB_APP_PRIVATE_KEY_PATH", keyPath],
  ["GITHUB_INSTALLATION_ID", options.installationId],
  ["GITHUB_ORG", options.org],
  ["GITHUB_API_VERSION", "2026-03-10"],
  ["GITHUB_PUBLIC_ARCHIVE_REPO", options.publicArchiveRepo]
];

const content = values.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n";
writeFileSync(outputPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
process.stdout.write(`Created ${outputPath} with owner-only permissions. No secret value was printed.\n`);
