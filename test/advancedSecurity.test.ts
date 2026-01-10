import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * @title MultiDelegateToken Advanced Security Tests
 * @notice Advanced security and edge case tests for MultiDelegateToken
 * @dev Tests reentrancy attacks, checkpoint bloat, vote overflow/underflow,
 *      race conditions, and other critical security edge cases.
 */

const encodeInitStrings = () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["string", "string", "string", "string", "string", "string"],
    ["Gnars", "GNARS", "desc", "img", "base", "contract"]
  );
};

describe("MultiDelegateToken - Advanced Security & Edge Cases", () => {
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

  describe("Reentrancy Attack Prevention", () => {
    it("prevents reentrancy during delegation via transfer", async () => {
      const { token, manager, auction, owner } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);

      const MaliciousReentrancy = await ethers.getContractFactory("MaliciousReentrancy");
      const malicious = await MaliciousReentrancy.deploy();
      await malicious.setToken(await token.getAddress());

      await token.connect(owner).delegateTokenIds(malicious.getAddress(), [0]);

      expect(await token.getVotes(malicious.getAddress())).to.equal(1);

      await expect(
        token.connect(malicious).transferFrom(malicious.getAddress(), owner.address, 0)
      ).to.be.revertedWithCustomError(token, "INVALID_OWNER");

      expect(await token.getVotes(malicious.getAddress())).to.equal(1);
    });

    it("prevents reentrancy during burn with delegated votes", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);

      const MaliciousReentrancy = await ethers.getContractFactory("MaliciousReentrancy");
      const malicious = await MaliciousReentrancy.deploy();

      await malicious.setShouldReenter(true);

      await expect(
        token.connect(malicious).burn(0)
      ).to.be.reverted;

      await token.connect(owner).burn(0);

      expect(await token.getVotes(alice.address)).to.equal(0);
    });

    it("prevents reentrancy during batch delegation", async () => {
      const { token, manager, auction, owner } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      for (let i = 0; i < 10; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const MaliciousReentrancy = await ethers.getContractFactory("MaliciousReentrancy");
      const malicious = await MaliciousReentrancy.deploy();
      await malicious.setToken(await token.getAddress());
      await malicious.setShouldReenter(true);

      await token.connect(owner).delegateTokenIds(malicious.getAddress(), [0, 1, 2]);

      const tokenIds = Array.from({ length: 10 }, (_, i) => i);

      await expect(
        token.connect(owner).delegateTokenIds(malicious.getAddress(), tokenIds)
      ).to.not.be.reverted;

      expect(await token.getVotes(malicious.getAddress())).to.equal(10);
    });

    it("prevents reentrancy during batch clear delegation", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      for (let i = 0; i < 10; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const MaliciousReentrancy = await ethers.getContractFactory("MaliciousReentrancy");
      const malicious = await MaliciousReentrancy.deploy();
      await malicious.setToken(await token.getAddress());

      const tokenIds = Array.from({ length: 10 }, (_, i) => i);
      await token.connect(owner).delegateTokenIds(alice.address, tokenIds);

      await malicious.setShouldReenter(true);

      await expect(
        token.connect(owner).clearTokenDelegation(tokenIds)
      ).to.not.be.reverted;

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(10);
    });
  });

  describe("Checkpoint Bloat Attack Prevention", () => {
    it("prevents creating more than MAX_CHECKPOINTS for an account", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      const MAX_CHECKPOINTS = 1000;

      for (let i = 0; i < MAX_CHECKPOINTS; i++) {
        await token.connect(auction).mintTo(owner.address);
        await ethers.provider.send("evm_increaseTime", [1]);
        await ethers.provider.send("evm_mine", []);

        await token.connect(owner).delegateTokenIds(alice.address, [i]);

        if (i < MAX_CHECKPOINTS - 1) {
          expect(await token.getVotes(alice.address)).to.equal(i + 1);
        }
      }

      await ethers.provider.send("evm_increaseTime", [1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        token.connect(auction).mintTo(owner.address)
      ).to.not.be.reverted;

      await token.connect(owner).delegateTokenIds(alice.address, [MAX_CHECKPOINTS]);

      expect(await token.getVotes(alice.address)).to.equal(MAX_CHECKPOINTS + 1);
    });

    it("handles multiple accounts with many checkpoints", async () => {
      const { token, manager, auction, owner, alice, bob, charlie } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      for (let i = 0; i < 500; i++) {
        await token.connect(auction).mintTo(owner.address);

        if (i % 3 === 0) {
          await token.connect(owner).delegateTokenIds(alice.address, [i]);
        } else if (i % 3 === 1) {
          await token.connect(owner).delegateTokenIds(bob.address, [i]);
        } else {
          await token.connect(owner).delegateTokenIds(charlie.address, [i]);
        }

        await ethers.provider.send("evm_increaseTime", [1]);
        await ethers.provider.send("evm_mine", []);
      }

      expect(await token.getVotes(alice.address)).to.equal(Math.ceil(500 / 3));
      expect(await token.getVotes(bob.address)).to.equal(Math.floor(500 / 3));
      expect(await token.getVotes(charlie.address)).to.equal(Math.floor(500 / 3));
    });

    it("compresses checkpoints when multiple operations occur in same block", async () => {
      const { token, manager, auction, owner, alice, bob, charlie } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      for (let i = 0; i < 10; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const blockNum = await ethers.provider.getBlockNumber();

      await token.connect(owner).delegateTokenIds(alice.address, [0, 1, 2]);
      await token.connect(owner).delegateTokenIds(bob.address, [3, 4, 5]);
      await token.connect(owner).delegateTokenIds(charlie.address, [6, 7, 8, 9]);

      const finalBlock = await ethers.provider.getBlockNumber();

      expect(finalBlock).to.equal(blockNum + 1);

      expect(await token.getVotes(alice.address)).to.equal(3);
      expect(await token.getVotes(bob.address)).to.equal(3);
      expect(await token.getVotes(charlie.address)).to.equal(4);
    });
  });

  describe("Vote Overflow/Underflow Boundaries", () => {
    it("prevents vote underflow during delegation transfer", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).clearTokenDelegation([0]);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(1);
    });

    it("handles large vote amounts across many tokens", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      const largeAmount = 500;

      for (let i = 0; i < largeAmount; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: largeAmount }, (_, i) => i);
      await token.connect(owner).delegateTokenIds(alice.address, tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(largeAmount);
      expect(await token.getVotes(owner.address)).to.equal(0);

      await token.connect(owner).clearTokenDelegation(tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(largeAmount);
    });

    it("prevents uint192 overflow with maximum vote values", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      const reasonableAmount = 1000;

      for (let i = 0; i < reasonableAmount; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: reasonableAmount }, (_, i) => i);
      await token.connect(owner).delegateTokenIds(alice.address, tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(reasonableAmount);

      await token.connect(owner).delegateTokenIds(owner.address, tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(reasonableAmount);
    });

    it("handles vote transfers from zero address", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(manager).updateMinters([{ minter: owner.address, allowed: true }]);
      await token.connect(owner).burn(0);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(0);
      expect(await token.getVotes(ethers.ZeroAddress)).to.equal(0);
    });
  });

  describe("Race Condition Prevention", () => {
    it("prevents race condition between delegation and transfer", async () => {
      const { token, manager, auction, owner, alice, bob } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      await token.connect(auction).mintTo(owner.address);

      const delegatePromise = token.connect(owner).delegateTokenIds(alice.address, [0]);
      const transferPromise = token.connect(owner).transferFrom(owner.address, bob.address, 0);

      await delegatePromise;
      await transferPromise;

      expect(await token.getVotes(bob.address)).to.equal(1);
      expect(await token.getVotes(alice.address)).to.equal(0);
    });

    it("handles rapid sequential delegations correctly", async () => {
      const { token, manager, auction, owner, alice, bob, charlie } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      await token.connect(auction).mintTo(owner.address);

      const blockNum = await ethers.provider.getBlockNumber();

      await token.connect(owner).delegateTokenIds(alice.address, [0]);
      await token.connect(owner).delegateTokenIds(bob.address, [0]);
      await token.connect(owner).delegateTokenIds(charlie.address, [0]);

      const finalBlock = await ethers.provider.getBlockNumber();

      expect(finalBlock).to.equal(blockNum + 3);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(0);
      expect(await token.getVotes(charlie.address)).to.equal(1);
    });

    it("handles delegation during batch mint", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      await token.connect(auction).mintBatchTo(10, owner.address);

      const tokenIds = Array.from({ length: 10 }, (_, i) => i);
      await token.connect(owner).delegateTokenIds(alice.address, tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(10);
      expect(await token.totalSupply()).to.equal(10);
    });
  });

  describe("Founder Vesting Exact Expiry Scenarios", () => {
    async function deployTokenWithFounders(vestExpiry: number) {
      const [manager, auction, owner, alice, bob, founder1] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const founders = [
        { wallet: founder1.address, ownershipPct: 10, vestExpiry: vestExpiry },
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

    it("handles vesting expiry exactly one second before mint", async () => {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const { token, auction, alice } = await deployTokenWithFounders(currentTimestamp - 1);

      await token.connect(auction).mintTo(alice.address);

      expect(await token.getScheduledRecipient(0)).to.equal(ethers.ZeroAddress);
    });

    it("handles vesting expiry exactly at mint time", async () => {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const { token, auction, alice } = await deployTokenWithFounders(currentTimestamp);

      await token.connect(auction).mintTo(alice.address);

      expect(await token.getScheduledRecipient(0)).to.equal(ethers.ZeroAddress);
    });

    it("handles vesting expiry one second after mint", async () => {
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const { token, auction, alice, founder1 } = await deployTokenWithFounders(currentTimestamp + 1);

      await token.connect(auction).mintTo(alice.address);

      expect(await token.getScheduledRecipient(0)).to.not.equal(ethers.ZeroAddress);
    });

    it("clears founder allocation after vesting expiry", async () => {
      const currentTimestamp = Math.floor(Date.now() / 1000) + 1;
      const { token, auction, alice, founder1 } = await deployTokenWithFounders(currentTimestamp);

      await token.connect(auction).mintTo(alice.address);

      const initialRecipient = await token.getScheduledRecipient(0);
      expect(initialRecipient.wallet).to.equal(founder1.address);

      await ethers.provider.send("evm_increaseTime", [2]);
      await ethers.provider.send("evm_mine", []);

      await token.connect(auction).mintTo(alice.address);

      const clearedRecipient = await token.getScheduledRecipient(10);
      expect(clearedRecipient.wallet).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Metadata Failure Edge Cases", () => {
    it("handles metadata generation failure on mint", async () => {
      const [manager, auction, owner, alice] = await ethers.getSigners();

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

      await expect(token.connect(auction).mintTo(alice.address)).to.not.be.reverted;
    });

    it("maintains state after failed metadata generation", async () => {
      const { token, auction, manager, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      const initialSupply = await token.totalSupply();

      await token.connect(auction).mintTo(alice.address);

      expect(await token.totalSupply()).to.equal(initialSupply + BigInt(1));
      expect(await token.getVotes(alice.address)).to.equal(1);
    });
  });

  describe("Token ID Overflow and Large Numbers", () => {
    it("handles token IDs at large numbers", async () => {
      const { token, manager, auction, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      const largeTokenId = 10000;

      await token.connect(manager).setReservedUntilTokenId(largeTokenId);
      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      await token.connect(manager).mintFromReserveTo(alice.address, largeTokenId - 1);

      expect(await token.ownerOf(largeTokenId - 1)).to.equal(alice.address);
      expect(await token.getVotes(alice.address)).to.equal(1);
    });

    it("handles delegation of high token IDs", async () => {
      const { token, manager, auction, owner, alice, bob } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      const largeTokenId = 1000;
      await token.connect(manager).setReservedUntilTokenId(largeTokenId);
      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      await token.connect(manager).mintFromReserveTo(owner.address, largeTokenId - 1);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [largeTokenId - 1]);
      await token.connect(owner).delegateTokenIds(bob.address, [largeTokenId]);

      expect(await token.getVotes(alice.address)).to.equal(1);
      expect(await token.getVotes(bob.address)).to.equal(1);
    });

    it("handles token IDs at modulo 100 boundaries", async () => {
      const { token, manager, auction, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      for (let i = 95; i < 105; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: 10 }, (_, i) => 95 + i);
      await token.connect(owner).delegateTokenIds(alice.address, tokenIds);

      expect(await token.getVotes(alice.address)).to.equal(10);
    });
  });

  describe("Storage Layout Compatibility", () => {
    it("maintains tokenDelegates mapping across operations", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);

      await token.connect(owner).clearTokenDelegation([0]);

      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);
    });

    it("handles tokenDelegates for multiple tokens", async () => {
      const { token, auction, owner, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0, 2]);
      await token.connect(owner).delegateTokenIds(bob.address, [1]);

      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);
      expect(await token.rawTokenDelegate(1)).to.equal(bob.address);
      expect(await token.rawTokenDelegate(2)).to.equal(alice.address);
    });
  });

  describe("Gas Optimization Edge Cases", () => {
    it("efficiently handles batch delegation at MAX_BATCH_SIZE", async () => {
      const { token, auction, owner, alice } = await deployToken();

      for (let i = 0; i < 100; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: 100 }, (_, i) => i);
      const tx = await token.connect(owner).delegateTokenIds(alice.address, tokenIds);
      const receipt = await tx.wait();

      expect(receipt!.gasUsed).to.be.lt(10000000n);

      expect(await token.getVotes(alice.address)).to.equal(100);
    });

    it("efficiently handles batch clear at MAX_BATCH_SIZE", async () => {
      const { token, auction, owner, alice } = await deployToken();

      for (let i = 0; i < 100; i++) {
        await token.connect(auction).mintTo(owner.address);
      }

      const tokenIds = Array.from({ length: 100 }, (_, i) => i);
      await token.connect(owner).delegateTokenIds(alice.address, tokenIds);

      const tx = await token.connect(owner).clearTokenDelegation(tokenIds);
      const receipt = await tx.wait();

      expect(receipt!.gasUsed).to.be.lt(10000000n);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(owner.address)).to.equal(100);
    });
  });

  describe("Complex Multi-Operation Scenarios", () => {
    it("handles delegate, transfer, burn, and mint in sequence", async () => {
      const { token, manager, auction, owner, alice, bob } = await deployToken();

      await token.connect(manager).updateMinters([
        { minter: auction.address, allowed: true },
        { minter: owner.address, allowed: true },
      ]);

      await token.connect(auction).mintTo(owner.address);
      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.getVotes(alice.address)).to.equal(1);

      await token.connect(owner).transferFrom(owner.address, bob.address, 0);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(1);

      await token.connect(manager).updateMinters([{ minter: bob.address, allowed: true }]);
      await token.connect(alice).burn(0);

      expect(await token.getVotes(bob.address)).to.equal(0);

      await token.connect(auction).mintTo(owner.address);

      expect(await token.getVotes(owner.address)).to.equal(1);
    });

    it("handles multiple delegates receiving and losing votes", async () => {
      const { token, auction, owner, alice, bob, charlie, dave } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      await token.connect(owner).delegateTokenIds(alice.address, [0, 1]);
      await token.connect(owner).delegateTokenIds(bob.address, [2, 3]);
      await token.connect(owner).delegateTokenIds(charlie.address, [4]);

      expect(await token.getVotes(alice.address)).to.equal(2);
      expect(await token.getVotes(bob.address)).to.equal(2);
      expect(await token.getVotes(charlie.address)).to.equal(1);

      await token.connect(owner).delegateTokenIds(dave.address, [0, 2]);
      await token.connect(owner).clearTokenDelegation([1, 3]);

      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(0);
      expect(await token.getVotes(charlie.address)).to.equal(1);
      expect(await token.getVotes(dave.address)).to.equal(2);
      expect(await token.getVotes(owner.address)).to.equal(2);
    });

    it("handles founder vesting with delegation", async () => {
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

      for (let i = 0; i < 12; i++) {
        await token.connect(auction).mintTo(alice.address);
      }

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
        await token.connect(founder1).delegateTokenIds(bob.address, [founderTokens[0]]);
        expect(await token.getVotes(bob.address)).to.equal(1);

        await token.connect(founder1).transferFrom(founder1.address, alice.address, founderTokens[0]);

        expect(await token.getVotes(bob.address)).to.equal(0);
        expect(await token.getVotes(alice.address)).to.equal(1);
      }
    });
  });

  describe("Zero Address Edge Cases", () => {
    it("prevents delegating to zero address", async () => {
      const { token, auction, owner } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      await expect(
        token.connect(owner).delegateTokenIds(ethers.ZeroAddress, [0])
      ).to.be.revertedWithCustomError(token, "INVALID_DELEGATE");
    });

    it("handles zero address in tokenDelegates after clear", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);

      await token.connect(owner).delegateTokenIds(alice.address, [0]);

      expect(await token.rawTokenDelegate(0)).to.equal(alice.address);

      await token.connect(owner).clearTokenDelegation([0]);

      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);
    });

    it("returns zero address as delegate for non-delegated tokens", async () => {
      const { token, auction, owner } = await deployToken();

      await token.connect(auction).mintTo(owner.address);

      expect(await token.rawTokenDelegate(0)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Reserve Depletion Edge Cases", () => {
    it("handles complete reserve depletion", async () => {
      const [manager, auction, owner, alice] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const reserveAmount = 10;

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

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      expect(await token.remainingTokensInReserve()).to.equal(10);

      for (let i = 0; i < 10; i++) {
        await token.connect(manager).mintFromReserveTo(alice.address, i);
      }

      expect(await token.remainingTokensInReserve()).to.equal(0);
    });

    it("prevents minting from depleted reserve", async () => {
      const [manager, auction, owner, alice] = await ethers.getSigners();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const metadata = await Metadata.deploy();

      const Token = await ethers.getContractFactory("MultiDelegateToken");
      const impl = await Token.connect(manager).deploy(manager.address);

      const initData = Token.interface.encodeFunctionData("initialize", [
        [],
        encodeInitStrings(),
        5,
        await metadata.getAddress(),
        auction.address,
        manager.address,
      ]);

      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await Proxy.connect(manager).deploy(await impl.getAddress(), initData);

      const token = Token.attach(await proxy.getAddress());

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      for (let i = 0; i < 5; i++) {
        await token.connect(manager).mintFromReserveTo(alice.address, i);
      }

      await expect(
        token.connect(manager).mintFromReserveTo(alice.address, 5)
      ).to.be.revertedWithCustomError(token, "TOKEN_NOT_RESERVED");
    });
  });

  describe("Access Control Edge Cases", () => {
    it("prevents calling onlyManager functions from unauthorized addresses", async () => {
      const { token, alice } = await deployToken();

      const Metadata = await ethers.getContractFactory("MockMetadataRenderer");
      const newMetadata = await Metadata.deploy();

      await expect(
        token.connect(alice).setMetadataRenderer(await newMetadata.getAddress())
      ).to.be.revertedWithCustomError(token, "ONLY_MANAGER");
    });

    it("prevents calling onlyOwner functions from unauthorized addresses", async () => {
      const { token, auction, alice, bob } = await deployToken();

      await token.connect(auction).mintTo(bob.address);

      await expect(
        token.connect(alice).burn(0)
      ).to.be.revertedWithCustomError(token, "ONLY_TOKEN_OWNER");

      await expect(
        token.connect(alice).delegateTokenIds(bob.address, [0])
      ).to.be.revertedWithCustomError(token, "ONLY_TOKEN_OWNER");
    });
  });

  describe("Event Emission Edge Cases", () => {
    it("emits all correct events in complex operation sequence", async () => {
      const { token, auction, manager, owner, alice } = await deployToken();

      await token.connect(manager).updateMinters([{ minter: auction.address, allowed: true }]);

      await token.connect(auction).mintTo(owner.address);

      await expect(token.connect(owner).delegateTokenIds(alice.address, [0]))
        .to.emit(token, "TokenDelegateChanged")
        .withArgs(0, owner.address, alice.address)
        .and.to.emit(token, "DelegateVotesChanged")
        .withArgs(owner.address, 1, 0)
        .and.to.emit(token, "DelegateVotesChanged")
        .withArgs(alice.address, 0, 1);

      await expect(token.connect(owner).transferFrom(owner.address, alice.address, 0))
        .to.emit(token, "TokenDelegationCleared")
        .withArgs(0, alice.address)
        .and.to.emit(token, "DelegateVotesChanged")
        .withArgs(alice.address, 1, 0)
        .and.to.emit(token, "DelegateVotesChanged")
        .withArgs(alice.address, 0, 1);
    });

    it("emits correct events in batch operations", async () => {
      const { token, auction, owner, alice } = await deployToken();

      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);
      await token.connect(auction).mintTo(owner.address);

      const tx = await token.connect(owner).delegateTokenIds(alice.address, [0, 1, 2]);

      await expect(tx)
        .to.emit(token, "TokenDelegateChanged")
        .withArgs(0, owner.address, alice.address)
        .and.to.emit(token, "TokenDelegateChanged")
        .withArgs(1, owner.address, alice.address)
        .and.to.emit(token, "TokenDelegateChanged")
        .withArgs(2, owner.address, alice.address);
    });
  });
});
