/**
 * A ball of pink yarn with a loose dangling strand at the top. Sways back and
 * forth via the `.pt-yarn` animation (App.css), pivoting from the strand; App.tsx
 * nudges it in front of the cat, which bats at it. Authored ~36×40px.
 */
export function Yarn() {
  return (
    <svg viewBox="0 0 40 44" width="36" height="40" aria-hidden>
      {/* Loose strand it hangs by. */}
      <path
        d="M20 6 C 26 3, 24 -2, 19 0"
        fill="none"
        stroke="#e88bb2"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle cx="20" cy="24" r="16" fill="#f2a0c0" stroke="rgba(120,60,90,0.5)" strokeWidth="1.5" />
      {/* Wound thread — a few crossing arcs. */}
      <g fill="none" stroke="#d9749b" strokeWidth="1.6" strokeLinecap="round" opacity="0.9">
        <path d="M7 20 Q20 30 33 21" />
        <path d="M6 26 Q20 20 34 27" />
        <path d="M11 12 Q22 24 30 37" />
        <path d="M30 12 Q18 24 11 37" />
      </g>
      <ellipse cx="14" cy="17" rx="4" ry="2.4" fill="rgba(255,255,255,0.45)" />
    </svg>
  );
}
