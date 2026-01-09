// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { UUPS } from "../lib/nouns-protocol/src/lib/proxy/UUPS.sol";
import { ReentrancyGuard } from "../lib/nouns-protocol/src/lib/utils/ReentrancyGuard.sol";
import { ERC721 } from "../lib/nouns-protocol/src/lib/token/ERC721.sol";
import { Ownable } from "../lib/nouns-protocol/src/lib/utils/Ownable.sol";
import { TokenStorageV1 } from "../lib/nouns-protocol/src/token/storage/TokenStorageV1.sol";
import { TokenStorageV2 } from "../lib/nouns-protocol/src/token/storage/TokenStorageV2.sol";
import { TokenStorageV3 } from "../lib/nouns-protocol/src/token/storage/TokenStorageV3.sol";
import { IBaseMetadata } from "../lib/nouns-protocol/src/token/metadata/interfaces/IBaseMetadata.sol";
import { IManager } from "../lib/nouns-protocol/src/manager/IManager.sol";
import { IAuction } from "../lib/nouns-protocol/src/auction/IAuction.sol";
import { IToken } from "../lib/nouns-protocol/src/token/IToken.sol";
import { VersionedContract } from "../lib/nouns-protocol/src/VersionedContract.sol";
import { ERC721SplitVotes } from "./lib/ERC721SplitVotes.sol";

/// @title MultiDelegateToken
/// @notice A DAO's ERC-721 governance token with per-token delegation
contract MultiDelegateToken is
    IToken,
    VersionedContract,
    UUPS,
    Ownable,
    ReentrancyGuard,
    ERC721SplitVotes,
    TokenStorageV1,
    TokenStorageV2,
    TokenStorageV3
{
    ///                                                          ///
    ///                         IMMUTABLES                       ///
    ///                                                          ///

    /// @notice The contract upgrade manager
    IManager private immutable manager;

    ///                                                          ///
    ///                          MODIFIERS                       ///
    ///                                                          ///

    /// @notice Reverts if caller is not an authorized minter
    modifier onlyMinter() {
        if (!minter[msg.sender]) {
            revert ONLY_AUCTION_OR_MINTER();
        }

        _;
    }

    /// @notice Reverts if caller is not an authorized minter
    modifier onlyAuctionOrMinter() {
        if (msg.sender != settings.auction && !minter[msg.sender]) {
            revert ONLY_AUCTION_OR_MINTER();
        }

        _;
    }

    ///                                                          ///
    ///                         DELEGATION                       ///
    ///                                                          ///

    /// @notice Emitted when a token's delegate changes
    event TokenDelegateChanged(uint256 indexed tokenId, address indexed fromDelegate, address indexed toDelegate);

    /// @notice Emitted when a token's delegation is cleared
    event TokenDelegationCleared(uint256 indexed tokenId, address indexed previousDelegate);

    /// @dev Reverts when delegatee is address(0)
    error INVALID_DELEGATE();

    /// @notice Token-level delegate mapping
    /// @dev tokenId => delegate
    mapping(uint256 => address) internal tokenDelegates;

    ///                                                          ///
    ///                         CONSTRUCTOR                      ///
    ///                                                          ///

    /// @param _manager The contract upgrade manager address
    constructor(address _manager) payable initializer {
        manager = IManager(_manager);
    }

    ///                                                          ///
    ///                         INITIALIZER                      ///
    ///                                                          ///

    /// @notice Initializes a DAO's ERC-721 token
    /// @param _founders The founding members to receive vesting allocations
    /// @param _initStrings The encoded token and metadata initialization strings
    /// @param _reservedUntilTokenId The tokenId that a DAO's auctions will start at
    /// @param _metadataRenderer The token's metadata renderer
    /// @param _auction The token's auction house
    /// @param _initialOwner The initial owner of the token
    function initialize(
        IManager.FounderParams[] calldata _founders,
        bytes calldata _initStrings,
        uint256 _reservedUntilTokenId,
        address _metadataRenderer,
        address _auction,
        address _initialOwner
    ) external initializer {
        if (msg.sender != address(manager)) {
            revert ONLY_MANAGER();
        }

        __ReentrancyGuard_init();
        __Ownable_init(_initialOwner);

        _addFounders(_founders);

        (string memory _name, string memory _symbol, , , , ) = abi.decode(_initStrings, (string, string, string, string, string, string));

        __ERC721_init(_name, _symbol);

        settings.metadataRenderer = IBaseMetadata(_metadataRenderer);
        settings.auction = _auction;
        reservedUntilTokenId = _reservedUntilTokenId;
    }

    /// @notice Called by the auction upon the first unpause / token mint to transfer ownership from founder to treasury
    function onFirstAuctionStarted() external override {
        if (msg.sender != settings.auction) {
            revert ONLY_AUCTION();
        }

        _transferOwnership(IAuction(settings.auction).treasury());
    }

    /// @notice Called upon initialization to add founders and compute their vesting allocations
    function _addFounders(IManager.FounderParams[] calldata _founders) internal {
        uint256 totalOwnership;
        uint8 numFoundersAdded = 0;

        unchecked {
            for (uint256 i; i < _founders.length; ++i) {
                uint256 founderPct = _founders[i].ownershipPct;
                if (founderPct == 0) {
                    continue;
                }

                totalOwnership += founderPct;
                if (totalOwnership > 99) {
                    revert INVALID_FOUNDER_OWNERSHIP();
                }

                uint256 founderId = numFoundersAdded++;
                Founder storage newFounder = founder[founderId];
                newFounder.wallet = _founders[i].wallet;
                newFounder.vestExpiry = uint32(_founders[i].vestExpiry);
                newFounder.ownershipPct = uint8(founderPct);

                uint256 schedule = 100 / founderPct;
                uint256 baseTokenId = 0;

                for (uint256 j; j < founderPct; ++j) {
                    baseTokenId = _getNextTokenId(baseTokenId);
                    tokenRecipient[baseTokenId] = newFounder;
                    emit MintScheduled(baseTokenId, founderId, newFounder);
                    baseTokenId = (baseTokenId + schedule) % 100;
                }
            }

            settings.totalOwnership = uint8(totalOwnership);
            settings.numFounders = numFoundersAdded;
        }
    }

    function _getNextTokenId(uint256 _tokenId) internal view returns (uint256) {
        unchecked {
            while (tokenRecipient[_tokenId].wallet != address(0)) {
                _tokenId = (++_tokenId) % 100;
            }

            return _tokenId;
        }
    }

    ///                                                          ///
    ///                             MINT                         ///
    ///                                                          ///

    function mint() external nonReentrant onlyAuctionOrMinter returns (uint256 tokenId) {
        tokenId = _mintWithVesting(msg.sender);
    }

    function mintTo(address recipient) external nonReentrant onlyAuctionOrMinter returns (uint256 tokenId) {
        tokenId = _mintWithVesting(recipient);
    }

    function mintFromReserveTo(address recipient, uint256 tokenId) external nonReentrant onlyMinter {
        if (tokenId >= reservedUntilTokenId) revert TOKEN_NOT_RESERVED();
        _mint(recipient, tokenId);
    }

    function mintBatchTo(uint256 amount, address recipient) external nonReentrant onlyAuctionOrMinter returns (uint256[] memory tokenIds) {
        tokenIds = new uint256[](amount);
        for (uint256 i = 0; i < amount; ) {
            tokenIds[i] = _mintWithVesting(recipient);
            unchecked {
                ++i;
            }
        }
    }

    function _mintWithVesting(address recipient) internal returns (uint256 tokenId) {
        unchecked {
            do {
                tokenId = reservedUntilTokenId + settings.mintCount++;
            } while (_isForFounder(tokenId));
        }

        _mint(recipient, tokenId);
    }

    function _mint(address _to, uint256 _tokenId) internal override {
        super._mint(_to, _tokenId);

        unchecked {
            ++settings.totalSupply;
        }

        if (!settings.metadataRenderer.onMinted(_tokenId)) revert NO_METADATA_GENERATED();
    }

    function _isForFounder(uint256 _tokenId) private returns (bool) {
        uint256 baseTokenId = _tokenId % 100;

        if (tokenRecipient[baseTokenId].wallet == address(0)) {
            return false;
        } else if (block.timestamp < tokenRecipient[baseTokenId].vestExpiry) {
            _mint(tokenRecipient[baseTokenId].wallet, _tokenId);
            return true;
        } else {
            delete tokenRecipient[baseTokenId];
            return false;
        }
    }

    ///                                                          ///
    ///                             BURN                         ///
    ///                                                          ///

    function burn(uint256 _tokenId) external onlyAuctionOrMinter {
        if (ownerOf(_tokenId) != msg.sender) {
            revert ONLY_TOKEN_OWNER();
        }

        _burn(_tokenId);
    }

    function _burn(uint256 _tokenId) internal override {
        super._burn(_tokenId);

        unchecked {
            --settings.totalSupply;
        }
    }

    ///                                                          ///
    ///                           METADATA                       ///
    ///                                                          ///

    function tokenURI(uint256 _tokenId) public view override(IToken, ERC721) returns (string memory) {
        return settings.metadataRenderer.tokenURI(_tokenId);
    }

    function contractURI() public view override(IToken, ERC721) returns (string memory) {
        return settings.metadataRenderer.contractURI();
    }

    ///                                                          ///
    ///                           FOUNDERS                       ///
    ///                                                          ///

    function totalFounders() external view returns (uint256) {
        return settings.numFounders;
    }

    function totalFounderOwnership() external view returns (uint256) {
        return settings.totalOwnership;
    }

    function getFounder(uint256 _founderId) external view returns (Founder memory) {
        return founder[_founderId];
    }

    function getFounders() external view returns (Founder[] memory) {
        uint256 numFounders = settings.numFounders;
        Founder[] memory founders = new Founder[](numFounders);

        unchecked {
            for (uint256 i; i < numFounders; ++i) {
                founders[i] = founder[i];
            }
        }

        return founders;
    }

    function getScheduledRecipient(uint256 _tokenId) external view returns (Founder memory) {
        return tokenRecipient[_tokenId % 100];
    }

    function updateFounders(IManager.FounderParams[] calldata newFounders) external onlyOwner {
        uint256 numFounders = settings.numFounders;
        Founder[] memory cachedFounders = new Founder[](numFounders);

        unchecked {
            for (uint256 i; i < numFounders; ++i) {
                cachedFounders[i] = founder[i];
            }
        }

        bool[] memory clearedTokenIds = new bool[](100);

        unchecked {
            for (uint256 i; i < cachedFounders.length; ++i) {
                Founder memory cachedFounder = cachedFounders[i];
                delete founder[i];

                if (cachedFounder.ownershipPct == 0) {
                    continue;
                }

                uint256 schedule = 100 / cachedFounder.ownershipPct;
                uint256 baseTokenId;

                for (uint256 j; j < cachedFounder.ownershipPct; ++j) {
                    while (clearedTokenIds[baseTokenId] != false) {
                        baseTokenId = (++baseTokenId) % 100;
                    }

                    delete tokenRecipient[baseTokenId];
                    clearedTokenIds[baseTokenId] = true;

                    emit MintUnscheduled(baseTokenId, i, cachedFounder);

                    baseTokenId = (baseTokenId + schedule) % 100;
                }
            }
        }

        settings.numFounders = 0;
        settings.totalOwnership = 0;
        emit FounderAllocationsCleared(newFounders);

        _addFounders(newFounders);
    }

    ///                                                          ///
    ///                           SETTINGS                       ///
    ///                                                          ///

    function totalSupply() external view returns (uint256) {
        return settings.totalSupply;
    }

    function remainingTokensInReserve() external view returns (uint256) {
        uint256 totalMintedFromReserve = settings.totalSupply - settings.mintCount;
        return reservedUntilTokenId - totalMintedFromReserve;
    }

    function auction() external view returns (address) {
        return settings.auction;
    }

    function metadataRenderer() external view returns (address) {
        return address(settings.metadataRenderer);
    }

    function owner() public view override(IToken, Ownable) returns (address) {
        return super.owner();
    }

    function updateMinters(MinterParams[] calldata _minters) external onlyOwner {
        for (uint256 i; i < _minters.length; ++i) {
            if (minter[_minters[i].minter] == _minters[i].allowed) continue;

            emit MinterUpdated(_minters[i].minter, _minters[i].allowed);
            minter[_minters[i].minter] = _minters[i].allowed;
        }
    }

    function isMinter(address _minter) external view returns (bool) {
        return minter[_minter];
    }

    function setReservedUntilTokenId(uint256 newReservedUntilTokenId) external onlyOwner {
        if (settings.mintCount > 0) {
            revert CANNOT_CHANGE_RESERVE();
        }

        if (settings.totalSupply > 0 && reservedUntilTokenId > newReservedUntilTokenId) {
            revert CANNOT_DECREASE_RESERVE();
        }

        reservedUntilTokenId = newReservedUntilTokenId;

        emit ReservedUntilTokenIDUpdated(newReservedUntilTokenId);
    }

    function setMetadataRenderer(IBaseMetadata newRenderer) external {
        if (msg.sender != address(manager)) {
            revert ONLY_MANAGER();
        }

        settings.metadataRenderer = newRenderer;
    }

    ///                                                          ///
    ///                         DELEGATION                       ///
    ///                                                          ///

    /// @notice Returns the delegate for a tokenId
    function tokenDelegate(uint256 tokenId) external view returns (address) {
        return tokenDelegates[tokenId];
    }

    /// @notice Delegates specific tokenIds to a delegatee
    function delegateTokenIds(address delegatee, uint256[] calldata tokenIds) external {
        if (delegatee == address(0)) revert INVALID_DELEGATE();

        for (uint256 i = 0; i < tokenIds.length; ) {
            uint256 tokenId = tokenIds[i];

            if (ownerOf(tokenId) != msg.sender) {
                revert ONLY_TOKEN_OWNER();
            }

            address prevDelegate = tokenDelegates[tokenId];
            if (prevDelegate != delegatee) {
                tokenDelegates[tokenId] = delegatee;
                emit TokenDelegateChanged(tokenId, prevDelegate, delegatee);
                _moveDelegateVotes(prevDelegate, delegatee, 1);
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Clears delegation for specific tokenIds
    function clearTokenDelegation(uint256[] calldata tokenIds) external {
        for (uint256 i = 0; i < tokenIds.length; ) {
            uint256 tokenId = tokenIds[i];

            if (ownerOf(tokenId) != msg.sender) {
                revert ONLY_TOKEN_OWNER();
            }

            address prevDelegate = tokenDelegates[tokenId];
            if (prevDelegate != address(0)) {
                delete tokenDelegates[tokenId];
                emit TokenDelegationCleared(tokenId, prevDelegate);
                _moveDelegateVotes(prevDelegate, address(0), 1);
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @dev Clears delegation on transfer and prevents auto-delegation
    function _afterTokenTransfer(
        address _from,
        address _to,
        uint256 _tokenId
    ) internal override(ERC721SplitVotes) {
        address prevDelegate = tokenDelegates[_tokenId];
        if (prevDelegate != address(0)) {
            delete tokenDelegates[_tokenId];
            emit TokenDelegationCleared(_tokenId, prevDelegate);
            _moveDelegateVotes(prevDelegate, address(0), 1);
        }

        super._afterTokenTransfer(_from, _to, _tokenId);
    }

    ///                                                          ///
    ///                         TOKEN UPGRADE                    ///
    ///                                                          ///

    function _authorizeUpgrade(address _newImpl) internal view override {
        if (msg.sender != owner()) revert ONLY_OWNER();

        if (!manager.isRegisteredUpgrade(_getImplementation(), _newImpl)) revert INVALID_UPGRADE(_newImpl);
    }
}
