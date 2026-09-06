/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  CapabilityProbeError,
  CapabilityProbePort,
  CapabilityProbeResult,
  InspectProductCapabilityHealthOptions,
} from "./capability-health.ts";
export {
  DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
  DEFAULT_CAPABILITY_PROBE_TTL_MS,
  inspectProductCapabilityHealth,
  MAX_CAPABILITY_PROBE_CONCURRENCY,
  MAX_CAPABILITY_PROBE_TIMEOUT_MS,
  MAX_CAPABILITY_PROBE_TTL_MS,
  MAX_CAPABILITY_PROBES,
} from "./capability-health.ts";
export type {
  CapabilityDoctorFinding,
  CapabilityDoctorInspection,
  CapabilityInspector,
  CapabilityInspectorError,
  CapabilityPermissionFact,
  CapabilityPermissionsInspection,
  CapabilityToolsInspection,
} from "./capability-inspector.ts";
export {
  CAPABILITY_INSPECTOR_SCHEMA_VERSION,
  createCapabilityInspector,
  MAX_CAPABILITIES_PER_DOCTOR_FINDING,
  MAX_CAPABILITY_DOCTOR_FINDINGS,
} from "./capability-inspector.ts";
export {
  capabilityEntryFromTool,
  capabilityFamilyForTool,
  createProductCapabilityRegistry,
} from "./product-capability-registry.ts";
