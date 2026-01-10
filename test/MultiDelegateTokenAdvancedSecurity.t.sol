// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { Test, console } from "forge-std/Test.sol";
import { MultiDelegateToken } from "../contracts/MultiDelegateToken.sol";
import { MockMetadataRenderer } from "../contracts/mocks/MockMetadataRenderer.sol";
import { ERC1967Proxy } from "../lib/nouns-protocol/src/lib/proxy/ERC1967Proxy.sol";
import { MaliciousReentrancy } from "../contracts/mocks/MaliciousReentrancy.sol";
import { IManager } from "../lib/nouns-protocol/src/manager/IManager.sol";

/**
 * @title MultiDelegateToken Advanced Security & Edge Cases Tests
 * @notice Foundry-based tests for advanced security scenarios and edge cases
 */

contract MultiDelegateTokenAdvancedSecurityTest is Test {
    MultiDelegateToken internal token;
    MockMetadataRenderer internal metadata;
    MaliciousReentrancy internal malicious;
    ERC1967Proxy internal proxy;

    address internal manager;
    address internal auction;
    address internal owner;
    address internal alice;
    address internal bob;
    address internal charlie;
    address internal dave;

    struct MinterParams {
        address minter;
        bool allowed;
    }

    function setUp() public {
        manager = address(this);
        auction = address(0xA11CE);
        owner = address(0xCAB);
        alice = address(0xDEADBEEF);
        bob = address(0xFEEDBEEF);
        charlie = address(0xBAADF00D);
        dave = address(0xFACEB00C);

        vm.label(manager, "MANAGER");
        vm.label(auction, "AUCTION");
        vm.label(owner, "OWNER");
        vm.label(alice, "ALICE");
        vm.label(bob, "BOB");
        vm.label(charlie, "CHARLIE");
        vm.label(dave, "DAVE");

        metadata = new MockMetadataRenderer();
        vm.label(address(metadata), "METADATA");

        MultiDelegateToken impl = new MultiDelegateToken(manager);
        vm.label(address(impl), "TOKEN_IMPL");

        bytes memory initData = abi.encodeWithSelector(
            MultiDelegateToken.initialize.selector,
            new IManager.FounderParams[](0),
            abi.encode("Gnars", "GNARS", "desc", "img", "base", "contract"),
            0,
            address(metadata),
            auction,
            manager
        );

        proxy = new ERC1967Proxy(address(impl), initData);
        token = MultiDelegateToken(address(proxy));
        vm.label(address(token), "TOKEN");

        malicious = new MaliciousReentrancy();
        malicious.setToken(address(token));
        vm.label(address(malicious), "MALICIOUS");

        vm.prank(manager);
        token.updateMinters(MinterParams({ minter: auction, allowed: true }));
    }

    // Test: Reentrancy prevention during token transfer
    function testReentrancyDuringTokenTransfer() public {
        vm.prank(auction);
        token.mintTo(owner);

        vm.prank(owner);
        token.delegateTokenIds(alice, singleTokenIdArray(0));

        assertEq(token.getVotes(alice), 1);

        vm.startPrank(alice);
        vm.expectRevert("INVALID_OWNER");
        token.transferFrom(alice, owner, 0);
        vm.stopPrank();

        assertEq(token.getVotes(alice), 1);
    }

    // Test: Checkpoint bloat prevention
    function testCheckpointBloatPrevention() public {
        for (uint256 i = 0; i < 999; i++) {
            vm.prank(auction);
            token.mintTo(owner);
            
            vm.startPrank(owner);
            token.delegateTokenIds(alice, singleTokenIdArray(i));
            vm.stopPrank();

            vm.warp(block.timestamp + 1);

            assertEq(token.getVotes(alice), i + 1);
        }

        vm.prank(auction);
        token.mintTo(owner);

        vm.prank(owner);
        token.delegateTokenIds(alice, singleTokenIdArray(999));

        assertEq(token.getVotes(alice), 1000);
    }

    // Test: Vote accounting integrity
    function testVoteUnderflowPrevention() public {
        vm.prank(auction);
        token.mintTo(owner);

        vm.prank(owner);
        token.delegateTokenIds(alice, singleTokenIdArray(0));

        assertEq(token.getVotes(alice), 1);

        vm.prank(owner);
        token.clearTokenDelegation(singleTokenIdArray(0));

        assertEq(token.getVotes(alice), 0);
        assertEq(token.getVotes(owner), 1);
    }

    // Test: Batch size at MAX_BATCH_SIZE
    function testBatchSizeAtMaxLimit() public {
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(auction);
            token.mintTo(owner);
        }

        uint256[] memory tokenIds = new uint256[](100);
        for (uint256 i = 0; i < 100; i++) {
            tokenIds[i] = i;
        }

        vm.prank(owner);
        token.delegateTokenIds(alice, tokenIds);

        assertEq(token.getVotes(alice), 100);
    }

    // Test: Batch size exceeds MAX_BATCH_SIZE
    function testBatchSizeExceedsMaxLimit() public {
        for (uint256 i = 0; i < 101; i++) {
            vm.prank(auction);
            token.mintTo(owner);
        }

        uint256[] memory tokenIds = new uint256[](101);
        for (uint256 i = 0; i < 101; i++) {
            tokenIds[i] = i;
        }

        vm.startPrank(owner);
        vm.expectRevert("BATCH_SIZE_EXCEEDED");
        token.delegateTokenIds(alice, tokenIds);
        vm.stopPrank();
    }

    // Test: Prevent delegation to zero address
    function testPreventDelegationToZeroAddress() public {
        vm.prank(auction);
        token.mintTo(owner);

        vm.startPrank(owner);
        vm.expectRevert("INVALID_DELEGATE");
        token.delegateTokenIds(address(0), singleTokenIdArray(0));
        vm.stopPrank();
    }

    // Test: Unauthorized minter cannot mint
    function testUnauthorizedMinterCannotMint() public {
        vm.startPrank(alice);
        vm.expectRevert("ONLY_AUCTION_OR_MINTER");
        token.mint();
        vm.stopPrank();
    }

    // Test: Unauthorized cannot update minters
    function testUnauthorizedCannotUpdateMinters() public {
        vm.startPrank(alice);
        vm.expectRevert("ONLY_OWNER");
        token.updateMinters(MinterParams({ minter: bob, allowed: true }));
        vm.stopPrank();
    }

    // Helper functions
    function singleTokenIdArray(uint256 id) internal pure returns (uint256[] memory) {
        uint256[] memory arr = new uint256[](1);
        arr[0] = id;
        return arr;
    }

    function multiTokenIdArray(uint256 a, uint256 b) internal pure returns (uint256[] memory) {
        uint256[] memory arr = new uint256[](2);
        arr[0] = a;
        arr[1] = b;
        return arr;
    }
}
