import type { ConfigurationRegistryPort } from "../../domain/configuration/index.ts";

/** Consumers hold one port while the loader atomically publishes its validated registry. */
export function createRegistryPublication(initial: ConfigurationRegistryPort) {
  let current = initial;
  const registry: ConfigurationRegistryPort = {
    get schemaFamily() {
      return current.schemaFamily;
    },
    get schemaVersion() {
      return current.schemaVersion;
    },
    get minimumSchemaVersion() {
      return current.minimumSchemaVersion;
    },
    keys: () => current.keys(),
    describe: (path) => current.describe(path),
    resolve: (path) => current.resolve(path),
    defaults: () => current.defaults(),
    validateLayer: (document, context) => current.validateLayer(document, context),
    crossValidate: (values) => current.crossValidate(values),
    validateComplete: (document, context) => current.validateComplete(document, context),
    render: (path, value) => current.render(path, value),
  };
  return {
    registry,
    publish: (candidate: ConfigurationRegistryPort) => {
      current = candidate;
    },
  };
}
