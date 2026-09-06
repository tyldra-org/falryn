import { err, ok } from "../../../domain/foundation/result.ts";
import {
  type GitFetchRequest,
  type GitPort,
  type GitPullRequest,
  type GitPushRequest,
  type GitRemoteResult,
  type GitSyncRequest,
  type GitSyncResult,
  validateGitRemoteName,
  worktreeHasBlockingChanges,
} from "../../../domain/git/index.ts";
import { MAX_COMMAND_OUTPUT_BYTES } from "../../../domain/process/index.ts";
import { fieldNumber, prepareMutation, reloadIdentity, statusAt } from "./support.ts";
import type { createGitExecution } from "./transport.ts";

export function createGitRemoteOperations(
  context: Pick<
    ReturnType<typeof createGitExecution>,
    "runGitWithUserHooks" | "runGit" | "loadIdentity"
  >,
): Pick<GitPort, "fetch" | "pull" | "push" | "sync"> {
  const { runGitWithUserHooks, runGit, loadIdentity } = context;
  return {
    async fetch(request: GitFetchRequest) {
      const remote = validateGitRemoteName(request.remote);
      if (!remote.ok) {
        return remote;
      }
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      const fetched = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["fetch", "--", remote.value],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!fetched.ok) {
        return fetched;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({ identity: identity.value, remote: remote.value } satisfies GitRemoteResult);
    },

    async pull(request: GitPullRequest) {
      const remote = validateGitRemoteName(request.remote);
      if (!remote.ok) {
        return remote;
      }
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      if (mutation.identity.upstream.state !== "observed") {
        return err({ code: "no-upstream" });
      }
      const status = await statusAt(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        mutation.timeoutMs,
        mutation.signal,
        runGit,
      );
      if (!status.ok) {
        return status;
      }
      if (worktreeHasBlockingChanges(status.value)) {
        return err({ code: "dirty-worktree" });
      }
      const fetched = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["fetch", "--", remote.value],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!fetched.ok) {
        return fetched;
      }
      const merged = await runGitWithUserHooks(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["merge", "--ff-only", "@{u}"],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!merged.ok) {
        return merged;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({ identity: identity.value, remote: remote.value } satisfies GitRemoteResult);
    },

    async push(request: GitPushRequest) {
      const remote = validateGitRemoteName(request.remote);
      if (!remote.ok) {
        return remote;
      }
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      if (mutation.identity.branch.state !== "observed") {
        return err({ code: "invalid-request", reason: "detached" });
      }
      const pushed = await runGitWithUserHooks(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["push", "--", remote.value, mutation.identity.branch.value],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!pushed.ok) {
        return pushed;
      }
      const identity = await reloadIdentity(mutation);
      if (!identity.ok) {
        return identity;
      }
      return ok({ identity: identity.value, remote: remote.value } satisfies GitRemoteResult);
    },

    async sync(request: GitSyncRequest) {
      const remote = validateGitRemoteName(request.remote);
      if (!remote.ok) {
        return remote;
      }
      const prepared = await prepareMutation(request, loadIdentity);
      if (!prepared.ok) {
        return prepared;
      }
      const mutation = prepared.value;
      if (mutation.identity.upstream.state !== "observed") {
        return err({ code: "no-upstream" });
      }
      const fetched = await runGit(
        mutation.gitExecutable,
        mutation.identity.worktreeRoot,
        ["fetch", "--", remote.value],
        mutation.timeoutMs,
        mutation.signal,
        MAX_COMMAND_OUTPUT_BYTES,
      );
      if (!fetched.ok) {
        return fetched;
      }
      const afterFetch = await reloadIdentity(mutation);
      if (!afterFetch.ok) {
        return afterFetch;
      }
      const ahead = fieldNumber(afterFetch.value.ahead);
      const behind = fieldNumber(afterFetch.value.behind);
      if (ahead === null || behind === null) {
        return err({ code: "no-upstream" });
      }
      if (ahead > 0 && behind > 0) {
        return err({ code: "diverged" });
      }
      let fastForwarded = false;
      if (behind > 0) {
        const status = await statusAt(
          mutation.gitExecutable,
          afterFetch.value.worktreeRoot,
          mutation.timeoutMs,
          mutation.signal,
          runGit,
        );
        if (!status.ok) {
          return status;
        }
        if (worktreeHasBlockingChanges(status.value)) {
          return err({ code: "dirty-worktree" });
        }
        const merged = await runGitWithUserHooks(
          mutation.gitExecutable,
          afterFetch.value.worktreeRoot,
          ["merge", "--ff-only", "@{u}"],
          mutation.timeoutMs,
          mutation.signal,
          MAX_COMMAND_OUTPUT_BYTES,
        );
        if (!merged.ok) {
          return merged;
        }
        fastForwarded = true;
      }
      let pushed = false;
      if (ahead > 0) {
        if (afterFetch.value.branch.state !== "observed") {
          return err({ code: "invalid-request", reason: "detached" });
        }
        const published = await runGitWithUserHooks(
          mutation.gitExecutable,
          afterFetch.value.worktreeRoot,
          ["push", "--", remote.value, afterFetch.value.branch.value],
          mutation.timeoutMs,
          mutation.signal,
          MAX_COMMAND_OUTPUT_BYTES,
        );
        if (!published.ok) {
          return published;
        }
        pushed = true;
      }
      const identity = await reloadIdentity({ ...mutation, identity: afterFetch.value });
      if (!identity.ok) {
        return identity;
      }
      return ok({
        identity: identity.value,
        remote: remote.value,
        fetched: true,
        fastForwarded,
        pushed,
      } satisfies GitSyncResult);
    },
  };
}
