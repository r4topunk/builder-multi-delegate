// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { IERC721Votes } from "../../lib/nouns-protocol/src/lib/interfaces/IERC721Votes.sol";
import { ERC721 } from "../../lib/nouns-protocol/src/lib/token/ERC721.sol";
import { EIP712 } from "../../lib/nouns-protocol/src/lib/utils/EIP712.sol";

/// @title ERC721SplitVotes
/// @notice ERC721Votes variant without account-level delegation
abstract contract ERC721SplitVotes is IERC721Votes, EIP712, ERC721 {
    /// @dev The EIP-712 typehash to delegate with a signature
    bytes32 internal constant DELEGATION_TYPEHASH = keccak256("Delegation(address from,address to,uint256 nonce,uint256 deadline)");

    /// @notice The delegate for an account (kept for storage compatibility)
    mapping(address => address) internal delegation;

    /// @notice The number of checkpoints for an account
    mapping(address => uint256) internal numCheckpoints;

    /// @notice The checkpoint for an account
    mapping(address => mapping(uint256 => Checkpoint)) internal checkpoints;

    /// @dev Reverts when using legacy account-level delegation
    error USE_TOKEN_ID_DELEGATION();

    /// @notice The current number of votes for an account
    function getVotes(address _account) public view returns (uint256) {
        uint256 nCheckpoints = numCheckpoints[_account];
        unchecked {
            return nCheckpoints != 0 ? checkpoints[_account][nCheckpoints - 1].votes : 0;
        }
    }

    /// @notice The number of votes for an account at a past timestamp
    function getPastVotes(address _account, uint256 _timestamp) public view returns (uint256) {
        if (_timestamp >= block.timestamp) revert INVALID_TIMESTAMP();

        uint256 nCheckpoints = numCheckpoints[_account];
        if (nCheckpoints == 0) return 0;

        mapping(uint256 => Checkpoint) storage accountCheckpoints = checkpoints[_account];

        unchecked {
            uint256 lastCheckpoint = nCheckpoints - 1;

            if (accountCheckpoints[lastCheckpoint].timestamp <= _timestamp) return accountCheckpoints[lastCheckpoint].votes;
            if (accountCheckpoints[0].timestamp > _timestamp) return 0;

            uint256 high = lastCheckpoint;
            uint256 low;
            uint256 middle;
            Checkpoint memory cp;

            while (high > low) {
                middle = high - (high - low) / 2;
                cp = accountCheckpoints[middle];

                if (cp.timestamp == _timestamp) {
                    return cp.votes;
                } else if (cp.timestamp < _timestamp) {
                    low = middle;
                } else {
                    high = middle - 1;
                }
            }

            return accountCheckpoints[low].votes;
        }
    }

    /// @notice The delegate for an account (legacy view, not used for vote splitting)
    function delegates(address _account) public view returns (address) {
        address current = delegation[_account];
        return current == address(0) ? _account : current;
    }

    /// @notice Legacy account-level delegation (disabled)
    function delegate(address) external pure virtual {
        revert USE_TOKEN_ID_DELEGATION();
    }

    /// @notice Legacy account-level delegation via signature (disabled)
    function delegateBySig(
        address,
        address,
        uint256,
        uint8,
        bytes32,
        bytes32
    ) external pure virtual {
        revert USE_TOKEN_ID_DELEGATION();
    }

    /// @dev Transfers voting weight
    function _moveDelegateVotes(
        address _from,
        address _to,
        uint256 _amount
    ) internal {
        unchecked {
            if (_from != _to && _amount > 0) {
                if (_from != address(0)) {
                    uint256 newCheckpointId = numCheckpoints[_from];
                    uint256 prevCheckpointId;
                    uint256 prevTotalVotes;
                    uint256 prevTimestamp;

                    if (newCheckpointId != 0) {
                        prevCheckpointId = newCheckpointId - 1;
                        prevTotalVotes = checkpoints[_from][prevCheckpointId].votes;
                        prevTimestamp = checkpoints[_from][prevCheckpointId].timestamp;
                    }

                    _writeCheckpoint(_from, newCheckpointId, prevCheckpointId, prevTimestamp, prevTotalVotes, prevTotalVotes - _amount);
                }

                if (_to != address(0)) {
                    uint256 nCheckpoints = numCheckpoints[_to];
                    uint256 prevCheckpointId;
                    uint256 prevTotalVotes;
                    uint256 prevTimestamp;

                    if (nCheckpoints != 0) {
                        prevCheckpointId = nCheckpoints - 1;
                        prevTotalVotes = checkpoints[_to][prevCheckpointId].votes;
                        prevTimestamp = checkpoints[_to][prevCheckpointId].timestamp;
                    }

                    _writeCheckpoint(_to, nCheckpoints, prevCheckpointId, prevTimestamp, prevTotalVotes, prevTotalVotes + _amount);
                }
            }
        }
    }

    /// @dev Records a checkpoint
    function _writeCheckpoint(
        address _account,
        uint256 _newId,
        uint256 _prevId,
        uint256 _prevTimestamp,
        uint256 _prevTotalVotes,
        uint256 _newTotalVotes
    ) private {
        unchecked {
            if (_newId > 0 && _prevTimestamp == block.timestamp) {
                checkpoints[_account][_prevId].votes = uint192(_newTotalVotes);
            } else {
                Checkpoint storage checkpoint = checkpoints[_account][_newId];
                checkpoint.votes = uint192(_newTotalVotes);
                checkpoint.timestamp = uint64(block.timestamp);
                ++numCheckpoints[_account];
            }

            emit DelegateVotesChanged(_account, _prevTotalVotes, _newTotalVotes);
        }
    }

    /// @dev No automatic vote movement on transfer
    function _afterTokenTransfer(
        address _from,
        address _to,
        uint256 _tokenId
    ) internal virtual override {
        super._afterTokenTransfer(_from, _to, _tokenId);
    }
}
