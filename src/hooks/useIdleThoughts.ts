import { useEffect, useState } from 'react';

/** Little thought-bubble lines the cat muses now and then while idle. Kept
 * light and content-free — pure flavor, never anything about your usage. */
const THOUGHTS = [
  '오늘도 화이팅이다냥',
  '츄르 먹고 싶다냥',
  '햇살 좋다냥 ☀️',
  '코딩 잘 되냥?',
  '살짝 졸리다냥 😴',
  '창밖 구경 중이다냥',
  '집사 옆이 좋다냥',
  '기지개 켜고 싶다냥',
];

/** How often we roll for a thought, and the odds each roll — rare enough to
 * feel spontaneous, not chatty (~1 in 8 per minute). */
const ROLL_MS = 60_000;
const ODDS = 0.12;
const THOUGHT_MS = 4000;

/**
 * Occasional idle "thoughts" — a soft bit of personality. Rolls on an interval
 * and, when it hits, surfaces a random line for a few seconds. `enabled` lets
 * the caller pause it (e.g. the master fun-effects toggle, or while the cat is
 * busy). Uses `Math.random`/index — this is the browser, not a workflow sandbox.
 */
export function useIdleThoughts(enabled: boolean): string | null {
  const [thought, setThought] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setThought(null);
      return;
    }
    let clear: number | undefined;
    const roll = window.setInterval(() => {
      if (Math.random() < ODDS) {
        const pick = THOUGHTS[Math.floor(Math.random() * THOUGHTS.length)];
        setThought(pick);
        if (clear) clearTimeout(clear);
        clear = window.setTimeout(() => setThought(null), THOUGHT_MS);
      }
    }, ROLL_MS);
    return () => {
      clearInterval(roll);
      if (clear) clearTimeout(clear);
    };
  }, [enabled]);

  return thought;
}
