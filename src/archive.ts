import { createHash } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";
import type { Limits, SubmissionSnapshot } from "./types.js";

export async function createDeterministicArchive(root: string, files: string[]): Promise<{ buffer: Buffer; sha256: string }> {
  const pack = tar.pack();
  const gzip = createGzip({ level: 9, mtime: 0 } as never);
  const chunks: Buffer[] = [];
  const output = pack.pipe(gzip);
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<void>((resolvePromise, reject) => {
    output.on("end", resolvePromise);
    output.on("error", reject);
    pack.on("error", reject);
  });
  for (const rel of [...files].sort()) {
    const data = readFileSync(join(root, rel));
    await new Promise<void>((resolvePromise, reject) => {
      pack.entry({ name: rel, size: data.length, mode: 0o644, mtime: new Date(0), uid: 0, gid: 0 }, data, (error) => error ? reject(error) : resolvePromise());
    });
  }
  pack.finalize();
  await completed;
  const buffer = Buffer.concat(chunks);
  return { buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function safeArchivePath(raw: string, limits: Limits): string {
  if (!raw || raw.includes("\\") || isAbsolute(raw) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(raw)) throw new Error("Archive contains an unsafe path");
  const normalized = raw.normalize("NFC");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Archive contains a traversal or ambiguous path");
  if (normalized.length > limits.maxPathLength) throw new Error("Archive contains an overlong path");
  if (posix.normalize(normalized) !== normalized) throw new Error("Archive contains a non-canonical path");
  return normalized;
}

function prohibitedPackagePath(path: string): boolean {
  const parts = path.split("/");
  return parts.includes(".git") || parts.includes(".hg") || parts.includes(".svn") || path === ".gitmodules" ||
    path === ".aidar-private-identities.txt" || path.startsWith(".github/workflows/") || path === ".github/workflows";
}

export async function safeExtractArchive(buffer: Buffer, target: string, limits: Limits): Promise<string[]> {
  if (buffer.length > limits.maxUploadBytes) throw new Error("Compressed upload exceeds the configured limit");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const root = resolve(target);
  const extract = tar.extract();
  const files: string[] = [];
  const collisions = new Set<string>();
  let totalBytes = 0;
  let extractionError: Error | undefined;

  const abort = (error: unknown): void => {
    if (!extractionError) extractionError = error instanceof Error ? error : new Error("Archive extraction failed");
    extract.destroy();
  };

  extract.on("entry", (header, stream, next) => {
    try {
      const rel = safeArchivePath(header.name, limits);
      if (header.type !== "file") throw new Error("Archive contains a non-regular entry");
      if (prohibitedPackagePath(rel)) throw new Error("Archive contains a prohibited path");
      if ((header.size ?? 0) > limits.maxFileBytes) throw new Error("Archive contains an oversized file");
      const key = rel.toLocaleLowerCase();
      if (collisions.has(key)) throw new Error("Archive contains duplicate or colliding paths");
      collisions.add(key);
      files.push(rel);
      if (files.length > limits.maxFileCount) throw new Error("Archive has too many files");
      totalBytes += header.size ?? 0;
      if (totalBytes > limits.maxUnpackedBytes) throw new Error("Archive expands beyond the configured limit");
      const chunks: Buffer[] = [];
      let actual = 0;
      let entryError: Error | undefined;
      stream.on("data", (chunk: Buffer) => {
        actual += chunk.length;
        if (actual > limits.maxFileBytes || totalBytes - (header.size ?? 0) + actual > limits.maxUnpackedBytes) entryError = new Error("Archive entry exceeds its declared limit");
        else chunks.push(chunk);
      });
      stream.on("error", abort);
      stream.on("end", () => {
        if (entryError) return abort(entryError);
        if (actual !== header.size) return abort(new Error("Archive entry size does not match its header"));
        const output = resolve(root, ...rel.split("/"));
        if (output !== root && !output.startsWith(`${root}${sep}`)) return abort(new Error("Archive path escaped the staging root"));
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        writeFileSync(output, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
        next();
      });
      stream.resume();
    } catch (error) {
      stream.resume();
      abort(error);
    }
  });

  try {
    await pipeline(Readable.from(buffer), createGunzip(), extract);
  } catch (error) {
    throw extractionError ?? error;
  }
  if (extractionError) throw extractionError;
  return files.sort();
}

export function snapshotDirectory(root: string, files: string[], digest: string): SubmissionSnapshot {
  const snapshot = new Map<string, Buffer>();
  for (const rel of files.sort()) {
    const fullPath = join(root, rel);
    const info = lstatSync(fullPath);
    if (!info.isFile()) throw new Error("Snapshot contains a non-regular file");
    snapshot.set(rel, readFileSync(fullPath));
  }
  return { files: snapshot, digest };
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const data = readFileSync(path);
  hash.update(data);
  return hash.digest("hex");
}
