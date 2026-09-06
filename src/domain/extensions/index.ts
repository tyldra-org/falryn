/** Public contracts for this capability. Internal modules import their exact dependencies. */

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
