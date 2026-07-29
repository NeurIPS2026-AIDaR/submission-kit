import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function createSubmissionToken(): string {
  return `aidar_sub_${randomBytes(32).toString("base64url")}`;
}

export function tokenHmac(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function redactError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "UnknownError";
}
