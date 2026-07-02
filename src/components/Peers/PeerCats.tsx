import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Cat } from '../Cat/Cat';
import { ACTIVITY_BADGE, Peer } from '../../types';
import './peers.css';

/** How long a "👋 nickname" greeting bubble shows after a peer first appears. */
const GREET_MS = 3500;
/** Horizontal gap (px) under which a peer counts as "next to" your cat. */
const PLAY_NEAR = 130;
/** How long a shared-play ❤️ moment lingers. */
const PLAY_MS = 2600;

/**
 * Visiting cats from clawd peers on the LAN, roaming the bottom band of the
 * overlay. Each shows the peer's coat + mood pose, a nickname, and a coarse
 * activity badge. Newly arrived cats wave hello; departures fade out.
 *
 * Peers wander on their own (a view-local walk, no positions sent over the
 * wire). When both your cat and a visitor are in a playful mood, the visitor
 * drifts over to your cat, faces it, and a ❤️ pops — a lightweight "playing
 * together" beat. `getSelfX` reports your cat's current x; `selfPlayful` is
 * whether your cat is relaxed enough to play. Both optional (only App passes
 * them), so the component still renders fine without.
 */
export function PeerCats({
  peers,
  getSelfX,
  selfPlayful = false,
}: {
  peers: Peer[];
  getSelfX?: () => number;
  selfPlayful?: boolean;
}) {
  const seen = useRef<Set<string>>(new Set());
  const [greeting, setGreeting] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fresh = peers.filter((p) => !seen.current.has(p.id)).map((p) => p.id);
    peers.forEach((p) => seen.current.add(p.id));
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
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            <PeerCat
              peer={p}
              index={i}
              greet={greeting.has(p.id)}
              getSelfX={getSelfX}
              selfPlayful={selfPlayful}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function PeerCat({
  peer,
  index,
  greet,
  getSelfX,
  selfPlayful,
}: {
  peer: Peer;
  index: number;
  greet: boolean;
  getSelfX?: () => number;
  selfPlayful: boolean;
}) {
  const moveRef = useRef<HTMLDivElement>(null);
  const xRef = useRef(0);
  const [gait, setGait] = useState<'idle' | 'walk'>('idle');
  const [flip, setFlip] = useState(false); // true = facing left
  const [playing, setPlaying] = useState(false);

  // Keep the latest self-position getter / mood in refs so the long-lived
  // wander loop reads fresh values without re-arming its timers each render.
  const selfXFn = useRef(getSelfX);
  selfXFn.current = getSelfX;
  const selfPlayfulRef = useRef(selfPlayful);
  selfPlayfulRef.current = selfPlayful;

  useEffect(() => {
    let alive = true;
    let walkTimer = 0;
    let restTimer = 0;
    let playTimer = 0;

    const startX = 40 + index * 96;
    xRef.current = startX;
    const el = moveRef.current;
    if (el) {
      el.style.transition = 'none';
      el.style.transform = `translateX(${startX}px)`;
    }

    const peerPlayful = () => peer.activity === 'light';
    const bothPlayful = () => peerPlayful() && selfPlayfulRef.current;

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
      const band = Math.max(160, Math.min(window.innerWidth - 140, window.innerWidth * 0.72));

      // When both are in the mood, half the time drift over to your cat to play.
      const selfX = selfXFn.current?.();
      const seek = bothPlayful() && selfX != null && Math.random() < 0.5;
      const target = seek
        ? Math.min(band, Math.max(0, selfX - 40 + (Math.random() * 40 - 20)))
        : Math.random() * band;

      const cur = xRef.current;
      const dist = Math.abs(target - cur);
      const dur = Math.max(900, dist * 7);
      setFlip(target < cur);
      setGait('walk');
      void node.offsetWidth;
      node.style.transition = `transform ${dur}ms ease-in-out`;
      node.style.transform = `translateX(${target}px)`;
      xRef.current = target;

      walkTimer = window.setTimeout(() => {
        setGait('idle');

        // Arrived: if we're beside your cat and both are playful, share a beat.
        const sx = selfXFn.current?.();
        if (bothPlayful() && sx != null && Math.abs(xRef.current - sx) < PLAY_NEAR) {
          setFlip(sx < xRef.current); // turn to face your cat
          setPlaying(true);
          playTimer = window.setTimeout(() => setPlaying(false), PLAY_MS);
          restTimer = window.setTimeout(wander, PLAY_MS + 400);
          return;
        }

        const [lo, hi] = restRange();
        restTimer = window.setTimeout(wander, lo + Math.random() * (hi - lo));
      }, dur);
    };

    restTimer = window.setTimeout(wander, 700 + index * 500 + Math.random() * 2200);
    return () => {
      alive = false;
      clearTimeout(walkTimer);
      clearTimeout(restTimer);
      clearTimeout(playTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, peer.activity]);

  const badge = ACTIVITY_BADGE[peer.activity] ?? ACTIVITY_BADGE.light;
  return (
    <div className="peer-move" ref={moveRef}>
      <AnimatePresence>
        {playing && (
          <motion.div
            className="peer-play-emote"
            initial={{ opacity: 0, y: 4, scale: 0.6 }}
            animate={{ opacity: 1, y: -6, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.7 }}
            transition={{ duration: 0.3 }}
          >
            ❤️
          </motion.div>
        )}
      </AnimatePresence>
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
      <div className={flip ? 'peer-flip flip' : 'peer-flip'}>
        <div className="peer-sprite">
          <Cat state={peer.state} gait={gait} color={peer.color} />
        </div>
      </div>
    </div>
  );
}
