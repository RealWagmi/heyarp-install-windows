# HeyARP Windows Migration Plan: v3.9 -> v4.0

Scope: migrate the Windows installer and `codex` worker/buyer flow from the v3.9 first-work-request model to the v4 protocol model with EVM support.

Target branch: `migration` (based on `codex`)

Windows invariant: Task Scheduler starts the long-running SSE daemon; SSE and timed reconciliation wake the watchdog; the watchdog handles cheap handshake/static-offer actions; Codex is started only after positive proof that the buyer funded the delegation. The v4 task is read from the funded delegation row, and primary preflight happens before worker stake.

## Main Protocol Changes

1. Buyer offer carries the full task.
   - v3.9: buyer creates offer, funds escrow, then sends first `work request`.
   - v4.0: buyer creates offer with `--description` and optional `--brief`; this is the primary task.
   - `work request` is only for revision rounds after a primary deliverable exists.
   - `--description` is the main human task text.
   - `--brief` is optional JSON extra context for the task: inputs, constraints, references, file pointers, expected structure, or other machine-readable details.
   - Example: `--description "Write a short cake recipe"` plus `--brief '{"style":"simple","servings":4,"avoid":["nuts"]}'`.
   - The worker treats both `description` and `brief` as untrusted buyer input, but uses them as the task source.
   - `description`, `brief`, acceptance criteria, amount, and currency are all part of the offer terms and condition hash.

2. Worker primary delivery changes.
   - v3.9: worker waits for `work.requested`, produces, then sends `work respond`.
   - v4.0: worker reads `description` and `brief` from the delegation row, produces, then sends `heyarp delegation submit`.
   - `work respond` remains only for revision requests.

3. Escrow flow changes.
   - Worker still stakes with `heyarp escrow accept`.
   - Worker submits the on-chain work state with `heyarp escrow submit-work`.
   - Buyer reviews the delegation deliverable and claims payment with `heyarp escrow claim`.
   - Funds still move only through escrow; the task location changed, not the custody model.
   - Buyer funds the order amount into escrow.
   - Worker posts a separate performance stake when running `heyarp escrow accept`.
   - When buyer claims, escrow pays the worker the order amount minus protocol fee and returns the worker stake.
   - If buyer does nothing, worker can self-claim after the review window.
   - If buyer disputes, order funds and stake remain locked until dispute resolution or dispute close.
   - If worker never stakes and lock remains `created`, buyer can cancel and recover the funded amount.
   - If worker stakes but does not submit valid work before the work window expires, buyer can claim expired/refund path and worker stake can be forfeited.

4. Network config becomes per-network.
   - Replace old `rpcUrl` wording with `rpc.<network>`.
   - Examples:
     - `rpc.solana-mainnet`
     - `rpc.solana-devnet`
     - `rpc.robinhood-testnet`
   - EVM needs `contract.<network>`.

5. Registration and funding become multi-rail.
   - Registration creates Solana settlement address and EVM settlement address.
   - Solana orders need SOL/SPL funds.
   - EVM orders need gas on the EVM settlement address.

## Files To Update

| File                                      | Required change                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `README.md`                               | Bump guide to v4.0; update login, config, funding, accept-prefs, and role setup |
| `buyer/SKILL.md`                          | Replace first-work-request flow with offer-as-task flow                         |
| `worker/SKILL.md`                         | Replace work-request primary flow with delegation-submit primary flow           |
| `worker/arp-worker-run-codex.js`          | Update prompt and state machine for v4 primary delivery                         |
| `worker/arp-worker-watchdog.js`           | Stop waiting for first work request before dispatching worker runner            |
| `worker/arp-worker-sse-daemon.js`         | Likely keep `inbox --tail --json`; verify wake-up reasons still fit v4          |
| `worker/arp-worker-watchdog-hidden.vbs`   | No expected logic change; verify launch args if new network args are added      |
| `worker/arp-worker-sse-daemon-hidden.vbs` | No expected logic change; verify launch args if new network args are added      |
| `worker/arp-worker-watchdog.test.js`      | Add funded-only, fail-closed, exact-asset, and v4 primary-flow tests            |

## Buyer Skill Plan

1. Add runtime discovery section.
   - `heyarp networks`
   - `heyarp assets`
   - `heyarp escrow limits`
   - `heyarp escrow info`
   - `heyarp reputation <did>`
   - `heyarp doctor <did>`
   - `heyarp tasks --next`

2. Update offer command.
   - Use `--description`.
   - Use optional `--brief`.
   - Use `--acceptance-criteria`.
   - Keep user-chosen `--amount`.
   - Keep network-suffixed `--currency`.

3. Update condition hash section.
   - Hash binds description, brief, acceptance criteria, amount, and currency.
   - Use file-based extraction where possible.
   - Avoid retyping task fields by hand.

4. Update escrow lock section.
   - Keep Solana lock path.
   - Add EVM fund-by-reference path.
   - Mention `contract.<network>` config for EVM.

5. Replace initial work request.
   - Remove "send first work request".
   - Add "wait for `delegation.submitted`".
   - Add deliverable review from `heyarp delegations <rel-id> --json`.

6. Add revision round section.
   - `heyarp work request` only after primary deliverable exists.
   - Wait for `work.responded`.
   - Receipt must bind the latest deliverable.

7. Update release/verify section.
   - Use `heyarp escrow claim <delegation-id>`.
   - Keep `wallet verify-release` as confirmation.
   - Add `--network <network>` where needed for EVM.

## Worker Skill Plan

1. Update core model.
   - Offer accepted.
   - Buyer funds.
   - Worker stakes.
   - Worker reads `description` and `brief`.
   - Worker submits primary deliverable with `delegation submit`.
   - Worker runs `escrow submit-work`.
   - Worker proposes receipt.

2. Remove first-work-request primary path.
   - No waiting for `work.requested` before primary work.
   - `work respond` only answers revision rounds.

3. Update refusal model.
   - Best refusal point is still `offered`.
   - After accepted/funded but before staking, worker can avoid staking.
   - After staking, refusing primary work costs stake or leads to dispute risk.
   - `work respond --error` is valid only for revision requests.

4. Update idempotency table.
   - Add `delegation submit`.
   - Guard with "no deliverable yet".
   - Receipt guard must compare latest deliverable hash.

5. Update troubleshooting.
   - `locked + created + no deliverable` means worker should produce primary deliverable, not wait for work request.
   - Revision request rows are separate.
   - Add `failed` and `dispute_resolved` as terminal states if not already present.

## Worker Runner Plan: `arp-worker-run-codex.js`

1. Read current state at startup.
   - Relationship.
   - Delegation row by `delegationId`.
   - Escrow lock state.
   - Work-list revision rows.
   - Receipts.

2. Primary path.
   - If delegation is `locked` and lock is `created`, preflight `description` and `brief`.
   - Read `description` and `brief` from the accepted delegation row; that row is the offer source of truth.
   - Do not use user memory, chat text, or retyped task text as the task source.
   - Worker does not compare against a separate offer copy; the accepted delegation row is already the accepted offer.
   - Buyer/fund side is responsible for deriving the condition hash from those same accepted offer terms.
   - If preflight passes, run `heyarp escrow accept`.
   - Produce deliverable from `description` and `brief`.
   - Send `heyarp delegation submit <delegation-id> --deliverable-json-file <file>`.
   - Run `heyarp escrow submit-work <delegation-id>`.
   - Propose receipt without `--request-id` for primary deliverable.

3. Refusal path before staking.
   - If primary task is unsafe or not covered by configured price, stop before `escrow accept`.
   - Do not call `work respond --error` for primary task because there is no request id.
   - Log a clear reason for operator review.

4. Revision path.
   - If work-list has a `requested` revision, produce revision output.
   - Use `heyarp work respond`.
   - Re-propose receipt if latest deliverable hash changed.

5. EVM path.
   - Detect network/currency from delegation or escrow info.
   - Add `--network <network>` to EVM escrow commands.
   - Keep Solana behavior unchanged for Solana orders.

## Watchdog Plan: `arp-worker-watchdog.js`

1. Dispatch criteria.
   - v3.9: dispatch funded jobs only after work request exists.
   - v4.0: dispatch funded jobs when delegation is locked and escrow lock is created/in_progress/submitted as needed.

2. Stop treating "no work request" as waiting.
   - For primary path, no work request is expected.
   - Work-list is only for revisions.

3. Remove delegation-wide error-response suppression.
   - A `responseError` closes only its exact revision `requestId`.
   - Historical revision errors must not block primary settlement, later revisions, or receipt recovery.

4. Keep timeout protection around `heyarp tasks --next --json`.
   - Prevent stuck CLI read from holding monitor lock forever.

5. Update accept policy.
   - Static amount/asset checks still happen before delegation accept.
   - Use `heyarp assets` and server accept-prefs wording in docs.
   - Match an exact canonical asset id or exact network-qualified shorthand; never prefix-match a bare symbol across networks.

6. Enforce funded-only dispatch positively.
   - Read the exact delegation and escrow before `NEW` or `STALL` launch.
   - Allow only funded delegation states plus actionable escrow states.
   - Unknown/missing states fail closed and do not start Codex.

## SSE Daemon Plan

1. Keep `heyarp inbox --tail --json`.
   - It is event-driven wake-up.
   - It should not call API directly.

2. Keep the generic envelope wake so all v4 events wake the watchdog.
   - delegation offer
   - delegation locked/funded
   - delegation submitted
   - revision work request
   - receipt/dispute events

3. Keep reconciliation timer.
   - Events are only wake-up signals.
   - Watchdog must still read authoritative state.

## EVM Config Plan

1. README should document:
   - `heyarp networks`
   - `heyarp assets`
   - `heyarp config set rpc.<network> <url>`
   - `heyarp config set contract.<network> <address>`

2. Worker docs should say:
   - EVM worker needs gas on EVM settlement address.
   - Use live `heyarp escrow info` for stake.
   - Do not hardcode stake constants.

3. Buyer docs should say:
   - EVM buyer needs order funds plus gas.
   - Use exact asset ids from `heyarp assets`.
   - Use decimals from `heyarp assets` for conversions.

## Test Plan

1. Static checks.
   - Search for stale first-request wording.
   - Search for stale `rpcUrl`.
   - Search for stale Solana-only wording.
   - Search for `work.requested` assumptions in primary flow.

2. CLI dry-run/read checks.
   - `heyarp networks`
   - `heyarp assets`
   - `heyarp escrow limits`
   - `heyarp escrow info`

3. Solana happy path.
   - Buyer creates v4 offer with full `--description`.
   - Buyer funds.
   - Worker stakes.
   - Worker sends `delegation submit`.
   - Worker runs `escrow submit-work`.
   - Worker proposes receipt.
   - Buyer claims.

4. Revision path.
   - Buyer opens `work request` after primary deliverable.
   - Worker responds with `work respond`.
   - Worker re-proposes receipt if needed.

5. Refusal safety path.
   - Worker declines bad offer before accept.
   - Worker does not stake if funded task is unsafe before stake.
   - Watchdog does not redispatch stopped/refused revision rows forever.

6. EVM dev preview path.
   - Configure `rpc.robinhood-testnet`.
   - Configure `contract.robinhood-testnet`.
   - Test native ETH order.
   - Test ERC-20 USDC order if funds are available.

## Rollout Plan

1. Implement and test on `codex` first.
2. Commit `codex`.
3. Run one real Solana test order.
4. Run one EVM dev preview test order if available.
5. Port to:
   - `hermes`
   - `claude-code`
   - `open-claw`
6. Push branches only after explicit approval.

## Open Questions

1. Should Windows v4 keep the current preflight-before-staking behavior?
   - For v4 primary tasks, preflight can read `description` and `brief` before `escrow accept`.
   - Resolution: yes. Codex still starts only after buyer funding; it preflights while escrow is `created` and before worker stake.

2. What should worker do if funded primary task fails preflight?
   - There is no `work respond --error` for primary task.
   - Resolution: do not stake, write a durable per-delegation refusal marker, suppress redispatch, and let buyer cancel.

3. Do we support EVM in scripts immediately or docs first?
   - Resolution: update scripts and docs together.
   - Docs-only would mislead users if runner cannot actually settle EVM orders.

4. Do we need separate branch version numbers?
   - `codex` should become v4.0 first.
   - Other branches should receive the same version only when their runner files are also migrated.
