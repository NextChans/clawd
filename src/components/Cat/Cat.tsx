import { useEffect, useState } from 'react';
import { CatColor, CatState } from '../../types';
import { CatSvg, type Gait } from './CatSvg';
import './cat.css';

export type { Gait };

// Per-frame dwell time (ms) for the walk/run flip. Half the old CSS cycle
// (0.5s walk / 0.3s run) so the visible cadence matches the previous version.
const FRAME_MS = { walk: 250, run: 150 } as const;

/**
 * The cat renderer. Prefers generated **PNG sprites** dropped into
 * `src/assets/cat/<color>/<pose>.png`, and falls back to the vector {@link
 * CatSvg} for any color+pose whose sprite isn't present yet — so the app runs
 * before the art arrives and degrades gracefully if a file is missing.
 *
 * Poses map 1:1 to CatSvg's postures (so the fallback shows the *same* pose):
 * walking/running flip between two frames (`*_a` / `*_b`) by swapping the *only*
 * rendered `<img>` on a timer — never stacking both, so the frames can't bleed
 * through each other's transparent regions. Everything else is a single still.
 * The container flips via `scaleX(-1)` from App.tsx when the cat heads left, so
 * sprites are authored facing **right**.
 */
export function Cat({
  state,
  gait = 'idle',
  color = 'cream',
}: {
  state: CatState;
  gait?: Gait;
  color?: CatColor;
}) {
  const poses = posesFor(state, gait);
  const frames = Array.isArray(poses) ? poses : [poses];
  const urls = frames.map((p) => spriteUrl(color, p));
  const twoFrame = urls.length === 2;

  // Which of the two frames is currently shown. Only meaningful when twoFrame.
  const [frameIdx, setFrameIdx] = useState(0);

  // Drive the flip with a timer that renders one frame at a time. Reset to
  // frame 0 and (re)arm whenever the animation identity changes so switching
  // walk→run (or leaving a moving state) starts clean; the cleanup clears the
  // interval on every change/unmount, so React strict-mode's double invoke
  // and later state changes never leave a stray timer running.
  const dur = twoFrame ? (gait === 'run' ? FRAME_MS.run : FRAME_MS.walk) : 0;
  const [a, b] = urls;
  useEffect(() => {
    if (!twoFrame) return;
    setFrameIdx(0);
    // Preload both frames so the first swap doesn't flash an unpainted image.
    [a, b].forEach((u) => {
      if (u) {
        const img = new Image();
        img.src = u;
      }
    });
    // Honor reduced-motion: hold on a single frame, no timer.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setFrameIdx((i) => 1 - i), dur);
    return () => clearInterval(id);
  }, [twoFrame, dur, a, b]);

  // Any missing frame → render the vector cat instead (keeps the same pose).
  if (urls.some((u) => !u)) {
    return <CatSvg state={state} gait={gait} color={color} />;
  }

  const src = twoFrame ? urls[frameIdx] : urls[0];
  return (
    <div className="cat-img" role="img" aria-label={`cat: ${state}`}>
      <img className="frame" src={src} alt="" draggable={false} />
    </div>
  );
}

/**
 * Pose selection — mirrors {@link CatSvg}'s `poseFor` exactly so switching
 * between PNG and the vector fallback never changes which pose is shown.
 * Moving (roam gait) wins; otherwise the mood picks a resting pose, with the
 * calm moods (playing / curious / active) sharing the forward-facing `sit`.
 */
function posesFor(state: CatState, gait: Gait): string | [string, string] {
  if (gait === 'walk') return ['walk_right_a', 'walk_right_b'];
  if (gait === 'run') return ['run_right_a', 'run_right_b'];
  // idle / jitter → resting pose by mood
  switch (state) {
    case 'sleeping':
      return 'sleep_curled';
    case 'exhausted':
      return 'exhausted_lie';
    case 'alert':
      return 'alert_arched';
    case 'angry':
      return 'angry_hiss';
    default:
      return 'sit_forward';
  }
}

// Eagerly resolve every sprite that actually exists on disk to its URL. Files
// that haven't been added yet simply aren't in the map (→ fallback). Vite
// inlines this at build time; adding PNGs later is picked up on rebuild / HMR.
const SPRITES = import.meta.glob('../../assets/cat/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function spriteUrl(color: CatColor, pose: string): string | undefined {
  return SPRITES[`../../assets/cat/${color}/${pose}.png`];
}
