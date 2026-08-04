/**
 * What the composer does not do yet, declared rather than half-built.
 *
 * The canonical contract names attachments, artifact references, command
 * completion, and file/symbol/model/provider/skill/agent/session suggestion as
 * part of a finished composer. None of them exist in this build, and each one
 * has a producer that does not exist either — there is no artifact store, no
 * workspace index, and no provider registry to suggest from.
 *
 * So they are listed here with the reason, and the composer reports them. That
 * is the same choice `../commands.ts` makes about an unavailable command, for
 * the same reason: a half-built attachment control that accepts a file and
 * drops it is worse than a sentence saying attachments are not here, and a
 * completion popup that never has anything to offer is worse than not opening.
 *
 * A feature whose *concept* does not exist is omitted rather than listed. This
 * is a list of gaps, not a roadmap — the roadmap is in GitHub, and a second one
 * here would go stale the first time either changed.
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
    id: "composer.attachments",
    title: "Attachments",
    reason: "there is no artifact store to attach anything from",
  },
  {
    id: "composer.artifactReferences",
    title: "Artifact references",
    reason: "no artifact exists to reference",
  },
  {
    id: "composer.completion",
    title: "Command completion",
    reason: "commands are reachable from the palette, and no argument schema exists to complete",
  },
  {
    id: "composer.suggestions",
    title: "File, symbol, model, and session suggestions",
    reason: "there is no workspace index, provider registry, or session store to suggest from",
  },
  {
    id: "composer.largePaste",
    title: "Including a large paste",
    reason:
      "a large paste is reported and bounded, and including it needs the attachment path that does not exist yet",
  },
];

/** A feature by id, or `undefined`. Lookup is by identity, never by title. */
export function composerFeature(id: string): ComposerFeature | undefined {
  return COMPOSER_FEATURES.find((feature) => feature.id === id);
}
