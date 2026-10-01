"use strict";

// Label rules for pull requests. The workflow that calls these runs on
// `pull_request_target` with a label-write token, so it loads this file from the
// trusted base revision and never checks out or executes pull-request code.

const SIZE_LABELS = ["size: XS", "size: S", "size: M", "size: L", "size: XL"];
/** Changed lines below each limit get that label; anything larger is `size: XL`. */
const SIZE_LIMITS = [
  [50, "size: XS"],
  [200, "size: S"],
  [500, "size: M"],
  [1000, "size: L"],
];
const VOUCH_LABELS = ["vouch: trusted", "vouch: unvouched", "vouch: blocked"];

function isTestFile(filename) {
  return /(^|\/)(?:__tests__|test|tests)\/|\.(?:test|spec|integration|browser)\.[^/]+$/i.test(
    filename,
  );
}

/** The size label from changed lines, counting tests only when nothing else changed. */
function sizeLabel(files) {
  const lines = (list) => list.reduce((total, file) => total + file.additions + file.deletions, 0);
  const total = lines(files);
  const nonTest = lines(files.filter((file) => !isTestFile(file.filename)));
  const changed = nonTest === 0 ? total : nonTest;
  const label = SIZE_LIMITS.find(([limit]) => changed < limit)?.[1] ?? "size: XL";
  return { label, changed, total, nonTest };
}

/** The vouch label for a `mitchellh/vouch` check-user status. */
function vouchLabel(status) {
  if (status === "denounced") return "vouch: blocked";
  return ["bot", "collaborator", "vouched"].includes(status)
    ? "vouch: trusted"
    : "vouch: unvouched";
}

/**
 * Make `next` the only label of its family on the issue: remove the others, then add it
 * when missing. A label someone else removed first is not an error.
 */
async function setExclusiveLabel(github, target, family, next) {
  const { data: current } = await github.rest.issues.listLabelsOnIssue({
    ...target,
    per_page: 100,
  });
  const names = current.map((label) => label.name);
  for (const name of names.filter((label) => family.includes(label) && label !== next)) {
    try {
      await github.rest.issues.removeLabel({ ...target, name });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (!names.includes(next)) await github.rest.issues.addLabels({ ...target, labels: [next] });
}

module.exports = {
  SIZE_LABELS,
  VOUCH_LABELS,
  isTestFile,
  setExclusiveLabel,
  sizeLabel,
  vouchLabel,
};
