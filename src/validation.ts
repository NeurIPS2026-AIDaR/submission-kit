import { spawnSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, statSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { looksLikeText } from "./redaction.js";
import type { Finding, Limits, ValidationReport } from "./types.js";

const PRIVATE_IDENTITIES = ".aidar-private-identities.txt";
const CLIENT_EXCLUDES = new Set([".git", PRIVATE_IDENTITIES]);
const FORBIDDEN_PARTS = new Set([".hg", ".svn"]);
export interface ValidationOptions {
  limits: Limits;
  tempRoot?: string;
  serverMode?: boolean;
  identityTerms?: string[];
}

export interface ValidatedProject {
  root: string;
  files: string[];
  report: ValidationReport;
  identityTerms: string[];
  unsupportedBinaryFiles: string[];
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function addMatch(findings: Finding[], text: string, regex: RegExp, rule: string, path: string, message: string, level: "WARN" | "FAIL"): void {
  regex.lastIndex = 0;
  const match = regex.exec(text);
  if (match) findings.push({ level, rule, path, line: lineNumber(text, match.index), message });
}

function readIdentityTerms(root: string): string[] {
  const file = join(root, PRIVATE_IDENTITIES);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((term) => term.trim()).filter((term) => term && !term.startsWith("#"));
}

function scanText(text: string, path: string, identityTerms: string[], findings: Finding[], mode: "redact" | "reject" | "relay"): void {
  for (const term of identityTerms) {
    const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
    if (index >= 0) {
      findings.push({ level: mode === "redact" ? "WARN" : "FAIL", rule: mode === "redact" ? "identity_redaction_planned" : "local_identity_term", path, line: lineNumber(text, index), message: mode === "redact" ? "A configured identity term will be redacted from the temporary snapshot" : "A configured identity term was found" });
      break;
    }
  }
  const privacyLevel = mode === "redact" ? "WARN" : "FAIL";
  const suffix = mode === "redact" ? " and will be redacted from the temporary snapshot" : "";
  addMatch(findings, text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, mode === "redact" ? "email_redaction_planned" : "email_address", path, `An email address was found${suffix}`, privacyLevel);
  addMatch(findings, text, /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/gi, mode === "redact" ? "orcid_redaction_planned" : "orcid", path, `An ORCID-like identifier was found${suffix}`, privacyLevel);
  addMatch(findings, text, /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s/\\]+/gi, mode === "redact" ? "home_path_redaction_planned" : "home_path", path, `An absolute user home path was found${suffix}`, privacyLevel);
  addMatch(findings, text, /Co-authored-by\s*:/gi, mode === "redact" ? "coauthor_redaction_planned" : "coauthor_trailer", path, `A co-author trailer was found${suffix}`, privacyLevel);
  addMatch(findings, text, /(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+/gi, "external_repository_url", path, "A repository URL can identify an author; inspect it", "WARN");
  addMatch(findings, text, /\b(?:acknowledg(?:e)?ments?|author information)\b/gi, "identity_section", path, "An identity-bearing section name was found; inspect it", "WARN");
  addMatch(findings, text, /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, "private_key", path, "A private key was found", "FAIL");
  addMatch(findings, text, /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "aws_access_key", path, "An AWS access key pattern was found", "FAIL");
  addMatch(findings, text, /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, "github_token", path, "A GitHub token pattern was found", "FAIL");
  addMatch(findings, text, /\bsk-[A-Za-z0-9_-]{20,}\b/g, "api_secret", path, "An API secret pattern was found", "FAIL");
  if (/^(?:author|maintainer)s?\s*[:=]/im.test(text) && /(?:package\.json|pyproject\.toml|setup\.cfg|citation\.cff|codemeta\.json)$/i.test(path) && mode !== "redact") {
    findings.push({ level: "FAIL", rule: "package_identity_metadata", path, message: "Package author or maintainer metadata was found" });
  }
}

function sanitizeReportPath(path: string | undefined, terms: string[]): string | undefined {
  if (!path) return path;
  let safe = path;
  for (const term of [...terms].sort((a, b) => b.length - a.length)) safe = safe.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), "[redacted]");
  safe = safe.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  safe = safe.replace(/\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/gi, "[redacted-orcid]");
  safe = safe.replace(/(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+/gi, "[redacted-repository]");
  return safe;
}

export function validateProject(inputPath: string, options: ValidationOptions): ValidatedProject {
  const root = realpathSync(resolve(inputPath));
  if (!statSync(root).isDirectory()) throw new Error("Project path must be a directory");
  const findings: Finding[] = [];
  const files: string[] = [];
  const collisionKeys = new Map<string, string>();
  const hardLinkKeys = new Map<string, string>();
  const identityTerms = options.serverMode ? [] : (options.identityTerms ?? readIdentityTerms(root));
  const unsupportedBinaryFiles: string[] = [];
  let bytesChecked = 0;
  let gitExcluded = false;
  let identitiesExcluded = false;

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = join(directory, entry.name);
      const rel = relative(root, fullPath).split(sep).join("/");
      if (!options.serverMode && CLIENT_EXCLUDES.has(entry.name)) {
        if (entry.name === ".git") gitExcluded = true;
        if (entry.name === PRIVATE_IDENTITIES) identitiesExcluded = true;
        continue;
      }
      if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(rel)) findings.push({ level: "FAIL", rule: "path_control_character", path: rel, message: "Path contains a terminal control or bidirectional formatting character" });
      if (rel.length > options.limits.maxPathLength) findings.push({ level: "FAIL", rule: "path_length", path: rel, message: "Path exceeds the configured limit" });
      if (FORBIDDEN_PARTS.has(entry.name) || (entry.name === ".git" && options.serverMode) || rel === ".gitmodules") {
        findings.push({ level: "FAIL", rule: "version_control_metadata", path: rel, message: "Version-control metadata is prohibited" });
        continue;
      }
      if (rel === PRIVATE_IDENTITIES) {
        findings.push({ level: "FAIL", rule: "private_identity_file", path: rel, message: "The local identity file must not enter a package" });
        continue;
      }
      if (rel === ".github/workflows" || rel.startsWith(".github/workflows/")) {
        findings.push({ level: "FAIL", rule: "github_workflow", path: rel, message: "Submitted GitHub workflows are prohibited" });
        continue;
      }
      const info = lstatSync(fullPath);
      if (info.isSymbolicLink()) {
        findings.push({ level: "FAIL", rule: "symlink", path: rel, message: "Symbolic links are prohibited" });
        continue;
      }
      if (info.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!info.isFile()) {
        findings.push({ level: "FAIL", rule: "special_file", path: rel, message: "Only regular files are allowed" });
        continue;
      }
      if (info.nlink > 1) {
        const key = `${info.dev}:${info.ino}`;
        const prior = hardLinkKeys.get(key);
        findings.push({ level: "FAIL", rule: "hard_link", path: rel, message: "Hard-linked files are prohibited" });
        if (!prior) hardLinkKeys.set(key, rel);
      }
      if (info.size > options.limits.maxFileBytes) findings.push({ level: "FAIL", rule: "file_size", path: rel, message: "File exceeds the configured limit" });
      files.push(rel);
      bytesChecked += info.size;
      const collisionKey = rel.normalize("NFC").toLocaleLowerCase();
      const collision = collisionKeys.get(collisionKey);
      if (collision && collision !== rel) findings.push({ level: "FAIL", rule: "path_collision", path: rel, message: "Path has a case or Unicode collision" });
      collisionKeys.set(collisionKey, rel);
    }
  }

  walk(root);
  if (files.length === 0) findings.push({ level: "FAIL", rule: "empty_submission", message: "Submission must contain at least one regular file" });
  if (files.length > options.limits.maxFileCount) findings.push({ level: "FAIL", rule: "file_count", message: "Package exceeds the configured file-count limit" });
  if (bytesChecked > options.limits.maxUnpackedBytes) findings.push({ level: "FAIL", rule: "unpacked_size", message: "Package exceeds the configured uncompressed-size limit" });

  for (const rel of files) {
    const fullPath = join(root, rel);
    const data = readFileSync(fullPath);
    if (looksLikeText(rel, data)) scanText(data.toString("utf8"), rel, identityTerms, findings, options.serverMode ? "reject" : "redact");
    else {
      unsupportedBinaryFiles.push(rel);
      findings.push({ level: "WARN", rule: "unsupported_binary", path: rel, message: "Binary content is kept unchanged; inspect it before submission" });
    }
  }

  findings.push({ level: "PASS", rule: "version_control_history", message: gitExcluded ? "Local .git history was excluded" : "No .git history was found" });
  if (identitiesExcluded) findings.push({ level: "PASS", rule: "private_identity_exclusion", message: "The local identity-term file was excluded" });
  if (!findings.some((item) => item.rule === "github_workflow")) findings.push({ level: "PASS", rule: "github_workflow", message: "No submitted GitHub workflows were found" });
  if (!findings.some((item) => ["private_key", "aws_access_key", "github_token", "api_secret"].includes(item.rule))) findings.push({ level: "PASS", rule: "secret_patterns", message: "No built-in high-confidence secret pattern was found" });

  return {
    root,
    files: files.sort(),
    identityTerms,
    unsupportedBinaryFiles,
    report: {
      schema_version: "0.1",
      valid: !findings.some((finding) => finding.level === "FAIL"),
      files_checked: files.length,
      bytes_checked: bytesChecked,
      findings: findings.map((finding) => ({ ...finding, path: sanitizeReportPath(finding.path, identityTerms) }))
    }
  };
}

export function stageValidatedProject(project: ValidatedProject, options: ValidationOptions): string {
  if (!project.report.valid) throw new Error("Validation failed; package was not created");
  const parent = options.tempRoot ?? tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(parent, "aidar-stage-"));
  for (const rel of project.files) {
    const target = join(stage, rel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(join(project.root, rel), target);
  }
  const gitleaks = spawnSync("gitleaks", ["detect", "--source", stage, "--no-git", "--no-banner", "--exit-code", "7"], { stdio: "ignore" });
  if (gitleaks.error && (gitleaks.error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("gitleaks could not run");
  if (!gitleaks.error && gitleaks.status === 7) throw new Error("gitleaks detected a secret; package was not created");
  return stage;
}

export function renderValidation(report: ValidationReport): string {
  return report.findings.map((finding) => {
    const location = finding.path ? `  ${terminalSafe(finding.path)}${finding.line ? `:${finding.line}` : ""}` : "";
    return `${finding.level.padEnd(4)}  ${terminalSafe(finding.message)}${location}`;
  }).join("\n");
}

export function validateRelayText(text: string, identityTerms: string[] = []): Finding[] {
  const findings: Finding[] = [];
  scanText(text, "author-response.md", identityTerms, findings, "relay");
  return findings;
}

export function terminalSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "�");
}
