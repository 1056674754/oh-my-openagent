import { realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"

import { readSessionContext } from "./session-role"

export const HOST_SOCKET_CONTEXT = "host_socket"

/** Absent for a session that is not inside a host (a root session). */
export function readOwnHostSocket(pi: unknown): string | undefined {
  const socket = readSessionContext(pi)?.[HOST_SOCKET_CONTEXT]
  return socket === undefined || socket.length === 0 ? undefined : socket
}

/**
 * Whether `socket` is the endpoint THIS session runs behind. A pure path comparison, independent of
 * which host generation answers there: such an endpoint is never ensured from inside, because a
 * session cannot restart the host it lives in.
 */
export function isOwnEndpoint(socket: string, ownHostSocket: string | undefined): boolean {
  return ownHostSocket !== undefined && canonicalSocketPath(socket) === canonicalSocketPath(ownHostSocket)
}

function canonicalSocketPath(socket: string): string {
  try {
    return join(realpathSync(dirname(socket)), basename(socket))
  } catch {
    return socket
  }
}
