export type FindingLevel = "PASS" | "WARN" | "FAIL";

export interface Finding {
  level: FindingLevel;
  rule: string;
  path?: string;
  line?: number;
  message: string;
}

export interface ValidationReport {
  schema_version: "0.1";
  valid: boolean;
  files_checked: number;
  bytes_checked: number;
  findings: Finding[];
}

export interface RedactionReport {
  schema_version: "0.1";
  files_changed: number;
  paths_changed: number;
  replacements_total: number;
  replacements_by_kind: Record<string, number>;
  unsupported_binary_files: number;
}

export interface Limits {
  maxUploadBytes: number;
  maxUnpackedBytes: number;
  maxFileBytes: number;
  maxFileCount: number;
  maxPathLength: number;
  maxResponseBytes: number;
}

export interface SubmissionRecord {
  id: string;
  external_id: string | null;
  author_token_hmac: string;
  revoked_at: string | null;
  status: string;
  repo_id: number | null;
  repo_name: string | null;
  pr_number: number | null;
  submission_branch: string;
  branch_head_sha: string | null;
  revision: number;
  package_sha256: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewItem {
  id: number;
  type: "review" | "comment" | "inline_comment";
  reviewer_login: string;
  reviewer_name?: string | null;
  body: string;
  state?: string | null;
  path?: string | null;
  line?: number | null;
  in_reply_to_id?: number | null;
  created_at: string;
}

export interface SubmissionSnapshot {
  files: Map<string, Buffer>;
  digest: string;
}

export interface GithubSubmissionResult {
  repoId: number;
  repoName: string;
  pullNumber: number;
  headSha: string;
}

export interface GithubRevisionResult {
  headSha: string;
}

export interface ReviewerAssignmentResult {
  state: "pending_acceptance" | "review_requested";
}

export interface GithubGateway {
  createSubmission(submissionId: string, snapshot: SubmissionSnapshot): Promise<GithubSubmissionResult>;
  revise(record: SubmissionRecord, snapshot: SubmissionSnapshot, revision: number): Promise<GithubRevisionResult>;
  assignReviewer(record: SubmissionRecord, login: string): Promise<ReviewerAssignmentResult>;
  syncReviewer(record: SubmissionRecord, login: string): Promise<ReviewerAssignmentResult>;
  removeReviewer(record: SubmissionRecord, login: string): Promise<void>;
  listReviews(record: SubmissionRecord): Promise<ReviewItem[]>;
  postResponse(record: SubmissionRecord, body: string, replyTo?: number | null): Promise<number>;
  closeReview(record: SubmissionRecord): Promise<void>;
  publish(record: SubmissionRecord, publicSlug: string, snapshot: SubmissionSnapshot): Promise<{ pullNumber: number }>;
}
