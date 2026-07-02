import { CatState } from '../../types';
import './cat.css';

/** How the cat is moving right now — drives the walk/run/jitter animations. */
export type Gait = 'idle' | 'walk' | 'run' | 'jitter';

/** The drawn posture. Derived from `state` + `gait` by {@link poseFor}. */
type Pose = 'sit' | 'stand' | 'sleep' | 'alert' | 'angry' | 'exhausted';

/**
 * Side-view pastel cat, drawn facing **right** (App flips the container with
 * `scaleX(-1)` when it heads left). One SVG, six postures:
 *
 *  - `sit`   — calm resting pose (playing / curious / active while standing still)
 *  - `stand` — a four-legged standing rig used for both walk & run; the gait
 *              class in cat.css swings the legs (diagonal pairs) and bobs the
 *              body, faster/bigger for `run`.
 *  - `sleep` — curled loaf, head down, tail wrapped, eye shut
 *  - `alert` — arched back, ears back, puffed tail, wide eye
 *  - `angry` — higher arch, hiss + fangs, max-puffed tail
 *  - `exhausted` — flopped forward, tongue out, drooped tail
 *
 * Anatomy is a set of primitives (body path, capsule legs, circle head, triangle
 * ears, a stroked tail) so the profile stays predictable. Idle motion (breathe,
 * tail wag, whisker twitch) and gait motion live in cat.css, keyed off the
 * `state-<mood>` / `pose-<name>` / `gait-<name>` classes.
 *
 * This is a hand-authored doodle: the profile silhouette reads clearly and the
 * gaits are believable, but it's still a stylized first pass — not a polished
 * character sheet.
 */
export function Cat({ state, gait = 'idle' }: { state: CatState; gait?: Gait }) {
  const pose = poseFor(state, gait);
  return (
    <svg
      className={`cat state-${state} pose-${pose} gait-${gait}`}
      viewBox="0 0 200 160"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`cat: ${state}`}
    >
      <Body pose={pose} state={state} />
      <Accessory state={state} pose={pose} />
    </svg>
  );
}

/** Standing still → the state's resting pose; moving → the shared walk/run rig. */
function poseFor(state: CatState, gait: Gait): Pose {
  if (gait === 'walk' || gait === 'run') return 'stand';
  switch (state) {
    case 'sleeping':
      return 'sleep';
    case 'exhausted':
      return 'exhausted';
    case 'alert':
      return 'alert';
    case 'angry':
      return 'angry';
    default:
      return 'sit'; // playing / curious / active, at rest
  }
}

// ---------------------------------------------------------------------------
// Shared anatomy pieces (facing right)
// ---------------------------------------------------------------------------

/** Two upright ears on top of a head centered at (cx, cy). */
function Ears({ cx, cy }: { cx: number; cy: number }) {
  // Offsets from head centre for the back (left) and front (right) ear.
  return (
    <>
      <path className="fur-line" d={`M${cx - 17},${cy - 18} L${cx - 23},${cy - 44} L${cx + 1},${cy - 26} Z`} />
      <path className="fur-line" d={`M${cx + 4},${cy - 24} L${cx + 22},${cy - 46} L${cx + 26},${cy - 20} Z`} />
      <path className="ear-inner" d={`M${cx - 13},${cy - 22} L${cx - 16},${cy - 37} L${cx - 2},${cy - 26} Z`} />
      <path className="ear-inner" d={`M${cx + 7},${cy - 25} L${cx + 19},${cy - 39} L${cx + 22},${cy - 24} Z`} />
    </>
  );
}

/** Upright head (ears, muzzle, nose, whiskers) centered at (cx, cy). */
function Head({ cx, cy, r = 25 }: { cx: number; cy: number; r?: number }) {
  return (
    <>
      <Ears cx={cx} cy={cy} />
      <circle className="fur-line" cx={cx} cy={cy} r={r} />
      <ellipse className="muzzle" cx={cx + 20} cy={cy + 8} rx={13} ry={11} />
      <path className="nose" d={`M${cx + 30},${cy + 4} l6,4 l-6,4 Z`} />
      <g className="cat-whiskers">
        <path className="whisker" d={`M${cx + 22},${cy + 6} L${cx + 46},${cy}`} />
        <path className="whisker" d={`M${cx + 22},${cy + 10} L${cx + 46},${cy + 12}`} />
      </g>
    </>
  );
}

/** Open eye with a catchlight. */
function EyeOpen({ cx, cy, r = 4.5 }: { cx: number; cy: number; r?: number }) {
  return (
    <>
      <ellipse className="eye" cx={cx} cy={cy} rx={r} ry={r + 1} />
      <circle className="eye-light" cx={cx + 2} cy={cy - 2} r={1.7} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Poses
// ---------------------------------------------------------------------------

function Body({ pose, state }: { pose: Pose; state: CatState }) {
  switch (pose) {
    case 'stand':
      return <Stand state={state} />;
    case 'sleep':
      return <Sleep />;
    case 'alert':
      return <Alert />;
    case 'angry':
      return <Angry />;
    case 'exhausted':
      return <Exhausted />;
    case 'sit':
    default:
      return <Sit state={state} />;
  }
}

/** Seated: rounded rear, chest rising to the head; one front leg + paw. */
function Sit({ state }: { state: CatState }) {
  return (
    <>
      <g className="cat-tail">
        <path className="tail-line" d="M50,124 C24,124 20,88 40,82" />
      </g>
      <rect className="leg far" x="98" y="112" width="12" height="30" rx="5" />
      <g className="cat-breathe">
        <path
          className="fur-line"
          d="M46,142 C34,108 44,80 74,78 C104,76 120,94 120,116 C120,124 116,126 110,124 C104,110 94,108 84,116 C74,124 68,134 66,142 Z"
        />
      </g>
      <rect className="leg" x="108" y="112" width="13" height="30" rx="6" />
      <ellipse className="leg" cx="114" cy="140" rx="9" ry="5" />
      <Head cx={140} cy={64} />
      <EyeOpen cx={147} cy={60} />
      <Mouth state={state} cx={140} />
    </>
  );
}

/** Four-legged standing rig, shared by walk & run (gait class animates it). */
function Stand({ state }: { state: CatState }) {
  return (
    <>
      <g className="cat-tail">
        <path className="tail-line" d="M48,104 C24,100 22,72 40,66" />
      </g>
      {/* Everything but the tail bobs together as one body during the gait. */}
      <g className="cat-move">
        {/* far side legs (behind the body) */}
        <rect className="leg far leg-a" x="60" y="112" width="11" height="30" rx="5" />
        <rect className="leg far leg-b" x="118" y="112" width="11" height="30" rx="5" />
        <g className="cat-breathe">
          <path
            className="fur-line"
            d="M44,116 C38,86 58,74 96,74 C132,74 150,84 150,104 C150,120 138,124 120,124 L70,124 C56,124 48,124 44,116 Z"
          />
        </g>
        {/* near side legs (in front of the body) */}
        <rect className="leg leg-b" x="52" y="114" width="12" height="30" rx="5" />
        <rect className="leg leg-a" x="126" y="114" width="12" height="30" rx="5" />
        <Head cx={150} cy={64} />
        <EyeOpen cx={157} cy={60} />
        <Mouth state={state} cx={150} />
      </g>
    </>
  );
}

/** Curled sleeping loaf, head resting left, tail wrapped around the front. */
function Sleep() {
  return (
    <>
      <g className="cat-breathe cat-breathe-loaf">
        <ellipse className="fur-line" cx="102" cy="118" rx="64" ry="27" />
      </g>
      <g className="cat-tail">
        <path className="tail-line" d="M150,126 C168,120 168,138 150,140 C120,144 96,144 82,138" />
      </g>
      <circle className="fur-line" cx="56" cy="112" r="24" />
      <path className="fur-line" d="M40,96 L34,74 L58,90 Z" />
      <path className="fur-line" d="M62,90 L80,72 L84,96 Z" />
      <path className="ear-inner" d="M44,92 L41,79 L54,90 Z" />
      <path className="ear-inner" d="M65,90 L77,78 L80,94 Z" />
      <path className="eye-line" d="M42,112 q6,5 12,0" />
      <ellipse className="muzzle" cx="40" cy="118" rx="10" ry="8" />
      <path className="nose" d="M32,114 l-5,4 l5,4 Z" />
    </>
  );
}

/** Arched back, ears laid back, puffed tail, wide startled eye. */
function Alert() {
  return (
    <>
      <g className="cat-tail cat-tail-puff">
        <path className="tail-line puff" d="M50,92 C30,70 34,44 50,38" />
      </g>
      <rect className="leg far" x="58" y="112" width="11" height="30" rx="5" />
      <rect className="leg far" x="120" y="112" width="11" height="30" rx="5" />
      <g className="cat-breathe">
        <path
          className="fur-line"
          d="M46,120 C34,78 60,58 96,58 C132,58 150,80 148,112 C147,122 136,124 118,124 L72,124 C56,124 50,124 46,120 Z"
        />
      </g>
      <rect className="leg" x="52" y="114" width="12" height="30" rx="5" />
      <rect className="leg" x="126" y="114" width="12" height="30" rx="5" />
      {/* ears swept back */}
      <path className="fur-line" d="M134,52 L120,34 L150,42 Z" />
      <path className="fur-line" d="M156,44 L176,34 L168,52 Z" />
      <circle className="fur-line" cx="152" cy="60" r="24" />
      <ellipse className="muzzle" cx="171" cy="68" rx="12" ry="10" />
      <path className="nose" d="M181,64 l6,4 l-6,4 Z" />
      <EyeOpen cx={158} cy={55} r={6} />
      <ellipse className="mouth-open" cx="172" cy="80" rx="3.5" ry="4.5" />
    </>
  );
}

/** Higher arch, hissing mouth with fangs, angry brow, max-puffed tail. */
function Angry() {
  return (
    <>
      <g className="cat-tail cat-tail-puff">
        <path className="tail-line puff-max" d="M50,90 C26,66 32,38 50,32" />
      </g>
      <rect className="leg far" x="58" y="112" width="11" height="30" rx="5" />
      <rect className="leg far" x="120" y="112" width="11" height="30" rx="5" />
      <g className="cat-breathe">
        <path
          className="fur-line"
          d="M44,120 C30,74 58,52 96,52 C134,52 152,78 150,112 C149,122 138,124 118,124 L72,124 C54,124 48,124 44,120 Z"
        />
      </g>
      <rect className="leg" x="52" y="114" width="12" height="30" rx="5" />
      <rect className="leg" x="126" y="114" width="12" height="30" rx="5" />
      <path className="fur-line" d="M136,54 L124,40 L152,46 Z" />
      <path className="fur-line" d="M158,48 L178,42 L166,56 Z" />
      <circle className="fur-line" cx="152" cy="60" r="24" />
      <ellipse className="muzzle" cx="171" cy="70" rx="12" ry="10" />
      <path className="nose" d="M181,64 l6,4 l-6,4 Z" />
      <line className="brow angry" x1="146" y1="48" x2="160" y2="53" />
      <path className="eye-line thick" d="M150,58 L162,55" />
      <path className="mouth-open fill" d="M166,74 Q176,72 184,76 Q178,86 172,86 Q168,84 166,74 Z" />
      <path className="fang" d="M170,75 l2,5 l2,-5 Z" />
      <path className="fang" d="M177,76 l2,5 l2,-5 Z" />
    </>
  );
}

/** Flopped forward, forelegs splayed out front, tongue lolling, tail drooped. */
function Exhausted() {
  return (
    <>
      <g className="cat-tail">
        <path className="tail-line" d="M40,128 C16,132 12,120 26,116" />
      </g>
      <g className="cat-breathe cat-breathe-loaf">
        <ellipse className="fur-line" cx="96" cy="126" rx="60" ry="20" />
      </g>
      <rect className="leg" x="70" y="128" width="30" height="11" rx="5" />
      <rect className="leg" x="106" y="128" width="30" height="11" rx="5" />
      <circle className="fur-line" cx="150" cy="104" r="23" />
      <path className="fur-line" d="M134,86 L128,66 L152,80 Z" />
      <path className="fur-line" d="M156,82 L174,64 L178,88 Z" />
      <ellipse className="muzzle" cx="169" cy="110" rx="12" ry="10" />
      <path className="nose" d="M179,106 l6,4 l-6,4 Z" />
      <path className="eye-line thick" d="M150,100 L160,104 L150,108" />
      <path className="tongue" d="M180,112 q6,6 2,12 q-4,-2 -4,-8 Z" />
    </>
  );
}

/** Small mouth line under the muzzle for the calm/standing poses. */
function Mouth({ state, cx }: { state: CatState; cx: number }) {
  // A soft content curve; `playing` gets a happier upturn.
  const y = 78;
  const x = cx + 40;
  if (state === 'playing') {
    return <path className="mouth-line" d={`M${x},${y} q-6,7 -13,2`} />;
  }
  return <path className="mouth-line" d={`M${x},${y} q-6,5 -12,2`} />;
}

// ---------------------------------------------------------------------------
// Accessory glyphs — floated near the head, position depends on the pose.
// ---------------------------------------------------------------------------

function Accessory({ state, pose }: { state: CatState; pose: Pose }) {
  switch (state) {
    case 'sleeping':
      // Head is on the left in the sleep loaf; zzz drift up from it.
      return (
        <g className="zzz">
          <text x="78" y="84" className="glyph">z</text>
          <text x="88" y="72" className="glyph small">z</text>
          <text x="96" y="62" className="glyph tiny">z</text>
        </g>
      );
    case 'playing':
      return (
        <g className="sparkle">
          <path className="glyph-fill spark" d="M176,26 l2,6 l6,2 l-6,2 l-2,6 l-2,-6 l-6,-2 l6,-2 Z" />
        </g>
      );
    case 'curious':
      return (
        <text x="176" y="30" className="glyph pop question">?</text>
      );
    case 'alert':
      return (
        <text x="180" y="30" className="glyph pop bang">!</text>
      );
    case 'exhausted':
      return (
        <g className="sweat">
          <path className="drop" d={pose === 'exhausted' ? 'M138,84 C138,80 142,78 142,84 A2,2 0 1 1 138,84 Z' : 'M138,44 C138,40 142,38 142,44 A2,2 0 1 1 138,44 Z'} />
        </g>
      );
    default:
      return null;
  }
}
