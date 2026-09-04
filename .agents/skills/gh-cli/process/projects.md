# projects

Use GitHub Projects for planning across one or more repositories when the current repository or organization has chosen that model. Keep implementation ownership in repository issues unless its established process says otherwise.

## Resolve the Project

```bash
gh project list --owner OWNER --limit 100
gh project view NUMBER --owner OWNER --format json
gh project field-list NUMBER --owner OWNER --format json
gh project item-list NUMBER --owner OWNER --limit 1000 --format json
```

User and organization Projects have different owners. Treat Project, item, field, option, iteration, and repository IDs as opaque.

Projects require the `project` scope:

```bash
gh auth refresh --scopes project
```

## Model a roadmap

Prefer:

```text
Project = aggregate live roadmap
Milestone = repository release/outcome
Parent issue = cohesive outcome
Native subissue = independently reviewable slice
Checklist = below-PR task detail
PR = implementation and validation record
```

Use fields for dimensions that cut across repositories: Status, Priority, Iteration, Team, Size, Risk, or Target date. Avoid reproducing issue hierarchy or milestones as labels.

Enable built-in Parent issue and Sub-issue progress fields when hierarchy visibility matters. Views are projections over the same items, not separate plans.

## Create and configure

```bash
gh project create --owner OWNER --title "Roadmap"
gh project edit NUMBER --owner OWNER \
  --title "Roadmap" --description "Live planning owner" \
  --visibility PRIVATE
gh project link NUMBER --owner OWNER --repo OWNER/REPO
gh project field-create NUMBER --owner OWNER \
  --name Priority --data-type SINGLE_SELECT \
  --single-select-options P0,P1,P2,P3
```

Visibility, ownership, deletion, and public exposure are consequential. Confirm before broadening access or deleting/closing a Project.

Some view/layout/filter/sort configuration may remain UI-only or incompletely exposed. State that honestly; do not claim a saved view exists from README prose.

## Add and inspect items

```bash
gh project item-add NUMBER --owner OWNER \
  --url https://github.com/OWNER/REPO/issues/123
gh project item-create NUMBER --owner OWNER \
  --title "Draft discovery item" --body "Convert to an issue before implementation"
gh project item-list NUMBER --owner OWNER --limit 1000 --format json
```

Prefer real Issues and PRs for committed work. Draft items are temporary intake, not implementation owners.

Native subissues may be auto-added by Project workflows or repository linkage, but do not assume it. Verify every required issue number after creation.

## Update fields

For one human-selected item on current CLI versions, prefer readable selectors and let the CLI resolve IDs:

```bash
gh project item-edit NUMBER --owner OWNER \
  --url https://github.com/OWNER/REPO/issues/123 \
  --field Status --value "In Progress"
```

Use this only after verifying that the field and option names are unambiguous. For repeatable automation, bulk work, iteration fields, or older CLI versions, resolve IDs first:

```bash
gh project view NUMBER --owner OWNER --format json
gh project field-list NUMBER --owner OWNER --format json
gh project item-list NUMBER --owner OWNER --limit 1000 --format json
```

Then update one field per invocation:

```bash
gh project item-edit \
  --project-id PROJECT_ID \
  --id ITEM_ID \
  --field-id FIELD_ID \
  --single-select-option-id OPTION_ID

gh project item-edit \
  --project-id PROJECT_ID \
  --id ITEM_ID \
  --field-id FIELD_ID \
  --clear
```

Use `--text`, `--number`, `--date`, or `--iteration-id` for matching field types. Never derive option IDs from labels or display order.

Check `gh project item-edit --help` before relying on the readable `--field`/`--value` form. GitHub Enterprise and older CLI versions may require the node-ID form.

## Automation and workflows

Use built-in Project workflows for deterministic state transitions such as auto-add, item closed, PR merged, and status updates. Keep repository Actions for behavior that truly needs code or cross-system logic.

Before enabling automation, test a narrow example and check for loops, cross-repository scope, archived-item behavior, and whether manual states will be overwritten.

**Automation is not completion proof.** After merge or close, verify issue state, Project fields, and parent rollups per [issue-lifecycle.md](issue-lifecycle.md). Repair explicitly when the visible board is wrong.

## Project and item lifecycle

Closing a Project is reversible with the installed command's `--undo` form. Archiving an item is also reversible and is different from deleting it. Resolve owner, Project number, item ID, linked issue/PR, and current state before either operation.

Copy, link/unlink, template marking, field deletion, item deletion, and Project deletion change structure or ownership. Snapshot the Project, fields, items, workflows, links, and views first. Confirm destructive targets exactly, then verify both the Project and linked repository records. Deleting a Project item does not delete its Issue or PR, while deleting a field removes that dimension from every item.

Check current help for `close`, `copy`, `delete`, `field-delete`, `item-archive`, `item-delete`, `mark-template`, and `unlink`. GitHub Enterprise availability can differ. Never replace an unavailable native lifecycle operation with a visually similar field update.

## Audit

Verify:

- linked repositories and visibility;
- expected item count and no accidental drafts;
- every issue/PR belongs to the intended repository;
- milestone and parent relationships;
- required fields and valid options;
- duplicate items, missing items, orphaned children, and closed-item policy;
- field values after bulk updates;
- saved views or UI-only work still outstanding.

Closing or archiving a Project item does not close its Issue. Closing an Issue does not necessarily archive its item. Audit both states.
