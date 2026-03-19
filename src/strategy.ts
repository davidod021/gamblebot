/**
 * Two-Phase Compound Betting Strategy
 *
 * Phase 1 — Bootstrap (bankroll < growthTarget × initialBankroll)
 *   Goal : grow the bankroll aggressively to a target multiple (default 5×)
 *   Staking: Half Kelly (50 %), capped at 5 % of current bankroll
 *   Edge   : minimum 3 % required
 *
 * Phase 2 — Compound (bankroll ≥ growthTarget × initialBankroll)
 *   Goal : sustainable long-term growth with drawdown protection
 *   Staking: Quarter Kelly (25 %), capped at 3 % of current bankroll
 *   Edge   : minimum 5 % required (more selective)
 *
 * Kelly formula: f* = (b·p − q) / b
 *   b = decimal_odds − 1   (net profit per unit staked)
 *   p = estimated win probability
 *   q = 1 − p
 *
 * Sources:
 *   - Kelly (1956), "A New Interpretation of Information Rate"
 *   - Betherosports Kelly Criterion Guide
 *   - CoreSportsBetting Edge Threshold Guide
 *   - Professional consensus: half Kelly = ~75 % of full growth rate with much lower variance
 */

import { config } from './config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Phase = 'bootstrap' | 'compound';

export interface PhaseConfig {
  kellyFraction: number;  // fraction of full Kelly to apply
  maxBetPct: number;      // hard cap as % of current bankroll
  minEdgePct: number;     // minimum edge required to bet (0–1)
  label: string;
}

export interface StakeInput {
  winProbability: number; // Claude's assessed probability (0–1)
  decimalOdds: number;    // Betfair best available back price
  currentBankroll: number;
  initialBankroll: number;
}

export interface StakeResult {
  stake: number;               // recommended stake in GBP (0 = don't bet)
  phase: Phase;
  edge: number;                // edge as a fraction, e.g. 0.08 = 8 %
  rawKellyPct: number;         // full Kelly % before fraction applied
  appliedKellyPct: number;     // after fraction
  cappedAt: string | null;     // why the stake was reduced, if at all
  reject: boolean;             // true if this bet should not be placed
  rejectReason?: string;
}

export interface SessionGuard {
  sessionStartBankroll: number;
  peakBankroll: number;
}

// ─── Phase configuration ──────────────────────────────────────────────────────

export const PHASE_CONFIG: Record<Phase, PhaseConfig> = {
  bootstrap: {
    kellyFraction: 0.50,   // half Kelly — good balance of growth vs variance
    maxBetPct:     0.05,   // never more than 5 % of bankroll in one bet
    minEdgePct:    0.03,   // require at least 3 % edge
    label: 'Bootstrap (aggressive growth)',
  },
  compound: {
    kellyFraction: 0.25,   // quarter Kelly — prioritises capital preservation
    maxBetPct:     0.03,   // never more than 3 % of bankroll in one bet
    minEdgePct:    0.05,   // require at least 5 % edge — more selective
    label: 'Compound (sustainable growth)',
  },
};

// ─── Core functions ───────────────────────────────────────────────────────────

/** Determine which phase we are in based on current vs initial bankroll. */
export function getPhase(currentBankroll: number, initialBankroll: number): Phase {
  const targetBankroll = initialBankroll * config.strategy.growthTargetMultiplier;
  return currentBankroll >= targetBankroll ? 'compound' : 'bootstrap';
}

/** Calculate the raw Kelly fraction (full Kelly, before any safety reduction). */
export function rawKelly(winProbability: number, decimalOdds: number): number {
  const b = decimalOdds - 1; // net profit per unit
  const p = winProbability;
  const q = 1 - p;
  return (b * p - q) / b;
}

/** Edge as a simple percentage: how much better our probability is than the implied odds probability. */
export function calculateEdge(winProbability: number, decimalOdds: number): number {
  const impliedProbability = 1 / decimalOdds;
  return winProbability - impliedProbability;
}

/**
 * Main stake sizing function.
 * Returns the recommended stake and a full audit trail of the calculation.
 */
export function calculateStake(input: StakeInput): StakeResult {
  const { winProbability, decimalOdds, currentBankroll, initialBankroll } = input;

  const phase = getPhase(currentBankroll, initialBankroll);
  const phaseCfg = PHASE_CONFIG[phase];

  // ── Sanity checks ──────────────────────────────────────────────────────────
  if (winProbability <= 0 || winProbability >= 1) {
    return reject(phase, 'Win probability must be between 0 and 1 exclusive');
  }
  if (decimalOdds <= 1) {
    return reject(phase, 'Decimal odds must be greater than 1.0');
  }

  const edge = calculateEdge(winProbability, decimalOdds);
  const kelly = rawKelly(winProbability, decimalOdds);

  // ── Reject if negative EV ──────────────────────────────────────────────────
  if (kelly <= 0 || edge <= 0) {
    return reject(phase, `Negative expected value (edge ${(edge * 100).toFixed(2)} %). Do not bet.`);
  }

  // ── Reject if below minimum edge threshold ─────────────────────────────────
  if (edge < phaseCfg.minEdgePct) {
    return reject(
      phase,
      `Edge ${(edge * 100).toFixed(2)} % is below the ${phaseCfg.label} minimum of ${(phaseCfg.minEdgePct * 100).toFixed(0)} %. Skip.`,
    );
  }

  // ── Apply fractional Kelly ─────────────────────────────────────────────────
  const appliedKellyPct = kelly * phaseCfg.kellyFraction;
  let stake = appliedKellyPct * currentBankroll;
  let cappedAt: string | null = null;

  // ── Cap at max bet percentage of bankroll ──────────────────────────────────
  const maxByPct = phaseCfg.maxBetPct * currentBankroll;
  if (stake > maxByPct) {
    stake = maxByPct;
    cappedAt = `${(phaseCfg.maxBetPct * 100).toFixed(0)} % bankroll cap (£${maxByPct.toFixed(2)})`;
  }

  // ── Cap at absolute hard limit from config ─────────────────────────────────
  if (stake > config.betting.maxStakePerBet) {
    stake = config.betting.maxStakePerBet;
    cappedAt = `absolute max stake cap (£${config.betting.maxStakePerBet})`;
  }

  // ── Round to 2 d.p. (Betfair minimum increment) ───────────────────────────
  stake = Math.round(stake * 100) / 100;

  // ── Enforce a sensible minimum (avoid tiny bets with transaction overhead) ─
  if (stake < 2.00) {
    return reject(phase, `Calculated stake £${stake.toFixed(2)} is below the £2.00 minimum. Skip.`);
  }

  return {
    stake,
    phase,
    edge,
    rawKellyPct: kelly,
    appliedKellyPct,
    cappedAt,
    reject: false,
  };
}

/**
 * Session drawdown guard.
 * Returns true if betting should be halted for this session.
 */
export function shouldHaltSession(guard: SessionGuard, currentBankroll: number): boolean {
  const drawdownFromPeak = (guard.peakBankroll - currentBankroll) / guard.peakBankroll;
  return drawdownFromPeak >= config.strategy.sessionDrawdownLimit;
}

/** Update the session peak if the current bankroll is a new high. */
export function updatePeak(guard: SessionGuard, currentBankroll: number): SessionGuard {
  return {
    ...guard,
    peakBankroll: Math.max(guard.peakBankroll, currentBankroll),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function reject(phase: Phase, rejectReason: string): StakeResult {
  return {
    stake: 0,
    phase,
    edge: 0,
    rawKellyPct: 0,
    appliedKellyPct: 0,
    cappedAt: null,
    reject: true,
    rejectReason,
  };
}

/** Human-readable summary of a stake result, for logging and approval messages. */
export function summariseStake(result: StakeResult, input: StakeInput): string {
  if (result.reject) {
    return `❌ Bet rejected: ${result.rejectReason}`;
  }
  const phaseCfg = PHASE_CONFIG[result.phase];
  const potReturn = (result.stake * input.decimalOdds).toFixed(2);
  return [
    `📊 Strategy: ${phaseCfg.label}`,
    `📈 Edge: ${(result.edge * 100).toFixed(2)} % | Raw Kelly: ${(result.rawKellyPct * 100).toFixed(2)} %`,
    `💡 Applied ${(phaseCfg.kellyFraction * 100).toFixed(0)} % Kelly → £${result.stake.toFixed(2)}`,
    result.cappedAt ? `⚠️  Capped by: ${result.cappedAt}` : null,
    `💰 Stake £${result.stake.toFixed(2)} @ ${input.decimalOdds} → returns £${potReturn}`,
  ]
    .filter(Boolean)
    .join('\n');
}
