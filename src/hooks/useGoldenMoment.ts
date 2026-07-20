import { useEffect, useState } from 'react';

/** How often we roll for a golden moment, and the odds each roll. ~4% every
 * 45s averages out to roughly one shimmer every ~20 minutes of uptime — rare
 * enough to feel like a treat, not a gimmick. */
const ROLL_MS = 45_000;
const ODDS = 0.04;
/** How long the shimmer lasts. */
const GOLDEN_MS = 4500;

/**
 * A rare "golden cat" shimmer — every so often the cat briefly turns lucky-gold,
 * a shiny-Pokémon-style treat you stumble on rather than trigger. Purely
 * cosmetic and self-contained: a low-odds roll on an interval, cleared after its
 * window. Uses `Math.random` (this is the browser, not a workflow sandbox).
 */
export function useGoldenMoment(): boolean {
  const [golden, setGolden] = useState(false);

  useEffect(() => {
    let clear: number | undefined;
    const roll = window.setInterval(() => {
      if (Math.random() < ODDS) {
        setGolden(true);
        if (clear) clearTimeout(clear);
        clear = window.setTimeout(() => setGolden(false), GOLDEN_MS);
      }
    }, ROLL_MS);
    return () => {
      clearInterval(roll);
      if (clear) clearTimeout(clear);
    };
  }, []);

  return golden;
}
