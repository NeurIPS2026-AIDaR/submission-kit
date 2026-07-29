#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { authHeaders, packageProject, readSecret, requestJson, uploadForm } from "./client.js";

const program = new Command();
program.name("aidar-admin").description("Operate the AIDaR review pilot").version("0.1.0");
program.option("--server <url>", "AIDaR API URL", process.env.AIDAR_BASE_URL ?? "http://localhost:3000");
program.option("--token-stdin", "read the admin token from standard input");

function context(): { server: string; token: string } {
  const options = program.opts<{ server: string; tokenStdin?: boolean }>();
  return { server: options.server.replace(/\/$/, ""), token: readSecret(Boolean(options.tokenStdin), "AIDAR_ADMIN_TOKEN") };
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function adminRequest(path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
  const { server, token } = context();
  return requestJson(`${server}${path}`, {
    method,
    headers: authHeaders(token, body === undefined ? {} : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

program.command("create-submission")
  .option("--external-id <id>", "chairs-only external submission identifier")
  .action(async (options) => json(await adminRequest("/v1/admin/submissions", "POST", { external_id: options.externalId })));

program.command("status")
  .argument("<submission-id>")
  .action(async (id) => json(await adminRequest(`/v1/admin/submissions/${encodeURIComponent(id)}`)));

program.command("assign-reviewer")
  .argument("<submission-id>")
  .requiredOption("--github-login <login>")
  .action(async (id, options) => json(await adminRequest(`/v1/admin/submissions/${encodeURIComponent(id)}/reviewers`, "POST", { github_login: options.githubLogin })));

program.command("sync-reviewer")
  .argument("<submission-id>")
  .requiredOption("--github-login <login>")
  .action(async (id, options) => json(await adminRequest(`/v1/admin/submissions/${encodeURIComponent(id)}/reviewers/${encodeURIComponent(options.githubLogin)}/sync`, "POST")));

program.command("remove-reviewer")
  .argument("<submission-id>")
  .requiredOption("--github-login <login>")
  .action(async (id, options) => json(await adminRequest(`/v1/admin/submissions/${encodeURIComponent(id)}/reviewers/${encodeURIComponent(options.githubLogin)}`, "DELETE")));

program.command("decision")
  .argument("<submission-id>")
  .requiredOption("--value <decision>", "accepted or rejected")
  .action(async (id, options) => json(await adminRequest(`/v1/admin/submissions/${encodeURIComponent(id)}/decision`, "POST", { decision: options.value })));

program.command("mock-review")
  .argument("<submission-id>")
  .requiredOption("--github-login <login>")
  .requiredOption("--file <path>")
  .option("--type <type>", "review, comment, or inline_comment", "review")
  .option("--path <path>", "inline file path")
  .option("--line <number>", "inline line", (value) => Number(value))
  .option("--state <state>", "review state", "COMMENTED")
  .action(async (id, options) => json(await adminRequest(`/v1/admin/submissions/${encodeURIComponent(id)}/mock-reviews`, "POST", {
    github_login: options.githubLogin,
    body: readFileSync(resolve(options.file), "utf8"),
    type: options.type,
    path: options.path,
    line: options.line,
    state: options.state
  })));

program.command("publish")
  .argument("<submission-id>")
  .argument("<path>", "accepted package directory")
  .requiredOption("--public-slug <slug>")
  .action(async (id, path, options) => {
    const packaged = await packageProject(path);
    const { server, token } = context();
    const result = await requestJson(`${server}/v1/admin/submissions/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      headers: authHeaders(token),
      body: uploadForm(packaged.archive, packaged.digest, options.publicSlug)
    });
    json(result);
  });

program.command("revoke-token")
  .argument("<submission-id>")
  .action(async (id) => json(await adminRequest(`/v1/admin/submissions/${encodeURIComponent(id)}/revoke-token`, "POST")));

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`ERROR: ${error instanceof Error ? error.message : "Command failed"}\n`);
  process.exitCode = 1;
});
