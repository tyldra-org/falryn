/** One bounded, immutable observation of package bytes; it conveys no execution authority. */
import type { z } from "zod";
import type { sourceCoordinateSchema } from "./identity.ts";

export type PackageFile = { readonly path: string; readonly bytes: Uint8Array };
export type InspectionDiagnostic = { readonly code: string; readonly path?: string };
export type PackageSnapshot = {
  readonly sourceId: string;
  /** Host-observed owner identity, never a manifest's publisher claim. */
  readonly ownership?: { readonly sourceOwner: string | null; readonly publisher: string | null };
  /**
   * Where the bytes were acquired from, set only by host acquisition adapters and by the
   * package cache for an installed version (#1210). Absent means a local directory.
   */
  readonly sourceCoordinate?: z.infer<typeof sourceCoordinateSchema>;
  readonly files: readonly PackageFile[];
  readonly diagnostics: readonly InspectionDiagnostic[];
  readonly omittedDiagnostics: number;
};
export interface PackageSource {
  read(signal?: AbortSignal): Promise<PackageSnapshot>;
}
