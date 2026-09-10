import { canonicalDigest, canonicalJson } from "../../domain/extensions/canonical.ts";
import {
  type PackageConfigurationSnapshot,
  packageDataValueSchema,
} from "../../domain/extensions/package-data.ts";
import {
  type PackageDataProtocolResponse,
  packageDataProtocolRequestSchema,
  packageDataProtocolResponseSchema,
} from "../../domain/extensions/package-data-protocol.ts";
import type { PackageDataStore } from "../../domain/extensions/package-data-store.ts";
import { createPackageDataService, type PackageDataAuthority } from "./package-data.ts";
import { foldPackageSettings } from "./package-data-policy.ts";

/** Strict supervised boundary for #150. It starts no process and accepts no host-control operation. */
export function createPackageDataProtocol(options: {
  readonly store: PackageDataStore;
  readonly ephemeralStore?: PackageDataStore;
  readonly authority: PackageDataAuthority;
  /** Snapshot from the normal configuration publication, fixed for this admitted invocation. */
  readonly configurationSnapshot?: PackageConfigurationSnapshot;
  readonly now: () => number;
}) {
  const authority = { ...options.authority, hostControl: false };
  const service = createPackageDataService({ ...options, authority });
  return {
    receive(raw: unknown, signal?: AbortSignal): PackageDataProtocolResponse {
      const fail = (code: string): PackageDataProtocolResponse => ({
        version: 1,
        status: "failed",
        code,
      });
      try {
        if (Buffer.byteLength(canonicalJson(raw)) > 131_072) return fail("protocol-request-limit");
        const parsed = packageDataProtocolRequestSchema.safeParse(raw);
        if (!parsed.success) return fail("invalid-package-data-protocol");
        const request = parsed.data;
        if (canonicalDigest(request.binding) !== canonicalDigest(authority.binding))
          return fail("foreign-package-binding");
        if (signal?.aborted || !authority.current()) return fail("revoked-package-data");
        if (request.operation === "configuration") {
          const read = options.store.read(authority.binding.packageId);
          if (!read.ok || !read.value) return fail("package-configuration-unavailable");
          const document = read.value;
          if (
            document.packageDigest !== authority.binding.packageDigest ||
            document.configurationRevision !==
              (authority.configurationRevision ?? authority.binding.configurationGeneration)
          )
            return fail("stale-configuration-generation");
          const declarations = document.declarations.configuration.filter(
            (declaration) =>
              declaration.contribution === null ||
              declaration.contribution === authority.binding.contribution,
          );
          // Dependencies are validated over the complete package before narrowing delivery.
          const settings = foldPackageSettings(
            document,
            document.layers.filter((layer) => authority.allows(layer.scope, layer.owner, false)),
          );
          const values: PackageConfigurationSnapshot["values"] = {};
          const diagnostics: PackageConfigurationSnapshot["diagnostics"] = [];
          const published = options.configurationSnapshot;
          if (
            published &&
            (canonicalDigest(published.binding) !== canonicalDigest(authority.binding) ||
              published.digest !== canonicalDigest(published.values))
          )
            return fail("stale-configuration-generation");
          for (const declaration of declarations) {
            if (declaration.sensitivity === "credential-reference") {
              diagnostics.push({
                code: "credential-resolution-owner-required",
                key: declaration.id,
              });
              continue;
            }
            const value = published
              ? published.values[declaration.id]
              : settings.values[declaration.id];
            if (value !== undefined) values[declaration.id] = packageDataValueSchema.parse(value);
          }
          return packageDataProtocolResponseSchema.parse({
            version: 1,
            status: "configuration",
            snapshot: {
              version: 1,
              binding: authority.binding,
              values,
              diagnostics,
              digest: canonicalDigest(values),
            },
          });
        }
        const input = {
          version: 1,
          operation: "state",
          operationId: request.operationId,
          expectedRevision: request.expectedRevision,
          state: request.state,
        };
        const preview = service.run(input, signal);
        const result =
          preview.status === "preview"
            ? service.run({ ...input, confirmation: preview.confirmation }, signal)
            : preview;
        if (result.status === "failed" || result.status === "uncertain") return fail(result.code);
        if (result.status === "imported") return fail("invalid-protocol-operation");
        if (result.status === "preview") return fail("state-confirmation-unavailable");
        return packageDataProtocolResponseSchema.parse(
          result.status === "inspected"
            ? { version: 1, status: "read", value: result.payload }
            : { version: 1, status: "completed", receipt: result.receipt },
        );
      } catch {
        return fail("invalid-package-data-protocol");
      }
    },
  };
}
