import { CatColor, CatState } from '../../types';
import './cat.css';

/** How the cat is moving right now — drives the walk/run/jitter animations. */
export type Gait = 'idle' | 'walk' | 'run' | 'jitter';

/** The drawn posture. Derived from `state` + `gait` by {@link poseFor}. */
type Pose = 'sit' | 'stand' | 'sleep' | 'alert' | 'angry' | 'exhausted';

/**
 * Chunky, thick-line "sticker" cat — pastel fills, big eyes, pink cheeks. The
 * viewpoint is chosen per pose for the most natural read (an idle cat faces you;
 * a moving one is drawn in profile):
 *
 *  - `sit`   — **front view**, sitting and looking at you (playing / curious /
 *              active while still); the face varies by mood.
 *  - `stand` — **side profile**, an elongated loaf shared by walk & run; the
 *              gait class in cat.css swings the legs (diagonal pairs), bobs the
 *              body, and streams the tail back for a run.
 *  - `sleep` — curled loaf, eyes shut, tail wrapped
 *  - `alert` — arched back, ears back, puffed tail, wide eye (profile)
 *  - `angry` — higher arch, hiss + fang, max-puffed tail (profile)
 *  - `exhausted` — flopped on its side, tongue out, drooped tail
 *
 * Coat color is a set of CSS custom properties on `.cat`, switched by the
 * `color-<name>` class (see cat.css). Tabbies (orange / gray) reveal a stripe
 * layer that's hidden for the solid colors. viewBox is per-pose so each
 * viewpoint gets a sensible aspect ratio inside the square window.
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
  const pose = poseFor(state, gait);
  return (
    <svg
      className={`cat color-${color} state-${state} pose-${pose} gait-${gait}`}
      viewBox={POSE_VIEWBOX[pose]}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`cat: ${state}`}
    >
      <Body pose={pose} state={state} />
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

const POSE_VIEWBOX: Record<Pose, string> = {
  sit: '0 0 180 196',
  stand: '0 0 240 150',
  sleep: '0 0 230 150',
  alert: '0 0 210 176',
  angry: '0 0 210 176',
  exhausted: '0 0 240 140',
};

// ---------------------------------------------------------------------------
// Shared face pieces
// ---------------------------------------------------------------------------

/** Big round eye: colored disc + pupil + catchlight (all theme-driven so the
 * black cat gets white eyes with a dark pupil, others get a dark shiny eye). */
function Eye({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <>
      <circle className="eye" cx={cx} cy={cy} r={r} />
      <circle className="pupil" cx={cx} cy={cy} r={r * 0.5} />
      <circle className="eye-hl" cx={cx + r * 0.32} cy={cy - r * 0.34} r={r * 0.3} />
    </>
  );
}

function Body({ pose, state }: { pose: Pose; state: CatState }) {
  switch (pose) {
    case 'stand':
      return <Stand />;
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

// ---------------------------------------------------------------------------
// SIT — front view, chubby, sitting. Face varies by mood.
// ---------------------------------------------------------------------------
function Sit({ state }: { state: CatState }) {
  return (
    <>
      {/* curled tail peeking out to the side */}
      <g className="cat-tail">
        <path className="body" d="M40,168 C10,176 8,140 30,140 C48,140 54,158 50,172 Z" />
      </g>
      <g className="cat-breathe">
        {/* ears */}
        <path className="body" d="M46,64 C40,30 52,22 74,52 Z" />
        <path className="body" d="M134,64 C140,30 128,22 106,52 Z" />
        <path className="ear-in" d="M52,58 C49,38 57,34 68,52 Z" />
        <path className="ear-in" d="M128,58 C131,38 123,34 112,52 Z" />
        {/* head + body blob */}
        <path
          className="body"
          d="M26,104 C26,58 52,40 90,40 C128,40 154,58 154,104 C154,128 150,146 148,160 C144,182 120,190 90,190 C60,190 36,182 32,160 C30,146 26,128 26,104 Z"
        />
        {/* white belly */}
        <path
          className="belly"
          d="M64,150 C64,120 116,120 116,150 C116,176 100,186 90,186 C80,186 64,176 64,150 Z"
        />
        {/* tabby forehead stripes */}
        <g className="stripes">
          <path className="stripe-line" d="M78,52 L74,66" />
          <path className="stripe-line" d="M90,50 L90,64" />
          <path className="stripe-line" d="M102,52 L106,66" />
        </g>
        {/* front paws */}
        <ellipse className="leg" cx="66" cy="184" rx="17" ry="12" />
        <ellipse className="leg" cx="114" cy="184" rx="17" ry="12" />
        {/* cheeks */}
        <ellipse className="cheek" cx="52" cy="118" rx="13" ry="10" />
        <ellipse className="cheek" cx="128" cy="118" rx="13" ry="10" />
        {/* whiskers */}
        <path className="whisker" d="M40,120 L16,116" />
        <path className="whisker" d="M40,127 L16,130" />
        <path className="whisker" d="M140,120 L164,116" />
        <path className="whisker" d="M140,127 L164,130" />
        <SitFace state={state} />
      </g>
    </>
  );
}

/** The front-view face, expression by mood. */
function SitFace({ state }: { state: CatState }) {
  const nose = <path className="nose" d="M84,120 L96,120 L90,127 Z" />;
  const smile = (
    <>
      <path className="mouth" d="M90,127 C90,133 82,135 79,130" />
      <path className="mouth" d="M90,127 C90,133 98,135 101,130" />
    </>
  );
  switch (state) {
    case 'playing':
      // happy squint ^ ^ + open smile
      return (
        <>
          <path className="eye-line" d="M56,106 C62,98 72,98 78,106" />
          <path className="eye-line" d="M102,106 C108,98 118,98 124,106" />
          {nose}
          <path className="mouth" d="M78,128 C84,138 96,138 102,128" />
        </>
      );
    case 'curious':
      return (
        <>
          <Eye cx={66} cy={104} r={11} />
          <Eye cx={114} cy={104} r={11} />
          {nose}
          {/* tiny 'o' of curiosity */}
          <circle className="mouth-o" cx="90" cy="132" r="3" />
        </>
      );
    default:
      // active / anything else at rest: bright round eyes + content smile
      return (
        <>
          <Eye cx={66} cy={104} r={11} />
          <Eye cx={114} cy={104} r={11} />
          {nose}
          {smile}
        </>
      );
  }
}

// ---------------------------------------------------------------------------
// STAND — side profile loaf, shared by walk & run (gait class animates it).
// ---------------------------------------------------------------------------
function Stand() {
  return (
    <>
      {/* tail up-left */}
      <g className="cat-tail">
        <path className="body" d="M44,86 C18,80 10,34 30,26 C40,22 48,30 44,42 C34,52 34,72 56,80 Z" />
      </g>
      {/* everything but the tail bobs together during the gait */}
      <g className="cat-move">
        {/* far legs (behind the body) */}
        <rect className="leg far leg-a" x="66" y="104" width="20" height="34" rx="10" />
        <rect className="leg far leg-b" x="150" y="104" width="20" height="34" rx="10" />
        {/* body: long loaf with a head bump at the right */}
        <path
          className="body"
          d="M40,84 C40,54 70,46 120,46 C150,46 168,44 176,40 C182,20 210,20 214,44 C222,52 224,64 224,80 C224,104 210,120 176,120 L78,120 C54,120 40,108 40,84 Z"
        />
        {/* white belly */}
        <path
          className="belly"
          d="M60,110 C60,96 190,96 200,104 C200,118 180,120 120,120 L80,120 C66,120 60,116 60,110 Z"
        />
        {/* tabby back stripes */}
        <g className="stripes">
          <path className="stripe" d="M78,54 C82,54 84,58 82,70 C80,76 76,76 74,70 C73,60 74,54 78,54 Z" />
          <path className="stripe" d="M100,52 C104,52 106,56 104,68 C102,74 98,74 96,68 C95,58 96,52 100,52 Z" />
          <path className="stripe" d="M122,52 C126,52 128,56 126,68 C124,74 120,74 118,68 C117,58 118,52 122,52 Z" />
          <path className="stripe" d="M144,52 C148,52 150,56 148,68 C146,74 142,74 140,68 C139,58 140,52 144,52 Z" />
          <path className="stripe" d="M166,54 C170,54 172,58 170,70 C168,76 164,76 162,70 C161,60 162,54 166,54 Z" />
        </g>
        {/* near legs (in front of the body) */}
        <rect className="leg leg-b" x="58" y="106" width="20" height="34" rx="10" />
        <rect className="leg leg-a" x="158" y="106" width="20" height="34" rx="10" />
        {/* ear + face (3/4) */}
        <path className="body" d="M188,40 C186,20 200,18 206,38 Z" />
        <path className="ear-in" d="M192,38 C191,26 199,25 202,37 Z" />
        <Eye cx={196} cy={72} r={7} />
        <path className="whisker" d="M206,86 L232,82" />
        <path className="whisker" d="M206,92 L232,94" />
        <path className="mouth" d="M212,80 C216,84 222,84 224,80" />
      </g>
    </>
  );
}

// ---------------------------------------------------------------------------
// SLEEP — curled loaf, eyes shut, tail wrapped.
// ---------------------------------------------------------------------------
function Sleep() {
  return (
    <>
      <g className="cat-breathe">
        {/* big curled body */}
        <path
          className="body"
          d="M118,140 C60,140 30,112 30,84 C30,50 62,34 108,34 C170,34 210,54 210,92 C210,124 180,140 118,140 Z"
        />
      </g>
      {/* tail curling across the front */}
      <g className="cat-tail">
        <path className="body" d="M52,132 C24,132 22,150 50,148 C96,150 150,150 176,136 C150,144 92,146 52,132 Z" />
      </g>
      {/* ears */}
      <path className="body" d="M60,54 C48,26 66,18 84,44 Z" />
      <path className="body" d="M96,44 C104,18 122,24 116,52 Z" />
      <path className="ear-in" d="M65,50 C58,32 68,28 79,45 Z" />
      {/* head resting on the left */}
      <path
        className="body"
        d="M34,96 C34,66 58,52 84,52 C112,52 128,72 126,98 C124,122 104,132 82,132 C56,132 34,120 34,96 Z"
      />
      {/* closed sleepy eyes */}
      <path className="eye-line" d="M50,96 C56,104 66,104 72,96" />
      <path className="eye-line" d="M88,96 C94,104 104,104 110,96" />
      <ellipse className="cheek" cx="58" cy="110" rx="11" ry="8" />
      <path className="nose" d="M76,104 L86,104 L81,110 Z" />
    </>
  );
}

// ---------------------------------------------------------------------------
// ALERT — arched back, ears back, puffed tail, wide eye (profile).
// ---------------------------------------------------------------------------
function Alert() {
  return (
    <>
      <g className="cat-tail cat-tail-puff">
        <path className="body" d="M40,120 C6,108 6,52 34,42 C50,36 60,50 50,64 C36,76 34,102 60,110 Z" />
      </g>
      <g className="cat-breathe">
        <rect className="leg" x="56" y="126" width="19" height="38" rx="9" />
        <rect className="leg" x="132" y="126" width="19" height="38" rx="9" />
        <path
          className="body"
          d="M44,138 C32,84 60,44 106,44 C150,44 172,84 168,138 C166,150 150,150 128,150 L84,150 C60,150 46,150 44,138 Z"
        />
        <path
          className="belly"
          d="M64,132 C64,116 150,116 152,132 C152,146 132,148 108,148 L86,148 C70,148 64,142 64,132 Z"
        />
        {/* ears swept back */}
        <path className="body" d="M150,54 C140,32 158,26 168,44 Z" />
        <path className="body" d="M172,48 C186,34 196,46 180,60 Z" />
        <path className="ear-in" d="M154,50 C148,36 158,33 165,45 Z" />
        <path
          className="body"
          d="M138,74 C138,50 158,38 178,38 C200,38 214,56 212,78 C210,98 194,108 174,108 C154,108 138,96 138,74 Z"
        />
        <Eye cx={176} cy={68} r={9} />
        <ellipse className="mouth-fill" cx="192" cy="92" rx="5" ry="6" />
      </g>
    </>
  );
}

// ---------------------------------------------------------------------------
// ANGRY — higher arch, hiss + fang, max-puffed tail (profile).
// ---------------------------------------------------------------------------
function Angry() {
  return (
    <>
      <g className="cat-tail cat-tail-puff">
        <path className="body" d="M42,118 C2,104 4,42 34,32 C52,26 62,42 50,56 C34,68 34,98 62,108 Z" />
      </g>
      <g className="cat-breathe">
        <rect className="leg" x="56" y="126" width="19" height="38" rx="9" />
        <rect className="leg" x="132" y="126" width="19" height="38" rx="9" />
        <path
          className="body"
          d="M44,140 C28,80 60,36 106,36 C152,36 176,80 170,140 C168,152 150,150 128,150 L84,150 C58,150 46,152 44,140 Z"
        />
        <path
          className="belly"
          d="M64,134 C64,118 150,118 152,134 C152,148 132,150 108,150 L86,150 C70,150 64,144 64,134 Z"
        />
        <path className="body" d="M150,52 C140,30 158,24 168,42 Z" />
        <path className="body" d="M172,46 C186,32 196,44 180,58 Z" />
        <path className="ear-in" d="M154,48 C148,34 158,31 165,43 Z" />
        <path
          className="body"
          d="M138,72 C138,48 158,36 178,36 C200,36 214,54 212,76 C210,96 194,106 174,106 C154,106 138,94 138,72 Z"
        />
        <path className="eye-line thick" d="M166,64 L182,60" />
        <path className="mouth-fill" d="M188,84 Q200,80 206,88 Q200,100 194,100 Q189,96 188,84 Z" />
        <path className="fang" d="M192,86 l2.5,6 l2.5,-6 Z" />
      </g>
    </>
  );
}

// ---------------------------------------------------------------------------
// EXHAUSTED — flopped on its side, tongue out, drooped tail.
// ---------------------------------------------------------------------------
function Exhausted() {
  return (
    <>
      <g className="cat-tail">
        <path className="body" d="M46,110 C16,116 12,96 32,90 C42,88 48,98 46,110 Z" />
      </g>
      <g className="cat-breathe">
        {/* lying body */}
        <path
          className="body"
          d="M44,96 C44,74 70,66 120,66 C175,66 205,78 205,100 C205,120 180,126 120,126 C70,126 44,118 44,96 Z"
        />
        <path
          className="belly"
          d="M60,116 C70,104 180,104 195,112 C190,124 150,126 120,126 C80,126 62,122 60,116 Z"
        />
        {/* outstretched forelegs */}
        <rect className="leg" x="70" y="118" width="46" height="16" rx="8" />
        <rect className="leg" x="128" y="118" width="46" height="16" rx="8" />
        {/* head flopped to the right */}
        <path
          className="body"
          d="M158,74 C158,52 178,42 198,42 C220,42 234,58 232,80 C230,100 214,110 194,110 C172,110 158,96 158,74 Z"
        />
        <path className="body" d="M170,50 C160,30 178,24 188,42 Z" />
        <path className="ear-in" d="M174,46 C168,32 178,29 185,41 Z" />
        <path className="eye-line thick" d="M182,66 L192,72 L182,78" />
        <ellipse className="cheek" cx="172" cy="84" rx="10" ry="8" />
        <path className="tongue" d="M206,92 q10,8 3,18 q-6,-3 -6,-11 Z" />
      </g>
    </>
  );
}
