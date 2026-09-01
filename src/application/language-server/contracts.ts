/** Public contracts for the supervised Language Server Protocol client. */

import type {
  LanguageServerChangeDocumentRequest,
  LanguageServerCloseDocumentRequest,
  LanguageServerCodeActionResult,
  LanguageServerCodeActionsRequest,
  LanguageServerCompletionList,
  LanguageServerDocumentSymbolsRequest,
  LanguageServerEditToPatchResult,
  LanguageServerError,
  LanguageServerEvent,
  LanguageServerFormatRequest,
  LanguageServerHover,
  LanguageServerLocation,
  LanguageServerLocationLink,
  LanguageServerOpenDocument,
  LanguageServerOpenDocumentRequest,
  LanguageServerPublishDiagnostics,
  LanguageServerReferencesRequest,
  LanguageServerRenameRequest,
  LanguageServerSaveDocumentRequest,
  LanguageServerSnapshot,
  LanguageServerStartRequest,
  LanguageServerSymbols,
  LanguageServerTextDocumentPosition,
  LanguageServerWorkspaceFoldersChange,
  ManagedServiceId,
  ServiceGeneration,
} from "../../domain/index.ts";
import type { Result } from "../../domain/result.ts";

export type LanguageServerListener = (event: LanguageServerEvent) => void;

/** Closed extended request set used by strict product adapters (#805). */
export type LanguageServerExtendedRequest =
  | {
      readonly kind: "declaration" | "type-definition" | "implementation";
      readonly uri: string;
      readonly position: { readonly line: number; readonly character: number };
    }
  | { readonly kind: "workspace-symbols"; readonly query: string }
  | {
      readonly kind: "signature-help";
      readonly uri: string;
      readonly position: { readonly line: number; readonly character: number };
    }
  | {
      readonly kind: "call-hierarchy-prepare" | "type-hierarchy-prepare";
      readonly uri: string;
      readonly position: { readonly line: number; readonly character: number };
    }
  | {
      readonly kind:
        | "call-hierarchy-incoming"
        | "call-hierarchy-outgoing"
        | "type-hierarchy-supertypes"
        | "type-hierarchy-subtypes";
      readonly item: Readonly<Record<string, unknown>>;
    };

export type LanguageServerSupervisor = {
  start(
    request: LanguageServerStartRequest,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  shutdown(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  openDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerOpenDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  changeDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerChangeDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  saveDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerSaveDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  closeDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerCloseDocumentRequest,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  changeWorkspaceFolders(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    change: LanguageServerWorkspaceFoldersChange,
  ): Promise<Result<LanguageServerSnapshot, LanguageServerError>>;
  hover(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerTextDocumentPosition,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerHover | null, LanguageServerError>>;
  definition(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerTextDocumentPosition,
    signal?: AbortSignal,
  ): Promise<
    Result<
      readonly LanguageServerLocation[] | readonly LanguageServerLocationLink[],
      LanguageServerError
    >
  >;
  references(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerReferencesRequest,
    signal?: AbortSignal,
  ): Promise<Result<readonly LanguageServerLocation[], LanguageServerError>>;
  documentSymbols(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerDocumentSymbolsRequest,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerSymbols, LanguageServerError>>;
  completion(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerTextDocumentPosition,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerCompletionList, LanguageServerError>>;
  formatDocument(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerFormatRequest,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerEditToPatchResult, LanguageServerError>>;
  formatRange(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerFormatRequest & {
      readonly range: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
      };
    },
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerEditToPatchResult, LanguageServerError>>;
  rename(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerRenameRequest,
    signal?: AbortSignal,
  ): Promise<Result<LanguageServerEditToPatchResult, LanguageServerError>>;
  codeActions(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerCodeActionsRequest,
    signal?: AbortSignal,
  ): Promise<
    Result<
      {
        readonly result: LanguageServerCodeActionResult;
        readonly patches: readonly LanguageServerEditToPatchResult[];
      },
      LanguageServerError
    >
  >;
  /**
   * Send one of the closed, product-owned extended LSP requests.
   * This is not an arbitrary JSON-RPC escape and is never registered as a tool.
   */
  extendedFeature(
    serviceId: ManagedServiceId,
    generation: ServiceGeneration,
    request: LanguageServerExtendedRequest,
    signal?: AbortSignal,
  ): Promise<Result<unknown, LanguageServerError>>;
  diagnostics(serviceId: ManagedServiceId, uri: string): LanguageServerPublishDiagnostics | null;
  document(serviceId: ManagedServiceId, uri: string): LanguageServerOpenDocument | null;
  snapshot(serviceId: ManagedServiceId): LanguageServerSnapshot | null;
  attach(
    serviceId: ManagedServiceId,
    listener: LanguageServerListener,
  ): Result<{ detach(): void }, LanguageServerError>;
};
