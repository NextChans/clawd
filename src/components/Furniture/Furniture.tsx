import { useMemo } from 'react';
import { CatColor } from '../../types';
import './furniture.css';

export type FurnitureKind = 'tower' | 'cushion' | 'bowl';

/** Where each prop sits along the bottom baseline, as a fraction of the stage
 * width. **Must stay in sync with `roam.rs`'s `anchor_pos`** so the cat lands on
 * the matching prop when its mood sends it there. */
export const FURNITURE_X: Record<FurnitureKind, number> = {
  tower: 0.2,
  cushion: 0.5,
  bowl: 0.8,
};

// Eagerly resolve every furniture PNG that exists on disk. Files not yet added
// simply aren't in the map. Vite inlines this at build time; adding art later is
// picked up on rebuild / HMR. Mirrors the sprite glob in Cat.tsx.
const FURNITURE = import.meta.glob('../../assets/furniture/*/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/**
 * Resolve a furniture image URL for a color, with graceful fallbacks:
 *  - Food bowls were only authored for `gray_tabby`, so every other color falls
 *    back to the gray bowl (physical file reused, not duplicated on disk).
 *  - `cream` has no furniture sheet yet → returns undefined → the prop renders
 *    nothing (the whole baseline simply omits it).
 */
function furnitureUrl(color: CatColor, kind: FurnitureKind): string | undefined {
  const direct = FURNITURE[`../../assets/furniture/${color}/${kind}.png`];
  if (direct) return direct;
  if (kind === 'bowl') return FURNITURE['../../assets/furniture/gray_tabby/bowl.png'];
  return undefined;
}

/** A single decorative prop pinned to the bottom baseline. Click-through. */
export function Furniture({ kind, color }: { kind: FurnitureKind; color: CatColor }) {
  const src = useMemo(() => furnitureUrl(color, kind), [color, kind]);
  if (!src) return null;
  return <img src={src} className={`furniture furniture-${kind}`} alt="" draggable={false} />;
}

/**
 * The bottom-of-screen furniture row: cat tower (left), cushion cave (center),
 * food bowl (right). Purely decorative and click-through; the cat wanders onto
 * these props based on its mood (see `roam.rs`). Rendered only in Roam mode —
 * the shrunken Grab window would clip them off-screen.
 */
export function FurnitureBaseline({ color }: { color: CatColor }) {
  return (
    <div className="furniture-baseline" aria-hidden>
      <Furniture kind="tower" color={color} />
      <Furniture kind="cushion" color={color} />
      <Furniture kind="bowl" color={color} />
    </div>
  );
}
