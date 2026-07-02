/**
 * A bouncy toy ball — a round body with red/blue striped panels and a glossy
 * highlight. Rolls across the floor via the `.pt-ball` roll animation (App.css);
 * App.tsx glides it start→end. Authored ~40px.
 */
export function Ball() {
  return (
    <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden>
      <defs>
        <clipPath id="ball-clip">
          <circle cx="20" cy="20" r="18" />
        </clipPath>
      </defs>
      <g clipPath="url(#ball-clip)">
        <rect x="0" y="0" width="40" height="40" fill="#f6f4ef" />
        <path d="M4 -2 L16 -2 L11 42 L-1 42 Z" fill="#e0554e" />
        <path d="M26 -2 L38 -2 L43 42 L31 42 Z" fill="#4a90d9" />
      </g>
      <circle cx="20" cy="20" r="18" fill="none" stroke="rgba(50,45,60,0.55)" strokeWidth="2" />
      <ellipse cx="13.5" cy="12.5" rx="5" ry="3" fill="rgba(255,255,255,0.6)" />
    </svg>
  );
}
