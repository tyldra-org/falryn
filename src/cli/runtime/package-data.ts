import { userInfo } from "node:os";
import {
  createPackageDataService,
  type PackageDataResult,
} from "../../application/extensions/package-data.ts";
import { importPackageData } from "../../application/extensions/package-data-transfer.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { catalogWorkspaceBinding } from "../../domain/extensions/catalog-history.ts";
import type { PackageLifecycleStore, PackageRequest } from "../../domain/extensions/lifecycle.ts";
import type { PackageDataStore } from "../../domain/extensions/package-data-store.ts";
import type { PackageDataImportStore } from "../../domain/extensions/package-data-transfer.ts";
import { sessionId } from "../../domain/foundation/index.ts";
import type { SessionRepositoryPort } from "../../domain/sessions/records.ts";
import { inspectPackageConfiguration } from "./package-configuration-inspection.ts";

export function runPackageDataImport(
  imports: PackageDataImportStore,
  request: PackageRequest,
  signal: AbortSignal,
): PackageDataResult {
  if (request.data?.operation !== "import")
    return { status: "failed", code: "inert-import-required" };
  const user = userInfo();
  const owner = canonicalDigest({ kind: "local-user", uid: user.uid, username: user.username });
  return importPackageData(
    {
      store: imports,
      owner,
      packageId: request.packageId,
      operationId: request.data.operationId,
      raw: request.data.bundle,
      ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
    },
    signal,
  );
}

import type { Services } from "./services.ts";

export async function runPackageDataControl(
  services: Services,
  repositories: {
    packages: PackageLifecycleStore;
    data: PackageDataStore;
    imports: PackageDataImportStore;
    sessions: SessionRepositoryPort;
  },
  request: PackageRequest,
  signal: AbortSignal,
): Promise<PackageDataResult> {
  const user = userInfo();
  const actor = canonicalDigest({ kind: "local-user", uid: user.uid, username: user.username });
  const { packages, data, imports, sessions } = repositories;
  if (request.data?.operation === "import") return runPackageDataImport(imports, request, signal);
  const installed = packages.current(request.packageId);
  if (!installed.ok || !installed.value.current)
    return { status: "failed", code: "package-not-installed" };
  if (installed.value.revision !== request.expectedRevision)
    return { status: "failed", code: "stale-package-revision" };
  const version = installed.value.current;
  if (version.identity.packageVersion === null)
    return { status: "failed", code: "package-version-required" };
  const workspace = await services.ensureWorkspaceSet(signal);
  const trust = await services.workspaceTrust.resolve(undefined, signal);
  const roots = workspace.ok ? catalogWorkspaceBinding(workspace.value.set) : null;
  const admitted = trust.status === "accepted" || trust.status === "empty";
  const trustGeneration = trust.inventory?.generation ?? null;
  const operation = request.data;
  if (!operation) return { status: "failed", code: "package-data-request-required" };
  const document = data.read(request.packageId);
  if (!document.ok || !document.value)
    return { status: "failed", code: "package-data-unavailable" };
  const session = operation.context?.session ?? null;
  const profile = operation.context?.profile ?? null;
  const sessionGeneration = (owner: string): string | null => {
    const id = sessionId.parse(owner);
    if (!id.ok || !admitted) return null;
    const record = sessions.get(id.value);
    if (
      !record.ok ||
      !record.value ||
      record.value.closedAt !== null ||
      record.value.extensionCatalog?.workspaceBinding !== roots
    )
      return null;
    return canonicalDigest({
      session: owner,
      roots,
      configuration: record.value.configurationGeneration,
    });
  };
  if (session !== null && sessionGeneration(session) === null)
    return { status: "failed", code: "session-scope-unavailable" };
  const binding = {
    version: 1 as const,
    packageId: request.packageId,
    packageDigest: version.identityDigest,
    packageVersion: version.identity.packageVersion,
    contribution: null,
    packageRevision: installed.value.revision,
    configurationGeneration: document.value.configurationRevision,
    catalogGeneration: version.identityDigest,
    workspaceGeneration: roots,
    sessionGeneration: session === null ? null : sessionGeneration(session),
    protocolGeneration: "package-data-v1",
    authority: canonicalDigest({ actor, roots, trustGeneration, profile, session }),
  };
  const result = createPackageDataService({
    store: data,
    imports,
    now: () => Date.now(),
    authority: {
      binding,
      hostControl: true,
      principal: actor,
      allows: (scope, owner) =>
        scope === "user"
          ? owner === actor
          : scope === "project" || scope === "workspace"
            ? admitted && owner === roots
            : scope === "profile"
              ? owner === profile
              : scope === "session"
                ? (owner === session ||
                    (operation.operation === "fork" &&
                      (owner === operation.from || owner === operation.to))) &&
                  sessionGeneration(owner) !== null
                : false,
      current: () => {
        const current = packages.current(request.packageId);
        const currentTrust = services.workspaceTrust.current();
        return (
          !signal.aborted &&
          current.ok &&
          current.value.revision === binding.packageRevision &&
          current.value.current?.identityDigest === binding.packageDigest &&
          (currentTrust.inventory?.generation ?? null) === trustGeneration &&
          currentTrust.status === trust.status &&
          (services.workspaceSet === null
            ? null
            : catalogWorkspaceBinding(services.workspaceSet)) === roots &&
          (session === null || sessionGeneration(session) === binding.sessionGeneration) &&
          (operation.operation !== "fork" ||
            sessionGeneration(operation.to) === operation.generation)
        );
      },
    },
  }).run(
    {
      ...operation,
      ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
    },
    signal,
  );
  return result.status === "inspected"
    ? {
        ...result,
        payload: {
          result: result.payload,
          ...(operation.operation === "inspect"
            ? {
                effectiveConfiguration: await inspectPackageConfiguration(
                  services,
                  request.packageId,
                  profile,
                  signal,
                ),
              }
            : {}),
          scopes: {
            user: actor,
            workspace: admitted ? roots : null,
            profile,
            session,
            sessionGeneration: binding.sessionGeneration,
          },
        },
      }
    : result;
}
