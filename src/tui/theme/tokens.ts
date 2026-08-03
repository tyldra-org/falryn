/**
 * The semantic token vocabulary.
 *
 * Names only. Nothing here knows what colour a token is, which is the whole
 * point: a view asks for `error`, not for red, so the same view is correct in a
 * light theme, a dark theme, a monochrome terminal, and a high-contrast one
 * without knowing any of them exist.
 *
 * The vocabulary is closed and every list is `as const`, so a palette that
 * forgot a token fails to compile rather than resolving it to a default nobody
 * chose. That is the mechanism that makes "every semantic token resolves at
 * every colour depth" a property of the build rather than a review item.
 *
 * This module imports nothing. It is the bottom of the interface area.
 */

/* -------------------------------------------------------------------------- */
/* Colour roles                                                                */
/* -------------------------------------------------------------------------- */

/** Surfaces and text. What a frame is made of before anything means anything. */
export const SURFACE_TOKENS = [
  "foreground",
  "mutedForeground",
  "background",
  "elevatedSurface",
  "overlay",
] as const;

/** Interaction. What the interface is doing with the user's attention. */
export const INTERACTION_TOKENS = ["accent", "focus", "selection", "link"] as const;

/**
 * Outcome and progress.
 *
 * `uncertain` is not a shade of `error`. The runtime distinguishes a failure
 * from an effect nobody observed, and an interface that rendered them the same
 * would erase the distinction the exit table exists to carry.
 */
export const STATUS_TOKENS = [
  "success",
  "warning",
  "error",
  "informational",
  "pending",
  "cancelled",
  "uncertain",
] as const;

/** Version-control states, which every diff and file view reuses. */
export const GIT_TOKENS = [
  "added",
  "removed",
  "modified",
  "conflict",
  "ignored",
  "untracked",
] as const;

export const COLOR_TOKENS = [
  ...SURFACE_TOKENS,
  ...INTERACTION_TOKENS,
  ...STATUS_TOKENS,
  ...GIT_TOKENS,
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type SurfaceToken = (typeof SURFACE_TOKENS)[number];
export type StatusToken = (typeof STATUS_TOKENS)[number];
export type GitToken = (typeof GIT_TOKENS)[number];

/** A palette at full colour depth: every token, as a `#rrggbb` string. */
export type Palette = Readonly<Record<ColorToken, string>>;

/* -------------------------------------------------------------------------- */
/* Typography                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Typography roles, expressed only through attributes a terminal actually has.
 *
 * There are no font sizes here and there never will be. A role is a bundle of
 * bold, dim, italic, and underline, and roles exist so a view says `heading`
 * rather than `bold: true` — which is what lets a high-contrast variant make
 * headings bold *and* underlined without touching a single call site.
 */
export const TYPOGRAPHY_ROLES = [
  "body",
  "heading",
  "label",
  "emphasis",
  "muted",
  "code",
  "link",
] as const;

export type TypographyRole = (typeof TYPOGRAPHY_ROLES)[number];

/** The attributes a role turns on. Absent is off; there is no inherit. */
export type TypographyStyle = {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
};

export type Typography = Readonly<Record<TypographyRole, TypographyStyle>>;

/* -------------------------------------------------------------------------- */
/* Structure                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Border strengths, as meanings rather than as line styles.
 *
 * `none` is first and is the default a region should reach for. The design
 * direction is explicit that whitespace, alignment, and muted text come before
 * a border, and a vocabulary whose cheapest option is a box invites the
 * opposite.
 */
export const BORDER_STRENGTHS = ["none", "subtle", "strong", "focus"] as const;

export type BorderStrength = (typeof BORDER_STRENGTHS)[number];

/** Spacing steps, in terminal cells. A view picks a step, never a number. */
export const SPACING = {
  none: 0,
  tight: 1,
  regular: 2,
  loose: 4,
} as const;

export type SpacingStep = keyof typeof SPACING;

/* -------------------------------------------------------------------------- */
/* Motion                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Motion roles and their durations in milliseconds.
 *
 * Short on purpose. Motion here explains relationship, arrival, and completion;
 * anything long enough to be noticed as an animation is long enough to be in
 * the way of someone reading. Continuous decorative animation has no role
 * because it is prohibited, and a vocabulary that offered one would be an
 * invitation.
 */
export const MOTION_ROLES = ["instant", "reveal", "settle"] as const;

export type MotionRole = (typeof MOTION_ROLES)[number];

export type Motion = Readonly<Record<MotionRole, number>>;

export const FULL_MOTION: Motion = {
  instant: 0,
  reveal: 120,
  settle: 200,
};

/**
 * Reduced motion: every role maps to zero.
 *
 * A mapping rather than a branch at each call site. Every transition still
 * *happens* — it arrives at its final frame immediately — so a component never
 * has to know which mode it is in, and there is no path where reduced motion
 * skips a state change rather than shortening it.
 */
export const NO_MOTION: Motion = {
  instant: 0,
  reveal: 0,
  settle: 0,
};

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Text a theme draws that is not content.
 *
 * The truncation mark lives here rather than in a component because whether `…`
 * is legible is a capability fact — and because `truncateToWidth` takes the
 * mark as an argument precisely so the decision is made once, by whoever knows.
 */
export type Marks = {
  readonly truncation: string;
  readonly separator: string;
  readonly bullet: string;
};

/* -------------------------------------------------------------------------- */
/* Variants                                                                    */
/* -------------------------------------------------------------------------- */

export const THEME_VARIANTS = ["dark", "light", "monochrome", "high-contrast"] as const;

export type ThemeVariant = (typeof THEME_VARIANTS)[number];

/**
 * The smallest region a view may be given before it must say so instead.
 *
 * Not a layout breakpoint — those are in `../layout.ts`. This is the point below
 * which no arrangement is honest, and the interface owes the user an actionable
 * message rather than a frame with content pushed off the edge of it.
 */
export const MINIMUM_COLUMNS = 24;
export const MINIMUM_ROWS = 6;
