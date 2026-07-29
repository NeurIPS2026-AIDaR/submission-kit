import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

interface StoredCredential {
  submission_id: string;
  server: string;
  project_path: string;
  author_token: string;
  created_at: string;
}

interface CredentialFile {
  version: 1;
  submissions: StoredCredential[];
}

export interface AuthorCredential {
  submissionId: string;
  server: string;
  projectPath: string;
  authorToken: string;
  createdAt: string;
}

function normalizeServer(server: string): string {
  return server.replace(/\/$/, "");
}

export function credentialDirectory(override?: string): string {
  if (override) return resolve(override);
  if (process.env.AIDAR_CREDENTIALS_DIR) return resolve(process.env.AIDAR_CREDENTIALS_DIR);
  const configRoot = process.env.XDG_CONFIG_HOME ? resolve(process.env.XDG_CONFIG_HOME) : join(homedir(), ".config");
  return join(configRoot, "aidar");
}

function credentialPath(directory?: string): string {
  return join(credentialDirectory(directory), "credentials.json");
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

function readCredentialFile(directory?: string): CredentialFile {
  const path = credentialPath(directory);
  if (!existsSync(path)) return { version: 1, submissions: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CredentialFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.submissions)) throw new Error("AIDaR credential file is invalid");
  return parsed as CredentialFile;
}

export function saveAuthorCredential(credential: AuthorCredential, directory?: string): void {
  const root = credentialDirectory(directory);
  const path = credentialPath(directory);
  const projectPath = canonicalCandidate(credential.projectPath);
  const canonicalRoot = canonicalCandidate(root);
  if (canonicalRoot === projectPath || canonicalRoot.startsWith(`${projectPath}${sep}`)) throw new Error("AIDaR credentials must be stored outside the submitted project");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const data = readCredentialFile(directory);
  data.submissions = data.submissions.filter((item) => !(item.server === normalizeServer(credential.server) && item.submission_id === credential.submissionId));
  data.submissions.push({
    submission_id: credential.submissionId,
    server: normalizeServer(credential.server),
    project_path: projectPath,
    author_token: credential.authorToken,
    created_at: credential.createdAt
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function loadAuthorCredential(options: { server: string; projectPath?: string; submissionId?: string }, directory?: string): AuthorCredential {
  const server = normalizeServer(options.server);
  const projectPath = canonicalCandidate(options.projectPath ?? process.cwd());
  const matches = readCredentialFile(directory).submissions
    .filter((item) => item.server === server)
    .filter((item) => options.submissionId ? item.submission_id === options.submissionId : item.project_path === projectPath)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const found = matches[0];
  if (!found) {
    const selector = options.submissionId ? `submission ${options.submissionId}` : `project ${projectPath}`;
    throw new Error(`No saved AIDaR credential exists for ${selector}`);
  }
  return {
    submissionId: found.submission_id,
    server: found.server,
    projectPath: found.project_path,
    authorToken: found.author_token,
    createdAt: found.created_at
  };
}
