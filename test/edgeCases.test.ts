import { expect } from "chai";
import { ethers } from "hardhat";

describe("MultiDelegateToken - Edge Cases", () => {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();

    const Gnars = await ethers.getContractFactory("MockGnarsToken");
    const gnars = await Gnars.deploy();
    await gnars.mint(owner.address, 4);

    const Delegation = await ethers.getContractFactory("MultiDelegateToken");
    const delegation = await Delegation.deploy(await gnars.getAddress());

    return { gnars, delegation, owner, alice, bob };
  }

  it("clears all delegations in one call", async () => {
    const { delegation, owner, alice, bob } = await deploy();

    await delegation.connect(owner).delegate(alice.address, 2);
    await delegation.connect(owner).delegate(bob.address, 1);

    await delegation.connect(owner).clearAllDelegations();

    expect(await delegation.delegateVotes(alice.address)).to.equal(0);
    expect(await delegation.delegateVotes(bob.address)).to.equal(0);
    expect(await delegation.totalDelegated(owner.address)).to.equal(0);
    expect(await delegation.getVotes(owner.address)).to.equal(4);
  });

  it("returns delegates for owner", async () => {
    const { delegation, owner, alice } = await deploy();

    await delegation.connect(owner).delegate(alice.address, 1);

    const delegates = await delegation.getDelegates(owner.address);
    expect(delegates).to.deep.equal([alice.address]);
  });
});
