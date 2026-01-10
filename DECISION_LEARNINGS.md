# Decision Learnings Log (Commit-Linked)

Template note (append-only): This document is additions only. Never edit or remove past entries. Add new entries by appending at the end, using the template below.

Template for new entries (append at end):
- Date/time (local): YYYY-MM-DD HH:MM:SS TZ
- Related commits: <hashes and titles>
- Decision summary: <what was decided>
- Rationale: <why it was decided>
- Implications / follow-ups: <what this changes, what still needs attention>

## Commit-linked context
- 5619b5f: Task list defined explicit delegation-only model and upgrade checklist.
- 9aeea2a: Initial multi-delegate token implementation and baseline tests/docs.
- 0d0a0c7: Fixed self-transfer behavior to avoid clearing delegation.
- 4cbc30f: Switched to auto-delegation to owner on mint/transfer; tests updated.
- 5b299ac: Security hardening (underflow checks, batch limits, storage safety), expanded tests.
- 75bf70a: Added founders/minting/reserve coverage.
- 0b04f4a: Large edge-case test suite for limits and boundaries.
- 4125152: Reentrancy guards, checkpoint cap, mint overflow protection, advanced security tests/docs.

## Entry
- Date/time (local): 2026-01-10 00:09:26 -03
- Related commits: 5619b5f, 9aeea2a, 0d0a0c7, 4cbc30f, 5b299ac, 75bf70a, 0b04f4a, 4125152
- Decision summary: The project evolved from an explicit-delegation-only model to auto-delegation on mint/transfer, and progressively tightened security with underflow checks, batch limits, reentrancy guards, storage layout safety, and checkpoint caps. Test coverage broadened to founders, reserves, edge cases, and adversarial scenarios.
- Rationale: The shift to auto-delegation aligns vote availability with ownership by default, while later hardening reduces exploitation risk and improves governance safety under adversarial usage. Expanded tests reflect a risk-driven mindset focused on boundary conditions and regression prevention.
- Implications / follow-ups: Documentation and frontend expectations must match the auto-delegation behavior; upgrade/migration strategy for legacy delegations should be defined; checkpoint caps and reserve calculations should be validated for long-term liveness.

## Entry
- Date/time (local): 2026-01-10 10:51:09 -0300
- Related commits: 74f89ed (security audit and vulnerability testing)
- Decision summary: Comprehensive security audit revealed checkpoint griefing attack vector (MAX_CHECKPOINTS=1000 exploitable), missing storage gaps in TokenStorageV4, no approved operator delegation support, trusted external contracts (metadata renderer), and timestamp manipulation risks in getPastVotes. Created test/criticalVulnerabilities.test.ts proving checkpoint lock attack (~2.3B gas cost). Overall security rating: 7.5/10 - strong but needs checkpoint management solution.
- Rationale: MAX_CHECKPOINTS prevents storage bloat DoS but creates griefing vector where attacker can lock delegate addresses by forcing 1000 checkpoint writes through alternating delegations. No pruning mechanism means permanent lock. Storage gaps omitted from V4 risks future upgrade collisions. Metadata renderer trusted without validation enables DoS. Block.timestamp vs block.number trade-off favors user-friendly timestamps despite ~15s manipulation window. No operator support limits composability but simplifies security model.
- Implications / follow-ups: CRITICAL - Implement checkpoint pruning or sliding window mechanism before mainnet; add storage gap uint256[50] to TokenStorageV4; consider governance timelock/delay to mitigate timestamp manipulation; add metadata renderer validation or circuit breaker; evaluate operator delegation support vs security trade-offs; document all trust assumptions for integrators; recommend professional audit before production; set up monitoring for addresses approaching checkpoint limits; consider emergency pause mechanism for delegation operations; evaluate using block.number for governance-critical getPastVotes queries.

## Entry
- Date/time (local): 2026-01-10 13:09:03 -0300
- Related commits: 8c892c7 (Fix checkpoint pruning and delegation guards)
- Decision summary: Replaced the hard checkpoint cap with a rolling checkpoint window, added metadata renderer failure containment, enabled approved-operator delegation, tightened founder/minter validation, and reserved storage gap in TokenStorageV4. Updated tests and docs to reflect auto-delegation and retention behavior.
- Rationale: The checkpoint cap created a governance liveness lockout. Rolling retention preserves bounded history without freezing delegation. Renderer failures and gas griefing are contained to avoid mint DoS. Operator delegation restores ERC-721 composability. Additional validation and storage gaps reduce upgrade and configuration risk.
- Implications / follow-ups: getPastVotes now reverts with CHECKPOINTS_PRUNED for pruned history—governance snapshots must stay within the retention window; monitor MetadataRendererFailed events; consider making checkpoint window and renderer gas stipend configurable if needed.
