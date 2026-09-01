/** Shared read-only `/tools`, `/doctor`, and `/permissions` action boundary. */

import {
  type CapabilityHealthCode,
  type CapabilityHealthQuery,
  type CapabilityHealthQueryResult,
  type CapabilityHealthSnapshot,
  type CapabilityId,
  EFFECT_CLASSES,
  type EffectClass,
  queryCapabilityHealth,
  type Result,
} from "../domain/index.ts";

export const CAPABILITY_INSPECTOR_SCHEMA_VERSION = 1;
export const MAX_CAPABILITY_DOCTOR_FINDINGS = 64;
export const MAX_CAPABILITIES_PER_DOCTOR_FINDING = 16;

export type CapabilityToolsInspection = {
  readonly schemaVersion: typeof CAPABILITY_INSPECTOR_SCHEMA_VERSION;
  readonly action: "tools";
  readonly snapshot: Pick<
    CapabilityHealthSnapshot,
    "generation" | "consumer" | "observedAt" | "discoveryHandle" | "summary"
  >;
  readonly result: CapabilityHealthQueryResult;
};

export type CapabilityPermissionFact = {
  readonly effect: EffectClass;
  readonly allowed: boolean;
  readonly registered: number;
  readonly selectable: number;
  readonly denied: number;
  readonly unavailable: number;
};

export type CapabilityPermissionsInspection = {
  readonly schemaVersion: typeof CAPABILITY_INSPECTOR_SCHEMA_VERSION;
  readonly action: "permissions";
  readonly generation: CapabilityHealthSnapshot["generation"];
  readonly consumer: CapabilityHealthSnapshot["consumer"];
  readonly effects: readonly CapabilityPermissionFact[];
  readonly mutationAction: "settings.permissions";
  readonly readOnly: true;
};

export type CapabilityDoctorFinding = {
  readonly code: CapabilityHealthCode;
  readonly count: number;
  readonly capabilityIds: readonly CapabilityId[];
  readonly omitted: number;
  readonly recoveryHandles: readonly string[];
};

export type CapabilityDoctorInspection = {
  readonly schemaVersion: typeof CAPABILITY_INSPECTOR_SCHEMA_VERSION;
  readonly action: "doctor";
  readonly generation: CapabilityHealthSnapshot["generation"];
  readonly consumer: CapabilityHealthSnapshot["consumer"];
  readonly healthy: boolean;
  readonly findings: readonly CapabilityDoctorFinding[];
  readonly omittedFindings: number;
  readonly readOnly: true;
};

export type CapabilityInspectorError =
  | { readonly code: "query-rejected"; readonly reason: string }
  | { readonly code: "stale-generation"; readonly reason: string };

export type CapabilityInspector = {
  tools(query?: CapabilityHealthQuery): Result<CapabilityToolsInspection, CapabilityInspectorError>;
  permissions(): CapabilityPermissionsInspection;
  doctor(): CapabilityDoctorInspection;
};

function queryError(reason: { readonly code: string }): CapabilityInspectorError {
  return reason.code === "stale-generation"
    ? { code: "stale-generation", reason: reason.code }
    : { code: "query-rejected", reason: reason.code };
}

function permissionFacts(snapshot: CapabilityHealthSnapshot): readonly CapabilityPermissionFact[] {
  return EFFECT_CLASSES.map((effect) => {
    const entries = snapshot.entries.filter((entry) => entry.effect === effect);
    return {
      effect,
      allowed: entries.some((entry) => entry.selectable),
      registered: entries.length,
      selectable: entries.filter((entry) => entry.selectable).length,
      denied: entries.filter((entry) => entry.health === "denied").length,
      unavailable: entries.filter((entry) => !entry.available).length,
    };
  });
}

function doctorFindings(snapshot: CapabilityHealthSnapshot): {
  readonly findings: readonly CapabilityDoctorFinding[];
  readonly omittedFindings: number;
} {
  const grouped = new Map<
    CapabilityHealthCode,
    { capabilityIds: CapabilityId[]; recoveryHandles: Set<string>; count: number }
  >();
  for (const entry of snapshot.entries) {
    for (const diagnostic of entry.diagnostics) {
      const group = grouped.get(diagnostic.code) ?? {
        capabilityIds: [],
        recoveryHandles: new Set<string>(),
        count: 0,
      };
      group.count += 1;
      if (group.capabilityIds.length < MAX_CAPABILITIES_PER_DOCTOR_FINDING) {
        group.capabilityIds.push(entry.capabilityId);
      }
      if (diagnostic.recovery !== null) group.recoveryHandles.add(diagnostic.recovery.handle);
      grouped.set(diagnostic.code, group);
    }
  }
  const all = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, value]) => ({
      code,
      count: value.count,
      capabilityIds: Object.freeze(value.capabilityIds),
      omitted: Math.max(0, value.count - value.capabilityIds.length),
      recoveryHandles: Object.freeze([...value.recoveryHandles].sort()),
    }));
  return {
    findings: Object.freeze(all.slice(0, MAX_CAPABILITY_DOCTOR_FINDINGS)),
    omittedFindings: Math.max(0, all.length - MAX_CAPABILITY_DOCTOR_FINDINGS),
  };
}

export function createCapabilityInspector(snapshot: CapabilityHealthSnapshot): CapabilityInspector {
  return {
    tools(query = {}) {
      const result = queryCapabilityHealth(snapshot, query);
      if (!result.ok) return { ok: false, error: queryError(result.error) };
      return {
        ok: true,
        value: {
          schemaVersion: CAPABILITY_INSPECTOR_SCHEMA_VERSION,
          action: "tools",
          snapshot: {
            generation: snapshot.generation,
            consumer: snapshot.consumer,
            observedAt: snapshot.observedAt,
            discoveryHandle: snapshot.discoveryHandle,
            summary: snapshot.summary,
          },
          result: result.value,
        },
      };
    },
    permissions() {
      return {
        schemaVersion: CAPABILITY_INSPECTOR_SCHEMA_VERSION,
        action: "permissions",
        generation: snapshot.generation,
        consumer: snapshot.consumer,
        effects: permissionFacts(snapshot),
        mutationAction: "settings.permissions",
        readOnly: true,
      };
    },
    doctor() {
      const grouped = doctorFindings(snapshot);
      return {
        schemaVersion: CAPABILITY_INSPECTOR_SCHEMA_VERSION,
        action: "doctor",
        generation: snapshot.generation,
        consumer: snapshot.consumer,
        healthy: grouped.findings.length === 0,
        findings: grouped.findings,
        omittedFindings: grouped.omittedFindings,
        readOnly: true,
      };
    },
  };
}
