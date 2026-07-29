import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { RedactionProfile } from "../redaction.js";

interface StoredProfile {
  project_path: string;
  key: string;
  identity_terms: string[];
}

interface PrivacyFile {
  version: 1;
  projects: StoredProfile[];
}

function credentialDirectory(override?: string): string {
  if (override) return resolve(override);
  if (process.env.AIDAR_CREDENTIALS_DIR) return resolve(process.env.AIDAR_CREDENTIALS_DIR);
  const configRoot = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(configRoot, "aidar");
}

function privacyPath(directory?: string): string {
  return join(credentialDirectory(directory), "redactions.json");
}

function canonicalCandidate(path: string): string {
  const missing: string[] = [];
  let cursor = resolve(path);
  while (!existsSync(cursor)) {
    missing.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return join(realpathSync(cursor), ...missing);
}

function normalizeTerms(terms: string[]): string[] {
  const unique = new Map<string, string>();
  for (const raw of terms) {
    const term = raw.trim();
    if (term.length < 2 || /[\u0000-\u001f\u007f-\u009f]/u.test(term)) continue;
    const key = term.toLocaleLowerCase();
    if (!unique.has(key)) unique.set(key, term);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

function readPrivacyFile(directory?: string): PrivacyFile {
  const path = privacyPath(directory);
  if (!existsSync(path)) return { version: 1, projects: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PrivacyFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.projects)) throw new Error("AIDaR redaction profile is invalid");
  return parsed as PrivacyFile;
}

function gitValue(root: string, key: string): string | undefined {
  const result = spawnSync("git", ["-C", root, "config", "--get", key], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || undefined;
}

export function detectLocalIdentityTerms(inputPath: string): string[] {
  const root = resolve(inputPath);
  const terms: string[] = [];
  const localFile = join(root, ".aidar-private-identities.txt");
  if (existsSync(localFile)) {
    terms.push(...readFileSync(localFile, "utf8").split(/\r?\n/).map((term) => term.trim()).filter((term) => term && !term.startsWith("#")));
  }
  const name = gitValue(root, "user.name");
  const email = gitValue(root, "user.email");
  if (name) terms.push(name);
  if (email) terms.push(email);
  const homeName = basename(homedir());
  if (homeName) terms.push(homeName);
  return normalizeTerms(terms);
}

export function loadOrCreateRedactionProfile(inputPath: string, proposedTerms: string[] = [], directory?: string): RedactionProfile {
  const projectPath = realpathSync(resolve(inputPath));
  const root = credentialDirectory(directory);
  const resolvedRoot = canonicalCandidate(root);
  if (resolvedRoot === projectPath || resolvedRoot.startsWith(`${projectPath}${sep}`)) throw new Error("AIDaR credentials and redaction profiles must be stored outside the submitted project");
  const path = privacyPath(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const data = readPrivacyFile(directory);
  let profile = data.projects.find((item) => item.project_path === projectPath);
  if (!profile) {
    profile = { project_path: projectPath, key: randomBytes(32).toString("base64url"), identity_terms: [] };
    data.projects.push(profile);
  }
  profile.identity_terms = normalizeTerms([...profile.identity_terms, ...detectLocalIdentityTerms(projectPath), ...proposedTerms]);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { key: profile.key, identityTerms: [...profile.identity_terms] };
}
