import { join } from "node:path";
import { createPackageExecutionAdmission } from "../../application/extensions/package-execution-admission.ts";
import { packageToolContract } from "../../application/extensions/package-tool-contract.ts";
import {
  type PreparedPackage,
  preparePackage,
} from "../../application/extensions/prepare-package.ts";
import type { CatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { rootChild } from "../../data/index.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { catalogEntryKey } from "../../domain/extensions/catalog.ts";
import type { InstalledPackage } from "../../domain/extensions/lifecycle.ts";
import {
  type NativeActivation,
  type NativeActivationStore,
  nativeActivationKey,
} from "../../domain/extensions/native-activation.ts";
import { PACKAGE_TOOL_PROTOCOL } from "../../domain/extensions/package-health.ts";
import { type ScopeControl, scopeControlKey } from "../../domain/extensions/scope-controls.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { validateHealthExecutable } from "../../integrations/extensions/host-package-health.ts";
import { FALRYN_VERSION } from "../version.ts";
import { composeExtensionCatalog } from "./extension-catalog.ts";
import {
  createProductSandbox,
  SANDBOX_CONFIGURATION_KEY,
  sandboxConfigurationSchema,
} from "./sandbox-configuration.ts";
import type { Services } from "./services.ts";

/** One host context supplies scope, installed bytes, configuration, trust and native activation. */
export function createNativePackageContext(options: {
  services: Services;
  records: CatalogRepositories;
  activations: NativeActivationStore;
  session?: string;
}) {
  const { services, records } = options;
  const metadata = composeExtensionCatalog(options);
  const root = rootChild(services.localData.layout, "state");
  if (!root) throw new ExtensionInputError("native-package-root-unavailable");
  const bytes = createHostPackageCache(join(root, "packages"));
  const host = {
    falryn: FALRYN_VERSION,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
  };
  const policy = () => {
    const configuration = services.loader.current();
    const parsed = sandboxConfigurationSchema.safeParse(
      configuration?.values[SANDBOX_CONFIGURATION_KEY],
    );
    return {
      mode: parsed.success ? parsed.data.mode : "unavailable",
      generation: Number(configuration?.generation ?? 0),
    };
  };
  const sandbox = createProductSandbox({
    values: () => services.loader.current()?.values ?? {},
    configuration: () => services.loader.current(),
    generation: () => policy().generation,
    now: () => Number(services.clock.now()),
    workspaceRoot: null,
  });
  const qualified = () => policy().mode === "strict" && sandbox.probe().status === "available";
  function configuration(installed: InstalledPackage) {
    return canonicalDigest(installed.current?.dataDeclarations ?? null);
  }
  async function capture(signal: AbortSignal) {
    const catalog = await metadata.captureMetadata(signal);
    if (catalog.status === "failed") throw new ExtensionInputError(catalog.code);
    const authority = await metadata.authorityContext(signal);
    const controls = records.controls.list(
      authority.actor,
      authority.authorities.map(({ authority }) => ({ scope: authority.scope, id: authority.id })),
    );
    if (!controls.ok) throw new ExtensionInputError(controls.error.code);
    return { catalog: catalog.catalog, authority, controls: controls.value };
  }
  async function admission(
    control: ScopeControl,
    installed: InstalledPackage,
    contribution: string | null,
    signal: AbortSignal,
  ) {
    const captured = await capture(signal);
    const entries = captured.catalog.entries.filter(
      (entry) =>
        entry.source.kind === "package" &&
        entry.source.owner.packageId === installed.packageId &&
        entry.source.activation.scope === control.authority.scope &&
        entry.source.activation.scopeAuthorityId === control.authority.id &&
        (contribution === null || canonicalDigest(entry.contribution) === contribution),
    );
    const trust = await metadata.trustProjection(installed);
    return {
      trusted: trust?.eligible === true,
      enabled: captured.authority.actor === control.actor && entries.some((entry) => entry.enabled),
      inputs: canonicalDigest({
        catalog: captured.catalog.inputs,
        policy: policy(),
        configuration: services.loader.current()?.values ?? {},
      }),
      strict: qualified(),
      catalogGeneration: captured.catalog.generation,
    };
  }
  async function inspect(installed: InstalledPackage, signal: AbortSignal) {
    if (!installed.current) throw new ExtensionInputError("native-package-not-installed");
    const snapshot = await bytes.read(installed.current, signal);
    const prepared = await preparePackage({ read: async () => snapshot }, host, {
      candidates: installed.current.dependencies,
      locked: installed.current.dependencies,
      signal,
    });
    if (!prepared.ok) throw new ExtensionInputError(prepared.code);
    if (prepared.package.identityDigest !== installed.current.identityDigest)
      throw new ExtensionInputError("native-package-bytes-changed");
    return { snapshot, prepared: prepared.package };
  }
  async function validate(
    control: ScopeControl,
    installed: InstalledPackage,
    contribution: string,
    signal: AbortSignal,
  ) {
    if (!qualified()) throw new ExtensionInputError("native-tool-host-unavailable");
    const admitted = await createPackageExecutionAdmission({
      packages: records.packages,
      bytes,
      host,
      protocol: PACKAGE_TOOL_PROTOCOL,
      authority: (installed, contribution, signal) =>
        admission(control, installed, contribution, signal),
    })(
      {
        packageId: installed.packageId,
        expectedRevision: installed.revision,
        contribution,
        requiredControls: [],
      },
      signal,
    );
    const inspected = await inspect(installed, signal);
    const selected = inspected.prepared.contributions.find(
      (entry) => entry.identityDigest === contribution,
    );
    if (!selected) throw new ExtensionInputError("native-contribution-missing");
    packageToolContract(selected);
    const executable = admitted.snapshot.files.find(
      (file) => file.path === admitted.declaration.execution?.executable,
    );
    if (!executable) throw new ExtensionInputError("native-tool-executable-missing");
    const failure = validateHealthExecutable(executable.bytes);
    if (failure) throw new ExtensionInputError(failure);
    return admitted;
  }
  async function registered(signal: AbortSignal) {
    const captured = await capture(signal);
    const packages = new Map<string, PreparedPackage>();
    const activations = new Map<string, NativeActivation>();
    const controls = new Map<string, ScopeControl>();
    let inventoryBytes = 0;
    const trust = new Map<
      string,
      NonNullable<Awaited<ReturnType<typeof metadata.trustProjection>>>
    >();
    for (const control of captured.controls) {
      const stored = options.activations.get(
        nativeActivationKey({ actor: control.actor, scopeKey: scopeControlKey(control) }),
      );
      if (!stored.ok) throw new ExtensionInputError(stored.error.code);
      const activation = stored.value;
      if (!activation) continue;
      const current = records.packages.current(control.package.packageId);
      if (!current.ok) throw new ExtensionInputError(current.error.code);
      if (
        current.value.revision !== activation.installedRevision ||
        current.value.current?.identityDigest !== activation.package ||
        control.scopeBinding !== activation.scopeBinding ||
        configuration(current.value) !== activation.configuration ||
        canonicalDigest(control.authority) !== canonicalDigest(activation.authority)
      )
        continue;
      if (!packages.has(activation.package)) {
        inventoryBytes += current.value.current.byteLength;
        if (inventoryBytes > 67_108_864)
          throw new ExtensionInputError("native-inventory-exhausted");
        const inspected = await inspect(current.value, signal);
        packages.set(activation.package, inspected.prepared);
      }
      const projected = await metadata.trustProjection(current.value);
      if (projected) trust.set(activation.package, projected);
      for (const entry of captured.catalog.entries) {
        if (
          entry.source.kind !== "package" ||
          entry.contribution.owner.digest !== activation.package ||
          entry.source.activation.scope !== activation.authority.scope ||
          entry.source.activation.scopeAuthorityId !== activation.authority.id
        )
          continue;
        activations.set(catalogEntryKey(entry), activation);
      }
      controls.set(canonicalDigest(activation), control);
    }
    const after = await capture(signal);
    if (captured.catalog.identity !== after.catalog.identity)
      throw new ExtensionInputError("stale-native-publication");
    for (const activation of activations.values()) {
      const current = options.activations.get(nativeActivationKey(activation));
      if (
        !current.ok ||
        current.value === null ||
        canonicalDigest(current.value) !== canonicalDigest(activation)
      )
        throw new ExtensionInputError("stale-native-activation");
    }
    return { ...captured, packages, activations, controls, trust };
  }
  return {
    metadata,
    root,
    bytes,
    host,
    policy,
    qualified,
    capture,
    admission,
    inspect,
    validate,
    registered,
    configuration,
  };
}
