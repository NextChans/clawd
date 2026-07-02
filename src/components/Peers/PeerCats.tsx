import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Cat } from '../Cat/Cat';
import { cushionUrl } from '../Furniture/Furniture';
import { ACTIVITY_BADGE, Peer } from '../../types';
import './peers.css';

/** How long a "👋 nickname" greeting bubble shows after a peer first appears. */
const GREET_MS = 3500;
/** Distance (px) under which a peer counts as "next to" your cat. */
const PLAY_NEAR = 130;
/** How long a shared-play ❤️ moment lingers. */
const PLAY_MS = 2600;
/** Keep-out inset from the window edges (roughly the peer sprite size). */
const MARGIN = 16;
const PEER_SIZE = 74;

/** A screen point. */
interface Pt {
  x: number;
  y: number;
}

/**
 * Visiting cats from clawd peers (LAN or a remote room). Each roams the whole
 * overlay on its own — a view-local 2D wander, no positions sent over the wire
 * — so a visitor feels as alive as your own cat. Shows the peer's coat + mood
 * pose, a nickname, and a coarse activity badge. Newly arrived cats wave hello;
 * departures fade out.
 *
 * A sleeping visitor stays put on a cushion (it doesn't sleep-walk). When both
 * your cat and a visitor are in a playful mood, the visitor drifts over to your
 * cat, faces it, and a ❤️ pops. `getSelf` reports your cat's current position;
 * `selfPlayful` whether it's relaxed enough to play. Both optional (only App
 * passes them).
 */
export function PeerCats({
  peers,
  getSelf,
  selfPlayful = false,
}: {
  peers: Peer[];
  getSelf?: () => Pt;
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
              getSelf={getSelf}
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
  getSelf,
  selfPlayful,
}: {
  peer: Peer;
  index: number;
  greet: boolean;
  getSelf?: () => Pt;
  selfPlayful: boolean;
}) {
  const moveRef = useRef<HTMLDivElement>(null);
  const posRef = useRef<Pt>({ x: 0, y: 0 });
  const placed = useRef(false);
  const [gait, setGait] = useState<'idle' | 'walk'>('idle');
  const [flip, setFlip] = useState(false); // true = facing left
  const [playing, setPlaying] = useState(false);

  // Latest self getter / mood in refs so the long-lived wander loop reads fresh
  // values without re-arming its timers each render.
  const selfFn = useRef(getSelf);
  selfFn.current = getSelf;
  const selfPlayfulRef = useRef(selfPlayful);
  selfPlayfulRef.current = selfPlayful;

  const asleep = peer.state === 'sleeping';

  useEffect(() => {
    let alive = true;
    let walkTimer = 0;
    let restTimer = 0;
    let playTimer = 0;

    // Place once, on first mount — never on a later mood change, so a waking or
    // dozing cat doesn't teleport back to its start spot.
    const node = moveRef.current;
    if (node && !placed.current) {
      const start = { x: 40 + (index % 5) * 120, y: 60 + (index % 3) * 90 };
      posRef.current = start;
      node.style.transition = 'none';
      node.style.transform = `translate3d(${start.x}px, ${start.y}px, 0)`;
      placed.current = true;
    }

    // A sleeping visitor retreats to the bottom edge (out of the way of your
    // work) and curls up there — one move, then it stays put (no sleep-walking).
    if (asleep) {
      const el = moveRef.current;
      const maxX = Math.max(MARGIN, window.innerWidth - PEER_SIZE - MARGIN);
      const maxY = Math.max(MARGIN, window.innerHeight - PEER_SIZE - MARGIN);
      const cur = posRef.current;
      if (el && cur.y < maxY - 40) {
        const target = { x: Math.min(maxX, Math.max(MARGIN, cur.x)), y: maxY };
        const dur = Math.max(900, Math.hypot(target.x - cur.x, target.y - cur.y) * 6);
        setFlip(target.x < cur.x);
        setGait('walk');
        void el.offsetWidth;
        el.style.transition = `transform ${dur}ms ease-in-out`;
        el.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
        posRef.current = target;
        const t = window.setTimeout(() => setGait('idle'), dur);
        return () => clearTimeout(t);
      }
      setGait('idle');
      return () => {};
    }

    const bounds = () => ({
      maxX: Math.max(MARGIN, window.innerWidth - PEER_SIZE - MARGIN),
      maxY: Math.max(MARGIN, window.innerHeight - PEER_SIZE - MARGIN),
    });
    const clamp = (v: number, hi: number) => Math.min(hi, Math.max(MARGIN, v));

    const peerPlayful = () => peer.activity === 'light';
    const bothPlayful = () => peerPlayful() && selfPlayfulRef.current;

    const restRange = () => {
      switch (peer.activity) {
        case 'intense':
          return [1000, 2400];
        case 'busy':
          return [2000, 4000];
        default:
          return [3000, 7000];
      }
    };

    const wander = () => {
      if (!alive) return;
      const el = moveRef.current;
      if (!el) return;
      const { maxX, maxY } = bounds();

      // When both are relaxed, half the time drift over to your cat to play.
      const self = selfFn.current?.();
      const seek = bothPlayful() && self != null && Math.random() < 0.5;
      const target: Pt = seek
        ? {
            x: clamp(self.x + (Math.random() * 60 - 30), maxX),
            y: clamp(self.y + (Math.random() * 50 - 25), maxY),
          }
        : { x: MARGIN + Math.random() * (maxX - MARGIN), y: MARGIN + Math.random() * (maxY - MARGIN) };

      const cur = posRef.current;
      const dist = Math.hypot(target.x - cur.x, target.y - cur.y);
      const dur = Math.max(900, dist * 6);
      setFlip(target.x < cur.x);
      setGait('walk');
      void el.offsetWidth;
      el.style.transition = `transform ${dur}ms ease-in-out`;
      el.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
      posRef.current = target;

      walkTimer = window.setTimeout(() => {
        setGait('idle');

        // Arrived: if we're beside your cat and both playful, share a beat.
        const s = selfFn.current?.();
        if (bothPlayful() && s != null && Math.hypot(posRef.current.x - s.x, posRef.current.y - s.y) < PLAY_NEAR) {
          setFlip(s.x < posRef.current.x); // turn to face your cat
          setPlaying(true);
          playTimer = window.setTimeout(() => setPlaying(false), PLAY_MS);
          restTimer = window.setTimeout(wander, PLAY_MS + 400);
          return;
        }

        const [lo, hi] = restRange();
        restTimer = window.setTimeout(wander, lo + Math.random() * (hi - lo));
      }, dur);
    };

    restTimer = window.setTimeout(wander, 700 + index * 450 + Math.random() * 2000);
    return () => {
      alive = false;
      clearTimeout(walkTimer);
      clearTimeout(restTimer);
      clearTimeout(playTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, peer.activity, asleep]);

  const badge = ACTIVITY_BADGE[peer.activity] ?? ACTIVITY_BADGE.light;
  const cushion = asleep ? cushionUrl(peer.color) : undefined;
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
      {/* Cushion under a sleeping visitor (behind the cat). */}
      {cushion && <img className="peer-cushion" src={cushion} alt="" draggable={false} />}
      <div className={flip ? 'peer-flip flip' : 'peer-flip'}>
        <div className="peer-sprite">
          <Cat state={peer.state} gait={gait} color={peer.color} />
        </div>
      </div>
    </div>
  );
}
