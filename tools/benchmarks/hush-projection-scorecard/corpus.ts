import { HUSH_BUILD_OPERATION_CASES } from "../hush-build-operation-cases.ts";
import { HUSH_CLOUD_INFRA_CASES } from "../hush-cloud-infra-cases.ts";
import { HUSH_CONTAINER_CASES } from "../hush-container-cases.ts";
import { HUSH_KUBERNETES_CASES } from "../hush-kubernetes-cases.ts";
import { HUSH_NETWORK_CASES } from "../hush-network-cases.ts";
import type { ProjectionCase } from "../hush-projection-case.ts";

export { HUSH_FIND_LISTING_MARKERS, HUSH_FIND_LISTING_PATHS } from "./listing.ts";

import { COMPOUND_CASES } from "./cases/compound.ts";
import { COUNT_CASES } from "./cases/count.ts";
import { DIAGNOSTIC_CASES } from "./cases/diagnostic.ts";
import { FORGE_CASES } from "./cases/forge.ts";
import { GIT_DIFF_CASES } from "./cases/git-diff.ts";
import { GIT_LOG_CASES } from "./cases/git-log.ts";
import { GIT_MUTATION_CASES } from "./cases/git-mutation.ts";
import { GIT_STATUS_CASES } from "./cases/git-status.ts";
import { JSON_CASES } from "./cases/json.ts";
import { LISTING_CASES } from "./cases/listing.ts";
import { LOG_CASES } from "./cases/log.ts";
import { PACKAGE_CASES } from "./cases/package.ts";
import { READ_CASES } from "./cases/read.ts";
import { SEARCH_CASES } from "./cases/search.ts";
import { STRUCTURED_CASES } from "./cases/structured.ts";
import { TABLE_CASES } from "./cases/table.ts";
import { TEST_CASES } from "./cases/test.ts";
import { TRANSFORM_CASES } from "./cases/transform.ts";

export const HUSH_PROJECTION_CASES: readonly ProjectionCase[] = [
  ...LISTING_CASES,
  ...READ_CASES,
  ...JSON_CASES,
  ...STRUCTURED_CASES,
  ...TABLE_CASES,
  ...SEARCH_CASES,
  ...TRANSFORM_CASES,
  ...COMPOUND_CASES,
  ...GIT_STATUS_CASES,
  ...GIT_DIFF_CASES,
  ...GIT_LOG_CASES,
  ...GIT_MUTATION_CASES,
  ...FORGE_CASES,
  ...TEST_CASES,
  ...DIAGNOSTIC_CASES,
  ...HUSH_BUILD_OPERATION_CASES,
  ...PACKAGE_CASES,
  ...HUSH_CONTAINER_CASES,
  ...HUSH_KUBERNETES_CASES,
  ...HUSH_CLOUD_INFRA_CASES,
  ...HUSH_NETWORK_CASES,
  ...COUNT_CASES,
  ...LOG_CASES,
];
