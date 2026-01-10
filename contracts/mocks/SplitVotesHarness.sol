// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ERC721SplitVotes } from "../lib/ERC721SplitVotes.sol";

contract SplitVotesHarness is ERC721SplitVotes {
    function initialize() external initializer {
        __ERC721_init("SplitVotesHarness", "SVH");
        __EIP712_init("SplitVotesHarness", "1");
    }

    function seedCheckpoint(address account, uint256 index, uint64 timestamp, uint192 votes) external {
        checkpoints[account][index] = Checkpoint({ timestamp: timestamp, votes: votes });
    }

    function setCheckpointMeta(address account, uint256 start, uint256 count) external {
        numCheckpoints[account] = (start << CHECKPOINT_INDEX_SHIFT) | count;
    }

    function moveVotes(address from, address to, uint256 amount) external {
        _moveDelegateVotes(from, to, amount);
    }
}
