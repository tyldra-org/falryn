/**
 * The theme contract's entrypoint.
 *
 * Every view reads tokens through this module. `src/tui/tui-boundaries.test.ts`
 * asserts that no component names a colour literal, so this is not a convention
 * a reviewer has to hold — a hex string in a view fails a check.
 *
 * Nothing here imports OpenTUI. Tokens resolve from the domain's own colour and
 * symbol facts, so the whole contract is testable without a renderer.
 */

export type { StatusPresentation } from "./contrast.ts";
export {
  contrastFloorFor,
  contrastRatio,
  DE_EMPHASIZED_MINIMUM,
  distinguishableWithoutColor,
  HIGH_CONTRAST_MINIMUM,
  MINIMUM_CONTRAST,
  STATUS_PRESENTATION,
} from "./contrast.ts";
export type { Rgb } from "./palette.ts";
export { PALETTES, parseHex, quantize, resolvePalette } from "./palette.ts";
export type { SymbolRepertoire, SymbolRole, SymbolSet } from "./symbols.ts";
export { SYMBOL_ROLES, SYMBOL_SETS, symbolsFor } from "./symbols.ts";
export type { Theme, ThemeRequest } from "./theme.ts";
export { resolveTheme, selectVariant } from "./theme.ts";
export type {
  BorderStrength,
  ColorToken,
  GitToken,
  Marks,
  Motion,
  MotionRole,
  Palette,
  SpacingStep,
  StatusToken,
  SurfaceToken,
  ThemeVariant,
  Typography,
  TypographyRole,
  TypographyStyle,
} from "./tokens.ts";
export {
  BORDER_STRENGTHS,
  COLOR_TOKENS,
  FULL_MOTION,
  GIT_TOKENS,
  INTERACTION_TOKENS,
  MINIMUM_COLUMNS,
  MINIMUM_ROWS,
  MOTION_ROLES,
  NO_MOTION,
  SPACING,
  STATUS_TOKENS,
  SURFACE_TOKENS,
  THEME_VARIANTS,
  TYPOGRAPHY_ROLES,
  textAttributes,
} from "./tokens.ts";
