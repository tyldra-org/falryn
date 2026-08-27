/** Application-provided durable session creation seam (#787). */

export type SessionCreationOutcome =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: string };

export type SessionCreationPort = {
  create(): Promise<SessionCreationOutcome>;
};
