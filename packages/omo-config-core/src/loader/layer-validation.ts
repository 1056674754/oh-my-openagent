import type * as z from "zod"

import { OmoConfigLayerSchema } from "../schema"
import { isUnsafeObjectKey } from "./merge"
import { pruneInvalidConfigPaths, type PrunedConfigPath, type PruneValidator } from "./prune-invalid-leaves"
import type { OmoConfigDiagnostic } from "./types"

export type OmoConfigLayerValidation =
  | { readonly loaded: true; readonly diagnostics: readonly OmoConfigDiagnostic[]; readonly value: Record<string, unknown> }
  | { readonly loaded: false; readonly diagnostics: readonly OmoConfigDiagnostic[] }

export function validationDiagnostic(path: string, issues: readonly { readonly path: readonly PropertyKey[] }[]): OmoConfigDiagnostic {
  const issuePaths = issues.map((issue) => issue.path.map((segment) => String(segment)).join("."))
  return {
    kind: "validation",
    message: `Invalid omo config at ${path}: ${issuePaths.join(", ")}`,
    path,
    issuePaths,
  }
}

export function invalidValueDiagnostics(path: string, dropped: readonly PrunedConfigPath[]): readonly OmoConfigDiagnostic[] {
  return dropped.map((entry) => ({
    kind: "invalid-value",
    message: `Ignored invalid value in ${path}: ${entry.key}: ${entry.message}`,
    path,
    issuePaths: [entry.key],
  }))
}

type UnrecognizedKeyIssue = {
  readonly keys: readonly string[]
  readonly path: readonly string[]
}

function unrecognizedKeyIssues(issues: readonly z.core.$ZodIssue[]): readonly UnrecognizedKeyIssue[] {
  return issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? [{ keys: issue.keys, path: issue.path.map((segment) => String(segment)) }]
      : [],
  )
}

/**
 * A layer carrying `__proto__`, `prototype`, or `constructor` is hostile input, not a stale key, so it
 * stays fail-closed (whole layer rejected) instead of being stripped and partially loaded, at ANY
 * depth: nesting hostile input under `agents.*`/`categories.*` leaves no unrecognized-key issue at
 * all, so pruning must never run before the tamper check.
 *
 * `prototype` and `constructor` arrive as own properties and surface here as unrecognized keys. A
 * JSON `"__proto__"` member does not: it is written THROUGH the prototype, so the schema sees only the
 * injected payload's inner keys, or nothing at all when a sub-schema rebuilds the object first. That
 * case is caught by `hasTamperedPrototype`, which runs on every layer before validation.
 */
function hasUnsafeUnrecognizedKey(issues: readonly UnrecognizedKeyIssue[]): boolean {
  return issues.some((issue) => issue.keys.some((key) => isUnsafeObjectKey(key)))
}

function hasTamperedPrototype(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasTamperedPrototype(entry))
  if (!isRecord(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return true
  return Object.values(value).some((entry) => hasTamperedPrototype(entry))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The object an unrecognized-keys issue points at, walking through array elements (`teams.alpha.members.0`). */
function containerAt(record: Record<string, unknown>, path: readonly string[]): Record<string, unknown> | null {
  let node: unknown = record
  for (const segment of path) {
    if (Array.isArray(node)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return null
      node = node[index]
    } else if (isRecord(node) && Object.hasOwn(node, segment)) {
      node = node[segment]
    } else {
      return null
    }
  }
  return isRecord(node) ? node : null
}

/** Delete every unrecognized key reported by zod, returning the pruned clone plus the dotted path of each removal. */
function stripUnrecognizedKeys(
  record: Record<string, unknown>,
  issues: readonly UnrecognizedKeyIssue[],
): { readonly issuePaths: readonly string[]; readonly stripped: Record<string, unknown> } {
  const stripped = structuredClone(record)
  const issuePaths: string[] = []
  for (const issue of issues) {
    const container = containerAt(stripped, issue.path)
    if (container === null) continue
    for (const key of issue.keys) {
      delete container[key]
      issuePaths.push([...issue.path, key].join("."))
    }
  }
  return { issuePaths, stripped }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    record[key] = entry
  }
  return record
}

const validateLayerRecord: PruneValidator = (record) => {
  const parsed = OmoConfigLayerSchema.safeParse(record)
  return parsed.success ? { success: true } : { success: false, issues: parsed.error.issues }
}

/**
 * Validate one parsed config file. Gate order on the failure path: (1) the prototype-pollution
 * guard stays fail-closed and is never pruned past; (2) unknown keys are stripped with one
 * `unknown-keys` diagnostic; (3) every remaining invalid value is pruned with its own
 * `invalid-value` diagnostic. A root that is not an object, an issue on the root, an exhausted
 * prune bound, or a file with nothing valid left rejects the file with its validation diagnostic.
 */
export function validateConfigLayer(path: string, data: unknown): OmoConfigLayerValidation {
  // The guard reads `data` directly: `toRecord` rebuilds only the root from its own enumerable
  // properties, nested objects keep their prototype, and a valid layer (nothing for zod to report)
  // would otherwise hand a tampered sub-object to every consumer of it.
  if (hasTamperedPrototype(data)) {
    return {
      loaded: false,
      diagnostics: [{ kind: "validation", message: `Invalid omo config at ${path}: "__proto__" member is not allowed`, path }],
    }
  }

  const record = toRecord(data)
  const validation = OmoConfigLayerSchema.safeParse(data)
  if (validation.success) {
    if (record !== null) return { loaded: true, diagnostics: [], value: record }
    return {
      loaded: false,
      diagnostics: [{ kind: "validation", message: `Invalid omo config at ${path}: root must be an object`, path }],
    }
  }

  const rejected = { loaded: false, diagnostics: [validationDiagnostic(path, validation.error.issues)] } as const
  const unknownIssues = unrecognizedKeyIssues(validation.error.issues)
  if (hasUnsafeUnrecognizedKey(unknownIssues) || record === null) return rejected

  let candidate = record
  let issues: readonly z.core.$ZodIssue[] = validation.error.issues
  const diagnostics: OmoConfigDiagnostic[] = []
  if (unknownIssues.length > 0) {
    const { issuePaths, stripped } = stripUnrecognizedKeys(record, unknownIssues)
    if (issuePaths.length > 0) {
      diagnostics.push({ kind: "unknown-keys", message: `Ignored unknown keys in ${path}: ${issuePaths.join(", ")}`, path, issuePaths })
    }
    const strippedValidation = validateLayerRecord(stripped)
    if (strippedValidation.success) return { loaded: true, diagnostics, value: stripped }
    candidate = stripped
    issues = strippedValidation.issues
  }

  const pruned = pruneInvalidConfigPaths(candidate, issues, validateLayerRecord)
  if (!pruned.ok) return rejected
  return { loaded: true, diagnostics: [...diagnostics, ...invalidValueDiagnostics(path, pruned.dropped)], value: pruned.config }
}
