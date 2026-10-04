/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { composeGatewayRulesBlock, GATEWAY_RULES_SENTINEL_BEGIN, renderOperatingRulesBlock } from "./rules-block"

describe("renderOperatingRulesBlock", () => {
  test("#given a version and behavioral rules #when rendered #then the block carries the version attribute and one dash line per rule", () => {
    // given + when
    const block = renderOperatingRulesBlock("abc123", ["answer in bullet points", "tag the owner on decisions"])

    // then
    expect(block).toBe(['<operating-rules version="abc123">', "- answer in bullet points", "- tag the owner on decisions", "</operating-rules>"].join("\n"))
  })

  test("#given a version containing a quote #when rendered #then the attribute stays well-formed", () => {
    // given + when
    const block = renderOperatingRulesBlock('v"1', [])

    // then
    expect(block.startsWith('<operating-rules version="v&quot;1">')).toBe(true)
  })
})

describe("composeGatewayRulesBlock", () => {
  test("#given a prompt without the sentinel #when composed #then the block is appended after the existing content", () => {
    // given
    const block = renderOperatingRulesBlock("v1", ["rule one"])

    // when
    const composed = composeGatewayRulesBlock("BASE PROMPT\n", block)

    // then
    expect(composed.startsWith("BASE PROMPT\n\n")).toBe(true)
    expect(composed).toContain("<operating-rules")
  })

  test("#given an unchanged block #when composed twice #then the prompt bytes are identical", () => {
    // given
    const block = renderOperatingRulesBlock("v1", ["rule one"])
    const once = composeGatewayRulesBlock("BASE PROMPT", block)

    // when
    const twice = composeGatewayRulesBlock(once, block)

    // then
    expect(twice).toBe(once)
  })

  test("#given a new version #when composed over the previous prompt #then the old block is replaced, never duplicated", () => {
    // given
    const v1 = composeGatewayRulesBlock("BASE PROMPT", renderOperatingRulesBlock("v1", ["rule one"]))

    // when
    const v2 = composeGatewayRulesBlock(v1, renderOperatingRulesBlock("v2", ["rule two"]))

    // then
    expect(v2).toContain('version="v2"')
    expect(v2).not.toContain('version="v1"')
    expect(v2.startsWith("BASE PROMPT\n\n")).toBe(true)
    expect(v2.split(GATEWAY_RULES_SENTINEL_BEGIN).length - 1).toBe(1)
  })
})
