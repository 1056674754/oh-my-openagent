"use client"

import type { RefObject } from "react"
import { useEffect, useState } from "react"

function registerLitProgress(): boolean {
  if (typeof CSS === "undefined" || !("registerProperty" in CSS)) return false
  try {
    CSS.registerProperty({
      name: "--lit-p",
      syntax: "<number>",
      inherits: true,
      initialValue: "0",
    })
    return true
  } catch (error) {
    return error instanceof DOMException && error.name === "InvalidModificationError"
  }
}

function supportsScrollTimeline(): boolean {
  return CSS.supports("animation-timeline: view()")
}

export type LitMode = "pending" | "scroll" | "observer"

function vhPx(style: CSSStyleDeclaration, property: string, viewport: number): number {
  return (Number.parseFloat(style.getPropertyValue(property)) / 100) * viewport
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Scroll-driven reveal. `reveal` (manifesto): a bright edge moves down the block; everything above
 * it stays lit, words below rest at the unread floor — a whole screenful is always readable.
 * Default paragraph (landing secret): the body sweeps across `20vh → 50vh`, then `.lit-follow`
 * fades in after a hold. IO gates the fallback geometry sampling; intersection-ratio alone stops
 * changing for fully visible or viewport-spanning blocks, so geometry is sampled per frame.
 */
export function useLitProgress(
  ref: RefObject<HTMLDivElement | null>,
  reducedMotion: boolean,
  reveal: boolean,
): LitMode {
  const [driven, setMode] = useState<LitMode>("pending")
  const mode: LitMode = reducedMotion ? "observer" : driven

  useEffect(() => {
    if (reducedMotion) return
    const element = ref.current
    const body = element?.querySelector<HTMLElement>(".lit-text")
    const follow = element?.querySelector<HTMLElement>(".lit-follow") ?? null
    if (!element || !body) return
    const useTimeline = registerLitProgress() && supportsScrollTimeline()

    const updateProgress = () => {
      const rect = body.getBoundingClientRect()
      const viewport = window.innerHeight
      const style = getComputedStyle(element)
      if (reveal) {
        const startTop = vhPx(style, "--lit-line", viewport) + vhPx(style, "--lit-band", viewport)
        const endTop = vhPx(style, "--lit-line", viewport) - vhPx(style, "--lit-band", viewport)
        element.style.setProperty(
          "--lit-p",
          String(clamp01((startTop - rect.top) / (startTop - endTop))),
        )
        // Per-word geometry (fallback only): a word lights as its own bottom crosses the full line.
        // Read every rect first, then write vars — no layout read inside the write pass; only words
        // in or near the viewport are touched.
        const words: { node: HTMLElement; bottom: number; height: number }[] = []
        for (const word of body.querySelectorAll<HTMLElement>(".lit-word")) {
          const wordRect = word.getBoundingClientRect()
          if (wordRect.bottom < -viewport || wordRect.top > viewport * 2) continue
          words.push({ node: word, bottom: wordRect.bottom, height: wordRect.height || 1 })
        }
        for (const { node, bottom, height } of words) {
          node.style.setProperty("--lit-local", String(clamp01((endTop - bottom) / height + 1)))
        }
        return
      }
      const startTop = viewport * 0.8
      const endTop = viewport * 0.5 - rect.height
      element.style.setProperty(
        "--lit-p",
        String(clamp01((startTop - rect.top) / (startTop - endTop))),
      )
      if (!follow) return
      const hold = vhPx(style, "--lit-read-hold", viewport)
      const fade = vhPx(style, "--lit-follow-fade", viewport)
      const gap = Number.parseFloat(getComputedStyle(follow).marginTop)
      const nextFollow = (endTop - rect.top - Math.max(hold, gap)) / fade
      element.style.setProperty("--lit-f", String(clamp01(nextFollow)))
    }
    let frame = 0
    let intersecting = false
    let observing = false
    const sample = () => {
      updateProgress()
      frame = requestAnimationFrame(sample)
    }
    const syncSampling = () => {
      cancelAnimationFrame(frame)
      if (!observing) return
      updateProgress()
      if (intersecting && !document.hidden) frame = requestAnimationFrame(sample)
    }
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting)
      syncSampling()
    })
    const startObserving = () => {
      element.classList.remove("lit-scroll")
      setMode("observer")
      observing = true
      updateProgress()
      observer.observe(element)
      document.addEventListener("visibilitychange", syncSampling)
      window.addEventListener("resize", syncSampling)
      document.addEventListener("scrollend", syncSampling)
    }
    if (useTimeline) {
      element.classList.add("lit-scroll")
      const expected = ["lit-progress", ...(follow ? ["lit-follow"] : [])]
      const animations = element
        .getAnimations({ subtree: true })
        .filter((item) => item instanceof CSSAnimation && expected.includes(item.animationName))
      frame = requestAnimationFrame(() => {
        if (
          animations.length === expected.length &&
          animations.every(
            ({ timeline }) =>
              timeline && timeline !== document.timeline && timeline.currentTime !== null,
          )
        ) {
          setMode("scroll")
        } else {
          startObserving()
        }
      })
    } else {
      startObserving()
    }
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener("visibilitychange", syncSampling)
      window.removeEventListener("resize", syncSampling)
      document.removeEventListener("scrollend", syncSampling)
      element.classList.remove("lit-scroll")
      element.style.removeProperty("--lit-p")
      element.style.removeProperty("--lit-f")
    }
  }, [reducedMotion, reveal, ref])

  return mode
}
