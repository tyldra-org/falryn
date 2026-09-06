import { MAX_GIT_REMOTE_URL_LENGTH } from "./contracts.ts";

export function redactGitRemoteUrl(url: string): string {
  const trimmed =
    url.length > MAX_GIT_REMOTE_URL_LENGTH ? url.slice(0, MAX_GIT_REMOTE_URL_LENGTH) : url;
  return trimmed.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}
