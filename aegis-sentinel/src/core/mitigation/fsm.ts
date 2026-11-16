// Mitigation state machine (Requirements 2.3, 2.4, 2.12, 2.13, 2.14). Pure.
// The only place mitigation policy lives. Time arrives in events; the core never reads a clock.
import { IN_FLIGHT_STATES, type Mitigation, type MitigationTimeline } from '../model';
import type { EcdsaSignature } from './types';

export interface MitigationConfig {
  /** Requirement 2.14. */
  readonly maxStateAgeMs: number;
  /** Requirement 2.3. */
  readonly signatureTimeoutMs: number;
  /** First request plus one resubmit (Requirement 2.3). */
  readonly maxSignAttempts: number;
}

export const DEFAULT_MITIGATION_CONFIG: MitigationConfig = {
  maxStateAgeMs: 2_000,
  signatureTimeoutMs: 30_000,
  maxSignAttempts: 2,
};

export interface MitigationMachine {
  readonly contractId: string;
  readonly paused: boolean;
  readonly breachId?: string;
  /** When the most recent submit_sign command was issued. Timeout is measured from here. */
  readonly lastSignCommandAtMs?: number;
  readonly mitigation: Mitigation;
}

export type MitigationEvent =
  | { readonly kind: 'breach_detected'; readonly breachId: string; readonly readAtMs: number; readonly nowMs: number }
  | { readonly kind: 'gate_refused'; readonly reason: string; readonly nowMs: number }
  | { readonly kind: 'sign_submitted'; readonly nearTxHash: string; readonly nowMs: number }
  | { readonly kind: 'signature_received'; readonly signature: EcdsaSignature; readonly nowMs: number }
  | { readonly kind: 'broadcast'; readonly targetTxHash: string; readonly nowMs: number }
  | { readonly kind: 'confirmed'; readonly nowMs: number }
  | { readonly kind: 'timeout'; readonly nowMs: number }
  | { readonly kind: 'paused_observed'; readonly nowMs: number };

export type Command =
  | { readonly kind: 'reread_state' }
  | { readonly kind: 'submit_sign'; readonly attempt: number }
  | { readonly kind: 'broadcast'; readonly signature: EcdsaSignature }
  | { readonly kind: 'alert'; readonly reason: string };

export interface StepResult {
  readonly next: MitigationMachine;
  readonly commands: readonly Command[];
}

export function initialMachine(contractId: string): MitigationMachine {
  return { contractId, paused: false, mitigation: { state: 'none', attempts: 0, timeline: {} } };
}

const IDLE: StepResult['commands'] = [];

function withMitigation(m: MitigationMachine, patch: Partial<Mitigation>, timeline?: Partial<MitigationTimeline>): MitigationMachine {
  return {
    ...m,
    mitigation: {
      ...m.mitigation,
      ...patch,
      timeline: timeline ? { ...m.mitigation.timeline, ...timeline } : m.mitigation.timeline,
    },
  };
}

/** Pure transition function. Events that do not apply in the current state are ignored. */
export function step(m: MitigationMachine, e: MitigationEvent, cfg: MitigationConfig): StepResult {
  const state = m.mitigation.state;
  switch (e.kind) {
    case 'breach_detected': {
      // 2.13: a paused contract needs no further mitigation.
      if (m.paused) return { next: m, commands: IDLE };
      // 2.12: never a second mitigation while one is in flight, or after one confirmed.
      if (IN_FLIGHT_STATES.has(state) || state === 'confirmed') return { next: m, commands: IDLE };
      // 2.14: stale state must be re-read before acting.
      if (e.nowMs - e.readAtMs > cfg.maxStateAgeMs) return { next: m, commands: [{ kind: 'reread_state' }] };
      const next: MitigationMachine = {
        ...m,
        breachId: e.breachId,
        lastSignCommandAtMs: e.nowMs,
        mitigation: { state: 'pending_signature', attempts: 1, timeline: { t0: e.nowMs } },
      };
      return { next, commands: [{ kind: 'submit_sign', attempt: 1 }] };
    }

    case 'gate_refused': {
      if (state !== 'pending_signature') return { next: m, commands: IDLE };
      return { next: withMitigation(m, { state: 'refused' }), commands: [{ kind: 'alert', reason: `gate refused: ${e.reason}` }] };
    }

    case 'sign_submitted': {
      if (state !== 'pending_signature') return { next: m, commands: IDLE };
      const first = m.mitigation.timeline.signRequestSubmitted;
      return {
        next: withMitigation(m, { nearTxHash: e.nearTxHash }, first === undefined ? { signRequestSubmitted: e.nowMs } : undefined),
        commands: IDLE,
      };
    }

    case 'signature_received': {
      if (state !== 'pending_signature') return { next: m, commands: IDLE };
      return {
        next: withMitigation(m, { state: 'signed' }, { signatureReceived: e.nowMs }),
        commands: [{ kind: 'broadcast', signature: e.signature }],
      };
    }

    case 'broadcast': {
      if (state !== 'signed') return { next: m, commands: IDLE };
      return { next: withMitigation(m, { state: 'broadcast', targetTxHash: e.targetTxHash }, { broadcast: e.nowMs }), commands: IDLE };
    }

    case 'confirmed': {
      if (state !== 'broadcast') return { next: m, commands: IDLE };
      return { next: withMitigation(m, { state: 'confirmed' }, { confirmed: e.nowMs }), commands: IDLE };
    }

    case 'timeout': {
      // The runtime's timer may fire early or late; the core decides whether it has really expired.
      if (state !== 'pending_signature' || m.lastSignCommandAtMs === undefined) return { next: m, commands: IDLE };
      // 2.13: once the target reports paused, stop issuing mitigations, retries included.
      // Found by P9 (seed 209548967): breach -> paused_observed -> timeout resubmitted.
      if (m.paused) return { next: m, commands: IDLE };
      if (e.nowMs - m.lastSignCommandAtMs < cfg.signatureTimeoutMs) return { next: m, commands: IDLE };
      const attempts = m.mitigation.attempts;
      if (attempts < cfg.maxSignAttempts) {
        return {
          next: { ...withMitigation(m, { attempts: attempts + 1 }), lastSignCommandAtMs: e.nowMs },
          commands: [
            { kind: 'submit_sign', attempt: attempts + 1 },
            { kind: 'alert', reason: `no signature after ${cfg.signatureTimeoutMs} ms; resubmitting` },
          ],
        };
      }
      return {
        next: withMitigation(m, { state: 'failed' }),
        commands: [{ kind: 'alert', reason: `no signature after ${attempts} attempts; mitigation failed` }],
      };
    }

    case 'paused_observed':
      return { next: m.paused ? m : { ...m, paused: true }, commands: IDLE };
  }
}
