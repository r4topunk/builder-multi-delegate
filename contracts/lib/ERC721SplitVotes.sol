// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { IERC721Votes } from "../../lib/nouns-protocol/src/lib/interfaces/IERC721Votes.sol";
import { ERC721 } from "../../lib/nouns-protocol/src/lib/token/ERC721.sol";
import { EIP712 } from "../../lib/nouns-protocol/src/lib/utils/EIP712.sol";

/// @title ERC721SplitVotes
/// @notice ERC721Votes variant that supports per-token delegation instead of account-level delegation
/// @dev This contract maintains storage compatibility with ERC721Votes but disables account-level
///      delegation functions. Vote tracking is handled at the token level by the inheriting contract.
abstract contract ERC721SplitVotes is IERC721Votes, EIP712, ERC721 {
    ///                                                          ///
    ///                          CONSTANTS                       ///
    ///                                                          ///

    /// @dev The EIP-712 typehash to delegate with a signature (kept for storage compatibility)
    bytes32 internal constant DELEGATION_TYPEHASH = keccak256("Delegation(address from,address to,uint256 nonce,uint256 deadline)");

    ///                                                          ///
    ///                           STORAGE                        ///
    ///                                                          ///

    /// @notice The delegate for an account (kept for storage compatibility with ERC721Votes)
    /// @dev DEPRECATED: This mapping is not used in per-token delegation. It exists only to
    ///      maintain storage layout compatibility when upgrading from ERC721Votes.
    mapping(address => address) internal delegation;

    /// @notice The number of checkpoints for an account
    /// @dev Account => Num Checkpoints
    mapping(address => uint256) internal numCheckpoints;

    /// @notice The checkpoint for an account
    /// @dev Account => Checkpoint Id => Checkpoint
    mapping(address => mapping(uint256 => Checkpoint)) internal checkpoints;

    /// @notice Maximum number of checkpoints per account to prevent bloat attacks
    uint256 internal constant MAX_CHECKPOINTS = 1000;

    ///                                                          ///
    ///                           ERRORS                         ///
    ///                                                          ///

    /// @dev Reverts when using legacy account-level delegation
    error USE_TOKEN_ID_DELEGATION();

    /// @dev Reverts when vote accounting would underflow
    error VOTE_UNDERFLOW();

    /// @dev Reverts when maximum number of checkpoints is exceeded
    error TOO_MANY_CHECKPOINTS();

    ///                                                          ///
    ///                        VOTING WEIGHT                     ///
    ///                                                          ///

    /// @notice The current number of votes for an account
    /// @param _account The account address
    /// @return The current voting weight
    function getVotes(address _account) public view returns (uint256) {
        uint256 nCheckpoints = numCheckpoints[_account];
        unchecked {
            return nCheckpoints != 0 ? checkpoints[_account][nCheckpoints - 1].votes : 0;
        }
    }

    /// @notice The number of votes for an account at a past timestamp
    /// @param _account The account address
    /// @param _timestamp The past timestamp to query
    /// @return The voting weight at the given timestamp
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

    ///                                                          ///
    ///                    DEPRECATED DELEGATION                 ///
    ///                                                          ///

    /// @notice The delegate for an account
    /// @dev DEPRECATED: In per-token delegation, this function returns stale/meaningless data.
    ///      Use tokenDelegate(tokenId) on the inheriting contract instead.
    /// @param _account The account address
    /// @return The stored delegate (may be stale after upgrade)
    function delegates(address _account) public view returns (address) {
        address current = delegation[_account];
        return current == address(0) ? _account : current;
    }

    /// @notice Legacy account-level delegation (disabled)
    /// @dev Always reverts. Use delegateTokenIds() instead.
    function delegate(address) external pure virtual {
        revert USE_TOKEN_ID_DELEGATION();
    }

    /// @notice Legacy account-level delegation via signature (disabled)
    /// @dev Always reverts. Use delegateTokenIds() instead.
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

    ///                                                          ///
    ///                      VOTE ACCOUNTING                     ///
    ///                                                          ///

    /// @dev Transfers voting weight between delegates
    /// @param _from The address losing votes (address(0) for mint)
    /// @param _to The address gaining votes (address(0) for burn)
    /// @param _amount The number of votes to transfer
    function _moveDelegateVotes(
        address _from,
        address _to,
        uint256 _amount
    ) internal {
        if (_from == _to || _amount == 0) return;

        if (_from != address(0)) {
            uint256 newCheckpointId = numCheckpoints[_from];
            uint256 prevCheckpointId;
            uint256 prevTotalVotes;
            uint256 prevTimestamp;

            if (newCheckpointId != 0) {
                unchecked {
                    prevCheckpointId = newCheckpointId - 1;
                }
                prevTotalVotes = checkpoints[_from][prevCheckpointId].votes;
                prevTimestamp = checkpoints[_from][prevCheckpointId].timestamp;
            }

            // Explicit underflow check - critical for security
            if (prevTotalVotes < _amount) revert VOTE_UNDERFLOW();

            unchecked {
                _writeCheckpoint(_from, newCheckpointId, prevCheckpointId, prevTimestamp, prevTotalVotes, prevTotalVotes - _amount);
            }
        }

        if (_to != address(0)) {
            uint256 nCheckpoints = numCheckpoints[_to];
            uint256 prevCheckpointId;
            uint256 prevTotalVotes;
            uint256 prevTimestamp;

            if (nCheckpoints != 0) {
                unchecked {
                    prevCheckpointId = nCheckpoints - 1;
                }
                prevTotalVotes = checkpoints[_to][prevCheckpointId].votes;
                prevTimestamp = checkpoints[_to][prevCheckpointId].timestamp;
            }

            // Check for overflow before adding
            if (prevTotalVotes + _amount > type(uint192).max) revert VOTE_UNDERFLOW();

            unchecked {
                _writeCheckpoint(_to, nCheckpoints, prevCheckpointId, prevTimestamp, prevTotalVotes, prevTotalVotes + _amount);
            }
        }
    }

    /// @dev Records a checkpoint
    /// @param _account The account address
    /// @param _newId The new checkpoint id
    /// @param _prevId The previous checkpoint id
    /// @param _prevTimestamp The previous checkpoint timestamp
    /// @param _prevTotalVotes The previous checkpoint voting weight
    /// @param _newTotalVotes The new checkpoint voting weight
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
                if (numCheckpoints[_account] >= MAX_CHECKPOINTS) revert TOO_MANY_CHECKPOINTS();

                Checkpoint storage checkpoint = checkpoints[_account][_newId];
                checkpoint.votes = uint192(_newTotalVotes);
                checkpoint.timestamp = uint64(block.timestamp);
                ++numCheckpoints[_account];
            }

            emit DelegateVotesChanged(_account, _prevTotalVotes, _newTotalVotes);
        }
    }

    /// @dev Hook called after token transfer - override in inheriting contract to handle delegation
    /// @param _from The sender address
    /// @param _to The recipient address
    /// @param _tokenId The ERC-721 token id
    function _afterTokenTransfer(
        address _from,
        address _to,
        uint256 _tokenId
    ) internal virtual override {
        super._afterTokenTransfer(_from, _to, _tokenId);
    }
}
