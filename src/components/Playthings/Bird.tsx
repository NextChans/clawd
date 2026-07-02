/**
 * A little bird silhouette that swoops across the top of the screen. The wings
 * flap via `.bird-body` (App.css) while App.tsx glides it across; the `.pt-bird`
 * wrapper adds the mid-flight dip. Out of the cat's reach — it always escapes.
 * Authored facing right, ~40×32px.
 */
export function Bird() {
  return (
    <svg viewBox="0 0 40 32" width="40" height="32" aria-hidden>
      <g className="bird-body">
        {/* Body + tail. */}
        <path
          d="M18 17 C 22 13, 30 13, 34 18 C 30 20, 24 21, 18 19 Z"
          fill="#2b2b33"
        />
        {/* Beak. */}
        <path d="M33 17.5 L38 16 L33 19 Z" fill="#e0a24a" />
        {/* Wings (flap). */}
        <path
          d="M20 17 C 14 6, 6 8, 3 15 C 9 13, 15 15, 20 17 Z"
          fill="#33333c"
        />
        <path
          d="M20 17 C 16 9, 10 12, 8 18 C 13 16, 17 16, 20 17 Z"
          fill="#22222a"
          opacity="0.9"
        />
      </g>
    </svg>
  );
}
