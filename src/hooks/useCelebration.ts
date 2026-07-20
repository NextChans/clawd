import { useEffect, useRef, useState } from 'react';

/** A one-shot celebration beat (confetti + happy pose + bubble). */
export type Celebration = 'milestone' | 'party' | null;

const MILESTONE_MS = 5000;
const PARTY_MS = 5000;

/**
 * Celebration beats — the cat throws a little party.
 *
 *  - **`milestone`** — the cat-tower evolved: today's token total crossed into a
 *    higher `tower_tier`, a visible "you've been busy" moment. Edge-triggered
 *    (fires once per tier-up), with a baseline on the first sample so a launch
 *    that's already at a high tier doesn't celebrate on open. Resets naturally
 *    at midnight when `today_tokens` (and the tier) fall back.
 *  - **`party`** — the hidden treat: fire {@link party} from a rapid-click
 *    streak on the cat.
 *
 * Both render through the same confetti/pose/bubble layer in App.tsx.
 */
export function useCelebration(towerTier: number): {
  celebration: Celebration;
  party: () => void;
} {
  const [celebration, setCelebration] = useState<Celebration>(null);
  const prevTier = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const fire = (c: Celebration, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    setCelebration(c);
    timer.current = window.setTimeout(() => setCelebration(null), ms);
  };

  useEffect(() => {
    const prev = prevTier.current;
    prevTier.current = towerTier;
    if (prev === null) return; // first sample: baseline only
    if (towerTier > prev) fire('milestone', MILESTONE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [towerTier]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { celebration, party: () => fire('party', PARTY_MS) };
}
