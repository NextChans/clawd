import { useEffect, useRef, useState } from 'react';
import { Thresholds, Usage } from '../types';

/** One-shot "usage reaction" beats layered on top of the steady mood. */
export type UsageReaction = 'zoomies' | 'refresh' | null;

/** How long each one-shot reaction plays before clearing itself. */
const ZOOMIES_MS = 4500;
const REFRESH_MS = 4000;

/** The accumulated 5-hour session % must fall at least this much between polls
 * to read as a fresh window (the utilization rolls back toward 0 on reset). */
const SESSION_RESET_DROP = 25;

/**
 * Event-edge reactions derived from the usage stream — the celebratory
 * transitions the steady-state mood machine (`useCatState`) can't express:
 *
 *  - **`zoomies`** — a sudden token burst: the trailing rate jumps from calm
 *    (below the alert tier) into the angry tier in one step, so the cat gets
 *    the zoomies for a few seconds.
 *  - **`refresh`** — the 5-hour session window just reset: the accumulated
 *    utilization dropped sharply, so the cat wakes up and stretches into the
 *    fresh window. Only available when the session-usage integration is on.
 *
 * These are *edges*, not states: each fires once when its condition first
 * appears and clears after its window, so a sustained-high stretch or a slowly
 * climbing % never re-triggers every poll. `usage` refreshes on the ~30s poll,
 * so the effects key off the values that matter and establish a baseline on the
 * first sample (returning early) so a fresh launch never false-fires.
 */
export function useUsageReactions(
  usage: Usage,
  sessionPct: number | null | undefined,
  thresholds: Thresholds,
): UsageReaction {
  const [reaction, setReaction] = useState<UsageReaction>(null);
  const prevRate = useRef<number | null>(null);
  const prevPct = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const fire = (r: UsageReaction, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    setReaction(r);
    timer.current = window.setTimeout(() => setReaction(null), ms);
  };

  // Token burst → zoomies. Rising edge only: the rate must cross from below the
  // alert tier into the angry tier, so staying busy doesn't re-fire each poll.
  useEffect(() => {
    const rate = usage.rate_per_min;
    const prev = prevRate.current;
    prevRate.current = rate;
    if (prev === null) return; // first sample: set the baseline, don't fire
    if (prev < thresholds.high && rate >= thresholds.veryHigh) fire('zoomies', ZOOMIES_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage.rate_per_min, thresholds.high, thresholds.veryHigh]);

  // Session window reset → refresh stretch. Values arrive as a 0–1 fraction or
  // an already-0–100 number (mirrors useCatState's normalization).
  useEffect(() => {
    if (sessionPct == null) {
      prevPct.current = null;
      return;
    }
    const pct = sessionPct <= 1 ? sessionPct * 100 : sessionPct;
    const prev = prevPct.current;
    prevPct.current = pct;
    if (prev === null) return;
    if (prev - pct >= SESSION_RESET_DROP) fire('refresh', REFRESH_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionPct]);

  // Clear a pending timer on unmount.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return reaction;
}
