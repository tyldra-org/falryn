/** Shared result of one command-specific human payload renderer. */
export type RenderedPayload = {
  /** The result text, destined for stdout. */
  readonly lines: readonly string[];
  /** What this command found that a reader needs and stdout must not carry. */
  readonly diagnostics: readonly string[];
};
