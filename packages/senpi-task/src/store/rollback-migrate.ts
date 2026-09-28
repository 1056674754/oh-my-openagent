import { createTaskRecordStore } from "./record-store"

const R0_UNREADABLE_SUSPENSION_REASONS = new Set([
  "host_incompatible",
  "own_host_unreachable",
  "store_index_unavailable",
])

export type HostSessionMigrationPlan = {
  readonly store_dir: string
  readonly migrate: number
  readonly skipped: number
  readonly sockets: readonly string[]
}

export type HostSessionMigrationResult = HostSessionMigrationPlan & {
  readonly migrated: number
}

export function planHostSessionSocketMigration(storeDir: string, to: string): HostSessionMigrationPlan {
  const store = createTaskRecordStore({ project_dir: storeDir, task: { state_dir: storeDir } })
  const listing = store.list()
  if (listing.diagnostics.some((diagnostic) => diagnostic.type === "parse_error")) {
    throw new Error(`rollback migration refused malformed records in ${storeDir}`)
  }
  const candidates = listing.records.filter((record) => record.host_session !== undefined && record.host_session.socket !== to)
  return {
    store_dir: storeDir,
    migrate: candidates.length,
    skipped: listing.records.length - candidates.length,
    sockets: [...new Set(candidates.map((record) => record.host_session?.socket).filter((socket) => socket !== undefined))].toSorted(),
  }
}

export function migrateHostSessionSockets(
  storeDir: string,
  options: {
    readonly to: string
    readonly deadEndpoints: ReadonlySet<string>
    readonly dryRun?: boolean
  },
): HostSessionMigrationResult {
  const plan = planHostSessionSocketMigration(storeDir, options.to)
  for (const socket of plan.sockets) {
    if (!options.deadEndpoints.has(socket)) throw new Error(`rollback migration refused live or unverified endpoint ${socket}`)
  }
  if (options.dryRun) return { ...plan, migrated: 0 }

  const store = createTaskRecordStore({ project_dir: storeDir, task: { state_dir: storeDir } })
  let migrated = 0
  for (const record of store.list().records) {
    const from = record.host_session?.socket
    if (from === undefined || from === options.to) continue
    const next = store.mutate(record.task_id, (current) => {
      if (current.host_session === undefined || current.host_session.socket === options.to) return current
      const suspensionReason = current.suspension_reason
      return {
        ...current,
        host_session: { ...current.host_session, socket: options.to },
        ...(suspensionReason !== undefined && R0_UNREADABLE_SUSPENSION_REASONS.has(suspensionReason)
          ? { suspension_reason: undefined }
          : {}),
      }
    })
    if (next?.host_session?.socket !== options.to) continue
    store.appendEvent(record.task_id, {
      type: "host_session_migrated",
      payload: { from, to: options.to, reason: "rollback" },
    })
    migrated += 1
  }
  return { ...plan, migrated }
}
