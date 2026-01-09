# Multi-Delegate Governance for Gnars (Builder Protocol)

Context:
- Chain: Base
- DAO: Gnars (Builder frontend)
- Scope: governance voting only
- Delegation does NOT count until explicit delegation
- Tests: Hardhat + TypeScript

## Task List
- [ ] Confirm Solidity version and Builder/Nouns Builder contract dependencies used by Gnars to preserve compatibility and storage layout.
- [ ] Determine whether the Gnars Token implements ERC721Enumerable (or tokenOfOwnerByIndex) to decide delegate-all behavior.
- [ ] Verify Token/Governor are proxies and capture current implementation addresses for safe upgrades.
- [ ] Finalize per-token delegation model (each NFT => 1 delegatee) and event schema.
- [ ] Define behavior for existing delegate/delegateBySig:
  - [ ] If enumerable: allow delegate() to apply to all tokenIds owned by caller.
  - [ ] If not enumerable: revert with clear error; require batch tokenId delegation.
- [ ] Implement new Token contract (upgradeable implementation) extending current Builder token.
- [ ] Add storage: token-level delegate mapping and checkpointed vote tracking per delegate.
- [ ] Implement delegation API:
  - [ ] delegateTokenIds(address delegatee, uint256[] tokenIds)
  - [ ] clearTokenDelegation(uint256[] tokenIds)
- [ ] Update mint/transfer/burn hooks:
  - [ ] Remove votes from previous delegate for each token.
  - [ ] Clear delegation on transfer (reset).
  - [ ] Do not auto-delegate on mint.
- [ ] Preserve IVotes compatibility (getVotes/getPastVotes) for Governor integration.
- [ ] Add events for per-token delegation and revocation.
- [ ] Set up Hardhat + TS project:
  - [ ] hardhat.config.ts with Base RPC via env var
  - [ ] TypeChain + Ethers + Chai
- [ ] Write tests (TS):
  - [ ] Split delegation across multiple delegates
  - [ ] Redelegation of a tokenId
  - [ ] Transfer resets delegation and votes
  - [ ] Snapshot correctness (getVotes/getPastVotes)
  - [ ] delegate() revert path if non-enumerable
- [ ] Write integration docs for Gnars frontend:
  - [ ] UI flow to select tokenIds for delegation
  - [ ] Example calls for delegateTokenIds/clearTokenDelegation
  - [ ] Reminder: votes count only after delegation
- [ ] Upgrade plan:
  - [ ] Deploy new implementation
  - [ ] Submit upgrade proposal via Governor/Executor
  - [ ] Post-upgrade verification checklist
