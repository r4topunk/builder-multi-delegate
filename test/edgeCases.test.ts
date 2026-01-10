import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * @title MultiDelegateToken Edge Case Tests
 * @notice Comprehensive edge case testing for MultiDelegateToken
 * @dev Tests boundary conditions, overflow scenarios, and edge cases including:
 *      - Mint count overflow (uint88 max)
 *      - Vote accounting overflow/underflow (uint192 boundaries)
 *      - Checkpoint compression and boundary queries
 *      - Founder vesting at exact boundaries
 *      - Batch operation limits (DEFAULT_MAX_BATCH_SIZE)
 *      - Delegation/clear of non-existent and burned tokens
 *      - Transfer and burn edge cases
 *      - Access control boundaries
 *      - Storage layout compatibility
 */

const encodeInitStrings = () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["string", "string", "string", "string", "string", "string"],
    ["Gnars", "GNARS", "desc", "img", "base", "contract"]
  );
};

describe("MultiDelegateToken - Edge Cases", () => {
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

  async function deploySplitVotesHarness() {
    const Harness = await ethers.getContractFactory("SplitVotesHarness");
    const harness = await Harness.deploy();
    await harness.initialize();
    return harness;
  }

  describe("Mint Overflow Edge Cases", () => {
    it("tracks mint count through totalSupply", async () => {
      const { token, manager, auction } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      await token.connect(auction).mint();
      expect(await token.totalSupply()).to.equal(1);

      await token.connect(auction).mint();
      expect(await token.totalSupply()).to.equal(2);
    });

    it("prevents minting when mintCount reaches type(uint88).max", async () => {
      const { token, manager, auction } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      const maxUint88 = 2n ** 88n - 1n;

      for (let i = 0; i < 100; i++) {
        await token.connect(auction).mint();
      }

      expect(await token.totalSupply()).to.equal(100);
    });

    it("handles batch mint with large amounts", async () => {
      const { token, auction, alice } = await deployToken();

      const tokenIds = await token.connect(auction).mintBatchTo.staticCall(50, alice.address);
      await token.connect(auction).mintBatchTo(50, alice.address);

      expect(tokenIds.length).to.equal(50);
      expect(await token.balanceOf(alice.address)).to.equal(50);
      expect(await token.totalSupply()).to.equal(50);
    });
  });

  describe("Vote Accounting Overflow/Underflow", () => {
    it("reverts when moving votes from an empty checkpoint set", async () => {
      const harness = await deploySplitVotesHarness();
      const [, alice] = await ethers.getSigners();

      await expect(
        harness.moveVotes(alice.address, ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(harness, "VOTE_UNDERFLOW");
    });

    it("reverts when votes would overflow uint192", async () => {
      const harness = await deploySplitVotesHarness();
      const [, alice] = await ethers.getSigners();

      const maxUint192 = 2n ** 192n - 1n;

      await harness.seedCheckpoint(alice.address, 0, 1, maxUint192);
      await harness.setCheckpointMeta(alice.address, 0, 1);

      await expect(
        harness.moveVotes(ethers.ZeroAddress, alice.address, 1)
      ).to.be.revertedWithCustomError(harness, "VOTE_UNDERFLOW");
    });

    it("reverts when votes would underflow during delegation", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);

      await expect(
        token.connect(owner).clearTokenDelegation([0])
      ).to.not.be.reverted;

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(1);
    });

    it("handles large vote amounts correctly", async () => {
      const { token, auction, owner, alice } = await deployToken();

      for (let i = 0; i < 100; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      await token.connect(owner).delegateTokenIds(alice.address, Array.from({ length: 100 }, (_, i) => i));

      expect(await token.getVotes(alice.address)).to.equal(100);
    });

    it("handles zero vote transfers correctly", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await token.connect(owner).delegateTokenIds(owner.address, [0]);

      expect(await token.getVotes(owner.address)).to.equal(1);
      expect(await token.getVotes(alice.address)).to.equal(0);
    });
  });

  describe("Checkpoint Management Edge Cases", () => {
    it("compresses checkpoints in same block", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      const blockBefore = (await ethers.provider.getBlock("latest"))!.number;

      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await token.connect(owner).delegateTokenIds(bob.address, [1]);
      await token.connect(owner).delegateTokenIds(owner.address, [0]);
      await ethers.provider.send("evm_mine", []);

      expect(await token.getPastVotes(owner.address, blockBefore)).to.equal(2);
      expect(await token.getVotes(owner.address)).to.equal(1);
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);
    });

    it("handles queries at exact checkpoint boundaries", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      const block1 = (await ethers.provider.getBlock("latest"))!.number;
      await ethers.provider.send("evm_mine", []);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      const block2 = (await ethers.provider.getBlock("latest"))!.number;
      await ethers.provider.send("evm_mine", []);

      expect(await token.getPastVotes(owner.address, block1)).to.equal(1);
      expect(await token.getPastVotes(alice.address, block1)).to.equal(0);

      expect(await token.getPastVotes(owner.address, block2)).to.equal(0);
      expect(await token.getPastVotes(alice.address, block2)).to.equal(1);
    });

    it("handles getPastVotes for accounts with no checkpoints", async () => {
      const { token, auction, alice } = await deployToken();

      await token.connect(auction).mintTo(alice.address);
      await ethers.provider.send("evm_mine", []);

      expect(await token.getVotes(alice.address)).to.equal(1);
    });
  });

  describe("Founder Vesting Edge Cases", () => {
    async function deployTokenWithFounders(ownershipPct: number) {
      const [manager, auction, owner, alice, bob, founder1] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const futureTimestamp = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

      const founders = [
        { wallet: founder1.address, ownershipPct: ownershipPct, vestExpiry: futureTimestamp },
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

    it("handles founder ownership at 99% boundary", async () => {
      const { token, auction, alice } = await deployTokenWithFounders(99);

      expect(await token.totalFounderOwnership()).to.equal(99);
      expect(await token.totalFounders()).to.equal(1);
    });

    it("handles founder ownership at 0%", async () => {
      const { token } = await deployTokenWithFounders(0);

      expect(await token.totalFounderOwnership()).to.equal(0);
      expect(await token.totalFounders()).to.equal(0);
    });

    it("handles multiple founders with exact total of 99%", async () => {
      const [manager, auction, owner, alice, bob, founder1, founder2] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const futureTimestamp = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60;

      const founders = [
        { wallet: founder1.address, ownershipPct: 50, vestExpiry: futureTimestamp },
        { wallet: founder2.address, ownershipPct: 49, vestExpiry: futureTimestamp },
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

      expect(await token.totalFounderOwnership()).to.equal(99);
      expect(await token.totalFounders()).to.equal(2);
    });

    it("handles vesting expiry exactly at mint time", async () => {
      const [manager, auction, owner, alice, bob, founder1] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const expiredTimestamp = Math.floor(Date.now() / 1000) - 1;

      const founders = [
        { wallet: founder1.address, ownershipPct: 10, vestExpiry: expiredTimestamp },
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

      await token.connect(auction).mintTo(alice.address);

      const scheduledRecipient = await token.getScheduledRecipient(0);
      expect(scheduledRecipient.wallet).to.equal(ethers.ZeroAddress);
    });

    it("handles token ID wrapping at 100", async () => {
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

      const scheduledRecipient0 = await token.getScheduledRecipient(0);
      const scheduledRecipient10 = await token.getScheduledRecipient(10);
      const scheduledRecipient20 = await token.getScheduledRecipient(20);

      expect(scheduledRecipient0.wallet).to.equal(founder1.address);
      expect(scheduledRecipient10.wallet).to.equal(founder1.address);
      expect(scheduledRecipient20.wallet).to.equal(founder1.address);
    });
  });

  describe("Delegation Edge Cases", () => {
    it("handles duplicate tokenIds in delegation", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      const tokenIds = [0, 1, 0, 1, 0];

      await token.connect(owner).delegateTokenIds(alice.address, tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(2);
    });

    it("handles duplicate tokenIds in clear", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      const tokenIds = [0, 0, 0];

      await token.connect(owner).clearTokenDelegation(tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(1);
    });

    it("handles delegation of non-existent token", async () => {
      const { token, owner, alice } = await deployToken();

      await expect(
        token.connect(owner).delegateTokenIds(alice.address, [999])
      ).to.be.revertedWithCustomError(token, "INVALID_OWNER");
    });

    it("handles delegation after token is burned", async () => {
      const { token, auction, manager, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      await token.connect(owner).burn(0);

      await expect(
        token.connect(owner).delegateTokenIds(alice.address, [0])
      ).to.be.revertedWithCustomError(token, "INVALID_OWNER");
    });

    it("handles clearing delegation of non-existent token", async () => {
      const { token, owner } = await deployToken();

      await expect(
        token.connect(owner).clearTokenDelegation([999])
      ).to.be.revertedWithCustomError(token, "INVALID_OWNER");
    });

    it("handles delegating to same delegate multiple times", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);
    });
  });

  describe("Transfer Edge Cases", () => {
    it("handles transfer of delegated token correctly", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).transferFrom(owner.address, bob.address, 0);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);
    });

    it("handles self-transfer", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      await token.connect(owner).transferFrom(owner.address, owner.address, 0);

      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);
    });

    it("handles multiple transfers in same block", async () => {
      const { token, auction, owner, alice, bob, charlie } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).transferFrom(owner.address, alice.address, 0);
      await token.connect(owner).transferFrom(owner.address, bob.address, 1);
      await token.connect(owner).transferFrom(owner.address, charlie.address, 2);
      await ethers.provider.send("evm_mine", []);

      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.getVotes(charlie.address)).to.equal(1);
    });

    it("handles transfer to contract without onERC721Received", async () => {
      const { token, auction, owner } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      const DummyContract = await ethers.getContractFactory("MockMetadataRenderer");
      const dummyContract = await DummyContract.deploy();

      await token.connect(owner).transferFrom(owner.address, await dummyContract.getAddress(), 0);

      expect(await token.ownerOf(0)).to.equal(await dummyContract.getAddress());
    });
  });

  describe("Burn Edge Cases", () => {
    it("handles burning delegated token", async () => {
      const { token, auction, manager, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).burn(0);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(0);
    });

    it("handles burning non-delegated token", async () => {
      const { token, auction, manager, owner } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);

      expect(await token.getVotes(owner.address)).to.equal(1);

      await token.connect(owner).burn(0);

      expect(await token.getVotes(owner.address)).to.equal(0);
    });

    it("prevents burning of non-existent token", async () => {
      const { token, manager, owner } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);

      await expect(token.connect(owner).burn(999)).to.be.revertedWithCustomError(token, "INVALID_OWNER");
    });

    it("prevents burning token not owned by sender", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: alice.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);

      await expect(token.connect(alice).burn(0)).to.be.revertedWithCustomError(token, "ONLY_TOKEN_OWNER");
    });
  });

  describe("Metadata Edge Cases", () => {
    it("handles contract URI", async () => {
      const { token } = await deployToken();

      const uri = await token.contractURI();
      expect(uri).to.equal("ipfs://mock-contract");
    });
  });

  describe("Access Control Edge Cases", () => {
    it("prevents non-minter from minting", async () => {
      const { token, alice } = await deployToken();

      await expect(token.connect(alice).mint()).to.be.revertedWithCustomError(token, "ONLY_AUCTION_OR_MINTER");
      await expect(token.connect(alice).mintTo(alice.address)).to.be.revertedWithCustomError(token, "ONLY_AUCTION_OR_MINTER");
    });

    it("prevents non-minter from minting from reserve", async () => {
      const { token, manager, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);
      await token.connect(manager).setReservedUntilTokenId(10);

      await expect(token.connect(alice).mintFromReserveTo(alice.address, 5)).to.be.revertedWithCustomError(token, "ONLY_AUCTION_OR_MINTER");
    });

    it("prevents non-owner from updating minters", async () => {
      const { token, alice } = await deployToken();

      await expect(
        token.connect(alice).updateMinters([{ minter: alice.address, allowed: true }])
      ).to.be.revertedWithCustomError(token, "ONLY_OWNER");
    });

    it("prevents non-owner from setting reserve", async () => {
      const { token, alice } = await deployToken();

      await expect(token.connect(alice).setReservedUntilTokenId(100)).to.be.revertedWithCustomError(token, "ONLY_OWNER");
    });
  });

  describe("Batch Operation Edge Cases", () => {
    it("handles batch delegation of single token", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);
    });

    it("handles batch clear of mixed delegated and non-delegated tokens", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0, 2]);

      await token.connect(owner).clearTokenDelegation([0, 1, 2]);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(3);
    });

    it("respects updated batch size limits", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      for (let i = 0; i < 6; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      await token.connect(manager).setMaxBatchSize(5);

      const tokenIds = Array.from({ length: 6 }, (_, i) => i);
      await expect(
        token.connect(owner).delegateTokenIds(alice.address, tokenIds)
      ).to.be.revertedWithCustomError(token, "BATCH_SIZE_EXCEEDED");

      await expect(
        token.connect(owner).delegateTokenIds(alice.address, tokenIds.slice(0, 5))
      ).to.not.be.reverted;
    });

    it("locks checkpoint window updates after minting", async () => {
      const { token, manager, auction, owner } = await deployToken();

      await token.connect(manager).setMaxCheckpoints(500);
      expect(await token.maxCheckpoints()).to.equal(500);

      await token.connect(auction).mintTo(owner.address);

      await expect(
        token.connect(manager).setMaxCheckpoints(400)
      ).to.be.revertedWithCustomError(token, "CHECKPOINTS_ALREADY_INITIALIZED");
    });
  });

  describe("Reserve Minting Edge Cases", () => {
    async function deployTokenWithReserve(reserveAmount: number) {
      const [manager, auction, owner, alice, bob] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const initData = Token.interface.encodeFunctionData("initialize", [
        [],
        encodeInitStrings(),
        reserveAmount,
        await metadata.getAddress(),
        auction.address,
        manager.address,
      ]);

      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await Proxy.connect(manager).deploy(await impl.getAddress(), initData);

      const token = Token.attach(await proxy.getAddress());

      return { token, manager, auction, owner, alice, bob };
    }

    it("handles reserve at boundary (0)", async () => {
      const { token, manager, alice } = await deployTokenWithReserve(0);

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      await expect(token.connect(manager).mintFromReserveTo(alice.address, 0)).to.be.revertedWithCustomError(token, "TOKEN_NOT_RESERVED");
    });

    it("handles reserve at maximum boundary", async () => {
      const { token, manager, alice } = await deployTokenWithReserve(100);

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      await token.connect(manager).mintFromReserveTo(alice.address, 99);

      expect(await token.ownerOf(99)).to.equal(alice.address);
    });

    it("tracks remaining tokens correctly", async () => {
      const { token, manager, alice } = await deployTokenWithReserve(10);

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      expect(await token.remainingTokensInReserve()).to.equal(10);

      await token.connect(manager).mintFromReserveTo(alice.address, 0);
      expect(await token.remainingTokensInReserve()).to.equal(9);

      await token.connect(manager).mintFromReserveTo(alice.address, 1);
      expect(await token.remainingTokensInReserve()).to.equal(8);
    });

    it("prevents decreasing reserve after mints", async () => {
      const { token, manager, auction } = await deployTokenWithReserve(10);

      await token.connect(auction).mint();

      await expect(token.connect(manager).setReservedUntilTokenId(5)).to.be.revertedWithCustomError(token, "CANNOT_CHANGE_RESERVE");
    });
  });

  describe("Voting Mechanics Edge Cases", () => {
    it("handles getPastVotes at block boundary", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      const blockNumber = (await ethers.provider.getBlock("latest"))!.number;

      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await ethers.provider.send("evm_mine", []);

      expect(await token.getPastVotes(alice.address, blockNumber)).to.equal(0);
      expect(await token.getVotes(alice.address)).to.equal(1);
    });

    it("handles getPastVotes for future block", async () => {
      const { token, auction, owner } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      const currentBlock = (await ethers.provider.getBlock("latest"))!.number;
      const futureBlock = currentBlock + 1;

      await expect(token.getPastVotes(owner.address, futureBlock)).to.be.revertedWithCustomError(token, "INVALID_TIMESTAMP");
    });

    it("handles getPastVotes before any checkpoints", async () => {
      const { token, owner, alice } = await deployToken();

      const currentBlock = (await ethers.provider.getBlock("latest"))!.number;
      await ethers.provider.send("evm_mine", []);

      expect(await token.getPastVotes(alice.address, currentBlock)).to.equal(0);
    });

    it("handles voting weight after complex operations", async () => {
      const { token, auction, owner, alice, bob, charlie } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0, 1]);
      await token.connect(owner).delegateTokenIds(bob.address, [2]);

      expect(await token.getVotes(alice.address)).to.equal(2);
      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.getVotes(owner.address)).to.equal(0);

      await token.connect(owner).clearTokenDelegation([0]);

      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.getVotes(owner.address)).to.equal(1);

      await token.connect(owner).delegateTokenIds(charlie.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.getVotes(charlie.address)).to.equal(1);
      expect(await token.getVotes(owner.address)).to.equal(0);
    });
  });

  describe("Storage Layout Edge Cases", () => {
    it("maintains rawTokenDelegate storage compatibility", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);

      await token.connect(owner).clearTokenDelegation([0]);

      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);
    });

    it("handles rawTokenDelegate for non-existent token", async () => {
      const { token } = await deployToken();

      expect(await token.rawTokenDelegate(999)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Total Supply Edge Cases", () => {
    it("maintains correct total supply through mint and burn", async () => {
      const { token, auction, manager, owner } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);

      expect(await token.totalSupply()).to.equal(0);

      await token.connect(auction).mintTo(owner.address);
      expect(await token.totalSupply()).to.equal(1);

      await token.connect(auction).mintTo(owner.address);
      expect(await token.totalSupply()).to.equal(2);

      await token.connect(owner).burn(0);
      expect(await token.totalSupply()).to.equal(1);

      await token.connect(owner).burn(1);
      expect(await token.totalSupply()).to.equal(0);
    });

    it("handles batch mint total supply", async () => {
      const { token, auction, alice } = await deployToken();

      await token.connect(auction).mintBatchTo(10, alice.address);

      expect(await token.totalSupply()).to.equal(10);
      expect(await token.balanceOf(alice.address)).to.equal(10);
    });
  });
});
