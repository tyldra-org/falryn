import type { CredentialReference } from "../../domain/configuration/configuration.ts";
import type { PackageDownloadFailure } from "../../domain/extensions/package-acquisition.ts";

export type PackageDownload =
  | {
      readonly kind: "received";
      readonly bytes: Uint8Array;
      /** The final URL after any redirects. */
      readonly url: string;
      readonly redirects: number;
    }
  | { readonly kind: "failed"; readonly code: PackageDownloadFailure };

/** Downloads one package archive. Downloading grants, installs and writes nothing. */
export type PackageDownloadPort = {
  download(
    request: {
      readonly url: string;
      /** Sent only to hops on exactly this origin. */
      readonly credential: {
        readonly origin: string;
        readonly reference: CredentialReference;
      } | null;
    },
    signal: AbortSignal,
  ): Promise<PackageDownload>;
};
