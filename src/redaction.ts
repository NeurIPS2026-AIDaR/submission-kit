import { createHmac } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { isUtf8 } from "node:buffer";
import type { RedactionReport } from "./types.js";
import type { ValidatedProject } from "./validation.js";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".tex", ".bib", ".yaml", ".yml", ".json", ".jsonl", ".csv", ".tsv",
  ".py", ".r", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".java", ".c", ".cc",
  ".cpp", ".h", ".hpp", ".rs", ".go", ".sh", ".bash", ".zsh", ".fish", ".toml", ".ini",
  ".cfg", ".conf", ".xml", ".html", ".css", ".scss", ".sql", ".ipynb", ".cff", ".rst"
]);

const BUILTIN_PATTERNS: Array<{ kind: string; regex: RegExp }> = [
  { kind: "email", regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: "orcid", regex: /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/gi },
  { kind: "home-path", regex: /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s/\\]+/gi },
  { kind: "coauthor", regex: /^.*Co-authored-by\s*:.*$/gim },
  { kind: "repository-owner", regex: /(?:github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+/gi }
];

export interface RedactionProfile {
  key: string;
  identityTerms: string[];
}

export interface RedactedStage {
  root: string;
  files: string[];
  report: RedactionReport;
}

export function looksLikeText(path: string, data: Buffer): boolean {
  if (!isUtf8(data)) return false;
  const sample = data.subarray(0, Math.min(data.length, 8192));
  if (sample.includes(0)) return false;
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || basename(path).toLowerCase() === "dockerfile" || data.length === 0 || !sample.includes(0);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replacement(profile: RedactionProfile, kind: string, original: string): string {
  const digest = createHmac("sha256", profile.key).update(`${kind}\0${original.toLocaleLowerCase()}`).digest("hex").slice(0, 12);
  return `aidar-${kind}-${digest}`;
}

function replaceMatches(text: string, regex: RegExp, kind: string, profile: RedactionProfile, originals: Set<string>, counts: Record<string, number>): string {
  regex.lastIndex = 0;
  return text.replace(regex, (match) => {
    originals.add(match);
    counts[kind] = (counts[kind] ?? 0) + 1;
    return replacement(profile, kind, match);
  });
}

function redactValue(value: string, profile: RedactionProfile, originals: Set<string>, counts: Record<string, number>): string {
  let output = value;
  for (const pattern of BUILTIN_PATTERNS) output = replaceMatches(output, pattern.regex, pattern.kind, profile, originals, counts);
  const terms = [...new Set(profile.identityTerms)].sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const term of terms) {
    const regex = new RegExp(escapeRegex(term), "giu");
    output = replaceMatches(output, regex, "identity", profile, originals, counts);
  }
  return output;
}

function containsOriginal(value: string, originals: Set<string>): boolean {
  const folded = value.toLocaleLowerCase();
  return [...originals].some((original) => folded.includes(original.toLocaleLowerCase()));
}

export function redactProject(project: ValidatedProject, stage: string, profile: RedactionProfile): RedactedStage {
  const originals = new Set<string>();
  const counts: Record<string, number> = {};
  const outputFiles: string[] = [];
  const outputKeys = new Set<string>();
  let filesChanged = 0;
  let pathsChanged = 0;

  for (const rel of project.files) {
    const outputRel = redactValue(rel, profile, originals, counts);
    if (outputRel !== rel) pathsChanged += 1;
    const collisionKey = outputRel.normalize("NFC").toLocaleLowerCase();
    if (outputKeys.has(collisionKey)) throw new Error("Redaction caused two paths to collide; rename one source file and retry");
    outputKeys.add(collisionKey);
    const source = join(project.root, rel);
    const target = join(stage, outputRel);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const data = readFileSync(source);
    if (looksLikeText(rel, data)) {
      const text = data.toString("utf8");
      const redacted = redactValue(text, profile, originals, counts);
      if (redacted !== text) filesChanged += 1;
      writeFileSync(target, redacted, { mode: 0o600 });
    } else {
      copyFileSync(source, target);
    }
    outputFiles.push(outputRel);
  }

  for (const rel of outputFiles) {
    if (containsOriginal(rel, originals)) throw new Error("Redaction verification failed for a staged path");
    const data = readFileSync(join(stage, rel));
    if (looksLikeText(rel, data) && containsOriginal(data.toString("utf8"), originals)) throw new Error("Redaction verification failed for staged text");
  }

  const replacementsTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    root: stage,
    files: outputFiles.sort(),
    report: {
      schema_version: "0.1",
      files_changed: filesChanged,
      paths_changed: pathsChanged,
      replacements_total: replacementsTotal,
      replacements_by_kind: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      unsupported_binary_files: project.unsupportedBinaryFiles.length
    }
  };
}

export function renderRedactionReport(report: RedactionReport): string {
  const kinds = Object.entries(report.replacements_by_kind).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none";
  return [
    `REDACTION  replacements=${report.replacements_total} (${kinds})`,
    `REDACTION  files_changed=${report.files_changed} paths_changed=${report.paths_changed}`,
    `BINARY     unsupported_or_uninspected=${report.unsupported_binary_files}`
  ].join("\n");
}
