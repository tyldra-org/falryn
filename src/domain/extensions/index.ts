/** Public contracts for this capability. Internal modules import their exact dependencies. */

export { bytesDigest, canonicalDigest, canonicalJson, parseMetadata } from "./canonical.ts";
export type {
  DependencyCandidate,
  DependencyResolution,
  PackageDependency,
} from "./dependencies.ts";
export { resolvePackageDependencies } from "./dependencies.ts";
export type {
  BuiltinOwnerIdentityV1,
  CapabilityBindingV1,
  ContributionIdentityV1,
  ExtensionActivationIdentityV1,
  PackageIdentityV1,
  StandaloneSourceOwnerV1,
} from "./identity.ts";
export {
  builtinOwnerIdentityV1Schema,
  capabilityBindingV1Schema,
  contributionIdentityV1Schema,
  decodeIdentity,
  extensionActivationIdentityV1Schema,
  packageIdentityV1Schema,
  standaloneSourceOwnerV1Schema,
  validateCapabilityBinding,
} from "./identity.ts";
export type {
  ExportName,
  InMemoryPackageWriterOptions,
  PackageError,
  PackageErrorCode,
  PackageOperation,
  PackageWriterPort,
} from "./package.ts";
export {
  createInMemoryPackageWriter,
  PACKAGE_ERROR_CODES,
  PACKAGE_OPERATIONS,
} from "./package.ts";
export type {
  InspectionDiagnostic,
  PackageFile,
  PackageSnapshot,
  PackageSource,
} from "./package-source.ts";
