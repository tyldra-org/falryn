# Synchronize checkouts after delivery

Use the [default-checkout procedure](sync.md#synchronize-the-default-checkout-after-merge)
after verified remote landing. It owns eligibility, ancestry and preservation
checks. GitHub issue and Project reconciliation belongs to the remote delivery
contract.

Apply the procedure independently to each requested checkout. Derive order from
real dependencies, not repository names. A skipped dirty or occupied checkout
does not prevent another eligible checkout from synchronizing.

Report synchronized and skipped checkouts with relevant SHAs and reasons. Keep
branches unless their deletion is authorized. New work uses the repository's
intended base; do not automatically reuse a squash-merged branch.
