/** Data command argument normalization. */

import {
  type BackupName,
  backupName,
  type GcPlanId,
  isGcPlanId,
  isOwnershipClass,
  isPlanId,
  type OwnershipClass,
} from "../../domain/index.ts";

import type {
  DataCommandArguments,
  DataLifecycleArguments,
  RawArguments,
  RunnableCommand,
} from "./contracts.ts";

export function dataArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): DataCommandArguments | null | string {
  if (command !== "data.reset" && command !== "data.uninstall") {
    return null;
  }

  if (parsed.name !== undefined) {
    return "Argument name is only valid with data backup, restore, or inspect.";
  }

  const classes = parsed.class ?? [];
  if (command === "data.reset" && classes.length === 0) {
    return "Argument class is required for data reset; name at least one ownership class.";
  }
  if (command === "data.uninstall" && classes.length > 0) {
    return "Argument class is only valid with data reset.";
  }
  const ownershipClasses: OwnershipClass[] = [];
  for (const ownershipClass of classes) {
    if (!isOwnershipClass(ownershipClass)) {
      return "Argument class must name a declared Falryn ownership class.";
    }
    ownershipClasses.push(ownershipClass);
  }
  if (parsed.confirm !== undefined && !isPlanId(parsed.confirm)) {
    return "Argument confirm must be a removal plan identity from a prior preview.";
  }
  return { classes: ownershipClasses, confirmation: parsed.confirm ?? null };
}

export function dataLifecycleArgumentsFor(
  command: RunnableCommand,
  parsed: RawArguments,
): DataLifecycleArguments | null | string {
  if (
    command !== "data.backup" &&
    command !== "data.restore" &&
    command !== "data.inspect" &&
    command !== "data.diagnostics" &&
    command !== "data.retention" &&
    command !== "data.gc"
  ) {
    return null;
  }

  if ((parsed.class?.length ?? 0) > 0) {
    return "Argument class is only valid with data reset.";
  }

  if (command === "data.retention") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with data backup, restore, or inspect.";
    }
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset, restore, or gc.";
    }
    if ((parsed["pinned-session"]?.length ?? 0) > 0) {
      return "Argument pinned-session is only valid with data gc.";
    }
    return { action: "retention" };
  }

  if (command === "data.gc") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with data backup, restore, or inspect.";
    }
    let confirmation: GcPlanId | null = null;
    if (parsed.confirm !== undefined) {
      if (!isGcPlanId(parsed.confirm)) {
        return "Argument confirm must be a garbage-collection plan identity from a prior preview.";
      }
      confirmation = parsed.confirm;
    }
    return {
      action: "gc",
      confirmation,
      pinnedSessions: parsed["pinned-session"] ?? [],
    };
  }

  if ((parsed["pinned-session"]?.length ?? 0) > 0) {
    return "Argument pinned-session is only valid with data gc.";
  }

  if (command === "data.diagnostics") {
    if (parsed.name !== undefined) {
      return "Argument name is only valid with data backup, restore, or inspect.";
    }
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset, restore, or gc.";
    }
    return { action: "diagnostics" };
  }

  if (parsed.name === undefined) {
    return "Argument name is required for data backup, restore, and inspect.";
  }
  const parsedName = backupName.parse(parsed.name);
  if (!parsedName.ok) {
    return "Argument name must be a file-safe backup name.";
  }

  if (command === "data.backup") {
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset or restore.";
    }
    return { action: "backup", name: parsedName.value };
  }

  if (command === "data.inspect") {
    if (parsed.confirm !== undefined) {
      return "Argument confirm is only valid with data reset or restore.";
    }
    return { action: "inspect", name: parsedName.value };
  }

  let confirmation: BackupName | null = null;
  if (parsed.confirm !== undefined) {
    const parsedConfirm = backupName.parse(parsed.confirm);
    if (!parsedConfirm.ok) {
      return "Argument confirm must be the backup name from a prior restore preview.";
    }
    confirmation = parsedConfirm.value;
  }
  return { action: "restore", name: parsedName.value, confirmation };
}
