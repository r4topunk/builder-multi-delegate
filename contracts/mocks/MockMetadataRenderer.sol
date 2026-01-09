// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

/// @notice Minimal metadata renderer for tests
contract MockMetadataRenderer {
    address public token;
    address public owner;

    function initialize(bytes calldata, address _token) external {
        token = _token;
        owner = msg.sender;
    }

    function onMinted(uint256) external pure returns (bool) {
        return true;
    }

    function tokenURI(uint256) external pure returns (string memory) {
        return "ipfs://mock-token";
    }

    function contractURI() external pure returns (string memory) {
        return "ipfs://mock-contract";
    }
}
