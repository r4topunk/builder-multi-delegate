// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

/// @title MaliciousRenderer
/// @notice Mock malicious metadata renderer for testing DoS attacks
/// @dev Simplified to avoid interface requirements
contract MaliciousRenderer {
    bool public revertOnMint;
    bool public consumeGas;
    uint256 public gasToConsume;

    constructor(bool _revertOnMint) {
        revertOnMint = _revertOnMint;
    }

    function setRevertOnMint(bool _revert) external {
        revertOnMint = _revert;
    }

    function setGasConsumption(uint256 _amount) external {
        consumeGas = true;
        gasToConsume = _amount;
    }

    function onMinted(uint256) external view returns (bool) {
        if (revertOnMint) {
            revert("Malicious renderer DoS");
        }

        if (consumeGas) {
            // Waste gas
            uint256 dummy;
            for (uint256 i = 0; i < gasToConsume; i++) {
                dummy += i;
            }
        }

        return true;
    }

    function tokenURI(uint256) external pure returns (string memory) {
        return "malicious";
    }

    function contractURI() external pure returns (string memory) {
        return "malicious";
    }
}
