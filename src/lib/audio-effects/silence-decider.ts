// The testable half of smart speed. AudioManager owns the DOM parts
// (analyser, media element, setInterval) and hands each tick's raw readings
// here; this module decides whether the playback rate should switch to the
// fast tier and when it should come back. It has no DOM or AudioContext
// dependency, so it runs under vitest on its own.
//
// The gate itself (the RMS/timestamp state machine) stays in ./silence-gate;
// this wraps it with the two concerns the tick used to carry inline:
//   1. a paused media element reads as silence, so pause must never open the
//      fast tier and must reset the timing;
//   2. the output limiter's lookahead (see ./limiter) delays every sample, so
//      when the fast tier ends the restore point would land early by the
//      lookahead amount. The sample position where the fast tier began is
//      tracked and the resume is rewound by that latency.
import { DEFAULT_SILENCE_GATE, SilenceGate, type SilenceGateOptions } from './silence-gate'
import { limiterLatencySamples } from './limiter'

/**
 * Samples to rewind on resume, compensating for the limiter lookahead.
 *
 * The limiter delays the whole chain by `limiterLatencySamples(sampleRate)`
 * samples: the first audible sample of the return to normal rate was already
 * that many samples into the timeline when the decision is made, so the
 * element must seek backwards by the same amount to restore at the right
 * place. It is all-or-nothing: if fewer than the latency's worth of samples
 * have elapsed since the fast tier began there is nothing valid to rewind,
 * and the answer is 0 — never negative.
 */
export function computeResumeOffset(enteredAtSample: number, sampleRate: number): number {
    if (!Number.isFinite(enteredAtSample) || enteredAtSample < 0) return 0
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0
    const latency = limiterLatencySamples(sampleRate)
    return enteredAtSample < latency ? 0 : latency
}

/** One tick's decision. Only the flip is actionable; a steady state is all-false. */
export type SilenceDecision = {
    /** Switch the element to the fast playback rate now. */
    accelerate: boolean
    /** Return to the normal rate now, rewinding by `resumeOffsetSamples`. */
    restore: boolean
    /** Sample position (relative to the first observed tick) where the fast tier began. */
    enteredAtSample: number | null
    /** Samples to seek backwards on restore for limiter lookahead; 0 until a restore. */
    resumeOffsetSamples: number
}

const NO_CHANGE: SilenceDecision = {
    accelerate: false,
    restore: false,
    enteredAtSample: null,
    resumeOffsetSamples: 0
}

/**
 * Decides fast-tier flips from per-tick (RMS, timestamp, paused) readings.
 *
 * Timestamps are media/performance times in milliseconds; sample positions
 * are derived from them against the configured sample rate, anchored at the
 * first tick after construction or reset, so the class needs no external
 * sample counter and stays deterministic in tests.
 */
export class SilenceAccelDecider {
    private readonly gate: SilenceGate
    private clockOriginMs: number | null = null
    private enteredAtSample: number | null = null
    private _open = false

    constructor(
        private readonly sampleRate: number,
        options: SilenceGateOptions = DEFAULT_SILENCE_GATE
    ) {
        this.gate = new SilenceGate(options)
    }

    /** True while the fast tier is engaged. */
    get open(): boolean {
        return this._open
    }

    /** Sample position where the current fast tier began, or null when closed. */
    get entrySample(): number | null {
        return this.enteredAtSample
    }

    /**
     * Feed one sampling tick.
     *
     * @param rms      loudness of the sampled block (0..1)
     * @param nowMs    timestamp of the reading, in milliseconds
     * @param paused   whether the media element is currently paused
     */
    decide(rms: number, nowMs: number, paused: boolean): SilenceDecision {
        // A paused element reads as silence: never speed through it, and the
        // timing starts from scratch when playback resumes.
        if (paused) {
            const wasOpen = this._open
            this.reset()
            if (!wasOpen) return { ...NO_CHANGE }
            return {
                accelerate: false,
                restore: true,
                enteredAtSample: null,
                resumeOffsetSamples: 0
            }
        }

        if (this.clockOriginMs === null) this.clockOriginMs = nowMs
        const change = this.gate.feed(rms, nowMs)

        if (change === 'open') {
            this._open = true
            this.enteredAtSample = this.toSample(nowMs)
            return {
                accelerate: true,
                restore: false,
                enteredAtSample: this.enteredAtSample,
                resumeOffsetSamples: 0
            }
        }

        if (change === 'close') {
            const enteredAt = this.enteredAtSample ?? 0
            const offset = computeResumeOffset(enteredAt, this.sampleRate)
            this._open = false
            this.enteredAtSample = null
            return {
                accelerate: false,
                restore: true,
                enteredAtSample: null,
                resumeOffsetSamples: offset
            }
        }

        return { ...NO_CHANGE }
    }

    /** Forget all timing and state; the next tick starts a fresh count. */
    reset(): void {
        this.gate.reset()
        this.clockOriginMs = null
        this.enteredAtSample = null
        this._open = false
    }

    /** Milliseconds since the observed clock began, converted to whole samples. */
    private toSample(nowMs: number): number {
        const origin = this.clockOriginMs ?? nowMs
        return Math.max(0, Math.round(((nowMs - origin) / 1000) * this.sampleRate))
    }
}
