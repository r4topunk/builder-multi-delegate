import { expect } from "chai";
import { ethers } from "hardhat";

describe("MultiDelegateToken - Input Validation", () => {
  async function deploy() {
    const [owner, alice] = await ethers.getSigners();

    const Gnars = await ethers.getContractFactory("MockGnarsToken");
    const gnars = await Gnars.deploy();
    await gnars.mint(owner.address, 2);

    const Delegation = await ethers.getContractFactory("MultiDelegateToken");
    const delegation = await Delegation.deploy(await gnars.getAddress());

    return { delegation, owner, alice };
  }

  it("rejects zero-address delegate", async () => {
    const { delegation, owner } = await deploy();

    await expect(delegation.connect(owner).delegate(ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(
      delegation,
      "INVALID_DELEGATE"
    );
  });

  it("no-ops when syncing with sufficient balance", async () => {
    const { delegation, owner, alice } = await deploy();

    await delegation.connect(owner).delegate(alice.address, 1);
    await delegation.connect(alice).syncDelegations(owner.address);

    expect(await delegation.delegateVotes(alice.address)).to.equal(1);
  });
});
