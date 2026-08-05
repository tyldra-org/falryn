/**
 * What the composer control is given.
 *
 * A view model in the sense `./view-model.ts` means it: plain data, no renderer,
 * no OpenTUI type, no port. The component that draws it can be handed one in a
 * test and asserted on, and the shell builds one from the composer state, the
 * registry, and the feature list rather than from anything it drew.
 *
 * The state is carried whole rather than flattened into lines. The component
 * gives its text to OpenTUI's textarea and never derives a second cursor,
 * selection, or viewport from this model.
 */

import type { ComposerFeature, ComposerState } from "./composer/index.ts";
import type { CommandEntry } from "./view-model.ts";

export type ComposerModel = {
  readonly state: ComposerState;
  /**
   * Every command as a row, resolved through the live keymap.
   *
   * Carried so the composer can name a key without knowing a keymap exists, and
   * so the repair route on an unavailable submission resolves to a command that
   * is really registered with the key it currently has.
   */
  readonly commands: readonly CommandEntry[];
  /**
   * What the composer does not do yet.
   *
   * Passed rather than imported by the component, so a test can hand it an empty
   * list and assert that the region says nothing rather than inventing a
   * reassurance.
   */
  readonly features: readonly ComposerFeature[];
  /** Whether the composer holds focus. Decides the border and whether keys reach it. */
  readonly focused: boolean;
};
