import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const encodeInitStrings = () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["string", "string", "string", "string", "string", "string"],
    ["Gnars", "GNARS", "desc", "img", "base", "contract"]
  );
};

describe("MultiDelegateToken", () => {
  async function deployToken() {
    const [manager, auction, owner, alice, bob, charlie, dave] = await ethers.getSigners();

    const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
    const metadata = await Metadata.deploy();

    const Token = await ethers.getContractFactory("MultiDelegateToken");
    const impl = await Token.connect(manager).deploy(manager.address);

    const initData = Token.interface.encodeFunctionData("initialize", [
      [],
      encodeInitStrings(),
      0,
      await metadata.getAddress(),
      auction.address,
      manager.address,
    ]);

    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await Proxy.connect(manager).deploy(await impl.getAddress(), initData);

    const token = Token.attach(await proxy.getAddress());

    return { token, metadata, manager, auction, owner, alice, bob, charlie, dave };
  }

  // ============================================
  // BASIC DELEGATION TESTS
  // ============================================

  describe("Basic Delegation", () => {
    it("splits delegation across tokenIds", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0, 2]);
      await token.connect(owner).delegateTokenIds(bob.address, [1]);

      expect(await token.getVotes(alice.address)).to.equal(2);
      expect(await token.getVotes(bob.address)).to.equal(1);
    });

    it("supports redelegation for a tokenId", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).delegateTokenIds(bob.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);
    });

    it("clears delegation on transfer", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).transferFrom(owner.address, bob.address, 0);
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);
    });

    it("does not clear delegation on self-transfer", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).transferFrom(owner.address, owner.address, 0);
      expect(await token.getVotes(alice.address)).to.equal(1);
    });

    it("does not allow approved operator to clear delegation via self-transfer", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(owner.address)).to.equal(0);

      await token.connect(owner).approve(bob.address, 0);
      await token.connect(bob).transferFrom(owner.address, owner.address, 0);
      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(owner.address)).to.equal(0);
    });

    it("clears delegation explicitly", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).clearTokenDelegation([0]);
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(1);
    });

    it("rejects legacy delegate calls", async () => {
      const { token, owner, alice } = await deployToken();
      await expect(token.connect(owner).delegate(alice.address)).to.be.revertedWithCustomError(
        token,
        "USE_TOKEN_ID_DELEGATION"
      );
    });

    it("rejects legacy delegateBySig calls", async () => {
      const { token, owner, alice } = await deployToken();
      await expect(
        token.connect(owner).delegateBySig(owner.address, alice.address, 0, 0, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(token, "USE_TOKEN_ID_DELEGATION");
    });

    it("tracks past votes by timestamp", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      const currentTs = (await ethers.provider.getBlock("latest"))!.timestamp;

      await ethers.provider.send("evm_increaseTime", [2]);
      await ethers.provider.send("evm_mine", []);

      const pastVotes = await token.getPastVotes(alice.address, currentTs);
      expect(pastVotes).to.equal(1);
    });

    it("auto-delegates to the owner on mint", async () => {
      const { token, auction, owner } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      expect(await token.getVotes(owner.address)).to.equal(1);
      expect(await token.tokenDelegate(0)).to.equal(owner.address);
    });

    it("rejects zero-address delegates", async () => {
      const { token, auction, owner } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await expect(token.connect(owner).delegateTokenIds(ethers.ZeroAddress, [0])).to.be.revertedWithCustomError(
        token,
        "INVALID_DELEGATE"
      );
    });

    it("requires the token owner or approved operator to delegate or clear", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await expect(token.connect(alice).delegateTokenIds(bob.address, [0])).to.be.revertedWithCustomError(
        token,
        "ONLY_TOKEN_OWNER"
      );

      await token.connect(owner).setApprovalForAll(alice.address, true);
      await expect(token.connect(alice).delegateTokenIds(bob.address, [0])).to.not.be.reverted;
      expect(await token.getVotes(bob.address)).to.equal(1);

      await expect(token.connect(alice).clearTokenDelegation([0])).to.not.be.reverted;
      expect(await token.getVotes(bob.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(1);
    });

    it("clears delegation on transfer and auto-delegates to the new owner", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      await token.connect(owner).transferFrom(owner.address, bob.address, 0);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.tokenDelegate(0)).to.equal(bob.address);
    });

    it("clears delegation on burn and updates votes", async () => {
      const { token, auction, manager, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(owner.address)).to.equal(0);

      await token.connect(owner).burn(0);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(0);
    });

    it("clearing without an override is a no-op", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).clearTokenDelegation([0]);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(1);
      expect(await token.tokenDelegate(0)).to.equal(owner.address);
    });

    it("does not double-count when delegating the same tokenId to the same delegate", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);
    });

    it("supports delegating and clearing multiple tokenIds in a batch", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0, 2]);
      await token.connect(owner).delegateTokenIds(bob.address, [1]);

      expect(await token.getVotes(alice.address)).to.equal(2);
      expect(await token.getVotes(bob.address)).to.equal(1);

      await token.connect(owner).clearTokenDelegation([0, 2]);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.getVotes(owner.address)).to.equal(2);
      expect(await token.tokenDelegate(0)).to.equal(owner.address);
      expect(await token.tokenDelegate(2)).to.equal(owner.address);
    });
  });

  // ============================================
  // SECURITY TESTS
  // ============================================

  describe("Security: Batch Size Limits", () => {
    it("rejects delegateTokenIds with batch size exceeding MAX_BATCH_SIZE", async () => {
      const { token, auction, owner, alice } = await deployToken();

      // Mint 101 tokens (exceeds MAX_BATCH_SIZE of 100)
      for (let i = 0; i < 101; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: 101 }, (_, i) => i);

      await expect(
        token.connect(owner).delegateTokenIds(alice.address, tokenIds)
      ).to.be.revertedWithCustomError(token, "BATCH_SIZE_EXCEEDED");
    });

    it("rejects clearTokenDelegation with batch size exceeding MAX_BATCH_SIZE", async () => {
      const { token, auction, owner, alice } = await deployToken();

      // Mint 101 tokens
      for (let i = 0; i < 101; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: 101 }, (_, i) => i);

      await expect(
        token.connect(owner).clearTokenDelegation(tokenIds)
      ).to.be.revertedWithCustomError(token, "BATCH_SIZE_EXCEEDED");
    });

    it("allows delegateTokenIds at exactly MAX_BATCH_SIZE", async () => {
      const { token, auction, owner, alice } = await deployToken();

      // Mint exactly 100 tokens
      for (let i = 0; i < 100; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: 100 }, (_, i) => i);

      await expect(
        token.connect(owner).delegateTokenIds(alice.address, tokenIds)
      ).to.not.be.reverted;

      expect(await token.getVotes(alice.address)).to.equal(100);
    });
  });

  describe("Security: Vote Accounting Integrity", () => {
    it("maintains correct vote count through multiple operations", async () => {
      const { token, auction, owner, alice, bob, charlie } = await deployToken();

      // Mint 5 tokens
      for (let i = 0; i < 5; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      // Initial: owner has 5 votes
      expect(await token.getVotes(owner.address)).to.equal(5);

      // Delegate 2 to alice
      await token.connect(owner).delegateTokenIds(alice.address, [0, 1]);
      expect(await token.getVotes(owner.address)).to.equal(3);
      expect(await token.getVotes(alice.address)).to.equal(2);

      // Delegate 2 to bob
      await token.connect(owner).delegateTokenIds(bob.address, [2, 3]);
      expect(await token.getVotes(owner.address)).to.equal(1);
      expect(await token.getVotes(bob.address)).to.equal(2);

      // Redelegate token 0 from alice to charlie
      await token.connect(owner).delegateTokenIds(charlie.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(charlie.address)).to.equal(1);

      // Clear token 1 (alice -> owner)
      await token.connect(owner).clearTokenDelegation([1]);
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(2);

      // Total votes should still equal total supply
      const totalVotes =
        Number(await token.getVotes(owner.address)) +
        Number(await token.getVotes(alice.address)) +
        Number(await token.getVotes(bob.address)) +
        Number(await token.getVotes(charlie.address));
      expect(totalVotes).to.equal(5);
    });

    it("correctly tracks votes after multiple transfers", async () => {
      const { token, auction, owner, alice, bob, charlie } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      // owner -> alice
      expect(await token.getVotes(owner.address)).to.equal(1);
      await token.connect(owner).transferFrom(owner.address, alice.address, 0);
      expect(await token.getVotes(owner.address)).to.equal(0);
      expect(await token.getVotes(alice.address)).to.equal(1);

      // alice delegates to bob
      await token.connect(alice).delegateTokenIds(bob.address, [0]);
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);

      // alice transfers to charlie - should clear bob's delegation
      await token.connect(alice).transferFrom(alice.address, charlie.address, 0);
      expect(await token.getVotes(bob.address)).to.equal(0);
      expect(await token.getVotes(charlie.address)).to.equal(1);
    });
  });

  describe("Security: Burn Cleanup", () => {
    it("clears tokenDelegates mapping on burn", async () => {
      const { token, auction, manager, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);

      // Delegate to alice
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);

      // Burn
      await token.connect(owner).burn(0);

      // Raw delegate should be cleared (returns address(0))
      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);
    });

    it("removes votes from delegate on burn", async () => {
      const { token, auction, manager, owner, alice, bob } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      // Delegate both to alice
      await token.connect(owner).delegateTokenIds(alice.address, [0, 1]);
      expect(await token.getVotes(alice.address)).to.equal(2);

      // Burn token 0
      await token.connect(owner).burn(0);
      expect(await token.getVotes(alice.address)).to.equal(1);

      // Burn token 1
      await token.connect(owner).burn(1);
      expect(await token.getVotes(alice.address)).to.equal(0);
    });
  });

  describe("Security: Edge Cases", () => {
    it("handles delegating back to self (owner)", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(owner.address)).to.equal(0);
      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);

      // Delegate back to owner (should clear the override)
      await token.connect(owner).delegateTokenIds(owner.address, [0]);

      expect(await token.getVotes(owner.address)).to.equal(1);
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);
    });

    it("handles empty tokenIds array", async () => {
      const { token, owner, alice } = await deployToken();

      // Should not revert
      await expect(token.connect(owner).delegateTokenIds(alice.address, [])).to.not.be.reverted;
      await expect(token.connect(owner).clearTokenDelegation([])).to.not.be.reverted;
    });

    it("reverts when querying tokenDelegate for non-existent token", async () => {
      const { token } = await deployToken();

      await expect(token.tokenDelegate(999)).to.be.revertedWithCustomError(token, "INVALID_OWNER");
    });

    it("returns address(0) for rawTokenDelegate on non-existent token", async () => {
      const { token } = await deployToken();

      // rawTokenDelegate doesn't check existence, just returns the mapping value
      expect(await token.rawTokenDelegate(999)).to.equal(ethers.ZeroAddress);
    });

    it("handles sequential rapid delegation changes", async () => {
      const { token, auction, owner, alice, bob, charlie } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      // Rapid sequential delegations in separate transactions
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await token.connect(owner).delegateTokenIds(bob.address, [0]);
      await token.connect(owner).delegateTokenIds(charlie.address, [0]);

      // Final state should be delegated to charlie
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(0);
      expect(await token.getVotes(charlie.address)).to.equal(1);
      expect(await token.rawTokenDelegate(0)).to.equal(charlie.address);
    });
  });

  describe("Security: Access Control", () => {
    it("allows approved operators to delegate", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).approve(alice.address, 0);

      await expect(
        token.connect(alice).delegateTokenIds(bob.address, [0])
      ).to.not.be.reverted;

      expect(await token.getVotes(bob.address)).to.equal(1);
    });

    it("allows approved operators to clear delegation", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(bob.address, [0]);
      await token.connect(owner).approve(alice.address, 0);

      await expect(
        token.connect(alice).clearTokenDelegation([0])
      ).to.not.be.reverted;

      expect(await token.getVotes(bob.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(1);
    });

    it("setApprovalForAll grants delegation rights", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).setApprovalForAll(alice.address, true);

      await expect(
        token.connect(alice).delegateTokenIds(bob.address, [0])
      ).to.not.be.reverted;

      expect(await token.getVotes(bob.address)).to.equal(1);
    });
  });

  describe("Security: Checkpoint Integrity", () => {
    it("getPastVotes returns correct historical values", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      // Record timestamp after mint
      const ts1 = (await ethers.provider.getBlock("latest"))!.timestamp;

      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      // Delegate to alice
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      const ts2 = (await ethers.provider.getBlock("latest"))!.timestamp;

      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      // Redelegate to bob
      await token.connect(owner).delegateTokenIds(bob.address, [0]);
      const ts3 = (await ethers.provider.getBlock("latest"))!.timestamp;

      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      // Check historical values
      expect(await token.getPastVotes(owner.address, ts1)).to.equal(1);
      expect(await token.getPastVotes(alice.address, ts1)).to.equal(0);

      expect(await token.getPastVotes(owner.address, ts2)).to.equal(0);
      expect(await token.getPastVotes(alice.address, ts2)).to.equal(1);

      expect(await token.getPastVotes(alice.address, ts3)).to.equal(0);
      expect(await token.getPastVotes(bob.address, ts3)).to.equal(1);
    });

    it("getPastVotes reverts for future timestamp", async () => {
      const { token, auction, owner } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      const currentTs = (await ethers.provider.getBlock("latest"))!.timestamp;

      await expect(
        token.getPastVotes(owner.address, currentTs + 1000)
      ).to.be.revertedWithCustomError(token, "INVALID_TIMESTAMP");
    });

    it("getPastVotes returns 0 for timestamp before first checkpoint", async () => {
      const { token, auction, owner, alice } = await deployToken();

      const tsBeforeMint = (await ethers.provider.getBlock("latest"))!.timestamp;

      await ethers.provider.send("evm_increaseTime", [10]);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      await ethers.provider.send("evm_increaseTime", [10]);
      await ethers.provider.send("evm_mine", []);

      // Alice had no votes before mint
      expect(await token.getPastVotes(alice.address, tsBeforeMint)).to.equal(0);
    });
  });

  describe("Security: Events", () => {
    it("emits TokenDelegateChanged on delegation", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await expect(token.connect(owner).delegateTokenIds(alice.address, [0]))
        .to.emit(token, "TokenDelegateChanged")
        .withArgs(0, owner.address, alice.address);
    });

    it("emits TokenDelegationCleared when clearing delegation", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      await expect(token.connect(owner).clearTokenDelegation([0]))
        .to.emit(token, "TokenDelegationCleared")
        .withArgs(0, alice.address);
    });

    it("emits TokenDelegationCleared on transfer when delegated", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      await expect(token.connect(owner).transferFrom(owner.address, bob.address, 0))
        .to.emit(token, "TokenDelegationCleared")
        .withArgs(0, alice.address);
    });

    it("emits DelegateVotesChanged for both parties", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      const tx = await token.connect(owner).delegateTokenIds(alice.address, [0]);

      await expect(tx)
        .to.emit(token, "DelegateVotesChanged")
        .withArgs(owner.address, 1, 0);

      await expect(tx)
        .to.emit(token, "DelegateVotesChanged")
        .withArgs(alice.address, 0, 1);
    });
  });

  describe("Integration: Multiple Token Owners", () => {
    it("handles delegation from multiple owners to same delegate", async () => {
      const { token, auction, owner, alice, bob, charlie } = await deployToken();

      // Mint to different owners
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(alice.address);
      await token.connect(auction).mintTo(bob.address);

      // All delegate to charlie
      await token.connect(owner).delegateTokenIds(charlie.address, [0]);
      await token.connect(alice).delegateTokenIds(charlie.address, [1]);
      await token.connect(bob).delegateTokenIds(charlie.address, [2]);

      expect(await token.getVotes(charlie.address)).to.equal(3);

      // One revokes
      await token.connect(alice).clearTokenDelegation([1]);
      expect(await token.getVotes(charlie.address)).to.equal(2);
      expect(await token.getVotes(alice.address)).to.equal(1);
    });

    it("maintains isolation between different owners' delegations", async () => {
      const { token, auction, owner, alice, bob, charlie, dave } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(alice.address);

      // owner delegates to bob
      await token.connect(owner).delegateTokenIds(bob.address, [0]);
      // alice delegates to charlie
      await token.connect(alice).delegateTokenIds(charlie.address, [1]);

      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.getVotes(charlie.address)).to.equal(1);

      // owner changes delegation - should not affect alice's
      await token.connect(owner).delegateTokenIds(dave.address, [0]);
      expect(await token.getVotes(bob.address)).to.equal(0);
      expect(await token.getVotes(dave.address)).to.equal(1);
      expect(await token.getVotes(charlie.address)).to.equal(1); // unchanged
    });
  });

  describe("Gas Optimization Tests", () => {
    it("batch delegation is more gas efficient than individual calls", async () => {
      const { token, auction, owner, alice } = await deployToken();

      // Mint 10 tokens
      for (let i = 0; i < 10; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      // Measure batch delegation
      const tokenIds = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
      const batchTx = await token.connect(owner).delegateTokenIds(alice.address, tokenIds);
      const batchReceipt = await batchTx.wait();
      const batchGas = batchReceipt!.gasUsed;

      // Clear for individual test
      await token.connect(owner).clearTokenDelegation(tokenIds);

      // Measure individual delegations
      let individualGasTotal = 0n;
      for (const id of tokenIds) {
        const tx = await token.connect(owner).delegateTokenIds(alice.address, [id]);
        const receipt = await tx.wait();
        individualGasTotal += receipt!.gasUsed;
      }

      // Batch should use less gas due to reduced fixed costs
      console.log(`Batch gas: ${batchGas}, Individual total: ${individualGasTotal}`);
      expect(batchGas).to.be.lt(individualGasTotal);
    });
  });

  // ============================================
  // FOUNDER & MINTING TESTS
  // ============================================

  describe("Founders and Vesting", () => {
    async function deployTokenWithFounders() {
      const [manager, auction, owner, alice, bob, founder1, founder2] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const futureTimestamp = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year from now

      const founders = [
        { wallet: founder1.address, ownershipPct: 10, vestExpiry: futureTimestamp },
        { wallet: founder2.address, ownershipPct: 5, vestExpiry: futureTimestamp },
      ];

      const initData = Token.interface.encodeFunctionData("initialize", [
        founders,
        encodeInitStrings(),
        0,
        await metadata.getAddress(),
        auction.address,
        manager.address,
      ]);

      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await Proxy.connect(manager).deploy(await impl.getAddress(), initData);

      const token = Token.attach(await proxy.getAddress());

      return { token, manager, auction, owner, alice, bob, founder1, founder2 };
    }

    it("mints to founders based on vesting schedule", async () => {
      const { token, auction, founder1, founder2, alice } = await deployTokenWithFounders();

      // Mint first token - should go to auction recipient
      await token.connect(auction).mintTo(alice.address);

      // Check founder ownership percentage
      expect(await token.totalFounderOwnership()).to.equal(15);
      expect(await token.totalFounders()).to.equal(2);
    });

    it("returns founder information", async () => {
      const { token, founder1 } = await deployTokenWithFounders();

      const founderInfo = await token.getFounder(0);
      expect(founderInfo.wallet).to.equal(founder1.address);
      expect(founderInfo.ownershipPct).to.equal(10);
    });

    it("returns all founders", async () => {
      const { token, founder1, founder2 } = await deployTokenWithFounders();

      const founders = await token.getFounders();
      expect(founders.length).to.equal(2);
      expect(founders[0].wallet).to.equal(founder1.address);
      expect(founders[1].wallet).to.equal(founder2.address);
    });

    it("returns scheduled recipient for tokenId", async () => {
      const { token, founder1 } = await deployTokenWithFounders();

      const recipient = await token.getScheduledRecipient(0);
      expect(recipient.wallet).to.equal(founder1.address);
    });
  });

  describe("Minting Functions", () => {
    it("mints via mint() to msg.sender", async () => {
      const { token, auction, manager } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);
      await token.connect(auction).mint();

      expect(await token.ownerOf(0)).to.equal(auction.address);
      expect(await token.totalSupply()).to.equal(1);
    });

    it("batch mints multiple tokens", async () => {
      const { token, auction, alice } = await deployToken();

      const tokenIds = await token.connect(auction).mintBatchTo.staticCall(5, alice.address);
      await token.connect(auction).mintBatchTo(5, alice.address);

      expect(tokenIds.length).to.equal(5);
      expect(await token.balanceOf(alice.address)).to.equal(5);
      expect(await token.totalSupply()).to.equal(5);
      expect(await token.getVotes(alice.address)).to.equal(5);
    });

    it("only auction or minter can mint", async () => {
      const { token, alice } = await deployToken();

      await expect(token.connect(alice).mint()).to.be.revertedWithCustomError(
        token,
        "ONLY_AUCTION_OR_MINTER"
      );

      await expect(token.connect(alice).mintTo(alice.address)).to.be.revertedWithCustomError(
        token,
        "ONLY_AUCTION_OR_MINTER"
      );
    });
  });

  describe("Reserve Minting", () => {
    async function deployTokenWithReserve() {
      const [manager, auction, owner, alice, bob] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const initData = Token.interface.encodeFunctionData("initialize", [
        [],
        encodeInitStrings(),
        10, // Reserve first 10 tokenIds
        await metadata.getAddress(),
        auction.address,
        manager.address,
      ]);

      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await Proxy.connect(manager).deploy(await impl.getAddress(), initData);

      const token = Token.attach(await proxy.getAddress());

      return { token, manager, auction, owner, alice, bob };
    }

    it("mints from reserve to recipient", async () => {
      const { token, manager, alice } = await deployTokenWithReserve();

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);
      await token.connect(manager).mintFromReserveTo(alice.address, 5);

      expect(await token.ownerOf(5)).to.equal(alice.address);
      expect(await token.getVotes(alice.address)).to.equal(1);
    });

    it("rejects minting non-reserved tokenId from reserve", async () => {
      const { token, manager, alice } = await deployTokenWithReserve();

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      await expect(
        token.connect(manager).mintFromReserveTo(alice.address, 15)
      ).to.be.revertedWithCustomError(token, "TOKEN_NOT_RESERVED");
    });

    it("tracks remaining tokens in reserve", async () => {
      const { token, manager, alice } = await deployTokenWithReserve();

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      expect(await token.remainingTokensInReserve()).to.equal(10);

      await token.connect(manager).mintFromReserveTo(alice.address, 0);
      expect(await token.remainingTokensInReserve()).to.equal(9);
    });

    it("only minter can mint from reserve", async () => {
      const { token, alice } = await deployTokenWithReserve();

      await expect(
        token.connect(alice).mintFromReserveTo(alice.address, 0)
      ).to.be.revertedWithCustomError(token, "ONLY_AUCTION_OR_MINTER");
    });
  });

  describe("Minter Management", () => {
    it("owner can update minters", async () => {
      const { token, manager, alice } = await deployToken();

      expect(await token.isMinter(alice.address)).to.equal(false);

      await token.connect(manager).updateMinters([{ minter: alice.address, allowed: true }]);
      expect(await token.isMinter(alice.address)).to.equal(true);

      await token.connect(manager).updateMinters([{ minter: alice.address, allowed: false }]);
      expect(await token.isMinter(alice.address)).to.equal(false);
    });

    it("non-owner cannot update minters", async () => {
      const { token, alice } = await deployToken();

      await expect(
        token.connect(alice).updateMinters([{ minter: alice.address, allowed: true }])
      ).to.be.revertedWithCustomError(token, "ONLY_OWNER");
    });
  });

  describe("Token Metadata", () => {
    it("returns token URI", async () => {
      const { token, auction, alice } = await deployToken();

      await token.connect(auction).mintTo(alice.address);

      const uri = await token.tokenURI(0);
      expect(uri).to.equal("ipfs://mock-token");
    });

    it("returns contract URI", async () => {
      const { token } = await deployToken();

      const uri = await token.contractURI();
      expect(uri).to.equal("ipfs://mock-contract");
    });

    it("returns auction address", async () => {
      const { token, auction } = await deployToken();

      expect(await token.auction()).to.equal(auction.address);
    });

    it("returns metadata renderer address", async () => {
      const { token, metadata } = await deployToken();

      expect(await token.metadataRenderer()).to.equal(await metadata.getAddress());
    });
  });

  describe("Delegation with Founders", () => {
    async function deployTokenWithFounders() {
      const [manager, auction, owner, alice, bob, founder1] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const futureTimestamp = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

      const founders = [
        { wallet: founder1.address, ownershipPct: 10, vestExpiry: futureTimestamp },
      ];

      const initData = Token.interface.encodeFunctionData("initialize", [
        founders,
        encodeInitStrings(),
        0,
        await metadata.getAddress(),
        auction.address,
        manager.address,
      ]);

      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await Proxy.connect(manager).deploy(await impl.getAddress(), initData);

      const token = Token.attach(await proxy.getAddress());

      return { token, manager, auction, owner, alice, bob, founder1 };
    }

    it("founder can delegate their vested tokens", async () => {
      const { token, auction, alice, founder1 } = await deployTokenWithFounders();

      // Mint tokens - some will go to founder based on schedule
      for (let i = 0; i < 12; i++) {
        await token.connect(auction).mintTo(alice.address);
      }

      // Founder should have received some tokens
      const founderBalance = await token.balanceOf(founder1.address);
      expect(founderBalance).to.be.gt(0);

      // Founder has votes
      const founderVotes = await token.getVotes(founder1.address);
      expect(founderVotes).to.equal(founderBalance);

      // Founder can delegate
      if (founderBalance > 0) {
        const founderTokens = [];
        for (let i = 0; i < 20; i++) {
          try {
            if ((await token.ownerOf(i)) === founder1.address) {
              founderTokens.push(i);
            }
          } catch {
            // Token doesn't exist
          }
        }

        if (founderTokens.length > 0) {
          await token.connect(founder1).delegateTokenIds(alice.address, [founderTokens[0]]);
          expect(await token.getVotes(alice.address)).to.be.gt(0);
        }
      }
    });
  });
});
