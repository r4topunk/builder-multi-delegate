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
