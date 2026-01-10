# Frontend Integration Guide (Gnars + Base)

This guide explains how to integrate split delegation (per tokenId) into the Gnars frontend.

## Overview
- Votes auto-delegate to the token owner on mint and transfer.
- Delegation is per tokenId (1 NFT = 1 vote).
- Explicit delegation overrides auto-delegation; clearing returns votes to the owner.
- Legacy `delegate` and `delegateBySig` are disabled.
- Approved ERC-721 operators (per-token or `setApprovalForAll`) can delegate/clear on behalf of owners.

## Contract Addresses (Gnars on Base)
- Token (ERC-721): `0x880fb3cf5c6cc2d7dfc13a993e839a9411200c17`
- Auction House: `0x494eaa55ecf6310658b8fc004b0888dcb698097f`
- Governor: `0x3dd4e53a232b7b715c9ae455f4e732465ed71b4c`
- Treasury/Executor: `0x72ad986ebac0246d2b3c565ab2a1ce3a14ce6f88`
- Metadata Renderer: `0xdc9799d424ebfdcf5310f3bad3ddcce3931d4b58`

## Required UI Flow
1) **Fetch tokenIds owned by the user** (off-chain indexing).
2) **User selects X tokenIds** to delegate.
3) **Call `delegateTokenIds(delegatee, tokenIds[])`.**
4) Display votes via `getVotes(delegatee)`.

If the token does **not** implement `ERC721Enumerable`, the UI must supply explicit tokenIds.

## Contract Functions
### Delegate specific tokenIds
```solidity
function delegateTokenIds(address delegatee, uint256[] calldata tokenIds) external;
```

### Clear delegation for tokenIds
```solidity
function clearTokenDelegation(uint256[] calldata tokenIds) external;
```

### Read current delegate for a tokenId
```solidity
function tokenDelegate(uint256 tokenId) external view returns (address);
```

### Read votes (Governor expects this)
```solidity
function getVotes(address account) external view returns (uint256);
function getPastVotes(address account, uint256 blockNumber) external view returns (uint256);
```
Note: `getPastVotes` expects a past block number and can revert with `CHECKPOINTS_PRUNED` if the block is older than the retained checkpoint window.

### Admin configuration (owner-only)
```solidity
function maxBatchSize() external view returns (uint256);
function setMaxBatchSize(uint256 newMaxBatchSize) external;
function maxCheckpoints() external view returns (uint256);
function setMaxCheckpoints(uint256 newMaxCheckpoints) external;
```
`setMaxCheckpoints` is only allowed before any minting occurs to preserve ring-buffer indexing.

## Example Calls (ethers v6)
```ts
import { ethers } from "ethers";

const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, signer);

// Delegate tokenIds 12, 14, 15 to delegatee
await token.delegateTokenIds(delegatee, [12, 14, 15]);

// Clear delegation for tokenIds 12, 15
await token.clearTokenDelegation([12, 15]);

// Read votes
const votes = await token.getVotes(delegatee);
```

## UX Notes
- Votes are available immediately on mint/transfer via auto-delegation to the owner.
- After transfer, explicit delegation for that tokenId is cleared and votes move to the new owner.
- For split delegation, show the user how many tokenIds are delegated to each address.
- Historical vote queries use block numbers and retain a sliding window of the most recent 1000 checkpoints per delegate by default.
- Batch delegation defaults to 100 tokenIds per call and is owner-configurable.

## Upgrade Notes
- The new token implementation must be registered by the Builder manager and upgraded via Governor/Executor.
- Storage layout must be preserved; do not reorder existing storage variables.
