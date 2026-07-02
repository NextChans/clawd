# Cat sprite art

Drop generated PNG sprites here. Until a sprite exists, the app renders the
built-in **vector fallback** (`src/components/Cat/CatSvg.tsx`), so the app runs
fine with these folders empty.

## Layout

```
src/assets/cat/<color>/<pose>.png
```

**Colors** (folder names — must match exactly):
`cream` · `black` · `orange_tabby` · `gray_tabby` · `white`

**Poses** (9 files per color):

| File                | Used for                                  | View          |
| ------------------- | ----------------------------------------- | ------------- |
| `sit_forward.png`   | idle / calm (playing · curious · active)  | front         |
| `walk_right_a.png`  | walking — frame A                         | side, →       |
| `walk_right_b.png`  | walking — frame B                         | side, →       |
| `run_right_a.png`   | running — frame A                         | side, →       |
| `run_right_b.png`   | running — frame B                         | side, →       |
| `sleep_curled.png`  | sleeping                                  | curled loaf   |
| `alert_arched.png`  | alert                                     | side, arched  |
| `angry_hiss.png`    | angry / hiss                              | side, arched  |
| `exhausted_lie.png` | exhausted                                 | lying on side |

`walk_*` and `run_*` are two-frame flip animations (the app alternates A/B by
opacity — 0.5 s cycle for walk, 0.3 s for run). All side/moving poses face
**right**; the app mirrors them with `scaleX(-1)` when the cat heads left.

## Requirements

- **Transparent background**, PNG.
- Roughly **square** canvas (e.g. 512×512). The sprite is `contain`-fitted into
  a 128 px square, so keep the cat centered with a little padding.
- Keep the character/scale consistent across poses of the same color so it
  doesn't jump when the pose changes.

Adding files is picked up on the next `npm run build` (or HMR in `npm run dev`).
You don't need all 45 — any missing sprite just falls back to the vector cat,
so you can fill them in incrementally (e.g. start with `cream/`).

## Generating with Nano Banana (Gemini image)

Suggested prompt skeleton (adjust the coat color per folder):

> Cute chubby kawaii **cat sticker**, thick dark outline, flat pastel colors,
> big round eyes with a white highlight, small pink cheek blush, tiny pink inner
> ears, simple happy face. **\<COLOR\>** coat. **\<POSE\>**. Centered, full body,
> **transparent background**, sticker style, soft and rounded, no text.

Coat phrases: `cream/beige`, `solid black (white eyes)`, `orange tabby with
stripes`, `gray tabby with stripes`, `white`.

Pose phrases:
- `sit_forward` — "sitting, facing forward, looking at the viewer"
- `walk_right_a` / `_b` — "walking in side profile facing right, legs mid-stride
  (frame A / opposite legs forward for frame B)"
- `run_right_a` / `_b` — "running fast in side profile facing right, legs
  stretched out (two stride frames)"
- `sleep_curled` — "curled up asleep, eyes closed, tail wrapped around"
- `alert_arched` — "startled, side view, back arched, fur puffed, wide eyes"
- `angry_hiss` — "angry, side view, arched back, hissing with a tiny fang,
  puffed tail"
- `exhausted_lie` — "exhausted, lying flopped on its side, tongue out, tired eyes"

Generate each pose against a transparent background and keep the same cat design
across all nine poses of a color.
