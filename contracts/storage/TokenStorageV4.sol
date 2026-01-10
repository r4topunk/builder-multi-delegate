// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

/// @title TokenStorageV4
/// @notice Storage extension for per-token delegation
/// @dev This contract must be inherited AFTER TokenStorageV3 to maintain storage layout
contract TokenStorageV4 {
    /// @notice Token-level delegate mapping
    /// @dev tokenId => delegate address (address(0) means delegated to owner)
    mapping(uint256 => address) internal tokenDelegates;

    /// @notice Default maximum number of token IDs that can be processed in a single batch operation
    /// @dev Prevents out-of-gas issues and potential DoS vectors
    uint256 internal constant DEFAULT_MAX_BATCH_SIZE = 100;

    /// @notice Configurable batch size limit (0 uses default)
    uint256 internal maxBatchSizeValue;

    /// @notice Configurable checkpoint window (0 uses default)
    uint256 internal maxCheckpointsValue;

    /// @notice Number of reserved token IDs minted
    uint256 internal reserveMinted;

    /// @dev Storage gap for future upgrades
    uint256[47] private __gap;
}
