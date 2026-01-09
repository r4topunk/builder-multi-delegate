// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { Proxy } from "@openzeppelin/contracts/proxy/Proxy.sol";
import { IERC1967Upgrade } from "../../lib/nouns-protocol/src/lib/interfaces/IERC1967Upgrade.sol";
import { ERC1967Upgrade } from "../../lib/nouns-protocol/src/lib/proxy/ERC1967Upgrade.sol";

/// @title ERC1967Proxy
/// @notice Minimal ERC1967 proxy used for tests
contract ERC1967Proxy is IERC1967Upgrade, Proxy, ERC1967Upgrade {
    constructor(address _logic, bytes memory _data) payable {
        _upgradeToAndCall(_logic, _data, false);
    }

    function _implementation() internal view virtual override returns (address) {
        return ERC1967Upgrade._getImplementation();
    }
}
