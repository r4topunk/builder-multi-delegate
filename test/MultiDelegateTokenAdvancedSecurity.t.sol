// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { Test } from "forge-std/Test.sol";
import { MultiDelegateToken } from "../contracts/MultiDelegateToken.sol";
import { MockERC721 } from "../lib/nouns-protocol/test/utils/mocks/MockERC721.sol";

contract MultiDelegateTokenAdvancedSecurityTest is Test {
    MultiDelegateToken internal token;
    MockERC721 internal gnars;

    address internal owner;
    address internal alice;
    address internal bob;
    address internal dave;

    function setUp() public {
        owner = address(0xCAB);
        alice = address(0xA11CE);
        bob = address(0xB0B);
        dave = address(0xDAVE);

        gnars = new MockERC721();
        token = new MultiDelegateToken(address(gnars));
    }

    function testDelegateUpdatesVotesAndList() public {
        _mintToOwner(3);

        vm.prank(owner);
        token.delegate(alice, 2);

        assertEq(token.delegatedAmount(owner, alice), 2);
        assertEq(token.totalDelegated(owner), 2);
        assertEq(token.delegateVotes(alice), 2);
        assertEq(token.getVotes(owner), 1);

        address[] memory delegates = token.getDelegates(owner);
        assertEq(delegates.length, 1);
        assertEq(delegates[0], alice);
    }

    function testClearDelegationRemovesDelegate() public {
        _mintToOwner(3);

        vm.startPrank(owner);
        token.delegate(alice, 2);
        token.clearDelegation(alice);
        vm.stopPrank();

        assertEq(token.delegatedAmount(owner, alice), 0);
        assertEq(token.totalDelegated(owner), 0);
        assertEq(token.delegateVotes(alice), 0);
        assertEq(token.getVotes(owner), 3);

        address[] memory delegates = token.getDelegates(owner);
        assertEq(delegates.length, 0);
    }

    function testSyncDelegationsReducesFromEnd() public {
        _mintToOwner(3);

        vm.startPrank(owner);
        token.delegate(alice, 2);
        token.delegate(bob, 1);
        vm.stopPrank();

        vm.prank(owner);
        gnars.transferFrom(owner, dave, 2);

        token.syncDelegations(owner);

        assertEq(token.delegatedAmount(owner, alice), 2);
        assertEq(token.delegatedAmount(owner, bob), 0);
        assertEq(token.delegateVotes(alice), 2);
        assertEq(token.delegateVotes(bob), 0);
        assertEq(token.totalDelegated(owner), 2);

        address[] memory delegates = token.getDelegates(owner);
        assertEq(delegates.length, 1);
        assertEq(delegates[0], alice);
    }

    function testSyncDelegationsPartialReduction() public {
        _mintToOwner(4);

        vm.startPrank(owner);
        token.delegate(alice, 3);
        token.delegate(bob, 1);
        vm.stopPrank();

        vm.startPrank(owner);
        gnars.transferFrom(owner, dave, 2);
        gnars.transferFrom(owner, dave, 3);
        vm.stopPrank();

        token.syncDelegations(owner);

        assertEq(token.delegatedAmount(owner, alice), 2);
        assertEq(token.delegatedAmount(owner, bob), 0);
        assertEq(token.delegateVotes(alice), 2);
        assertEq(token.delegateVotes(bob), 0);
        assertEq(token.totalDelegated(owner), 2);
    }

    function testMaxDelegatesLimit() public {
        _mintToOwner(51);

        vm.startPrank(owner);
        for (uint256 i = 0; i < 50; i++) {
            token.delegate(address(uint160(i + 1)), 1);
        }

        vm.expectRevert(MultiDelegateToken.MAX_DELEGATES_EXCEEDED.selector);
        token.delegate(address(0xDEAD), 1);
        vm.stopPrank();
    }

    function testInsufficientBalanceReverts() public {
        _mintToOwner(1);

        vm.prank(owner);
        vm.expectRevert(MultiDelegateToken.INSUFFICIENT_BALANCE.selector);
        token.delegate(alice, 2);
    }

    function testInvalidDelegateReverts() public {
        _mintToOwner(1);

        vm.prank(owner);
        vm.expectRevert(MultiDelegateToken.INVALID_DELEGATE.selector);
        token.delegate(address(0), 1);
    }

    function _mintToOwner(uint256 count) internal {
        for (uint256 i = 0; i < count; i++) {
            gnars.mint(owner, i);
        }
    }
}
