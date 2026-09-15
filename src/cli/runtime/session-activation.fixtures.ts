import { expect } from "bun:test";
import { configurationGeneration, instant, workspaceId } from "../../domain/foundation/index.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type ModelRequest,
} from "../../providers/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { createSessionNavigationController } from "../../tui/session-nav/controller.ts";
import { createCheckpointFixture } from "./history-checkpoint.fixtures.ts";
import {
  composeProductShellAttachments,
  type ProductShellAttachmentPorts,
} from "./product-shell-attachments.ts";

export async function createActivationFixture(
  register: (close: () => Promise<unknown>) => void,
  workspaceRoot?: string,
  native = false,
) {
  const f = await createCheckpointFixture(undefined, workspaceRoot);
  register(() => f.close());
  await f.services.ensureWorkspaceSet();
  const requests: ModelRequest[] = [];
  const adapter = createDeterministicProviderAdapter({
    onRequest(request) {
      requests.push(request);
    },
  });
  const profile = {
    ...adapter.identity,
    endpoint: null,
    credential: null,
    organization: null,
    project: null,
    enabledModels: [...adapter.supportedModels],
    transportCompatibility: null,
    modelCapabilities: [],
    discovery: "static" as const,
    timeouts: { connectMs: 1000, requestMs: 10000 },
  };
  const controller = new AbortController();
  register(async () => controller.abort());
  const ports: ProductShellAttachmentPorts = {
    ...(native
      ? {
          publishNativePackages: f.durable.publishNativePackages,
          rehydrateExtensions: f.durable.rehydrateExtensions,
        }
      : {}),
    records: f.durable.records,
    eventStore: f.durable.eventStore,
    clock: f.services.clock,
    fileSystem: f.services.fileSystem,
    workspaceSet: f.services.workspaceSet,
    configurationGeneration: configurationGeneration.from(0),
    artifacts: f.durable.artifacts,
    signal: controller.signal,
    provider: {
      kind: "ready",
      adapter,
      session: {
        kind: "ready",
        release: async () => {},
        connection: { profile, account: null, updatedAt: f.services.clock.now() },
        auth: {
          profileId: adapter.identity.profileId,
          state: "ready",
          consumer: "provider:activation",
          observedAt: instant(0),
          health: null,
          code: null,
          retryable: false,
        },
        catalog: catalogFromAdapterModels(adapter.supportedModels, {
          generation: 0,
          fetchedAt: instant(0),
          capabilities: adapter.modelCapabilities,
        }),
      },
    },
  };
  const attached = await composeProductShellAttachments(ports);
  if (!attached) throw new Error("missing host");
  register(() => attached.close());
  const send = async (text: string) => {
    const result = await attached.submission.submit(snapshotOf(text, requests.length + 1));
    expect(result.kind, JSON.stringify(result)).toBe("accepted");
    return requests.at(-1);
  };
  const currentId = () => String(attached.transcriptFeed.events().at(-1)?.correlation.sessionId);
  const nav = createSessionNavigationController({
    ...f.durable.records,
    events: f.durable.eventStore,
    workspaceId: workspaceId.from(f.services.workspaceSet?.roots[0]?.rootId ?? "workspace-unbound"),
    activation: attached.activation,
  });
  return { f, ports, attached, requests, send, currentId, nav, controller };
}
