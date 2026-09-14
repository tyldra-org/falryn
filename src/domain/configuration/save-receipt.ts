/** Durable file state and runtime state are separate acknowledgements. Contains no setting values. */
export type ConfigurationSaveReceipt = {
  readonly path: string;
  readonly revision: string | null;
  readonly previousRevision: string | null;
  readonly changedPaths: readonly string[];
  readonly validation: "valid";
  readonly save: "saved" | "unchanged";
  readonly publication: "pending" | "published" | "failed";
  readonly generation: number | null;
  readonly application: "pending" | "failed";
};
