import { expect } from "chai";
import { ethers } from "hardhat";

describe("MultiDelegateToken", () => {
  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();

    const Gnars = await ethers.getContractFactory("MockGnarsToken");
    const gnars = await Gnars.deploy();

    await gnars.mint(owner.address, 5);

    const Delegation = await ethers.getContractFactory("MultiDelegateToken");
    const delegation = await Delegation.deploy(await gnars.getAddress());

    return { gnars, delegation, owner, alice, bob };
  }

  it("delegates by amount and keeps remainder for owner", async () => {
    const { delegation, owner, alice } = await deploy();

    await delegation.connect(owner).delegate(alice.address, 3);

    expect(await delegation.delegateVotes(alice.address)).to.equal(3);
    expect(await delegation.totalDelegated(owner.address)).to.equal(3);
    expect(await delegation.getVotes(owner.address)).to.equal(2);
  });

  it("supports redelegation and clearing", async () => {
    const { delegation, owner, alice, bob } = await deploy();

    await delegation.connect(owner).delegate(alice.address, 2);
    await delegation.connect(owner).delegate(bob.address, 1);

    await delegation.connect(owner).delegate(alice.address, 1);
    await delegation.connect(owner).clearDelegation(bob.address);

    expect(await delegation.delegateVotes(alice.address)).to.equal(1);
    expect(await delegation.delegateVotes(bob.address)).to.equal(0);
    expect(await delegation.totalDelegated(owner.address)).to.equal(1);
  });

  it("rejects delegation beyond balance", async () => {
    const { delegation, owner, alice } = await deploy();

    await expect(delegation.connect(owner).delegate(alice.address, 6)).to.be.revertedWithCustomError(
      delegation,
      "INSUFFICIENT_BALANCE"
    );
  });

  it("syncs delegations after balance drops", async () => {
    const { gnars, delegation, owner, alice, bob } = await deploy();

    await delegation.connect(owner).delegate(alice.address, 4);
    await gnars.connect(owner).transferFrom(owner.address, bob.address, 4);

    await delegation.connect(bob).syncDelegations(owner.address);

    expect(await delegation.delegateVotes(alice.address)).to.equal(0);
    expect(await delegation.totalDelegated(owner.address)).to.equal(0);
    expect(await delegation.getVotes(owner.address)).to.equal(1);
  });

  it("enforces a cap on delegate count", async () => {
    const { gnars, delegation, owner } = await deploy();
    const maxDelegates = Number(await delegation.MAX_DELEGATES_PER_OWNER());

    await gnars.mint(owner.address, maxDelegates);

    for (let i = 0; i < maxDelegates; i++) {
      const delegatee = ethers.Wallet.createRandom().address;
      await delegation.connect(owner).delegate(delegatee, 1);
    }

    const overflowDelegate = ethers.Wallet.createRandom().address;
    await expect(
      delegation.connect(owner).delegate(overflowDelegate, 1)
    ).to.be.revertedWithCustomError(delegation, "MAX_DELEGATES_EXCEEDED");

    const delegates = await delegation.getDelegates(owner.address);
    await delegation.connect(owner).clearDelegation(delegates[0]);

    await delegation.connect(owner).delegate(overflowDelegate, 1);
    expect(await delegation.delegateVotes(overflowDelegate)).to.equal(1);
  });
});
