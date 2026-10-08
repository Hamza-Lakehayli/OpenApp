# Animation profile

The single source of truth is `client/src/anim.ts` (`ANIM`), mirrored as CSS
custom properties in `client/src/styles.css` (`:root`). When changing a value
here, change it there too.

## Rules

1. **Motion answers an action** — opening, expanding, confirming. Nothing
   decorative, nothing that plays without a user action behind it.
2. **Drag interactions follow the finger 1:1** (transition off) and spring
   back on release with `--ease-standard`. The sidebar drawer is the
   reference implementation (`Sidebar` in `client/src/components.tsx`):
   - pull open with a left-to-right drag from the left edge
     (`.sidebar-edge`, 22px invisible strip, `touch-action: none`)
   - drag closed from inside the drawer — axis-locked after 6px, so
     vertical scrolls of the session list stay native (`touch-action: pan-y`
     on the drawer)
   - release settles by distance (past 40% of the drawer width) or flick
     (velocity > 0.4 px/ms)
   - gestures track at the document level, never `setPointerCapture` on
     pointerdown — capturing retargets the derived click, which eats taps
     on buttons inside the drawer
3. **One easing per personality**: `--ease-standard` for entrances/exits,
   `--ease-spring` only for small tactile pops (icon taps).
4. **`prefers-reduced-motion: reduce`** collapses every duration to ~0.

## Durations

| Token           | Value  | Used for                                   |
| --------------- | ------ | ------------------------------------------ |
| `--anim-fast`   | 120ms  | hovers, icon feedback, button taps          |
| `--anim-base`   | 180ms  | menus, rows, scrims, small reveals          |
| `--anim-slow`   | 240ms  | sidebar, sheets (MCP/Skills), page pushes   |

## Keyframes

Defined in `styles.css`: `fade-in`, `pop-in`, `panel-in`, `spin`.
