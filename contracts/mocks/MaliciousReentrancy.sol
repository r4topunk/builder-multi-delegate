// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @notice Malicious contract that attempts to reenter during token transfer
contract MaliciousReentrancy is IERC721Receiver {
    address public token;
    address public owner;
    uint256 public reentryCount;
    uint256 public maxReentries;
    bool public shouldReenter;

    constructor() {
        owner = msg.sender;
        shouldReenter = true;
        maxReentries = 2;
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external returns (bytes4) {
        if (shouldReenter && reentryCount < maxReentries) {
            reentryCount++;

            try this.delegateAndTransfer() {
                // Reentrancy successful
            } catch {
                // Reentrancy prevented
            }
        }

        return IERC721Receiver.onERC721Received.selector;
    }

    function setShouldReenter(bool _shouldReenter) external {
        require(msg.sender == owner, "Only owner");
        shouldReenter = _shouldReenter;
    }

    function setMaxReentries(uint256 _max) external {
        require(msg.sender == owner, "Only owner");
        maxReentries = _max;
    }

    function delegateAndTransfer() external {
        require(msg.sender == address(this), "Self-call only");
        require(token != address(0), "Token not set");

        (bool success, ) = token.call(
            abi.encodeWithSignature("delegateTokenIds(address,uint256[])", address(this), new uint256[](0))
        );
        if (!success) {
        }
    }

    function setToken(address _token) external {
        require(msg.sender == owner, "Only owner");
        token = _token;
    }
}
