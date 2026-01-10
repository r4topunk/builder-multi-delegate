import { expect } from "chai";
import { ethers } from "hardhat";

describe("MultiDelegateToken - Delegation Safety", () => {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();

    const Gnars = await ethers.getContractFactory("MockGnarsToken");
    const gnars = await Gnars.deploy();
    await gnars.mint(owner.address, 3);

    const Delegation = await ethers.getContractFactory("MultiDelegateToken");
    const delegation = await Delegation.deploy(await gnars.getAddress());

    return { gnars, delegation, owner, alice, bob };
  }

  it("allows permissionless sync when balance drops", async () => {
    const { gnars, delegation, owner, alice, bob } = await deploy();

    await delegation.connect(owner).delegate(alice.address, 2);
    await gnars.connect(owner).transferFrom(owner.address, bob.address, 2);

    await expect(delegation.connect(bob).syncDelegations(owner.address)).to.emit(
      delegation,
      "DelegationsCleared"
    );

    expect(await delegation.getVotes(owner.address)).to.equal(1);
  });
});
