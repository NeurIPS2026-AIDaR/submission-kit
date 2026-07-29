import "dotenv/config";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Limits } from "./types.js";

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export interface AppConfig {
  host: string;
  port: number;
  baseUrl: string;
  databasePath: string;
  tempRoot: string;
  tokenHmacSecret: string;
  adminToken?: string;
  adminTokenHash?: string;
  githubMode: "mock" | "live";
  github?: {
    appId: string;
    privateKey: string;
    installationId: number;
    org: string;
    apiVersion: string;
    publicArchiveRepo: string;
  };
  limits: Limits;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const databasePath = resolve(process.env.AIDAR_DATABASE_PATH ?? "./data/aidar.sqlite");
  const tempRoot = resolve(process.env.AIDAR_TEMP_ROOT ?? "./data/tmp");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const githubMode = (process.env.AIDAR_GITHUB_MODE ?? "mock") as "mock" | "live";
  if (!['mock', 'live'].includes(githubMode)) throw new Error("AIDAR_GITHUB_MODE must be mock or live");
  const tokenHmacSecret = process.env.AIDAR_TOKEN_HMAC_SECRET ?? "local-pilot-change-this-secret";
  const adminToken = process.env.AIDAR_ADMIN_TOKEN;
  const adminTokenHash = process.env.AIDAR_ADMIN_TOKEN_HASH;
  if (githubMode === "live" && Buffer.byteLength(tokenHmacSecret) < 32) throw new Error("Live mode requires an AIDAR_TOKEN_HMAC_SECRET of at least 32 bytes");
  if (githubMode === "live" && !adminToken && !adminTokenHash) throw new Error("Live mode requires AIDAR_ADMIN_TOKEN_HASH or AIDAR_ADMIN_TOKEN");
  if (adminTokenHash && !/^[0-9a-f]{64}$/i.test(adminTokenHash)) throw new Error("AIDAR_ADMIN_TOKEN_HASH must be a SHA-256 hex digest");

  let github: AppConfig["github"];
  if (githubMode === "live") {
    const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    const appId = process.env.GITHUB_APP_ID;
    const installationId = Number(process.env.GITHUB_INSTALLATION_ID);
    const org = process.env.GITHUB_ORG;
    if (!privateKeyPath || !appId || !Number.isSafeInteger(installationId) || !org) {
      throw new Error("Live GitHub mode requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_INSTALLATION_ID, and GITHUB_ORG");
    }
    github = {
      appId,
      privateKey: readFileSync(resolve(privateKeyPath), "utf8"),
      installationId,
      org,
      apiVersion: process.env.GITHUB_API_VERSION ?? "2026-03-10",
      publicArchiveRepo: process.env.GITHUB_PUBLIC_ARCHIVE_REPO ?? "aidar-2026-submissions"
    };
  }

  return {
    host: process.env.AIDAR_HOST ?? "127.0.0.1",
    port: positiveInt("PORT", 3000),
    baseUrl: process.env.AIDAR_BASE_URL ?? "http://localhost:3000",
    databasePath,
    tempRoot,
    tokenHmacSecret,
    adminToken,
    adminTokenHash,
    githubMode,
    github,
    limits: {
      maxUploadBytes: positiveInt("MAX_UPLOAD_BYTES", 209_715_200),
      maxUnpackedBytes: positiveInt("MAX_UNPACKED_BYTES", 524_288_000),
      maxFileBytes: positiveInt("MAX_FILE_BYTES", 52_428_800),
      maxFileCount: positiveInt("MAX_FILE_COUNT", 10_000),
      maxPathLength: positiveInt("MAX_PATH_LENGTH", 240),
      maxResponseBytes: positiveInt("MAX_RESPONSE_BYTES", 65_536)
    },
    ...overrides
  };
}
