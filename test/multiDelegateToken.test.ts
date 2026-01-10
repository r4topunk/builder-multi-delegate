import { expect } from "chai";
import { ethers } from "hardhat";

const encodeInitStrings = () => {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return coder.encode(
    ["string", "string", "string", "string", "string", "string"],
    ["Gnars", "GNARS", "desc", "img", "base", "contract"]
  );
};

describe("MultiDelegateToken", () => {
  async function deployToken() {
    const [manager, auction, owner, alice, bob] = await ethers.getSigners();

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

    return { token, metadata, manager, auction, owner, alice, bob };
  }

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

  it("requires the token owner to delegate or clear", async () => {
    const { token, auction, owner, alice, bob } = await deployToken();

    await token.connect(auction).mintTo(owner.address);

    await expect(token.connect(alice).delegateTokenIds(bob.address, [0])).to.be.revertedWithCustomError(
      token,
      "ONLY_TOKEN_OWNER"
    );

    await token.connect(owner).setApprovalForAll(alice.address, true);
    await expect(token.connect(alice).delegateTokenIds(bob.address, [0])).to.be.revertedWithCustomError(
      token,
      "ONLY_TOKEN_OWNER"
    );

    await expect(token.connect(alice).clearTokenDelegation([0])).to.be.revertedWithCustomError(token, "ONLY_TOKEN_OWNER");
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
