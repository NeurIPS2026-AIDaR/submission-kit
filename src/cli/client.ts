import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Limits } from "../types.js";
import { createDeterministicArchive } from "../archive.js";
import { renderValidation, stageValidatedProject, validateProject } from "../validation.js";
import { redactProject, renderRedactionReport } from "../redaction.js";
import { loadOrCreateRedactionProfile } from "./privacy.js";

export const DEFAULT_LIMITS: Limits = {
  maxUploadBytes: 209_715_200,
  maxUnpackedBytes: 524_288_000,
  maxFileBytes: 52_428_800,
  maxFileCount: 10_000,
  maxPathLength: 240,
  maxResponseBytes: 65_536
};

export function readSecret(stdin: boolean, environmentName: string): string {
  if (stdin) {
    const token = readFileSync(0, "utf8").trim();
    if (!token) throw new Error("Standard input did not contain a token");
    return token;
  }
  const token = process.env[environmentName];
  if (!token) throw new Error(`Set ${environmentName} or use --token-stdin`);
  return token;
}

export function readOptionalSecret(stdin: boolean, environmentName: string): string | undefined {
  if (stdin) return readSecret(true, environmentName);
  return process.env[environmentName];
}

export async function requestJson(url: string, options: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `HTTP ${response.status}`));
  return body;
}

export function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra };
}

export interface PackageOptions {
  identityTerms?: string[];
  privacyStoreDirectory?: string;
  tempRoot?: string;
}

export async function packageProject(path: string, options: PackageOptions = {}): Promise<{ archive: Buffer; digest: string; summary: string }> {
  const profile = loadOrCreateRedactionProfile(path, options.identityTerms, options.privacyStoreDirectory);
  const validationOptions = { limits: DEFAULT_LIMITS, identityTerms: profile.identityTerms, tempRoot: options.tempRoot };
  const checked = validateProject(path, validationOptions);
  const summary = renderValidation(checked.report);
  if (!checked.report.valid) throw new Error(`Validation failed:\n${summary}`);
  const parent = options.tempRoot ?? tmpdir();
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const redactionRoot = mkdtempSync(join(parent, "aidar-redacted-"));
  let hardenedStage: string | undefined;
  try {
    const redacted = redactProject(checked, redactionRoot, profile);
    const staged = validateProject(redacted.root, { limits: DEFAULT_LIMITS, serverMode: true });
    if (!staged.report.valid) throw new Error(`Staged package failed validation:\n${renderValidation(staged.report)}`);
    hardenedStage = stageValidatedProject(staged, { limits: DEFAULT_LIMITS, tempRoot: parent, serverMode: true });
    const hardened = validateProject(hardenedStage, { limits: DEFAULT_LIMITS, serverMode: true });
    if (!hardened.report.valid) throw new Error(`Hardened package failed validation:\n${renderValidation(hardened.report)}`);
    const packaged = await createDeterministicArchive(hardenedStage, hardened.files);
    if (packaged.buffer.length > DEFAULT_LIMITS.maxUploadBytes) throw new Error("Compressed package exceeds the configured upload limit");
    return { archive: packaged.buffer, digest: packaged.sha256, summary: `${summary}\n${renderRedactionReport(redacted.report)}` };
  } finally {
    rmSync(redactionRoot, { recursive: true, force: true });
    if (hardenedStage) rmSync(hardenedStage, { recursive: true, force: true });
  }
}

export function uploadForm(archive: Buffer, digest: string, publicSlug?: string): FormData {
  const form = new FormData();
  form.set("archive", new Blob([Uint8Array.from(archive)], { type: "application/gzip" }), "submission.tar.gz");
  form.set("archive_sha256", digest);
  if (publicSlug) form.set("public_slug", publicSlug);
  return form;
}

export function idempotencyKey(): string {
  return randomUUID();
}
