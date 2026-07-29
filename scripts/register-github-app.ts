import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";

interface ManifestConversion {
  id: number;
  slug: string;
  client_id: string;
  pem: string;
}

const program = new Command();
program
  .requiredOption("--org <name>", "GitHub organization that will own the App")
  .option("--port <number>", "local callback port", "43128")
  .option("--output <path>", "directory for the private key")
  .parse();

const options = program.opts<{ org: string; port: string; output?: string }>();
const port = Number(options.port);
if (!/^[A-Za-z0-9-]{1,39}$/.test(options.org)) throw new Error("GitHub organization name is invalid");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535");

const state = randomBytes(32).toString("hex");
const callback = `http://127.0.0.1:${port}/callback`;
const outputRoot = resolve(options.output ?? join(homedir(), ".config", "aidar", "github-apps", options.org));
const appName = `aidar-${options.org.toLowerCase()}-submission`.slice(0, 34);
const manifest = {
  name: appName,
  url: `https://github.com/${options.org}/submission-kit`,
  description: "Creates private AIDaR review repositories and relays anonymous author revisions and responses.",
  redirect_url: callback,
  hook_attributes: {
    url: "https://example.invalid/aidar-disabled-webhook",
    active: false
  },
  public: false,
  request_oauth_on_install: false,
  setup_on_update: false,
  default_permissions: {
    administration: "write",
    contents: "write",
    issues: "write",
    metadata: "read",
    pull_requests: "write"
  },
  default_events: []
};

function html(body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>AIDaR GitHub App registration</title><body style="font:16px system-ui;max-width:48rem;margin:4rem auto;padding:0 1rem"><h1>AIDaR GitHub App registration</h1>${body}</body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", callback);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/") {
    const action = `https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new?state=${state}`;
    response.end(html(`<p>This creates a private GitHub App owned by <strong>${options.org}</strong>.</p><p>No user authorization or active webhook is enabled.</p><form action="${action}" method="post"><input type="hidden" name="manifest" value="${JSON.stringify(manifest).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"><button type="submit" style="font:inherit;padding:.6rem 1rem">Register the AIDaR App</button></form>`));
    return;
  }
  if (url.pathname !== "/callback") {
    response.statusCode = 404;
    response.end(html("<p>Not found.</p>"));
    return;
  }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    response.statusCode = 400;
    response.end(html("<p>The callback state is invalid. Stop this process and start again.</p>"));
    return;
  }
  try {
    const conversionResponse = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" }
    });
    const conversion = await conversionResponse.json() as Partial<ManifestConversion> & { message?: string };
    if (!conversionResponse.ok || !conversion.id || !conversion.slug || !conversion.client_id || !conversion.pem) {
      throw new Error(conversion.message ?? `GitHub returned HTTP ${conversionResponse.status}`);
    }
    mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    chmodSync(outputRoot, 0o700);
    const keyPath = join(outputRoot, `${conversion.slug}.pem`);
    const infoPath = join(outputRoot, `${conversion.slug}.json`);
    writeFileSync(keyPath, conversion.pem, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(infoPath, `${JSON.stringify({ app_id: conversion.id, slug: conversion.slug, client_id: conversion.client_id, owner: options.org }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    process.stdout.write(`${JSON.stringify({ app_id: conversion.id, slug: conversion.slug, client_id: conversion.client_id, private_key_path: keyPath, install_url: `https://github.com/apps/${conversion.slug}/installations/new` }, null, 2)}\n`);
    response.end(html(`<p>The App was created. Its private key was stored with owner-only access.</p><p><a href="https://github.com/apps/${conversion.slug}/installations/new">Install the App on ${options.org}</a>.</p><p>You can close this page after installation.</p>`));
    setTimeout(() => server.close(), 1_000);
  } catch (error) {
    response.statusCode = 500;
    response.end(html(`<p>Registration failed: ${error instanceof Error ? error.message.replace(/[<>&]/g, "") : "unknown error"}</p>`));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Open http://127.0.0.1:${port} in a browser where you are signed in to GitHub.\n`);
});
