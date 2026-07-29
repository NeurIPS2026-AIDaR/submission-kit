import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const artifactSchema = z.object({
  path: z.string().min(1),
  type: z.string().min(1),
  description: z.string().min(1)
}).strict();

const manifestSchema = z.object({
  schema_version: z.literal("0.1"),
  submission: z.object({
    title: z.string().min(1),
    artifact_types: z.array(z.string().min(1)).min(1)
  }).strict(),
  manuscript: z.object({
    pdf: z.string().min(1),
    source: z.string().min(1).optional()
  }).strict(),
  artifacts: z.array(artifactSchema).optional(),
  claims: z.object({
    path: z.string().min(1),
    required: z.boolean()
  }).strict().optional(),
  reproduction: z.object({
    entrypoint: z.string().min(1),
    execution_policy: z.literal("manual_only"),
    network_required: z.boolean()
  }).strict().optional(),
  availability: z.record(z.string(), z.unknown()).optional()
}).strict();

const FORBIDDEN_KEYS = new Set([
  "author", "authors", "affiliation", "affiliations", "email", "emails",
  "orcid", "corresponding_author", "laboratory", "maintainer", "maintainers"
]);

function findForbiddenKeys(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const next = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) found.push(next);
    found.push(...findForbiddenKeys(child, next));
  }
  return found;
}

export interface AIDaRManifest {
  schema_version: "0.1";
  submission: { title: string; artifact_types: string[] };
  manuscript: { pdf: string; source?: string };
  artifacts?: Array<{ path: string; type: string; description: string }>;
  claims?: { path: string; required: boolean };
  reproduction?: { entrypoint: string; execution_policy: "manual_only"; network_required: boolean };
  availability?: Record<string, unknown>;
}

export function readManifest(path: string): AIDaRManifest {
  const document = parse(readFileSync(path, "utf8")) as unknown;
  const forbidden = findForbiddenKeys(document);
  if (forbidden.length) throw new Error(`Anonymous manifest contains forbidden identity fields: ${forbidden.join(", ")}`);
  return manifestSchema.parse(document) as AIDaRManifest;
}
