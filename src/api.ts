import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { AIDaRService } from "./service.js";
import { bearerToken, secureEqual, sha256 } from "./security.js";
import { MockGithubGateway } from "./github/mock.js";

interface UploadParts {
  archive: Buffer;
  archiveSha256: string;
  publicSlug?: string;
}

async function uploadParts(request: FastifyRequest): Promise<UploadParts> {
  let archive: Buffer | undefined;
  let archiveSha256 = "";
  let publicSlug: string | undefined;
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "archive" || archive) throw new Error("Exactly one archive field is required");
      archive = await part.toBuffer();
      if (part.file.truncated) throw new Error("Upload exceeds the configured limit");
    } else if (part.fieldname === "archive_sha256") archiveSha256 = String(part.value);
    else if (part.fieldname === "public_slug") publicSlug = String(part.value);
  }
  if (!archive || !archiveSha256) throw new Error("archive and archive_sha256 fields are required");
  return { archive, archiveSha256, publicSlug };
}

function authorToken(request: FastifyRequest): string {
  const token = bearerToken(request.headers.authorization);
  if (!token) throw new Error("Author bearer token is required");
  return token;
}

function requireAdmin(request: FastifyRequest, config: AppConfig): void {
  const token = bearerToken(request.headers.authorization);
  if (!token) throw new Error("Admin bearer token is required");
  if (config.adminToken && secureEqual(token, config.adminToken)) return;
  if (config.adminTokenHash && secureEqual(sha256(token), config.adminTokenHash.toLowerCase())) return;
  throw new Error("Admin authorization failed");
}

export async function buildApi(service: AIDaRService, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: config.limits.maxUploadBytes + 1_048_576 });
  await app.register(multipart, {
    limits: { fileSize: config.limits.maxUploadBytes, files: 1, fields: 4, parts: 5 }
  });

  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : "Request failed";
    const authFailure = /token|authorization/i.test(message);
    void reply.code(authFailure ? 401 : 400).send({ error: message });
  });

  app.get("/health", async () => ({ status: "ok", github_mode: config.githubMode }));

  app.post<{ Body: { openreview_url?: string } }>("/v1/author/submissions", async (request) => {
    return service.createSelfServiceSubmission(request.body?.openreview_url ?? "");
  });

  app.post("/v1/author/submit", async (request) => {
    const token = authorToken(request);
    const parts = await uploadParts(request);
    return service.submit(token, parts.archive, parts.archiveSha256, String(request.headers["idempotency-key"] ?? ""));
  });

  app.post("/v1/author/revise", async (request) => {
    const token = authorToken(request);
    const parts = await uploadParts(request);
    return service.revise(token, parts.archive, parts.archiveSha256, String(request.headers["idempotency-key"] ?? ""));
  });

  app.get("/v1/author/status", async (request) => service.status(authorToken(request)));
  app.get("/v1/author/reviews", async (request) => service.reviews(authorToken(request)));
  app.post<{ Body: { body?: string; reply_to_review_comment_id?: number | null } }>("/v1/author/responses", async (request) => {
    return service.respond(authorToken(request), request.body?.body ?? "", request.body?.reply_to_review_comment_id);
  });

  app.post<{ Body: { external_id?: string } }>("/v1/admin/submissions", async (request) => {
    requireAdmin(request, config);
    return service.createSubmission(request.body?.external_id);
  });

  app.get<{ Params: { id: string } }>("/v1/admin/submissions/:id", async (request) => {
    requireAdmin(request, config);
    return service.adminStatus(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { github_login?: string } }>("/v1/admin/submissions/:id/reviewers", async (request) => {
    requireAdmin(request, config);
    return service.assignReviewer(request.params.id, request.body?.github_login ?? "");
  });

  app.post<{ Params: { id: string; login: string } }>("/v1/admin/submissions/:id/reviewers/:login/sync", async (request) => {
    requireAdmin(request, config);
    return service.syncReviewer(request.params.id, request.params.login);
  });

  app.delete<{ Params: { id: string; login: string } }>("/v1/admin/submissions/:id/reviewers/:login", async (request) => {
    requireAdmin(request, config);
    await service.removeReviewer(request.params.id, request.params.login);
    return { removed: true };
  });

  app.post<{ Params: { id: string }; Body: { decision?: "accepted" | "rejected" } }>("/v1/admin/submissions/:id/decision", async (request) => {
    requireAdmin(request, config);
    if (!request.body?.decision || !["accepted", "rejected"].includes(request.body.decision)) throw new Error("Decision must be accepted or rejected");
    return service.decide(request.params.id, request.body.decision);
  });

  app.post<{ Params: { id: string } }>("/v1/admin/submissions/:id/publish", async (request) => {
    requireAdmin(request, config);
    const parts = await uploadParts(request);
    if (!parts.publicSlug) throw new Error("public_slug is required");
    return service.publish(request.params.id, parts.archive, parts.archiveSha256, parts.publicSlug);
  });

  app.post<{ Params: { id: string }; Body: { github_login?: string; body?: string; type?: "review" | "comment" | "inline_comment"; path?: string; line?: number; state?: string } }>("/v1/admin/submissions/:id/mock-reviews", async (request) => {
    requireAdmin(request, config);
    if (!(service.github instanceof MockGithubGateway)) throw new Error("Mock review injection is available only in mock mode");
    const { github_login: login, body, type, path, line, state } = request.body ?? {};
    if (!login || !body) throw new Error("github_login and body are required");
    const id = service.github.injectReview(request.params.id, login, { body, type, path, line, state });
    return { review_id: id };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/submissions/:id/revoke-token", async (request) => {
    requireAdmin(request, config);
    service.revokeToken(request.params.id);
    return { revoked: true };
  });

  return app;
}
