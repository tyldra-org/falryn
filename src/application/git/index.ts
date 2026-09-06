/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type {
  GitDashboard,
  GitDashboardOptions,
  GitDashboardSnapshot,
} from "./git-dashboard.ts";
export { createGitDashboard, describeGitError } from "./git-dashboard.ts";
