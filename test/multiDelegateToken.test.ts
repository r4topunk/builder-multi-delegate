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
    expect(await token.getVotes(bob.address)).to.equal(0);
  });

  it("clears delegation explicitly", async () => {
    const { token, auction, owner, alice } = await deployToken();

    await token.connect(auction).mintTo(owner.address);
    await token.connect(owner).delegateTokenIds(alice.address, [0]);
    expect(await token.getVotes(alice.address)).to.equal(1);

    await token.connect(owner).clearTokenDelegation([0]);
    expect(await token.getVotes(alice.address)).to.equal(0);
  });

  it("rejects legacy delegate calls", async () => {
    const { token, owner, alice } = await deployToken();
    await expect(token.connect(owner).delegate(alice.address)).to.be.revertedWithCustomError(
      token,
      "USE_TOKEN_ID_DELEGATION"
    );
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
});
