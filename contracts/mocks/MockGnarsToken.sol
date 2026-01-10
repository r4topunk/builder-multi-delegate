// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

contract MockGnarsToken {
    mapping(address => uint256) private balances;

    event Transfer(address indexed from, address indexed to, uint256 amount);

    function balanceOf(address owner) external view returns (uint256) {
        return balances[owner];
    }

    function mint(address to, uint256 amount) external {
        balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(balances[from] >= amount, "INSUFFICIENT_BALANCE");
        balances[from] -= amount;
        emit Transfer(from, address(0), amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(balances[from] >= amount, "INSUFFICIENT_BALANCE");
        balances[from] -= amount;
        balances[to] += amount;
        emit Transfer(from, to, amount);
    }
}
