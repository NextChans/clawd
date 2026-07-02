/**
 * The teaser-wand lure — a little bell where the string ties on, and a fan of
 * feathers below. This is the bit the cat chases; the rod + string are drawn
 * separately (a line from the corner to here) in App.tsx while fishing.
 * Authored ~44px tall with the tie-on point at the top-center (22, 3), so the
 * string can meet it cleanly.
 */
export function FishingRod() {
  return (
    <svg viewBox="0 0 44 48" width="44" height="48" aria-hidden>
      {/* Tie-on ring + bell */}
      <circle cx="22" cy="4" r="2.4" fill="none" stroke="#8a7a63" strokeWidth="1.4" />
      <path d="M18.5 10c0-2.2 1.6-3.8 3.5-3.8s3.5 1.6 3.5 3.8v1.5h-7z" fill="#f2b705" />
      <rect x="17.6" y="11" width="8.8" height="2.4" rx="1.2" fill="#e0a100" />
      <circle cx="22" cy="15" r="1.3" fill="#c98f00" />

      {/* Feather fan */}
      <g stroke="rgba(60,50,40,0.35)" strokeWidth="0.6">
        <path d="M22 16 C14 24 12 34 15 45 C19 38 21 28 22 16Z" fill="#e0554e" />
        <path d="M22 16 C22 26 22 36 22 47 C22 36 22 26 22 16Z" fill="#4a90d9" />
        <path d="M22 16 C30 24 32 34 29 45 C25 38 23 28 22 16Z" fill="#5bbf7a" />
      </g>
      {/* Quill highlights */}
      <g stroke="rgba(255,255,255,0.5)" strokeWidth="0.7" fill="none">
        <path d="M18 22 C16 30 16 38 17 43" />
        <path d="M22 20 L22 44" />
        <path d="M26 22 C28 30 28 38 27 43" />
      </g>
    </svg>
  );
}
