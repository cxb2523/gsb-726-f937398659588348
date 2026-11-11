import { describe, expect, it } from 'vitest'
import { SilenceAccelDecider, computeResumeOffset } from './silence-decider'
import { limiterLatencySamples } from './limiter'

const SR = 44100
// The limiter's 5 ms lookahead at this rate: round(0.005 * 44100) = 221.
const LATENCY = limiterLatencySamples(SR)

const decider = (sampleRate = SR) =>
    new SilenceAccelDecider(sampleRate, { threshold: 0.01, openAfterMs: 400, closeAfterMs: 0 })

const silent = (d: SilenceAccelDecider, t: number) => d.decide(0.001, t, false)
const loud = (d: SilenceAccelDecider, t: number) => d.decide(0.05, t, false)
const paused = (d: SilenceAccelDecider, t: number) => d.decide(0.001, t, true)

describe('SilenceAccelDecider', () => {
    it('accelerates after a long enough silence and restores with the limiter offset', () => {
        const d = decider()
        expect(silent(d, 0)).toMatchObject({ accelerate: false, restore: false })
        expect(silent(d, 200)).toMatchObject({ accelerate: false, restore: false })
        expect(silent(d, 399)).toMatchObject({ accelerate: false, restore: false })

        const open = silent(d, 400)
        expect(open.accelerate).toBe(true)
        expect(open.restore).toBe(false)
        // 400 ms at 44.1 kHz, anchored at the first tick.
        expect(open.enteredAtSample).toBe(Math.round(0.4 * SR))
        expect(d.open).toBe(true)
        expect(d.entrySample).toBe(open.enteredAtSample)

        // Any reading over the threshold closes immediately (closeAfterMs = 0).
        const close = loud(d, 500)
        expect(close.accelerate).toBe(false)
        expect(close.restore).toBe(true)
        expect(close.resumeOffsetSamples).toBe(LATENCY)
        expect(close.enteredAtSample).toBeNull()
        expect(d.open).toBe(false)
        expect(d.entrySample).toBeNull()

        // Steady-state ticks afterwards report nothing.
        expect(loud(d, 550)).toMatchObject({ accelerate: false, restore: false })
    })

    it('never accelerates while paused and restarts the timing on resume', () => {
        const d = decider()
        silent(d, 0)
        silent(d, 200)

        // Paused before the gate ever opened: no flip, and the count is dropped.
        const pausedTick = paused(d, 300)
        expect(pausedTick.accelerate).toBe(false)
        expect(pausedTick.restore).toBe(false)
        expect(d.open).toBe(false)

        // Fresh clock on resume: 400 ms of silence from here is needed again.
        expect(silent(d, 400)).toMatchObject({ accelerate: false, restore: false })
        expect(silent(d, 799)).toMatchObject({ accelerate: false, restore: false })
        expect(silent(d, 800).accelerate).toBe(true)

        // Pausing mid-acceleration restores the rate (without seeking, since the
        // entry bookkeeping was reset) and leaves the decider closed.
        const stop = paused(d, 900)
        expect(stop.restore).toBe(true)
        expect(stop.accelerate).toBe(false)
        expect(stop.resumeOffsetSamples).toBe(0)
        expect(stop.enteredAtSample).toBeNull()
        expect(d.open).toBe(false)

        // A second pause while already closed is a quiet no-op.
        expect(paused(d, 950)).toMatchObject({ accelerate: false, restore: false })
    })

    it('does not accelerate for a short silence between sounds', () => {
        const d = decider()
        silent(d, 0)
        silent(d, 300)
        // Sound returns 100 ms before the 400 ms requirement.
        expect(loud(d, 350)).toMatchObject({ accelerate: false, restore: false })
        expect(d.open).toBe(false)

        // The interrupted silence must not count: another 400 ms is needed.
        expect(silent(d, 400)).toMatchObject({ accelerate: false, restore: false })
        expect(silent(d, 700)).toMatchObject({ accelerate: false, restore: false })
        expect(silent(d, 800).accelerate).toBe(true)
    })

    it('reports zero resume offset when fewer samples than the limiter latency elapsed', () => {
        // At 8 kHz the limiter lookahead is 40 samples (5 ms). A gate that opens
        // after just 2 ms enters at ~16 samples — inside the lookahead — so there
        // is nothing valid to rewind and the offset must be 0, never negative.
        const lowRate = 8000
        expect(limiterLatencySamples(lowRate)).toBe(40)
        const d = new SilenceAccelDecider(lowRate, {
            threshold: 0.01,
            openAfterMs: 2,
            closeAfterMs: 0
        })

        const open = silent(d, 0)
        expect(open.accelerate).toBe(false)
        const opened = silent(d, 2)
        expect(opened.accelerate).toBe(true)
        expect(opened.enteredAtSample).toBe(Math.round(0.002 * lowRate))
        expect(opened.enteredAtSample!).toBeLessThan(limiterLatencySamples(lowRate))

        const close = loud(d, 3)
        expect(close.restore).toBe(true)
        expect(close.resumeOffsetSamples).toBe(0)
    })

    it('reset() restarts timing without reporting a flip', () => {
        const d = decider()
        silent(d, 0)
        silent(d, 500)
        expect(d.open).toBe(true)
        d.reset()
        expect(d.open).toBe(false)
        expect(d.entrySample).toBeNull()
        // Clock re-anchored: the old 500 ms of silence no longer counts.
        expect(silent(d, 600)).toMatchObject({ accelerate: false, restore: false })
        expect(silent(d, 1000).accelerate).toBe(true)
    })
})

describe('computeResumeOffset', () => {
    it('returns the full limiter latency once enough samples have elapsed', () => {
        expect(computeResumeOffset(LATENCY, SR)).toBe(LATENCY)
        expect(computeResumeOffset(10_000, SR)).toBe(LATENCY)
        expect(computeResumeOffset(10_000, 48000)).toBe(limiterLatencySamples(48000))
    })

    it('clamps to zero at and below the latency boundary and on bad input', () => {
        expect(computeResumeOffset(LATENCY - 1, SR)).toBe(0)
        expect(computeResumeOffset(0, SR)).toBe(0)
        expect(computeResumeOffset(-50, SR)).toBe(0)
        expect(computeResumeOffset(Number.NaN, SR)).toBe(0)
        expect(computeResumeOffset(1000, 0)).toBe(0)
        expect(computeResumeOffset(1000, -44100)).toBe(0)
        expect(computeResumeOffset(1000, Number.NaN)).toBe(0)
    })
})
