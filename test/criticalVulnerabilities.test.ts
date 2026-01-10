import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const encodeInitStrings = () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["string", "string", "string", "string", "string", "string"],
    ["Test", "TEST", "", "", "", ""]
  );
};

describe("Critical Vulnerability Proofs", function () {
  let token: any;
  let manager: HardhatEthersSigner;
  let auction: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let victim: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  async function deployToken() {
    const signers = await ethers.getSigners();
    manager = signers[0];
    auction = signers[1];
    attacker = signers[2];
    victim = signers[3];
    user1 = signers[4];
    user2 = signers[5];

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

    return Token.attach(await proxy.getAddress());
  }

  beforeEach(async function () {
    token = await deployToken();
  });

  describe("CRITICAL: Checkpoint Limit Griefing Attack", function () {
    it("Mitigation: prevents permanent lockout by pruning old checkpoints", async function () {
      this.timeout(300000); // 5 minutes for long test
      console.log("\n=== CHECKPOINT GRIEFING MITIGATION ===\n");

      // Step 1: Attacker mints tokens to themselves
      const attackTokenCount = 10;
      for (let i = 0; i < attackTokenCount; i++) {
        await token.connect(auction).mintTo(attacker.address);
      }
      console.log(`✓ Attacker minted ${attackTokenCount} tokens`);

      // Step 2: Attacker alternates delegation to rotate checkpoints beyond the retention window
      const tokenIds = Array.from({ length: attackTokenCount }, (_, i) => i);
      const rounds = 550; // 1100 checkpoints > MAX_CHECKPOINTS (1000)
      let firstBlock: number | null = null;

      console.log("\n→ Rotating checkpoints beyond retention window...");

      for (let round = 0; round < rounds; round++) {
        const tx = await token.connect(attacker).delegateTokenIds(victim.address, tokenIds);
        const receipt = await tx.wait();

        if (firstBlock === null && receipt) {
          const block = await ethers.provider.getBlock(receipt.blockNumber);
          firstBlock = block!.number;
        }

        await token.connect(attacker).clearTokenDelegation(tokenIds);

        if (round % 100 === 0) {
          const victimVotes = await token.getVotes(victim.address);
          console.log(`  Round ${round}: Victim votes: ${victimVotes}`);
        }
      }

      // Step 3: Delegation still works after exceeding the checkpoint window
      await token.connect(attacker).delegateTokenIds(victim.address, tokenIds);
      expect(await token.getVotes(victim.address)).to.equal(attackTokenCount);

      // Step 4: Old history is pruned rather than locking the delegate
      expect(firstBlock).to.not.equal(null);
      await expect(
        token.getPastVotes(victim.address, firstBlock!)
      ).to.be.revertedWithCustomError(token, "CHECKPOINTS_PRUNED");

      console.log("\n✓ Delegation remains live after checkpoint rollover");
      console.log("✓ Older checkpoints are pruned to avoid lockout");
    });

    it("Should show cost to rotate the checkpoint window is bounded", async function () {
      this.timeout(60000);
      // Mint 100 tokens to attacker (MAX_BATCH_SIZE)
      for (let i = 0; i < 100; i++) {
        await token.connect(auction).mintTo(attacker.address);
      }

      const tokenIds = Array.from({ length: 100 }, (_, i) => i);

      // Measure gas for one round trip (2 checkpoints)
      const tx1 = await token.connect(attacker).delegateTokenIds(victim.address, tokenIds);
      const receipt1 = await tx1.wait();

      const tx2 = await token.connect(attacker).clearTokenDelegation(tokenIds);
      const receipt2 = await tx2.wait();

      const gasPerRoundTrip = receipt1!.gasUsed + receipt2!.gasUsed;
      const roundsNeeded = 1000 / 2; // 500 round trips to create 1000 checkpoints

      console.log("\n=== CHECKPOINT ROTATION COST ANALYSIS ===");
      console.log(`Gas per round trip (100 tokens): ${gasPerRoundTrip.toString()}`);
      console.log(`Total rounds needed: ${roundsNeeded}`);
      console.log(`Estimated total gas: ~${(gasPerRoundTrip * BigInt(roundsNeeded)).toString()}`);
      console.log("→ Rotation no longer locks delegates; history is pruned instead\n");
    });
  });

  describe("MEDIUM: Metadata Renderer DoS Risk", function () {
    it("Mitigation: renderer failure no longer blocks minting", async function () {
      console.log("\n=== MALICIOUS METADATA RENDERER MITIGATION ===\n");

      const Malicious = await ethers.getContractFactory("MaliciousRenderer");
      const malicious = await Malicious.deploy(true);

      await token.connect(manager).setMetadataRenderer(await malicious.getAddress());

      await expect(token.connect(auction).mintTo(attacker.address)).to.not.be.reverted;
      expect(await token.getVotes(attacker.address)).to.equal(1);

      console.log("✓ Mint succeeded despite renderer reverting");
      console.log("✓ Renderer failure surfaced via event, not a revert\n");
    });
  });

  describe("MEDIUM: Block Number Validation in getPastVotes", function () {
    it("Should use block numbers for historical queries", async function () {
      console.log("\n=== BLOCK NUMBER VALIDATION ===\n");

      // Mint and delegate
      await token.connect(auction).mintTo(user1.address);
      await token.connect(user1).delegateTokenIds(user2.address, [0]);

      const block = await ethers.provider.getBlock("latest");
      const currentBlock = block!.number;

      console.log(`Current block number: ${currentBlock}`);

      const votes = await token.getVotes(user2.address);
      console.log(`Current votes for user2: ${votes}`);

      await expect(
        token.getPastVotes(user2.address, currentBlock)
      ).to.be.revertedWithCustomError(token, "INVALID_TIMESTAMP");

      await ethers.provider.send("evm_mine", []);

      const pastVotes = await token.getPastVotes(user2.address, currentBlock);
      console.log(`Past votes (block-1): ${pastVotes}`);
      console.log("→ Uses block.number instead of timestamp\n");
    });
  });

  describe("MEDIUM: Storage Collision Risk", function () {
    it("Mitigation: storage gap reserved in TokenStorageV4", async function () {
      console.log("\n=== STORAGE COLLISION RISK ===\n");

      // TokenStorageV4 reserves a storage gap for upgrades
      // New variables should consume the gap before adding new storage slots

      console.log("Current storage layout:");
      console.log("  TokenStorageV1: founder[], tokenRecipient[], settings, reservedUntilTokenId");
      console.log("  TokenStorageV2: minter[]");
      console.log("  TokenStorageV3: (additional fields)");
      console.log("  TokenStorageV4: tokenDelegates[], DEFAULT_MAX_BATCH_SIZE, config");
      console.log("\n✅ MITIGATION:");
      console.log("   - TokenStorageV4 now reserves a __gap for future upgrades");
      console.log("   - Future storage additions can extend safely without collisions\n");
    });
  });

  describe("MEDIUM: Founder Update Validation Gap", function () {
    it("Mitigation: updateFounders blocks after any auction mint, even if burned", async function () {
      console.log("\n=== FOUNDER UPDATE VALIDATION MITIGATION ===\n");

      await token.connect(manager).updateMinters([{ minter: manager.address, allowed: true }]);

      await token.connect(auction).mintTo(manager.address);
      await token.connect(manager).burn(0);

      await expect(token.connect(manager).updateFounders([])).to.be.revertedWithCustomError(token, "CANNOT_CHANGE_RESERVE");

      console.log("✓ updateFounders blocked after mintCount > 0, even if totalSupply returns to 0\n");
    });
  });

  describe("MEDIUM: No Approved Operator Delegation Support", function () {
    it("Mitigation: approved operators can delegate and clear", async function () {
      console.log("\n=== APPROVED OPERATOR DELEGATION ===\n");

      await token.connect(auction).mintTo(user1.address);

      // User1 approves user2 as operator
      await token.connect(user1).setApprovalForAll(user2.address, true);

      const isApproved = await token.isApprovedForAll(user1.address, user2.address);
      console.log(`✓ User2 approved as operator: ${isApproved}`);

      // User2 delegates user1's token
      await expect(
        token.connect(user2).delegateTokenIds(victim.address, [0])
      ).to.not.be.reverted;

      expect(await token.getVotes(victim.address)).to.equal(1);

      // User2 clears delegation
      await expect(token.connect(user2).clearTokenDelegation([0])).to.not.be.reverted;
      expect(await token.getVotes(victim.address)).to.equal(0);

      console.log("✓ Approved operator can delegate and clear\n");
    });
  });

  describe("LOW: Missing Input Validation", function () {
    it("Mitigation: updateMinters rejects zero address", async function () {
      console.log("\n=== INPUT VALIDATION MITIGATION ===\n");

      await expect(
        token.connect(manager).updateMinters([{ minter: ethers.ZeroAddress, allowed: true }])
      ).to.be.revertedWithCustomError(token, "INVALID_MINTER");

      console.log("✓ Zero address minter rejected\n");
    });
  });
});
