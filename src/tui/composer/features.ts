/**
 * What the composer does not do yet, declared rather than half-built.
 *
 * Attachments and including a large paste are real as of #278: handles on
 * composer state, a payload port for paste bodies, and `@` mentions that
 * resolve against attached identities and explicit paths. Workspace slash
 * aliases of palette ids are real as of #609 (`./slash.ts`), but they are
 * submit-time dispatch — not a completion popup. What remains missing still
 * has no producer for general command completion or suggestions.
 *
 * So those gaps stay listed here with the reason, and the composer reports
 * them. A completion popup that never has anything to offer is worse than not
 * opening.
 *
 * Pure data. Nothing here imports a renderer, and nothing reads state.
 */

export type ComposerFeature = {
  /** Stable. What a test and a later implementation both reference. */
  readonly id: string;
  readonly title: string;
  /**
   * Why it is not here, in the same voice a command's unavailable reason uses.
   *
   * Names what is missing rather than saying "not implemented", because the
   * first is an answer and the second is a category.
   */
  readonly reason: string;
};

export const COMPOSER_FEATURES: readonly ComposerFeature[] = [
  {
    id: "composer.artifactCatalog",
    title: "Retained artifact catalog",
    reason: "no earlier-run artifact catalog exists to browse",
  },
  {
    id: "composer.completion",
    title: "Command completion",
    reason:
      "/workspace slash aliases dispatch palette ids on submit; there is still no completion popup",
  },
  {
    id: "composer.suggestions",
    title: "File, symbol, model, and session suggestions",
    reason: "there is no workspace index, provider registry, or session store to suggest from",
  },
];

/** A feature by id, or `undefined`. Lookup is by identity, never by title. */
export function composerFeature(id: string): ComposerFeature | undefined {
  return COMPOSER_FEATURES.find((feature) => feature.id === id);
}
