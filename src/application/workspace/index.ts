/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  EphemeralProductIndexPort,
  ProductIndexLifecycle,
  ProductIndexLifecyclePorts,
  ProductIndexLifecycleStatus,
} from "./product-index-lifecycle.ts";
export {
  composeProductIndexLifecycle,
  createEphemeralProductIndexPort,
  PRODUCT_INDEX_LIFECYCLE_OWNER,
} from "./product-index-lifecycle.ts";
export type {
  ProductReadCoordinator,
  ProductReadCoordinatorOptions,
  ProductReadOutputMode,
  ProductReadResult,
} from "./product-read.ts";
export {
  createProductReadCoordinator,
  DEFAULT_PRODUCT_READ_LOOM_BYTES,
  MAX_PRODUCT_READ_CANDIDATES,
  PRODUCT_READ_OUTPUT_MODES,
  PRODUCT_READ_OWNER,
  productReadInputSchema,
} from "./product-read.ts";
export type {
  WorkspaceIndexBuilder,
  WorkspaceIndexBuilderOptions,
} from "./workspace-index-build.ts";
export { createWorkspaceIndexBuilder } from "./workspace-index-build.ts";
export type {
  WorkspaceLayoutStore,
  WorkspaceLayoutStoreError,
  WorkspaceLayoutUnusableRoot,
} from "./workspace-layout.ts";
export { createWorkspaceLayoutStore } from "./workspace-layout.ts";
export type { WorkspaceListing } from "./workspace-listing.ts";
export { createWorkspaceListing } from "./workspace-listing.ts";
export type { WorkspaceMutator, WorkspaceMutatorOptions } from "./workspace-mutate.ts";
export { createWorkspaceMutator } from "./workspace-mutate.ts";
export type { PatchPort, WorkspacePatcher, WorkspacePatcherOptions } from "./workspace-patch.ts";
export { createWorkspacePatcher } from "./workspace-patch.ts";
export type { WorkspacePathBinder, WorkspacePathProbeError } from "./workspace-path.ts";
export { createWorkspacePathBinder } from "./workspace-path.ts";
export type { WorkspaceReader, WorkspaceReaderOptions } from "./workspace-read.ts";
export { createWorkspaceReader } from "./workspace-read.ts";
export type {
  WorkspaceSetBinder,
  WorkspaceSetProbeError,
  WorkspaceSetResolveError,
  WorkspaceSetRootInput,
} from "./workspace-set.ts";
export { createWorkspaceSetBinder, resolveWorkspaceSet } from "./workspace-set.ts";
export type { WorkspaceWriter, WorkspaceWriterOptions } from "./workspace-write.ts";
export { createWorkspaceWriter } from "./workspace-write.ts";
