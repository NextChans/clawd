/**
 * The butterfly the cat chases. Wings flutter on their own via the
 * `.bfly-wings` CSS animation (App.css); the whole element is glided from spawn
 * to target imperatively by App.tsx. Authored facing the viewer, ~30px.
 */
export function Butterfly() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
      <g className="bfly-wings">
        <path
          d="M16 16 C 9 4, 1 6, 4 15 C 1 24, 10 26, 16 16 Z"
          fill="rgba(255,255,255,0.95)"
          stroke="rgba(120,110,140,0.6)"
          strokeWidth="1"
        />
        <path
          d="M16 16 C 23 4, 31 6, 28 15 C 31 24, 22 26, 16 16 Z"
          fill="rgba(255,255,255,0.95)"
          stroke="rgba(120,110,140,0.6)"
          strokeWidth="1"
        />
      </g>
      <line x1="16" y1="10" x2="16" y2="22" stroke="rgba(90,80,110,0.8)" strokeWidth="1.6" />
    </svg>
  );
}
