import { CatState } from '../../types';
import './cat.css';

/** How the cat is moving right now — drives the walk/run/jitter animations. */
export type Gait = 'idle' | 'walk' | 'run' | 'jitter';

/**
 * Hand-drawn-ish pastel cat, one SVG parametrized by mood. Base anatomy (body,
 * head, ears, nose, whiskers, tail) is shared; eyes / brows / mouth / a small
 * accessory (zzz, sparkle, "!", sweat…) swap per state. Idle motion —
 * breathing, tail wag, whisker twitch — is CSS in cat.css, keyed off the
 * `state-<mood>` class so busier moods animate faster.
 *
 * When it's on the move, the `gait-<walk|run|jitter>` class layers a body bob,
 * alternating paw steps, and a livelier tail on top; `idle` falls back to the
 * resting breathe/wag.
 *
 * This is a first-draft doodle: playing / alert / angry read clearly; the other
 * four are recognizable variations on the same rig. The gait animations are
 * likewise an initial pass.
 */
export function Cat({ state, gait = 'idle' }: { state: CatState; gait?: Gait }) {
  return (
    <svg
      className={`cat state-${state} gait-${gait}`}
      viewBox="0 0 120 134"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`cat: ${state}`}
    >
      {/* ---- Tail (own group so it can wag independently) ---- */}
      <g className="cat-tail">
        <path
          className="fur-line"
          d="M86,116 C112,114 116,86 100,80 C112,90 104,104 86,106 Z"
        />
      </g>

      <g className="cat-breathe">
        {/* ---- Body ---- */}
        <path
          className="fur-line"
          d="M34,122 C28,86 40,72 60,72 C80,72 92,86 86,122 Z"
        />
        {/* front paws — step alternately while walking / running */}
        <ellipse className="fur-line paw paw-l" cx="49" cy="123" rx="9" ry="6" />
        <ellipse className="fur-line paw paw-r" cx="71" cy="123" rx="9" ry="6" />

        {/* ---- Ears ---- */}
        <g className="cat-ears">
          <path className="fur-line" d="M39,40 L34,12 L58,32 Z" />
          <path className="fur-line" d="M81,40 L86,12 L62,32 Z" />
          <path className="ear-inner" d="M41,37 L38,20 L52,32 Z" />
          <path className="ear-inner" d="M79,37 L82,20 L68,32 Z" />
        </g>

        {/* ---- Head ---- */}
        <circle className="fur-line" cx="60" cy="56" r="30" />

        {/* cheeks blush (angry / exhausted highlight it) */}
        <circle className="cheek" cx="43" cy="64" r="5" />
        <circle className="cheek" cx="77" cy="64" r="5" />

        {/* ---- Whiskers ---- */}
        <g className="cat-whiskers">
          <line className="whisker" x1="40" y1="60" x2="20" y2="56" />
          <line className="whisker" x1="40" y1="64" x2="20" y2="66" />
          <line className="whisker" x1="80" y1="60" x2="100" y2="56" />
          <line className="whisker" x1="80" y1="64" x2="100" y2="66" />
        </g>

        {/* ---- Nose ---- */}
        <path className="nose" d="M56,62 L64,62 L60,67 Z" />

        {/* ---- Eyes / brows / mouth per state ---- */}
        <Face state={state} />
      </g>

      {/* ---- Accessory glyphs ---- */}
      <Accessory state={state} />
    </svg>
  );
}

function Face({ state }: { state: CatState }) {
  switch (state) {
    case 'playing':
      return (
        <>
          {/* happy closed eyes (^ ^) */}
          <path className="eye-line" d="M44,52 q6,-7 12,0" />
          <path className="eye-line" d="M64,52 q6,-7 12,0" />
          {/* content smile + tongue */}
          <path className="mouth-line" d="M54,68 q6,6 12,0" />
        </>
      );
    case 'curious':
      return (
        <>
          <Eye cx={50} cy={52} r={7} />
          <Eye cx={70} cy={52} r={7} />
          {/* small 'o' */}
          <circle className="mouth-line no-fill" cx="60" cy="70" r="2.5" />
        </>
      );
    case 'active':
      return (
        <>
          <Eye cx={50} cy={52} rx={6} ry={7} />
          <Eye cx={70} cy={52} rx={6} ry={7} />
          <path className="mouth-line" d="M55,69 q5,4 10,0" />
        </>
      );
    case 'alert':
      return (
        <>
          {/* raised brows */}
          <line className="brow" x1="43" y1="41" x2="55" y2="44" />
          <line className="brow" x1="77" y1="41" x2="65" y2="44" />
          {/* big wide eyes */}
          <Eye cx={50} cy={53} r={8.5} />
          <Eye cx={70} cy={53} r={8.5} />
          {/* small open mouth */}
          <ellipse className="mouth-open" cx="60" cy="70" rx="3.5" ry="4.5" />
        </>
      );
    case 'angry':
      return (
        <>
          {/* angled angry brows */}
          <line className="brow angry" x1="42" y1="43" x2="56" y2="49" />
          <line className="brow angry" x1="78" y1="43" x2="64" y2="49" />
          {/* narrowed slanted eyes */}
          <path className="eye-line thick" d="M44,54 L57,51" />
          <path className="eye-line thick" d="M76,54 L63,51" />
          {/* hissing open mouth with fangs */}
          <path className="mouth-open fill" d="M50,66 Q60,64 70,66 Q64,78 60,78 Q56,78 50,66 Z" />
          <path className="fang" d="M54,67 L57,72 L59,67 Z" />
          <path className="fang" d="M61,67 L63,72 L66,67 Z" />
        </>
      );
    case 'exhausted':
      return (
        <>
          {/* >< tired eyes */}
          <path className="eye-line thick" d="M45,49 L53,53 L45,57" />
          <path className="eye-line thick" d="M75,49 L67,53 L75,57" />
          {/* panting mouth */}
          <ellipse className="mouth-open" cx="60" cy="70" rx="3" ry="4" />
        </>
      );
    case 'sleeping':
    default:
      return (
        <>
          {/* closed sleepy eyes (downward arcs) */}
          <path className="eye-line" d="M44,53 q6,6 12,0" />
          <path className="eye-line" d="M64,53 q6,6 12,0" />
          <path className="mouth-line" d="M57,68 q3,2 6,0" />
        </>
      );
  }
}

/** Round or oval eye with a catchlight. */
function Eye({
  cx,
  cy,
  r,
  rx,
  ry,
}: {
  cx: number;
  cy: number;
  r?: number;
  rx?: number;
  ry?: number;
}) {
  return (
    <g>
      <ellipse className="eye" cx={cx} cy={cy} rx={rx ?? r} ry={ry ?? r} />
      <circle className="eye-light" cx={cx + (rx ?? r ?? 6) * 0.35} cy={cy - (ry ?? r ?? 6) * 0.35} r={1.8} />
    </g>
  );
}

function Accessory({ state }: { state: CatState }) {
  switch (state) {
    case 'sleeping':
      return (
        <g className="zzz">
          <text x="92" y="34" className="glyph">z</text>
          <text x="100" y="24" className="glyph small">z</text>
          <text x="106" y="16" className="glyph tiny">z</text>
        </g>
      );
    case 'playing':
      return (
        <g className="sparkle">
          <path className="glyph-fill spark" d="M96,30 l2,6 l6,2 l-6,2 l-2,6 l-2,-6 l-6,-2 l6,-2 Z" />
        </g>
      );
    case 'curious':
      return (
        <text x="94" y="30" className="glyph pop question">?</text>
      );
    case 'alert':
      return (
        <text x="96" y="30" className="glyph pop bang">!</text>
      );
    case 'exhausted':
      return (
        <g className="sweat">
          <path className="drop" d="M88,44 C88,40 92,38 92,44 A2,2 0 1 1 88,44 Z" />
        </g>
      );
    default:
      return null;
  }
}
