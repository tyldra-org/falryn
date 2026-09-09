/** One bounded, immutable observation of package bytes; it conveys no execution authority. */
export type PackageFile = { readonly path: string; readonly bytes: Uint8Array };
export type InspectionDiagnostic = { readonly code: string; readonly path?: string };
export type PackageSnapshot = {
  readonly sourceId: string;
  /** Host-observed owner identity, never a manifest's publisher claim. */
  readonly ownership?: { readonly sourceOwner: string | null; readonly publisher: string | null };
  readonly files: readonly PackageFile[];
  readonly diagnostics: readonly InspectionDiagnostic[];
  readonly omittedDiagnostics: number;
};
export interface PackageSource {
  read(signal?: AbortSignal): Promise<PackageSnapshot>;
}
