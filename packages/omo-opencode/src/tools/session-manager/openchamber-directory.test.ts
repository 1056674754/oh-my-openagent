import { afterAll, describe, expect, mock, test } from "bun:test"
import { unsafeTestValue } from "../../../../../test-support/unsafe-test-value"

// Regression coverage for OpenChamber embedded mode where ctx.directory is a server-
// relative path ("<workdir>/current", "<workdir>/root", "/", parent path) and the
// OpenCode server filters GET /session strictly by ?directory=. See GitLab
// songsong/openchamber#92 for the full bug analysis.

mock.module("./constants", () => ({
  OPENCODE_STORAGE: "/unused-empty",
  MESSAGE_STORAGE: "/unused-empty/message",
  PART_STORAGE: "/unused-empty/part",
  SESSION_STORAGE: "/unused-empty/session",
  TODO_DIR: "/unused-empty/todos",
  TRANSCRIPT_DIR: "/unused-empty/transcripts",
  SESSION_LIST_DESCRIPTION: "test",
  SESSION_READ_DESCRIPTION: "test",
  SESSION_SEARCH_DESCRIPTION: "test",
  SESSION_INFO_DESCRIPTION: "test",
  SESSION_DELETE_DESCRIPTION: "test",
  TOOL_NAME_PREFIX: "session_",
}))

mock.module("../../shared/opencode-storage-detection", () => ({
  isSqliteBackend: () => true,
  resetSqliteBackendCache: () => {},
}))

mock.module("../../shared/opencode-storage-paths", () => ({
  OPENCODE_STORAGE: "/unused-empty",
  MESSAGE_STORAGE: "/unused-empty/message",
  PART_STORAGE: "/unused-empty/part",
  SESSION_STORAGE: "/unused-empty/session",
}))

afterAll(() => { mock.restore() })

const { normalizeProjectFilter, setStorageClient, resetStorageClient, getMainSessions } =
  await import("./storage")

describe("normalizeProjectFilter — OpenChamber embedded mode", () => {
  test("#given undefined #when normalized #then returns undefined (no filter)", () => {
    expect(normalizeProjectFilter(undefined)).toBeUndefined()
  })

  test("#given filesystem root '/' #when normalized #then returns undefined so server returns all sessions", () => {
    // opencode web / opencode serve pass ctx.directory === "/"; server-side ?directory=/
    // would match zero sessions, so we drop the filter entirely.
    expect(normalizeProjectFilter("/")).toBeUndefined()
  })

  test("#given OpenChamber '/current' suffix #when normalized #then strips to real workdir", () => {
    expect(normalizeProjectFilter("/Users/song/dev_ai/openchamber-merge-v1.11.0/current"))
      .toBe("/Users/song/dev_ai/openchamber-merge-v1.11.0")
  })

  test("#given OpenChamber '/root' suffix #when normalized #then strips to real workdir", () => {
    expect(normalizeProjectFilter("/Users/song/dev_ai/openchamber-merge-v1.11.0/root"))
      .toBe("/Users/song/dev_ai/openchamber-merge-v1.11.0")
  })

  test("#given real workdir without suffix #when normalized #then returns unchanged", () => {
    expect(normalizeProjectFilter("/Users/song/dev_ai/openchamber-merge-v1.11.0"))
      .toBe("/Users/song/dev_ai/openchamber-merge-v1.11.0")
  })

  test("#given trailing path segment that merely contains 'current' as substring #when normalized #then does not strip", () => {
    // Only exact trailing "/current" or "/root" segments are stripped.
    expect(normalizeProjectFilter("/work/imcurrent")).toBe("/work/imcurrent")
    expect(normalizeProjectFilter("/work/current-state")).toBe("/work/current-state")
  })

  test("#given suffix as the whole path ('/current' or '/root') #when normalized #then returns undefined (no real workdir)", () => {
    expect(normalizeProjectFilter("/current")).toBeUndefined()
    expect(normalizeProjectFilter("/root")).toBeUndefined()
  })
})

describe("getMainSessions — OpenChamber '/current' suffix through full storage path", () => {
  const mockSdkClient = {
    session: {
      list: mock((): Promise<unknown> => Promise.resolve({ data: [] })),
      messages: mock((): Promise<unknown> => Promise.resolve({ data: [] })),
      todo: mock((): Promise<unknown> => Promise.resolve({ data: [] })),
    },
  }

  test("#given ctx.directory has '/current' suffix and SDK returns real-workdir sessions #when getMainSessions runs #then suffix is normalized and real-workdir session matches", async () => {
    // given: SDK returns sessions stored against the REAL workdir (no /current suffix)
    mockSdkClient.session.list.mockImplementation(() =>
      Promise.resolve({
        data: [
          {
            id: "ses_main",
            directory: "/Users/me/project",
            parentID: null,
            time: { created: 1000, updated: 2000 },
          },
          {
            id: "ses_other",
            directory: "/somewhere/else",
            parentID: null,
            time: { created: 1000, updated: 1000 },
          },
        ],
      }),
    )

    setStorageClient(unsafeTestValue(mockSdkClient))

    // when: ctx.directory is the OpenChamber server-relative form with /current suffix
    const sessions = await getMainSessions({ directory: "/Users/me/project/current" })

    // then: the suffix is stripped, the real-workdir session matches, ses_other is filtered out
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe("ses_main")

    resetStorageClient()
  })

  test("#given ctx.directory has '/root' suffix #when getMainSessions runs #then suffix is normalized and matches real-workdir session", async () => {
    mockSdkClient.session.list.mockImplementation(() =>
      Promise.resolve({
        data: [
          {
            id: "ses_root_main",
            directory: "/Users/me/project",
            parentID: null,
            time: { created: 1000, updated: 2000 },
          },
        ],
      }),
    )

    setStorageClient(unsafeTestValue(mockSdkClient))

    const sessions = await getMainSessions({ directory: "/Users/me/project/root" })

    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe("ses_root_main")

    resetStorageClient()
  })

  test("#given ctx.directory is filesystem root '/' (opencode web/server mode) #when getMainSessions runs #then returns all main sessions", async () => {
    mockSdkClient.session.list.mockImplementation(() =>
      Promise.resolve({
        data: [
          {
            id: "ses_a",
            directory: "/anywhere/a",
            parentID: null,
            time: { created: 1000, updated: 2000 },
          },
          {
            id: "ses_b",
            directory: "/anywhere/b",
            parentID: null,
            time: { created: 1000, updated: 1000 },
          },
        ],
      }),
    )

    setStorageClient(unsafeTestValue(mockSdkClient))

    const sessions = await getMainSessions({ directory: "/" })

    // then: '/' is treated as no filter, all main sessions returned
    expect(sessions.length).toBe(2)

    resetStorageClient()
  })
})
