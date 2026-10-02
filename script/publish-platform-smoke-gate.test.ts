import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

interface WorkflowStep {
  readonly name?: string
  readonly "continue-on-error"?: boolean | string
  readonly run?: string
  readonly if?: string
}

interface WorkflowJob {
  readonly needs?: string | readonly string[]
  readonly if?: string
  readonly steps: readonly WorkflowStep[]
}

interface Workflow {
  readonly jobs: Readonly<Record<string, WorkflowJob>>
}

function isWorkflow(value: unknown): value is Workflow {
  if (typeof value !== "object" || value === null || !("jobs" in value)) return false
  const jobs = value.jobs
  return typeof jobs === "object" && jobs !== null
}

const parsed: unknown = Bun.YAML.parse(
  readFileSync(new URL("../.github/workflows/publish-platform.yml", import.meta.url), "utf8"),
)
if (!isWorkflow(parsed)) throw new Error("publish-platform.yml did not parse to a workflow with jobs")
const workflow: Workflow = parsed

function job(name: string): WorkflowJob {
  const found = workflow.jobs[name]
  if (!found) throw new Error(`publish-platform.yml has no job ${name}`)
  return found
}

function stepIndex(jobName: string, stepName: string): number {
  const index = job(jobName).steps.findIndex((step) => step.name === stepName)
  if (index < 0) throw new Error(`job ${jobName} has no step ${stepName}`)
  return index
}

function needsOf(jobName: string): readonly string[] {
  const needs = job(jobName).needs
  if (needs === undefined) return []
  return typeof needs === "string" ? [needs] : needs
}

describe("platform npm publish is gated on that platform's release-binary smoke", () => {
  test("#given a build leg #when its release-binary smoke fails #then its npm payload artifact was never uploaded, so only that platform's publish has nothing to ship", () => {
    const payloadUpload = stepIndex("build", "Upload artifact")

    expect(payloadUpload).toBeGreaterThan(stepIndex("build", "Smoke test release binary"))
    expect(payloadUpload).toBeGreaterThan(stepIndex("build", "Smoke eval registration in fresh binary"))
  })

  test("#given the linux-arm64 legs whose smoke runs in its own job #when publish starts #then that smoke has already finished", () => {
    expect(needsOf("publish")).toContain("smoke-linux-arm64")
  })

  test("#given the linux-arm64 smoke did not succeed #when an arm64 publish leg runs #then it refuses to publish while other legs are unaffected", () => {
    const gate = job("publish").steps.find((step) => JSON.stringify(step).includes("needs.smoke-linux-arm64.result"))

    expect(gate).toBeDefined()
    expect(gate?.if ?? "").toContain("startsWith(matrix.platform, 'linux-arm64')")
    expect(gate?.run ?? "").toContain("exit 1")
  })

  test("#given one unrelated build leg failed #when the arm64 smoke is scheduled #then it still runs, so a windows failure cannot block the arm64 publishes", () => {
    expect(job("smoke-linux-arm64").if ?? "").not.toContain("needs.build.result == 'success'")
    expect(job("smoke-linux-arm64").if ?? "").toContain("!cancelled()")
  })

  test("#given a platform whose payload artifact is missing #when its publish leg downloads it #then the leg fails loudly instead of skipping", () => {
    const download = job("publish").steps[stepIndex("publish", "Download artifact")]

    expect(download?.["continue-on-error"]).toBeUndefined()
  })

  test("#given an independent leg failed #when the publish job is scheduled #then the remaining legs still publish", () => {
    expect(job("publish").if ?? "").toContain("always()")
    expect(job("publish").if ?? "").toContain("!cancelled()")
  })
})
