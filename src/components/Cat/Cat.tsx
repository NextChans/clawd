import { CatColor, CatState } from '../../types';
import { CatSvg, type Gait } from './CatSvg';
import './cat.css';

export type { Gait };

/**
 * The cat renderer. Prefers generated **PNG sprites** dropped into
 * `src/assets/cat/<color>/<pose>.png`, and falls back to the vector {@link
 * CatSvg} for any color+pose whose sprite isn't present yet — so the app runs
 * before the art arrives and degrades gracefully if a file is missing.
 *
 * Poses map 1:1 to CatSvg's postures (so the fallback shows the *same* pose):
 * walking/running use a two-frame flip (`*_a` / `*_b`) animated by opacity;
 * everything else is a single still. The container flips via `scaleX(-1)` from
 * App.tsx when the cat heads left, so sprites are authored facing **right**.
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

  // Any missing frame → render the vector cat instead (keeps the same pose).
  if (urls.some((u) => !u)) {
    return <CatSvg state={state} gait={gait} color={color} />;
  }

  if (urls.length === 2) {
    const speed = gait === 'run' ? 'speed-fast' : 'speed-walk';
    return (
      <div className={`cat-img two-frame ${speed}`} role="img" aria-label={`cat: ${state}`}>
        <img className="frame frame-a" src={urls[0]} alt="" draggable={false} />
        <img className="frame frame-b" src={urls[1]} alt="" draggable={false} />
      </div>
    );
  }

  return (
    <div className="cat-img" role="img" aria-label={`cat: ${state}`}>
      <img className="frame" src={urls[0]} alt="" draggable={false} />
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
