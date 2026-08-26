/** Ordered Hush catalog group preserving executable matcher precedence. */

import { CLOUD_AWS_POLICY } from "../cloud/aws.ts";
import { CLOUD_COMMAND_POLICY } from "../cloud/command.ts";
import { CONTAINER_BUILD_POLICY } from "../container/build.ts";
import { CONTAINER_LOG_POLICY } from "../container/log.ts";
import { CONTAINER_OPERATION_POLICY } from "../container/operation.ts";
import { CONTAINER_TABLE_POLICY } from "../container/table.ts";
import type { HushCatalogEntry } from "../contracts.ts";
import { DATA_COMMAND_POLICY } from "../data/command.ts";
import { DIAGNOSTIC_COMMAND_POLICY } from "../diagnostic/command.ts";
import { INFRA_OPERATION_POLICY } from "../infra/operation.ts";
import { KUBERNETES_LOG_POLICY } from "../kubernetes/log.ts";
import { KUBERNETES_OPERATION_POLICY } from "../kubernetes/operation.ts";
import { KUBERNETES_TABLE_POLICY } from "../kubernetes/table.ts";
import { NETWORK_COMMAND_POLICY } from "../network/command.ts";
import { NETWORK_CURL_POLICY } from "../network/curl.ts";
import { NETWORK_WGET_POLICY } from "../network/wget.ts";
import { OPERATION_COMMAND_POLICY } from "../operation/command.ts";
import { PACKAGE_MANAGER_POLICY } from "../package/manager.ts";
import { PRECOMMIT_DIAGNOSTIC_POLICY } from "../precommit/diagnostic.ts";
import { SYSTEM_TABLE_POLICY } from "../system/table.ts";
import { TASK_BUILD_POLICY } from "../task/build.ts";

export const OPERATION_COMMANDS = [
  CONTAINER_TABLE_POLICY,
  KUBERNETES_TABLE_POLICY,
  CONTAINER_LOG_POLICY,
  KUBERNETES_LOG_POLICY,
  CONTAINER_BUILD_POLICY,
  CONTAINER_OPERATION_POLICY,
  KUBERNETES_OPERATION_POLICY,
  PACKAGE_MANAGER_POLICY,
  TASK_BUILD_POLICY,
  PRECOMMIT_DIAGNOSTIC_POLICY,
  CLOUD_AWS_POLICY,
  CLOUD_COMMAND_POLICY,
  DATA_COMMAND_POLICY,
  NETWORK_CURL_POLICY,
  NETWORK_WGET_POLICY,
  NETWORK_COMMAND_POLICY,
  INFRA_OPERATION_POLICY,
  SYSTEM_TABLE_POLICY,
  DIAGNOSTIC_COMMAND_POLICY,
  OPERATION_COMMAND_POLICY,
] as const satisfies readonly HushCatalogEntry[];
