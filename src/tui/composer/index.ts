/**
 * The composer's contract, in one place.
 *
 * Everything exported here is a pure value or function: draft and history
 * state, paste policy, and a submission port whose one implementation in this
 * build is an honest refusal.
 * The component that mounts them is `../components/composer.tsx`, and it is the
 * only part of the composer that needs a renderer — which is why every rule the
 * composer promises can be asserted without one.
 */

export type {
  ClickSequence,
  ClickSequenceInput,
  ClickSequenceTransition,
  RepeatedPressCount,
  TerminalCell,
} from "./click-sequence.ts";
export { REPEATED_PRESS_WINDOW, transitionClickSequence } from "./click-sequence.ts";
export type { ComposerFeature } from "./features.ts";
export { COMPOSER_FEATURES, composerFeature } from "./features.ts";
export type { InputHistory, Recall } from "./history.ts";
export {
  EMPTY_HISTORY,
  HISTORY_LIMIT,
  isRecalling,
  recallNext,
  recallPrevious,
  remember,
} from "./history.ts";
export type { AttachmentPayloadPort } from "./payload.ts";
export { createMemoryAttachmentPayloads } from "./payload.ts";
export type { ComposerAction, ComposerEnhancement, ComposerPhase, ComposerState } from "./state.ts";
export {
  COMPOSER_PHASES,
  composerNotice,
  composerReducer,
  INITIAL_COMPOSER_STATE,
} from "./state.ts";
export type {
  ComposerSnapshot,
  SubmissionOutcome,
  SubmissionOutcomeKind,
  SubmissionPort,
} from "./submission.ts";
export {
  describeOutcome,
  SUBMISSION_OUTCOMES,
  SUBMISSION_OWNER,
  snapshotOf,
  UNAVAILABLE_SUBMISSION,
} from "./submission.ts";
