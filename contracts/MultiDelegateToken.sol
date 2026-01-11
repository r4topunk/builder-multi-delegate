// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title MultiDelegateToken
/// @notice Delegation registry that splits NFT voting power by amount
/// @dev Uses an external ERC-721 balance as source of truth (Gnars)
contract MultiDelegateToken {
    IERC721 public immutable gnarsToken;

    uint256 public constant MAX_DELEGATES_PER_OWNER = 50;

    mapping(address => mapping(address => uint256)) public delegatedAmount;
    mapping(address => uint256) public totalDelegated;
    mapping(address => uint256) public delegateVotes;

    mapping(address => address[]) private ownerDelegates;
    mapping(address => mapping(address => uint256)) private ownerDelegateIndex;

    error INVALID_DELEGATE();
    error INVALID_TOKEN_ADDRESS();
    error INSUFFICIENT_BALANCE();
    error MAX_DELEGATES_EXCEEDED();

    event DelegationUpdated(
        address indexed owner,
        address indexed delegatee,
        uint256 previousAmount,
        uint256 newAmount
    );
    event DelegateVotesChanged(address indexed delegatee, uint256 previousVotes, uint256 newVotes);
    event DelegationsCleared(address indexed owner);

    constructor(address tokenAddress) {
        if (tokenAddress == address(0)) revert INVALID_TOKEN_ADDRESS();
        gnarsToken = IERC721(tokenAddress);
    }

    /// @notice Returns the current votes for an account
    /// @dev Includes undelegated balance for the account itself
    function getVotes(address account) external view returns (uint256) {
        uint256 baseVotes = delegateVotes[account];
        uint256 balance = gnarsToken.balanceOf(account);
        uint256 delegated = totalDelegated[account];
        uint256 undelegated = balance > delegated ? balance - delegated : 0;

        return baseVotes + undelegated;
    }

    /// @notice Returns the list of delegatees for an owner
    function getDelegates(address owner) external view returns (address[] memory) {
        return ownerDelegates[owner];
    }

    /// @notice Set the delegated amount for a delegatee
    /// @dev Amount is absolute, not incremental
    function delegate(address delegatee, uint256 amount) external {
        if (delegatee == address(0)) revert INVALID_DELEGATE();

        uint256 current = delegatedAmount[msg.sender][delegatee];
        if (amount == current) return;

        if (amount > current) {
            uint256 increase = amount - current;
            _requireAvailable(msg.sender, increase);
            totalDelegated[msg.sender] += increase;
            _increaseVotes(delegatee, increase);
            _addDelegate(msg.sender, delegatee);
        } else {
            uint256 decrease = current - amount;
            totalDelegated[msg.sender] -= decrease;
            _decreaseVotes(delegatee, decrease);
            if (amount == 0) {
                _removeDelegate(msg.sender, delegatee);
            }
        }

        delegatedAmount[msg.sender][delegatee] = amount;
        emit DelegationUpdated(msg.sender, delegatee, current, amount);
    }

    /// @notice Clear delegation for a single delegatee
    function clearDelegation(address delegatee) external {
        if (delegatee == address(0)) revert INVALID_DELEGATE();
        uint256 current = delegatedAmount[msg.sender][delegatee];
        if (current == 0) return;

        delegatedAmount[msg.sender][delegatee] = 0;
        totalDelegated[msg.sender] -= current;
        _decreaseVotes(delegatee, current);
        _removeDelegate(msg.sender, delegatee);

        emit DelegationUpdated(msg.sender, delegatee, current, 0);
    }

    /// @notice Clears all delegations for msg.sender
    function clearAllDelegations() external {
        _clearAllDelegations(msg.sender);
    }

    /// @notice Clears all delegations if balance dropped below total delegated
    /// @dev Permissionless to allow vote correction after transfers
    function syncDelegations(address owner) external {
        uint256 balance = gnarsToken.balanceOf(owner);
        if (balance >= totalDelegated[owner]) return;

        _clearAllDelegations(owner);
    }

    function _requireAvailable(address owner, uint256 increase) internal view {
        uint256 balance = gnarsToken.balanceOf(owner);
        if (totalDelegated[owner] + increase > balance) revert INSUFFICIENT_BALANCE();
    }

    function _increaseVotes(address delegatee, uint256 amount) internal {
        uint256 previousVotes = delegateVotes[delegatee];
        uint256 newVotes = previousVotes + amount;
        delegateVotes[delegatee] = newVotes;
        emit DelegateVotesChanged(delegatee, previousVotes, newVotes);
    }

    function _decreaseVotes(address delegatee, uint256 amount) internal {
        uint256 previousVotes = delegateVotes[delegatee];
        uint256 newVotes = previousVotes - amount;
        delegateVotes[delegatee] = newVotes;
        emit DelegateVotesChanged(delegatee, previousVotes, newVotes);
    }

    function _addDelegate(address owner, address delegatee) internal {
        if (ownerDelegateIndex[owner][delegatee] != 0) return;
        if (ownerDelegates[owner].length >= MAX_DELEGATES_PER_OWNER) revert MAX_DELEGATES_EXCEEDED();

        ownerDelegates[owner].push(delegatee);
        ownerDelegateIndex[owner][delegatee] = ownerDelegates[owner].length;
    }

    function _removeDelegate(address owner, address delegatee) internal {
        uint256 index = ownerDelegateIndex[owner][delegatee];
        if (index == 0) return;

        uint256 removeIndex = index - 1;
        uint256 lastIndex = ownerDelegates[owner].length - 1;

        if (removeIndex != lastIndex) {
            address lastDelegate = ownerDelegates[owner][lastIndex];
            ownerDelegates[owner][removeIndex] = lastDelegate;
            ownerDelegateIndex[owner][lastDelegate] = index;
        }

        ownerDelegates[owner].pop();
        delete ownerDelegateIndex[owner][delegatee];
    }

    function _clearAllDelegations(address owner) internal {
        address[] storage delegates = ownerDelegates[owner];
        uint256 length = delegates.length;

        for (uint256 i; i < length; ++i) {
            address delegatee = delegates[i];
            uint256 amount = delegatedAmount[owner][delegatee];
            if (amount > 0) {
                _decreaseVotes(delegatee, amount);
                emit DelegationUpdated(owner, delegatee, amount, 0);
                delete delegatedAmount[owner][delegatee];
            }

            delete ownerDelegateIndex[owner][delegatee];
        }

        if (length > 0) {
            delete ownerDelegates[owner];
        }

        totalDelegated[owner] = 0;
        emit DelegationsCleared(owner);
    }
}
