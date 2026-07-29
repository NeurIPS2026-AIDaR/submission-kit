import { createHash } from "node:crypto";
import type { AIDaRDatabase } from "../database.js";
import type {
  GithubGateway, GithubRevisionResult, GithubSubmissionResult, ReviewerAssignmentResult,
  ReviewItem, SubmissionRecord, SubmissionSnapshot
} from "../types.js";

interface MockRepository {
  id: number;
  name: string;
  pullNumber: number;
  headSha: string;
  files: Map<string, Buffer>;
  actionsEnabled: boolean;
  reviewers: Set<string>;
  responses: Array<{ id: number; body: string; replyTo?: number | null; createdAt: string }>;
  closed: boolean;
}

export class MockGithubGateway implements GithubGateway {
  readonly operations: string[] = [];
  readonly repositories = new Map<string, MockRepository>();
  private nextCommentId = 10_000;

  constructor(private readonly database: AIDaRDatabase) {}

  async createSubmission(submissionId: string, snapshot: SubmissionSnapshot): Promise<GithubSubmissionResult> {
    const repoName = `submission-${submissionId}`;
    const repoId = Number.parseInt(createHash("sha256").update(repoName).digest("hex").slice(0, 12), 16);
    const headSha = createHash("sha1").update(snapshot.digest).update("revision-1").digest("hex");
    this.operations.push("create_private_repository", "disable_actions", "write_review_shell", "create_submission_branch", "create_snapshot_commit", "open_pull_request");
    this.repositories.set(submissionId, {
      id: repoId,
      name: repoName,
      pullNumber: 1,
      headSha,
      files: new Map(snapshot.files),
      actionsEnabled: false,
      reviewers: new Set(),
      responses: [],
      closed: false
    });
    return { repoId, repoName, pullNumber: 1, headSha };
  }

  async revise(record: SubmissionRecord, snapshot: SubmissionSnapshot, revision: number): Promise<GithubRevisionResult> {
    const repo = this.requireRepo(record.id);
    const headSha = createHash("sha1").update(repo.headSha).update(snapshot.digest).update(String(revision)).digest("hex");
    repo.files = new Map(snapshot.files);
    repo.headSha = headSha;
    this.operations.push("fetch_branch_head", "create_complete_replacement_tree", "create_revision_commit", "update_branch_ref", "post_revision_comment");
    return { headSha };
  }

  async assignReviewer(record: SubmissionRecord, login: string): Promise<ReviewerAssignmentResult> {
    const repo = this.requireRepo(record.id);
    repo.reviewers.add(login);
    this.operations.push("add_pull_collaborator", "request_review");
    return { state: "review_requested" };
  }

  async syncReviewer(record: SubmissionRecord, login: string): Promise<ReviewerAssignmentResult> {
    const repo = this.requireRepo(record.id);
    repo.reviewers.add(login);
    this.operations.push("check_collaborator", "request_review");
    return { state: "review_requested" };
  }

  async removeReviewer(record: SubmissionRecord, login: string): Promise<void> {
    this.requireRepo(record.id).reviewers.delete(login);
    this.operations.push("remove_collaborator");
  }

  async listReviews(record: SubmissionRecord): Promise<ReviewItem[]> {
    this.requireRepo(record.id);
    const rows = this.database.raw.prepare(`
      SELECT id, reviewer_login, kind, body, path, line, state, created_at
      FROM mock_reviews WHERE submission_id = ? ORDER BY id
    `).all(record.id) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.kind as ReviewItem["type"],
      reviewer_login: String(row.reviewer_login),
      body: String(row.body),
      path: row.path ? String(row.path) : null,
      line: row.line ? Number(row.line) : null,
      state: row.state ? String(row.state) : null,
      created_at: String(row.created_at)
    }));
  }

  async postResponse(record: SubmissionRecord, body: string, replyTo?: number | null): Promise<number> {
    const repo = this.requireRepo(record.id);
    const id = this.nextCommentId++;
    repo.responses.push({ id, body, replyTo, createdAt: new Date().toISOString() });
    this.operations.push(replyTo ? "post_referenced_thread_response" : "post_author_response");
    return id;
  }

  async closeReview(record: SubmissionRecord): Promise<void> {
    this.requireRepo(record.id).closed = true;
    this.operations.push("close_pull_request");
  }

  async publish(record: SubmissionRecord, publicSlug: string, snapshot: SubmissionSnapshot): Promise<{ pullNumber: number }> {
    this.requireRepo(record.id);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(publicSlug)) throw new Error("Public slug is invalid");
    this.operations.push("create_publication_branch", "create_publication_snapshot", "open_publication_pull_request");
    return { pullNumber: 1 };
  }

  injectReview(submissionId: string, login: string, input: { body: string; type?: ReviewItem["type"]; path?: string; line?: number; state?: string }): number {
    const repo = this.requireRepo(submissionId);
    if (!repo.reviewers.has(login)) throw new Error("Reviewer does not have access to this submission");
    const result = this.database.raw.prepare(`
      INSERT INTO mock_reviews (submission_id, reviewer_login, kind, body, path, line, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(submissionId, login, input.type ?? "review", input.body, input.path ?? null, input.line ?? null, input.state ?? "COMMENTED", new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  canAccess(submissionId: string, login: string): boolean {
    return this.requireRepo(submissionId).reviewers.has(login);
  }

  private requireRepo(submissionId: string): MockRepository {
    const repo = this.repositories.get(submissionId);
    if (!repo) throw new Error("Mock repository does not exist");
    return repo;
  }
}
