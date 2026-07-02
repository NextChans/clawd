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
 * Per-color fallback chain for furniture art. When a color lacks a given
 * `kind`'s PNG on disk, we borrow the closest-toned palette instead of
 * duplicating files. The chain must terminate (no cycles):
 *  - `cream` authors only its bowl → tower/cushion borrow `orange_tabby` (its
 *    cream/beige posts match cream best), which in turn chains to `gray_tabby`.
 *  - every other color falls back to `gray_tabby` (the only complete set), and
 *    `gray_tabby` itself terminates (`undefined`).
 */
const FURNITURE_FALLBACK: Record<CatColor, CatColor | undefined> = {
  cream: 'orange_tabby',
  orange_tabby: 'gray_tabby',
  white: 'gray_tabby',
  black: 'gray_tabby',
  gray_tabby: undefined,
};

/**
 * Resolve a furniture image URL for a color, walking `FURNITURE_FALLBACK` until
 * a real PNG is found. Returns `undefined` only when neither the color nor any
 * fallback in its chain authors that `kind` → the prop renders nothing (that
 * slot on the baseline is simply omitted). No files are duplicated on disk; the
 * borrowed URL is reused as-is.
 */
function furnitureUrl(color: CatColor, kind: FurnitureKind): string | undefined {
  const direct = FURNITURE[`../../assets/furniture/${color}/${kind}.png`];
  if (direct) return direct;
  const fallback = FURNITURE_FALLBACK[color];
  return fallback ? furnitureUrl(fallback, kind) : undefined;
}

/**
 * A single decorative prop pinned to the bottom baseline. Click-through.
 * Always mounted so it can fade in/out; `visible` toggles the CSS transition.
 */
export function Furniture({
  kind,
  color,
  visible,
}: {
  kind: FurnitureKind;
  color: CatColor;
  visible: boolean;
}) {
  const src = useMemo(() => furnitureUrl(color, kind), [color, kind]);
  if (!src) return null;
  return (
    <img
      src={src}
      className={`furniture furniture-${kind}${visible ? ' visible' : ''}`}
      alt=""
      draggable={false}
    />
  );
}

/**
 * The bottom-of-screen furniture row: cat tower (left), cushion cave (center),
 * food bowl (right). Purely decorative and click-through; the cat wanders onto
 * these props based on its mood (see `roam.rs`). Rendered only in Roam mode —
 * the shrunken Grab window would clip them off-screen.
 *
 * Props are *on-demand*: rather than sitting on the baseline permanently, each
 * fades in only while its mood is active (cushion↔sleeping, tower↔alert/angry,
 * bowl↔exhausted or a feed reaction) and fades back out when the mood passes,
 * so the cat reads as heading *toward* whatever prop just appeared.
 */
export function FurnitureBaseline({
  color,
  visibleKinds,
}: {
  color: CatColor;
  visibleKinds: Set<FurnitureKind>;
}) {
  return (
    <div className="furniture-baseline" aria-hidden>
      <Furniture kind="tower" color={color} visible={visibleKinds.has('tower')} />
      <Furniture kind="cushion" color={color} visible={visibleKinds.has('cushion')} />
      <Furniture kind="bowl" color={color} visible={visibleKinds.has('bowl')} />
    </div>
  );
}
