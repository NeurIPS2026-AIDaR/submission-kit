#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { authHeaders, idempotencyKey, packageProject, readOptionalSecret, requestJson, uploadForm } from "./client.js";
import { loadAuthorCredential, saveAuthorCredential } from "./credentials.js";
import { terminalSafe, validateRelayText } from "../validation.js";
import { detectLocalIdentityTerms } from "./privacy.js";

const program = new Command();
program.name("aidar").description("Prepare and submit redacted AIDaR research snapshots").version("0.1.0");

async function privacyPrompt(path: string, enabled = true): Promise<string[]> {
  if (!enabled || !process.stdin.isTTY || !process.stdout.isTTY) return [];
  const detected = detectLocalIdentityTerms(path);
  process.stdout.write("Built-in redactions: email addresses, ORCIDs, user-home names, co-author trailers, and repository owners.\n");
  process.stdout.write("Locally detected private identity terms (never uploaded):\n");
  process.stdout.write(detected.length ? detected.map((term) => `  - ${terminalSafe(term)}`).join("\n") + "\n" : "  (none)\n");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question("Optional additional private terms, separated by commas (Enter for none): ");
    return answer.split(",").map((term) => term.trim()).filter(Boolean);
  } finally {
    readline.close();
  }
}

function baseUrl(value?: string): string {
  return (value ?? process.env.AIDAR_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

interface AuthorOptions {
  server?: string;
  tokenStdin?: boolean;
  submission?: string;
  project?: string;
}

function authorToken(options: AuthorOptions, projectPath?: string): string {
  const explicit = readOptionalSecret(Boolean(options.tokenStdin), "AIDAR_SUBMISSION_TOKEN");
  if (explicit) return explicit;
  return loadAuthorCredential({
    server: baseUrl(options.server),
    projectPath: projectPath ?? options.project,
    submissionId: options.submission
  }).authorToken;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program.command("init")
  .argument("<path>", "project directory")
  .description("Create an optional example AIDaR package layout")
  .action((path: string) => {
    const root = resolve(path);
    mkdirSync(join(root, "manuscript"), { recursive: true });
    for (const dir of ["code", "data", "results", "claims", "environment"]) mkdirSync(join(root, dir), { recursive: true });
    const files: Record<string, string> = {
      "aidar.yaml": `schema_version: "0.1"\n\nsubmission:\n  title: "Anonymous workshop submission"\n  artifact_types:\n    - manuscript\n    - code\n    - results\n\nmanuscript:\n  pdf: manuscript/paper.pdf\n\nartifacts:\n  - path: code\n    type: code\n    description: Analysis and model implementation\n  - path: results\n    type: results\n    description: Machine-readable results\n  - path: data/README.md\n    type: data_documentation\n    description: Data access and license notes\n\nreproduction:\n  entrypoint: "python code/run_analysis.py"\n  execution_policy: manual_only\n  network_required: false\n`,
      "README.md": "# Anonymous AIDaR submission\n\nDescribe the package, artifact map, and manual reproduction steps. Do not include author identity.\n",
      "data/README.md": "# Data\n\nDescribe access, licenses, and checksums.\n",
      ".aidar-private-identities.txt": "# One local identity term per line. This file is never submitted.\n"
    };
    for (const [rel, content] of Object.entries(files)) {
      const target = join(root, rel);
      if (!existsSync(target)) writeFileSync(target, content, { mode: rel.startsWith(".aidar-private") ? 0o600 : 0o644 });
    }
    process.stdout.write(`Created optional AIDaR example layout at ${root}\nAdd any intended submission files, then run: aidar check ${root}\n`);
  });

program.command("check")
  .argument("<path>", "project directory")
  .description("Build and verify a temporary redacted snapshot without uploading it")
  .option("--json", "print JSON")
  .action(async (path: string, options: { json?: boolean }) => {
    try {
      const packaged = await packageProject(resolve(path), { identityTerms: await privacyPrompt(path, !options.json) });
      if (options.json) printJson({ valid: true, package_sha256: packaged.digest, summary: packaged.summary });
      else process.stdout.write(`${packaged.summary}\n\nVALID REDACTED SNAPSHOT\n`);
    } catch (error) {
      if (options.json) printJson({ valid: false, error: error instanceof Error ? error.message : "Validation failed" });
      else process.stdout.write(`${error instanceof Error ? error.message : "Validation failed"}\n\nINVALID\n`);
      process.exitCode = 2;
    }
  });

async function submit(path: string, options: AuthorOptions, revision: boolean): Promise<void> {
  const projectPath = resolve(path);
  const server = baseUrl(options.server);
  const packaged = await packageProject(projectPath, { identityTerms: await privacyPrompt(projectPath) });
  process.stdout.write(`${packaged.summary}\n\nValidation passed. Uploading ${packaged.archive.length} bytes.\n`);
  let token = readOptionalSecret(Boolean(options.tokenStdin), "AIDAR_SUBMISSION_TOKEN");
  let registeredSubmissionId: string | undefined;
  if (!token && (revision || options.submission)) token = authorToken(options, projectPath);
  if (!token) {
    const registration = await requestJson(`${server}/v1/author/submissions`, { method: "POST" });
    const submissionId = String(registration.submission_id ?? "");
    const authorToken = String(registration.author_token ?? "");
    if (!/^[0-9a-f]{12}$/.test(submissionId) || !/^aidar_sub_[A-Za-z0-9_-]{43}$/.test(authorToken)) {
      throw new Error("AIDaR service returned an invalid self-service credential");
    }
    saveAuthorCredential({
      submissionId,
      server,
      projectPath,
      authorToken,
      createdAt: new Date().toISOString()
    });
    token = authorToken;
    registeredSubmissionId = submissionId;
  }
  const endpoint = revision ? "/v1/author/revise" : "/v1/author/submit";
  try {
    const result = await requestJson(`${server}${endpoint}`, {
      method: "POST",
      headers: authHeaders(token, { "Idempotency-Key": idempotencyKey() }),
      body: uploadForm(packaged.archive, packaged.digest)
    });
    printJson({ ...result, credential_saved: Boolean(registeredSubmissionId) });
  } catch (error) {
    if (registeredSubmissionId) {
      throw new Error(`Submission ${registeredSubmissionId} was created and its credential was saved. Retry with --submission ${registeredSubmissionId}. ${error instanceof Error ? error.message : "Upload failed"}`);
    }
    throw error;
  }
}

program.command("submit")
  .argument("<path>", "project directory")
  .requiredOption("--server <url>", "AIDaR API URL")
  .option("--token-stdin", "read the author token from standard input")
  .option("--submission <id>", "retry a saved submission instead of creating a new one")
  .description("Validate and create a self-service submission")
  .action((path: string, options) => submit(path, options, false));

program.command("revise")
  .argument("<path>", "project directory")
  .requiredOption("--server <url>", "AIDaR API URL")
  .option("--token-stdin", "read the author token from standard input")
  .option("--submission <id>", "use a saved submission instead of the latest for this project")
  .description("Validate and submit a complete replacement revision")
  .action((path: string, options) => submit(path, options, true));

program.command("status")
  .requiredOption("--server <url>", "AIDaR API URL")
  .option("--token-stdin", "read the author token from standard input")
  .option("--project <path>", "project directory used for the submission", process.cwd())
  .option("--submission <id>", "use a saved submission instead of the latest for this project")
  .action(async (options) => printJson(await requestJson(`${baseUrl(options.server)}/v1/author/status`, { headers: authHeaders(authorToken(options)) })));

program.command("reviews")
  .requiredOption("--server <url>", "AIDaR API URL")
  .option("--token-stdin", "read the author token from standard input")
  .option("--project <path>", "project directory used for the submission", process.cwd())
  .option("--submission <id>", "use a saved submission instead of the latest for this project")
  .option("--json", "print structured JSON")
  .action(async (options) => {
    const result = await requestJson(`${baseUrl(options.server)}/v1/author/reviews`, { headers: authHeaders(authorToken(options)) });
    if (options.json) {
      printJson(result);
      return;
    }
    const reviews = Array.isArray(result.reviews) ? result.reviews as Array<Record<string, unknown>> : [];
    if (!reviews.length) {
      process.stdout.write("No reviews or comments are available.\n");
      return;
    }
    for (const review of reviews) {
      const location = review.path ? ` ${review.path}${review.line ? `:${review.line}` : ""}` : "";
      process.stdout.write(`[${terminalSafe(String(review.type))}] ${terminalSafe(String(review.reviewer_login))}${terminalSafe(location)} (${terminalSafe(String(review.created_at))})\n${terminalSafe(String(review.body))}\n\n`);
    }
  });

program.command("respond")
  .requiredOption("--server <url>", "AIDaR API URL")
  .requiredOption("--file <path>", "Markdown response file")
  .option("--reply-to <id>", "review comment ID", (value) => Number(value))
  .option("--token-stdin", "read the author token from standard input")
  .option("--project <path>", "project directory used for the submission", process.cwd())
  .option("--submission <id>", "use a saved submission instead of the latest for this project")
  .action(async (options) => {
    const responsePath = resolve(options.file);
    const body = readFileSync(responsePath, "utf8");
    const identityPath = join(dirname(responsePath), ".aidar-private-identities.txt");
    const identityTerms = existsSync(identityPath)
      ? readFileSync(identityPath, "utf8").split(/\r?\n/).map((term) => term.trim()).filter((term) => term && !term.startsWith("#"))
      : [];
    const findings = validateRelayText(body, identityTerms);
    const failures = findings.filter((finding) => finding.level === "FAIL");
    if (failures.length) throw new Error(`Response privacy check failed: ${[...new Set(failures.map((finding) => finding.rule))].join(", ")}`);
    for (const warning of findings.filter((finding) => finding.level === "WARN")) process.stdout.write(`WARN  ${warning.message}\n`);
    const result = await requestJson(`${baseUrl(options.server)}/v1/author/responses`, {
      method: "POST",
      headers: authHeaders(authorToken(options), { "Content-Type": "application/json" }),
      body: JSON.stringify({ body, reply_to_review_comment_id: options.replyTo ?? null })
    });
    printJson(result);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : "Command failed"}\n`);
  process.exitCode = 1;
});
