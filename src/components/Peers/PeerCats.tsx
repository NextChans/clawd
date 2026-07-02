import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Cat } from '../Cat/Cat';
import { ACTIVITY_BADGE, Peer } from '../../types';
import './peers.css';

/** How long a "👋 nickname" greeting bubble shows after a peer first appears. */
const GREET_MS = 3500;

/**
 * Visiting cats from clawd peers on the LAN, gathered along the bottom-left of
 * the overlay. Each shows the peer's coat + mood pose, a nickname, and a coarse
 * activity badge (🔥 busy / 💤 idle …). Newly arrived cats pop in with a wave;
 * departures fade out — so the (otherwise invisible) discovery is visible.
 * Click-through and Roam-only, like the furniture row.
 *
 * MVP: peers gently pace in place rather than roaming the whole screen — the
 * wander scheduler (`roam.rs`) is single-cat today; giving visitors real
 * roaming is a natural follow-up.
 */
export function PeerCats({ peers }: { peers: Peer[] }) {
  // Track which peer ids we've already seen so a fresh arrival can wave hello.
  const seen = useRef<Set<string>>(new Set());
  const [greeting, setGreeting] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fresh = peers.filter((p) => !seen.current.has(p.id)).map((p) => p.id);
    peers.forEach((p) => seen.current.add(p.id));
    // Forget peers that have left, so if they return later they wave again.
    const present = new Set(peers.map((p) => p.id));
    seen.current.forEach((id) => {
      if (!present.has(id)) seen.current.delete(id);
    });
    if (fresh.length === 0) return;

    setGreeting((g) => new Set([...g, ...fresh]));
    const t = setTimeout(() => {
      setGreeting((g) => {
        const next = new Set(g);
        fresh.forEach((id) => next.delete(id));
        return next;
      });
    }, GREET_MS);
    return () => clearTimeout(t);
  }, [peers]);

  return (
    <div className="peer-strip" aria-label="네트워크 친구 고양이">
      <AnimatePresence>
        {peers.map((p, i) => {
          const badge = ACTIVITY_BADGE[p.activity] ?? ACTIVITY_BADGE.light;
          return (
            <motion.div
              className="peer-cat"
              key={p.id}
              layout
              initial={{ opacity: 0, y: 14, scale: 0.85 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.85 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              <AnimatePresence>
                {greeting.has(p.id) && (
                  <motion.div
                    className="peer-greet"
                    initial={{ opacity: 0, y: 6, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.9 }}
                    transition={{ duration: 0.2 }}
                  >
                    👋 {p.nickname}
                  </motion.div>
                )}
              </AnimatePresence>
              <div className="peer-label" title={`${p.nickname} · ${badge.label}`}>
                <span className="peer-badge">{badge.icon}</span>
                <span className="peer-name">{p.nickname}</span>
              </div>
              {/* Inner wrapper paces side to side; the sprite bobs within it, so
                  the two idle motions never fight over `transform`. */}
              <div
                className="peer-pace"
                // Stagger so visitors don't pace in lockstep.
                style={{ animationDelay: `${(i % 6) * 0.5}s` }}
              >
                <div className="peer-sprite">
                  <Cat state={p.state} gait="idle" color={p.color} />
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
