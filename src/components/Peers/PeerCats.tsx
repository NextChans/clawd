import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Cat } from '../Cat/Cat';
import { ACTIVITY_BADGE, Peer } from '../../types';
import './peers.css';

/** How long a "👋 nickname" greeting bubble shows after a peer first appears. */
const GREET_MS = 3500;

/**
 * Visiting cats from clawd peers on the LAN, roaming the bottom band of the
 * overlay. Each shows the peer's coat + mood pose, a nickname, and a coarse
 * activity badge (🔥 busy / 💤 idle …). Newly arrived cats pop in with a wave;
 * departures fade out — so the (otherwise invisible) discovery is visible.
 * Click-through and Roam-only, like the furniture row.
 *
 * Peers wander on their own here (a lightweight, view-local walk) so a visiting
 * cat feels as alive as your own — we never sync positions over the wire, only
 * the coarse mood, so each screen animates its visitors independently.
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
    <div className="peer-field" aria-label="네트워크 친구 고양이">
      <AnimatePresence>
        {peers.map((p, i) => (
          <motion.div
            className="peer-slot"
            key={p.id}
            // Fade only — the wander transform lives on an inner element so
            // framer-motion never fights it.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <PeerCat peer={p} index={i} greet={greeting.has(p.id)} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * A single visiting cat that strolls the bottom band on its own. Movement is
 * imperative (like the main cat in App.tsx) so React re-renders never clobber
 * an in-flight CSS transition. The busier the peer, the more often it moves.
 */
function PeerCat({ peer, index, greet }: { peer: Peer; index: number; greet: boolean }) {
  const moveRef = useRef<HTMLDivElement>(null);
  const xRef = useRef(0);
  const [gait, setGait] = useState<'idle' | 'walk'>('idle');
  const [flip, setFlip] = useState(false); // true = facing left

  useEffect(() => {
    let alive = true;
    let walkTimer = 0;
    let restTimer = 0;

    const startX = 40 + index * 96;
    xRef.current = startX;
    const el = moveRef.current;
    if (el) {
      el.style.transition = 'none';
      el.style.transform = `translateX(${startX}px)`;
    }

    // Busier peers pause less between strolls; sleepers barely move.
    const restRange = () => {
      switch (peer.activity) {
        case 'intense':
          return [1200, 2600];
        case 'busy':
          return [2200, 4200];
        case 'idle':
          return [7000, 13000];
        default:
          return [3500, 8000];
      }
    };

    const wander = () => {
      if (!alive) return;
      const node = moveRef.current;
      if (!node) return;
      // Keep cats within the visible band, away from the very edges.
      const band = Math.max(160, Math.min(window.innerWidth - 140, window.innerWidth * 0.72));
      const target = Math.random() * band;
      const cur = xRef.current;
      const dist = Math.abs(target - cur);
      const dur = Math.max(900, dist * 7);
      setFlip(target < cur);
      setGait('walk');
      // Commit the current spot before swapping to the timed transition.
      void node.offsetWidth;
      node.style.transition = `transform ${dur}ms ease-in-out`;
      node.style.transform = `translateX(${target}px)`;
      xRef.current = target;
      walkTimer = window.setTimeout(() => {
        setGait('idle');
        const [lo, hi] = restRange();
        restTimer = window.setTimeout(wander, lo + Math.random() * (hi - lo));
      }, dur);
    };

    // Stagger the first step so visitors don't all set off together.
    restTimer = window.setTimeout(wander, 700 + index * 500 + Math.random() * 2200);
    return () => {
      alive = false;
      clearTimeout(walkTimer);
      clearTimeout(restTimer);
    };
    // Re-arm the cadence when the peer's activity bucket changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, peer.activity]);

  const badge = ACTIVITY_BADGE[peer.activity] ?? ACTIVITY_BADGE.light;
  return (
    <div className="peer-move" ref={moveRef}>
      <AnimatePresence>
        {greet && (
          <motion.div
            className="peer-greet"
            initial={{ opacity: 0, y: 6, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.9 }}
            transition={{ duration: 0.2 }}
          >
            👋 {peer.nickname}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="peer-label" title={`${peer.nickname} · ${badge.label}`}>
        <span className="peer-badge">{badge.icon}</span>
        <span className="peer-name">{peer.nickname}</span>
      </div>
      {/* Flip faces the travel direction; the sprite bobs within it (separate
          elements, so scaleX and the bob translate never collide). */}
      <div className={flip ? 'peer-flip flip' : 'peer-flip'}>
        <div className="peer-sprite">
          <Cat state={peer.state} gait={gait} color={peer.color} />
        </div>
      </div>
    </div>
  );
}
