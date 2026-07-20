import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Cat, hasCatSprite } from './components/Cat/Cat';
import { FurnitureBaseline, FurnitureKind } from './components/Furniture/Furniture';
import { Butterfly } from './components/Playthings/Butterfly';
import { Ball } from './components/Playthings/Ball';
import { Yarn } from './components/Playthings/Yarn';
import { Bird } from './components/Playthings/Bird';
import { FishingRod } from './components/Playthings/FishingRod';
import { PeerCats } from './components/Peers/PeerCats';
import { useUsage } from './hooks/useUsage';
import { useConfig } from './hooks/useConfig';
import { usePeers, usePresencePublish } from './hooks/usePresence';
import { useSessionUsage } from './hooks/useSessionUsage';
import { useSessionAlert } from './hooks/useSessionAlert';
import { classifyWithReason, STATE_LABEL } from './hooks/useCatState';
import { useUsageReactions } from './hooks/useUsageReactions';
import { useCelebration } from './hooks/useCelebration';
import { ACTIVITY_FOR_STATE, CatState } from './types';
import { formatRate, formatTokens } from './utils/format';
import './App.css';

type Mode = 'roam' | 'grab' | 'fishing';
type Gait = 'idle' | 'walk' | 'run' | 'jitter';
type Direction = 'left' | 'right';
/** Resting flourishes scheduled by Rust. `yawn`/`stretch` have expressive
 * sprites (cream); the three smaller twitches are CSS-only (see App.css). */
type SubEventKind = 'yawn' | 'stretch' | 'ear_wiggle' | 'look_back' | 'blink_hard';
/** The four toys the cat reacts to (mirrors `roam.rs`'s `PLAYTHINGS`). */
type PlaythingKind = 'butterfly' | 'ball' | 'yarn' | 'bird';

/** Rust's `cat-wander` payload: tween the cat here over `duration_ms`. */
interface WanderEvent {
  x: number;
  y: number;
  duration_ms: number;
  direction: Direction;
  gait: Exclude<Gait, 'idle'>;
}
/** Rust's `cat-place` payload: snap the cat here with no transition. */
interface PlaceEvent {
  x: number;
  y: number;
}
/** Rust's `cat-sub-event` payload: a brief in-place flourish while resting. */
interface SubEvent {
  kind: SubEventKind;
  duration_ms: number;
}
/** Rust's `cat-plaything` payload: spawn a toy the cat reacts to. */
interface PlaythingEvent {
  kind: PlaythingKind;
  x: number;
  y: number;
  target_x: number;
  target_y: number;
  duration_ms: number;
}
/** Live plaything being animated on screen (frontend-only). */
interface Plaything extends PlaythingEvent {
  /** Bump on each spawn so the animation effect re-fires. */
  id: number;
}

/** Rust's `cat-furniture` payload: a prop fades in and the cat visits it. */
interface FurnitureEvent {
  kind: FurnitureKind;
  /** Cat's travel time (ms) — pounce on arrival. */
  arrive_ms: number;
  /** Total time the prop stays visible (ms). */
  duration_ms: number;
}

/** How long the "just ate" reaction (temp sit + bowl linger) lasts. */
const FEED_REACT_MS = 5000;

const FIRST_RUN_KEY = 'first_run_done';
/** Tooltip max width (px); must match `.tooltip { max-width }` in App.css. */
const TOOLTIP_MAX = 240;
/** Cat container side in px; must match `CAT_SIZE` (Rust) and `.cat-container`. */
const CAT_SIZE = 128;
/** How the tooltip is anchored over the cat once auto-flip has run. */
type TtAlign = 'center' | 'left' | 'right';

/**
 * The cat window is a full-screen, transparent, click-through overlay. The cat
 * itself is a `.cat-container` moved *inside* it with GPU-accelerated CSS
 * transforms — Rust only schedules where/when to go (`cat-wander`) and the
 * browser tweens there smoothly. Two modes, owned by Rust and broadcast via
 * `mode-change`:
 *  - **roam** (default): overlay is click-through and the cat auto-wanders. The
 *    pointer handlers never fire.
 *  - **grab** (⌘⇧C / tray): Rust shrinks the window around the frozen cat and
 *    makes it interactive — hover shows the tooltip, drag moves it, a plain
 *    click opens details.
 */
export default function App() {
  const usage = useUsage();
  const { config } = useConfig();
  // Session-usage integration (opt-in): when live, nearing the 5-hour limit
  // tires the cat out. `usage.ok` gates it so a failed/unconfigured probe never
  // affects the mood.
  const session = useSessionUsage();
  const sessionPct = session.usage?.ok ? session.usage.session_pct : null;
  const { state, reason } = classifyWithReason(usage, config, sessionPct, session.rising);
  // One-shot usage reactions layered over the steady mood: a token burst gives
  // the cat the zoomies; a fresh 5-hour window gets a wake-up stretch.
  const reaction = useUsageReactions(usage, sessionPct, config.thresholds);
  // Celebrations: a tower tier-up throws confetti; a rapid-click streak on the
  // cat sets off a hidden party. Both render through the confetti/pose/bubble.
  const { celebration, party } = useCelebration(usage.tower_tier);
  // Cat-toned native heads-up when the session/weekly budget nears its cap.
  useSessionAlert(session.usage);
  // Social mode: publish our coarse status + render cats from clawd peers on
  // the LAN (empty unless opted in).
  usePresencePublish(config, state);
  const peers = usePeers();
  const [hover, setHover] = useState(false);
  // Tooltip placement, recomputed each time it's shown so it never clips out of
  // the (small, edge-clamped) grab window.
  const [ttAlign, setTtAlign] = useState<TtAlign>('center');
  const [ttBelow, setTtBelow] = useState(false);
  const [mode, setMode] = useState<Mode>('roam');
  const [gait, setGait] = useState<Gait>('idle');
  const [direction, setDirection] = useState<Direction>('right');
  const [placed, setPlaced] = useState(false);
  // Short-lived badge shown right after a mode switch.
  const [badge, setBadge] = useState<string | null>(null);
  // First-launch hint (bigger, self-dismissing).
  const [hint, setHint] = useState(false);

  // --- "Alive" flourishes + interactions ---
  // Yawn / stretch class currently applied (cleared after its duration).
  const [subEvent, setSubEvent] = useState<SubEventKind | null>(null);
  // Plaything the cat is reacting to, and a transient pounce on the catch.
  const [plaything, setPlaything] = useState<Plaything | null>(null);
  const [pounce, setPounce] = useState(false);
  // A piece of furniture the cat is currently visiting (fades in for the visit).
  const [furnitureVisit, setFurnitureVisit] = useState<FurnitureKind | null>(null);
  // Brief "spooked" beat when a plaything first appears (drives the startled pose).
  const [startled, setStartled] = useState(false);
  // Grab-mode petting: mouse held down on the cat → purr.
  const [holding, setHolding] = useState(false);
  // Greeting wiggle + bubble shown for the first few seconds each launch.
  const [greeting, setGreeting] = useState(true);
  // Feed reaction: sparkle at the bowl + a temporary content pose. `feedPhase`
  // sequences the expressive pose: tuck in and `eating`, then a short `purr`
  // afterglow before returning to normal.
  const [fed, setFed] = useState(false);
  const [feedPhase, setFeedPhase] = useState<'eating' | 'purr' | null>(null);

  const grab = mode === 'grab';
  const fishing = mode === 'fishing';

  const containerRef = useRef<HTMLDivElement>(null);
  const gaitTimer = useRef<number | null>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  // Fishing (teaser) play. The cursor is the *rod tip*; the feather hangs from
  // it on a string and trails/swings with spring physics, and the cat chases
  // the swinging feather. All moved imperatively each frame via these refs.
  const tipRef = useRef({ x: 0, y: 0 }); // rod tip = cursor
  const featherRef = useRef({ x: 0, y: 0 }); // dangling lure (lags the tip)
  const featherVelRef = useRef({ x: 0, y: 0 });
  const lureElRef = useRef<HTMLDivElement>(null);
  const rodStickRef = useRef<SVGLineElement>(null); // handle → tip
  const stringLineRef = useRef<SVGLineElement>(null); // tip → feather
  const fishRaf = useRef<number | null>(null);
  const lastPounce = useRef(0);
  // Hidden party easter egg: a burst of rapid clicks on the cat. A lone click
  // (>500ms since the last) still opens details; only quick repeats count as
  // "play" and are withheld from opening details.
  const lastClick = useRef(0);
  const rapidClicks = useRef(0);
  // The cat's current position within the window, mirrored for peer cats so a
  // visitor can drift over to play. Updated wherever we move the cat.
  const catXRef = useRef(0);
  const catYRef = useRef(0);

  // --- Movement primitives (imperative so React re-renders never clobber an
  // in-flight CSS transition; `transform` is never part of the JSX style). ---
  const clearGaitTimer = () => {
    if (gaitTimer.current !== null) {
      clearTimeout(gaitTimer.current);
      gaitTimer.current = null;
    }
  };

  const placeAt = (x: number, y: number) => {
    const el = containerRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    catXRef.current = x;
    catYRef.current = y;
    setPlaced(true);
    clearGaitTimer();
    setGait('idle');
  };

  const wanderTo = (ev: WanderEvent) => {
    const el = containerRef.current;
    if (!el) return;
    // Force the pending "none" transition to commit before swapping to the
    // timed one, so we always animate from the current spot.
    void el.offsetWidth;
    el.style.transition = `transform ${ev.duration_ms}ms ease-in-out`;
    el.style.transform = `translate3d(${ev.x}px, ${ev.y}px, 0)`;
    catXRef.current = ev.x;
    catYRef.current = ev.y;
    setDirection(ev.direction);
    setGait(ev.gait);
    setPlaced(true);
    clearGaitTimer();
    // Drop back to the idle pose when the hop finishes.
    gaitTimer.current = window.setTimeout(() => setGait('idle'), ev.duration_ms);
  };

  // Freeze the cat exactly where it is on screen, then let Rust shrink the
  // window around it. `getBoundingClientRect` gives the live, mid-transition
  // position (the container's base sits at the window origin).
  const freezeForGrab = () => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    clearGaitTimer();
    setGait('idle');
    invoke('enter_grab', { x: r.left, y: r.top }).catch(() => {});
  };

  // Initial paint: place the cat where Rust says it is.
  useEffect(() => {
    invoke<[number, number]>('get_cat_pos')
      .then(([x, y]) => placeAt(x, y))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Movement events from Rust.
  useEffect(() => {
    const unWander = listen<WanderEvent>('cat-wander', (e) => wanderTo(e.payload));
    const unPlace = listen<PlaceEvent>('cat-place', (e) => placeAt(e.payload.x, e.payload.y));
    return () => {
      unWander.then((off) => off());
      unPlace.then((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep in sync with Rust's mode. `mode-change` only fires on a real switch
  // (hotkey / tray / command), so every one gets a badge. On entering grab we
  // freeze the cat and hand its position to Rust to shrink the window.
  useEffect(() => {
    invoke<string>('get_mode')
      .then((m) => setMode(m === 'grab' ? 'grab' : m === 'fishing' ? 'fishing' : 'roam'))
      .catch(() => {});

    const unlisten = listen<string>('mode-change', (e) => {
      const next: Mode =
        e.payload === 'grab' ? 'grab' : e.payload === 'fishing' ? 'fishing' : 'roam';
      if (next === 'grab') freezeForGrab();
      setMode(next);
      setBadge(
        next === 'grab'
          ? '🖐️ 잡기 모드 ON'
          : next === 'fishing'
            ? '🎣 낚시대 놀이! (트레이에서 재클릭 시 종료)'
            : '🐾 놀기 모드',
      );
    });
    return () => {
      unlisten.then((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear the mode badge after a beat.
  useEffect(() => {
    if (!badge) return;
    const t = setTimeout(() => setBadge(null), 2500);
    return () => clearTimeout(t);
  }, [badge]);

  // Report the cat's mood to Rust so Roam mode can tune the wander liveliness.
  useEffect(() => {
    invoke('set_cat_state', { catState: state }).catch(() => {});
  }, [state]);

  // First-run hint: show once, for 5s, then remember we've shown it.
  useEffect(() => {
    if (localStorage.getItem(FIRST_RUN_KEY)) return;
    setHint(true);
    const t = setTimeout(() => {
      setHint(false);
      localStorage.setItem(FIRST_RUN_KEY, '1');
    }, 9000);
    return () => clearTimeout(t);
  }, []);

  // Greeting: wiggle + a "hi!" bubble for the first 4s of every launch (we
  // deliberately don't persist this — the cat is always glad to see you).
  useEffect(() => {
    const t = setTimeout(() => setGreeting(false), 4000);
    return () => clearTimeout(t);
  }, []);

  // Yawn / stretch flourishes scheduled by Rust. Apply the class for its
  // duration, then clear. A fresh event supersedes any in-flight one.
  useEffect(() => {
    let clear: number | null = null;
    const un = listen<SubEvent>('cat-sub-event', (e) => {
      if (clear !== null) clearTimeout(clear);
      setSubEvent(e.payload.kind);
      clear = window.setTimeout(() => setSubEvent(null), e.payload.duration_ms);
    });
    return () => {
      if (clear !== null) clearTimeout(clear);
      un.then((off) => off());
    };
  }, []);

  // Plaything: Rust sends where the toy appears + where it travels (the cat is
  // sent reacting via a parallel `cat-wander`). We just record it; the animation
  // lives in the effect below.
  useEffect(() => {
    let seq = 0;
    const un = listen<PlaythingEvent>('cat-plaything', (e) => {
      seq += 1;
      setPlaything({ ...e.payload, id: seq });
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  // Furniture visit: a prop fades in and the cat trots over (via a parallel
  // `cat-wander`) to play at it. Pounce on arrival, then fade the prop out.
  useEffect(() => {
    const timers: number[] = [];
    const un = listen<FurnitureEvent>('cat-furniture', (e) => {
      timers.forEach(clearTimeout);
      timers.length = 0;
      setFurnitureVisit(e.payload.kind);
      timers.push(
        window.setTimeout(() => {
          setPounce(true);
          window.setTimeout(() => setPounce(false), 420);
        }, Math.max(0, e.payload.arrive_ms)),
      );
      timers.push(window.setTimeout(() => setFurnitureVisit(null), e.payload.duration_ms));
    });
    return () => {
      timers.forEach(clearTimeout);
      un.then((off) => off());
    };
  }, []);

  // Feed reaction: sparkle the bowl + sequence eating → purr for a few seconds.
  useEffect(() => {
    const timers: number[] = [];
    const un = listen('feed-cat', () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
      setFed(true);
      setFeedPhase('eating');
      // Perk up into a content purr for the tail end of the reaction window.
      timers.push(window.setTimeout(() => setFeedPhase('purr'), FEED_REACT_MS - 1500));
      timers.push(
        window.setTimeout(() => {
          setFed(false);
          setFeedPhase(null);
        }, FEED_REACT_MS),
      );
    });
    return () => {
      timers.forEach(clearTimeout);
      un.then((off) => off());
    };
  }, []);

  // Drive the plaything across the screen: snap to its start, glide to the
  // target over `duration_ms`, then fade it out. The per-kind flourish (roll /
  // sway / dip / flutter) rides on the inner element via CSS. On "catch" the cat
  // pounces — except for the bird, which flies off out of reach.
  useEffect(() => {
    if (!plaything) return;
    // A quick spooked beat as the toy pops in, before the cat reacts.
    setStartled(true);
    const unspook = window.setTimeout(() => setStartled(false), 550);
    const el = flyRef.current;
    if (!el) {
      return () => clearTimeout(unspook);
    }
    el.style.transition = 'none';
    el.style.opacity = '1';
    el.style.transform = `translate3d(${plaything.x}px, ${plaything.y}px, 0)`;
    void el.offsetWidth; // commit the start before animating
    // Bird glides at a steady pace (linear) under its CSS dip; the others ease.
    const ease = plaything.kind === 'bird' ? 'linear' : 'ease-in-out';
    el.style.transition = `transform ${plaything.duration_ms}ms ${ease}, opacity 0.35s ease`;
    el.style.transform = `translate3d(${plaything.target_x}px, ${plaything.target_y}px, 0)`;

    const catchable = plaything.kind !== 'bird';
    const caught = window.setTimeout(() => {
      el.style.opacity = '0';
      if (catchable) {
        setPounce(true);
        window.setTimeout(() => setPounce(false), 450);
      }
    }, plaything.duration_ms);
    const gone = window.setTimeout(() => setPlaything(null), plaything.duration_ms + 400);
    return () => {
      clearTimeout(unspook);
      clearTimeout(caught);
      clearTimeout(gone);
    };
  }, [plaything]);

  // Petting: releasing the mouse anywhere ends the purr (a drag hands the
  // pointer to the OS, so the container's own pointerup may never fire).
  useEffect(() => {
    const end = () => setHolding(false);
    window.addEventListener('pointerup', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('blur', end);
    };
  }, []);

  // Grab mode owns interaction: leaving it clears any hover/hold artifacts.
  useEffect(() => {
    if (!grab) {
      setHolding(false);
      setHover(false);
    }
  }, [grab]);

  // Fishing play: the lure tracks the cursor and the cat eases after it every
  // frame; the tray toggle ends it. All movement is imperative so we never thrash React
  // with per-frame state (only direction/gait/pounce flips, which are rare).
  useEffect(() => {
    if (!fishing) return;
    // The string's rest length: the feather hangs this far below the rod tip.
    const STRING_LEN = 52;
    // Damped-spring constants for the trailing feather (tuned to swing, settle).
    const SPRING = 0.16;
    const DAMP = 0.8;

    // Start the tip near the cat and the feather hanging under it (no snap).
    tipRef.current = { x: catXRef.current + CAT_SIZE / 2, y: catYRef.current - 8 };
    featherRef.current = { x: tipRef.current.x, y: tipRef.current.y + STRING_LEN };
    featherVelRef.current = { x: 0, y: 0 };

    // The overlay is click-through, so the WebView never sees `pointermove`.
    // Rust polls the OS cursor at 60fps and hands us the window-local position
    // via `fishing-cursor`; that drives the rod tip. Other apps stay clickable.
    const unlisten = listen<[number, number]>('fishing-cursor', (e) => {
      tipRef.current = { x: e.payload[0], y: e.payload[1] };
    });

    const el = containerRef.current;
    if (el) el.style.transition = 'none'; // per-frame transform, no CSS tween

    let lastDir: Direction = direction;
    let lastGait: Gait = 'idle';

    const step = () => {
      const T = tipRef.current;
      // Feather hangs from the tip on a string: a damped spring toward the rest
      // point (straight below the tip) makes it trail and swing as the tip
      // moves, then settle when it stops — like a real teaser wand.
      const F = featherRef.current;
      const V = featherVelRef.current;
      V.x = (V.x + (T.x - F.x) * SPRING) * DAMP;
      V.y = (V.y + (T.y + STRING_LEN - F.y) * SPRING) * DAMP;
      F.x += V.x;
      F.y += V.y;

      // The cat chases the *feather* (not the cursor); sit just below it so it
      // reaches up at the dangling lure.
      const tx = F.x - CAT_SIZE / 2;
      const ty = F.y - CAT_SIZE * 0.28;
      const dx = tx - catXRef.current;
      const dy = ty - catYRef.current;
      catXRef.current = Math.max(0, Math.min(window.innerWidth - CAT_SIZE, catXRef.current + dx * 0.14));
      catYRef.current = Math.max(0, Math.min(window.innerHeight - CAT_SIZE, catYRef.current + dy * 0.14));
      if (el) {
        el.style.transform = `translate3d(${catXRef.current}px, ${catYRef.current}px, 0)`;
      }

      const dist = Math.hypot(dx, dy);
      const dir: Direction = dx < -2 ? 'left' : dx > 2 ? 'right' : lastDir;
      if (dir !== lastDir) {
        lastDir = dir;
        setDirection(dir);
      }
      const g: Gait = dist > 90 ? 'run' : dist > 18 ? 'walk' : 'idle';
      if (g !== lastGait) {
        lastGait = g;
        setGait(g);
      }
      // Bat at the feather once the cat has caught up, on a short cooldown.
      if (dist < 30) {
        const now = performance.now();
        if (now - lastPounce.current > 850) {
          lastPounce.current = now;
          setPounce(true);
          window.setTimeout(() => setPounce(false), 360);
        }
      }

      // Draw the rod (a stick held up-and-right of the tip) and the string
      // (tip → feather), and hang the feather at the string's end, tilted into
      // its swing so it never looks detached.
      rodStickRef.current?.setAttribute('x1', String(T.x + 58));
      rodStickRef.current?.setAttribute('y1', String(T.y - 44));
      rodStickRef.current?.setAttribute('x2', String(T.x));
      rodStickRef.current?.setAttribute('y2', String(T.y));
      stringLineRef.current?.setAttribute('x1', String(T.x));
      stringLineRef.current?.setAttribute('y1', String(T.y));
      stringLineRef.current?.setAttribute('x2', String(F.x));
      stringLineRef.current?.setAttribute('y2', String(F.y));
      if (lureElRef.current) {
        // Tie-on point is (22, 3) within the feather's own 44×48 box; tilt it
        // into its horizontal swing for a natural dangle.
        const tilt = Math.max(-32, Math.min(32, V.x * 3.5));
        lureElRef.current.style.transform = `translate3d(${F.x - 22}px, ${F.y - 3}px, 0) rotate(${tilt}deg)`;
      }

      fishRaf.current = requestAnimationFrame(step);
    };
    fishRaf.current = requestAnimationFrame(step);

    return () => {
      unlisten.then((off) => off());
      if (fishRaf.current !== null) cancelAnimationFrame(fishRaf.current);
      fishRaf.current = null;
      setGait('idle');
      setPounce(false);
      // Hand Rust the cat's final spot so wandering resumes from here
      // (the tray toggle-off clears `fishing`).
      invoke('report_cat_pos', { x: catXRef.current, y: catYRef.current }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fishing]);

  // Distinguish a click (open details) from a drag (move window).
  const down = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (fishing) return; // fishing owns the pointer (lure follows the cursor)
    down.current = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    // Holding still on the cat = petting → purr (until it turns into a drag).
    if (grab) setHolding(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (fishing || !down.current || dragged.current) return;
    const dx = Math.abs(e.clientX - down.current.x);
    const dy = Math.abs(e.clientY - down.current.y);
    if (dx + dy > 4) {
      dragged.current = true;
      setHolding(false); // it's a drag, not a pet
      // Hand the gesture to the OS window manager (moves the grab window).
      invoke('start_drag').catch(() => {});
    }
  };
  const onClick = () => {
    if (fishing) return; // clicks are part of play, not "open details"
    if (dragged.current) return; // it was a drag, not a click
    // Rapid-click easter egg: quick repeats are "play". The first click of a
    // burst still opens details; once a streak builds it sets off the party and
    // the streak clicks are withheld from re-opening details.
    const now = Date.now();
    const rapid = now - lastClick.current < 500;
    lastClick.current = now;
    if (rapid) {
      rapidClicks.current += 1;
      if (rapidClicks.current >= 4) {
        rapidClicks.current = 0;
        party();
      }
      return;
    }
    rapidClicks.current = 0;
    invoke('open_details').catch(() => {});
  };

  // Decide where the tooltip sits so it stays inside the window. The grab
  // window is small (≈300px) and gets clamped against the screen edge, so a
  // cat parked near an edge would push a centered tooltip off the window — we
  // flip it to hug whichever edge the cat is close to, and drop it below the
  // cat when there isn't room above.
  const onMouseEnter = () => {
    const el = containerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const catCenter = r.left + r.width / 2;
      const half = TOOLTIP_MAX / 2;
      const pad = 12;
      let align: TtAlign = 'center';
      if (catCenter + half > window.innerWidth - pad) align = 'right';
      else if (catCenter - half < pad) align = 'left';
      setTtAlign(align);
      setTtBelow(r.top < 96); // not enough headroom above → sit below the cat
    }
    setHover(true);
  };

  // Pose overrides: greet with a forward sit; a just-fed exhausted cat perks up
  // to a content sit for the reaction window. Otherwise show the real mood.
  const effectiveState: CatState =
    fishing || greeting || reaction || celebration || (fed && state === 'exhausted')
      ? 'playing'
      : state;

  // Expressive pose override — the new art (cream only). Priority, highest
  // first: petting/holding in grab → purr; then Roam flourishes. Each maps to a
  // dedicated sprite; `usePose` gates on the sprite actually existing so other
  // colors fall back to the legacy CSS flourish below instead of breaking.
  let overridePose: string | undefined;
  if (grab) {
    if (hover || holding) overridePose = 'happy_purr';
  } else if (celebration) {
    overridePose = 'happy_purr';
  } else if (pounce) {
    overridePose = 'playing_pounce';
  } else if (startled) {
    overridePose = 'startled';
  } else if (reaction === 'zoomies') {
    overridePose = 'playing_pounce';
  } else if (reaction === 'refresh') {
    overridePose = 'stretch';
  } else if (feedPhase) {
    overridePose = feedPhase === 'purr' ? 'happy_purr' : 'eating';
  } else if (subEvent && gait === 'idle') {
    overridePose = subEvent; // 'yawn' | 'stretch'
  }
  const usePose = !!overridePose && hasCatSprite(config.catColor, overridePose);

  // On-demand furniture: a prop appears only while its mood is active (keyed on
  // the *raw* mood so it lines up with `roam.rs`'s wander target), plus the bowl
  // during a feed reaction. Idle moods (playing/curious/active) show nothing.
  const visibleFurniture = new Set<FurnitureKind>();
  if (state === 'sleeping') visibleFurniture.add('cushion');
  if (state === 'alert' || state === 'angry') visibleFurniture.add('tower');
  if (state === 'exhausted' || fed) visibleFurniture.add('bowl');
  // A playful-mood furniture visit shows its prop transiently too.
  if (furnitureVisit) visibleFurniture.add(furnitureVisit);

  // FX layer classes — a flourish/interaction stack on the `.cat-fx` wrapper.
  // When an expressive pose is in play (`usePose`) the pose *is* the flourish,
  // so we skip the CSS squish transforms it replaces (pounce/pet/purr/yawn/
  // stretch) to avoid double-animating. If the pose sprite is missing (non-cream
  // colors) the CSS classes below still fire as the fallback. The greeting
  // wiggle is independent (it never sets an override) so it always applies.
  const fx = ['cat-fx'];
  if (greeting) fx.push('wiggle');
  if (!usePose) {
    if (pounce) fx.push('pounce');
    if (grab && hover) fx.push('pet');
    if (grab && holding) fx.push('purr');
    // Yawn/stretch only while resting in Roam (grab / motion would look wrong).
    if (subEvent && !grab && gait === 'idle') fx.push(subEvent);
  }

  // Shadow reacts to the gait (blurs + shrinks while airborne).
  const containerClass = [
    placed ? 'cat-container placed' : 'cat-container',
    gait === 'run' ? 'running' : gait === 'walk' ? 'walking' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={grab ? 'stage grab' : 'stage'}
      style={{ '--cat-scale': config.catScale } as CSSProperties}
    >
      {/* Decorative furniture row (Roam only — the grab window would clip it).
          Rendered before the cat so the cat always sits in front of its props. */}
      {!grab && !fishing && (
        <FurnitureBaseline
          color={config.catColor}
          visibleKinds={visibleFurniture}
          towerTier={usage.tower_tier}
        />
      )}

      {/* Visiting peer cats (social mode, Roam only). `peers` is empty unless a
          transport (LAN or remote room) is live, so this shows nothing for the
          default local setup and covers remote-only sessions too.
          `getSelf`/`selfPlayful` let a visitor drift over to play. */}
      {!grab && !fishing && (
        <PeerCats
          peers={peers}
          getSelf={() => ({ x: catXRef.current, y: catYRef.current })}
          selfPlayful={ACTIVITY_FOR_STATE[state] === 'light'}
        />
      )}

      {/* Plaything the cat reacts to (Roam only). The outer element is glided
          imperatively via flyRef; the inner element carries the per-kind CSS
          flourish (roll / sway / dip / flutter). */}
      {!grab && !fishing && plaything && (
        <div ref={flyRef} className="plaything" aria-hidden>
          <div
            className={`plaything-inner pt-${plaything.kind}${
              plaything.kind === 'ball' && plaything.target_x < plaything.x ? ' rev' : ''
            }`}
            // The bird's dip runs once across the whole flight.
            style={
              plaything.kind === 'bird'
                ? { animationDuration: `${plaything.duration_ms}ms` }
                : undefined
            }
          >
            {plaything.kind === 'butterfly' && <Butterfly />}
            {plaything.kind === 'ball' && <Ball />}
            {plaything.kind === 'yarn' && <Yarn />}
            {plaything.kind === 'bird' && <Bird />}
          </div>
        </div>
      )}

      {/* Feed sparkle at the bowl (Roam only). */}
      {!grab && !fishing && fed && (
        <div className="feed-sparkle" aria-hidden>
          <span>✨</span>
          <span>🍚</span>
          <span>✨</span>
        </div>
      )}

      {/* Usage reaction FX burst above the cat (Roam only): a token burst
          throws off zoomie dust; a fresh 5-hour window sparkles awake. */}
      {!grab && !fishing && reaction && (
        <div className={`react-fx react-${reaction}`} aria-hidden>
          {reaction === 'zoomies' ? (
            <>
              <span>💨</span>
              <span>🔥</span>
              <span>💨</span>
            </>
          ) : (
            <>
              <span>✨</span>
              <span>🌅</span>
              <span>✨</span>
            </>
          )}
        </div>
      )}

      {/* Celebration confetti (tower tier-up or the party easter egg). Shown in
          any mode — the party can be set off by clicking the cat in Grab. */}
      {celebration && (
        <div className={`confetti confetti-${celebration}`} aria-hidden>
          {['🎉', '🎊', '✨', celebration === 'milestone' ? '🏆' : '🎈', '⭐', '🎉'].map((c, i) => (
            <span key={i} style={{ '--i': i } as CSSProperties}>
              {c}
            </span>
          ))}
        </div>
      )}

      <div
        ref={containerRef}
        className={containerClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onMouseLeave={() => setHover(false)}
      >
        {/* First-run hint — a wider, friendlier tooltip that rides above the cat. */}
        <AnimatePresence>
          {hint && (
            <motion.div
              className="hint"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.25 }}
            >
              🐾 반가워냥! 트레이 아이콘에서 <b>낚시대 놀이</b>·<b>먹이 주기</b>로 놀아줘냥.
              <b>설정</b>에서 세션 사용량 연동도 켤 수 있다냥!
            </motion.div>
          )}
        </AnimatePresence>

        {/* Greeting bubble — every launch, unless the first-run hint is up. */}
        <AnimatePresence>
          {greeting && !hint && (
            <motion.div
              className="greet"
              initial={{ opacity: 0, y: 6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.9 }}
              transition={{ duration: 0.2 }}
            >
              반가워냥! 😺
            </motion.div>
          )}
        </AnimatePresence>

        {/* Usage reaction bubble — token burst / fresh session window. */}
        <AnimatePresence>
          {reaction && !greeting && (
            <motion.div
              className="react-bubble"
              initial={{ opacity: 0, y: 6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.9 }}
              transition={{ duration: 0.2 }}
            >
              {reaction === 'zoomies' ? '🔥 폭주 냥!' : '✨ 새 세션이다냥!'}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Celebration bubble — tower tier-up or the party easter egg. */}
        <AnimatePresence>
          {celebration && !greeting && (
            <motion.div
              className="react-bubble"
              initial={{ opacity: 0, y: 6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.9 }}
              transition={{ duration: 0.2 }}
            >
              {celebration === 'milestone' ? '🏆 타워 진화다냥!' : '🎉 파티다냥!'}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mode-switch badge. */}
        <AnimatePresence>
          {badge && (
            <motion.div
              className="badge"
              initial={{ opacity: 0, y: -6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.9 }}
              transition={{ duration: 0.2 }}
            >
              {badge}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Stats tooltip — hover in Grab mode. */}
        <AnimatePresence>
          {hover && grab && (
            <motion.div
              className={`tooltip tt-${ttAlign}${ttBelow ? ' tt-below' : ''}`}
              // Fade only — animating transform here would clobber the CSS
              // `translateX(-50%)` that centers the tooltip.
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="tt-title">{STATE_LABEL[state]}</div>
              <div className="tt-row">오늘 {formatTokens(usage.today_tokens)} tokens</div>
              <div className="tt-row dim">
                rate {formatRate(usage.rate_per_min)} · 오늘 {formatTokens(usage.today_tokens)}
              </div>
              <div className="tt-row dim">이유: {reason}</div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {grab && (
            <motion.div
              className="grab-ring"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.2 }}
            />
          )}
        </AnimatePresence>

        {/* The cat itself — flips to face its travel direction. The `.cat-fx`
            wrapper carries the flourish/interaction transforms (yawn, stretch,
            purr, pounce, greeting wiggle, pet squish) so they never collide
            with the flip or the resting breathing. */}
        <div className={direction === 'left' ? 'cat-flip flip' : 'cat-flip'}>
          <div className={fx.join(' ')}>
            <Cat
              state={effectiveState}
              gait={gait}
              color={config.catColor}
              pose={usePose ? overridePose : undefined}
            />
          </div>
        </div>
      </div>

      {/* Fishing (teaser) play: a string from the corner to a lure that tracks
          the cursor. Purely visual — movement is driven imperatively by the rAF
          loop above; the cursor position arrives via Rust's `fishing-cursor`
          poll (the overlay stays click-through, so no pointer events here). */}
      {fishing && (
        <div className="fishing-layer" aria-hidden>
          <svg className="fishing-string" width="100%" height="100%">
            {/* Rod stick (handle → tip) and the string (tip → feather). Both are
                positioned every frame by the rAF loop. */}
            <line
              ref={rodStickRef}
              x1={0}
              y1={0}
              x2={0}
              y2={0}
              stroke="#7c5a34"
              strokeWidth={4}
              strokeLinecap="round"
            />
            <line
              ref={stringLineRef}
              x1={0}
              y1={0}
              x2={0}
              y2={0}
              stroke="rgba(90,75,60,0.6)"
              strokeWidth={1.4}
            />
          </svg>
          <div className="lure" ref={lureElRef}>
            <FishingRod />
          </div>
          <div className="fishing-hint">
            🎣 마우스로 낚싯대를 움직여 고양이랑 놀아주세요 · 트레이 메뉴에서 <b>🎣 낚시대 놀이</b> 재클릭으로 종료
          </div>
        </div>
      )}
    </div>
  );
}
