/**
 * Animation profile — the single source of truth for motion in this app.
 *
 * Mirrored as CSS custom properties in `styles.css` (`:root`) — when changing
 * a value here, change it there too. Documented in `docs/animation-profile.md`.
 *
 * Rules (the whole profile in four lines):
 *   1. Motion answers an action — opening, expanding, confirming. Nothing
 *      decorative, nothing that plays without a user action behind it.
 *   2. Drag interactions follow the finger 1:1 (transition off) and spring
 *      back on release with `--ease-standard`.
 *   3. One easing per personality: `--ease-standard` for entrances/exits,
 *      `--ease-spring` only for small tactile pops (icon taps).
 *   4. `prefers-reduced-motion: reduce` collapses every duration to ~0.
 */
export const ANIM = {
  dur: {
    /** hovers, icon feedback, button taps */
    fast: "120ms",
    /** menus, rows, scrims, small reveals */
    base: "180ms",
    /** sheets (MCP/Skills), sidebar, page-level pushes */
    slow: "240ms",
  },
  ease: {
    /** entrances, exits, spring-backs — the default personality */
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    /** small overshoot for tactile pops (icon taps, toggles) */
    spring: "cubic-bezier(0.34, 1.3, 0.64, 1)",
    /** spinners only */
    linear: "linear",
  },
  /** keyframe names defined in styles.css */
  keyframes: {
    fadeIn: "fade-in",
    popIn: "pop-in",
    panelIn: "panel-in",
    spin: "spin",
  },
} as const
