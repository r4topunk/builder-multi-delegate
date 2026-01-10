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
import { TokenStorageV4 } from "./storage/TokenStorageV4.sol";

/// @title MultiDelegateToken
/// @notice A DAO's ERC-721 governance token with per-token delegation
/// @dev Extends Builder Protocol's Token with per-token delegation capability.
///      Each token can be delegated to a different address, enabling vote splitting.
contract MultiDelegateToken is
    IToken,
    VersionedContract,
    UUPS,
    Ownable,
    ReentrancyGuard,
    ERC721SplitVotes,
    TokenStorageV1,
    TokenStorageV2,
    TokenStorageV3,
    TokenStorageV4
{
    ///                                                          ///
    ///                         IMMUTABLES                       ///
    ///                                                          ///

    /// @notice The contract upgrade manager
    IManager private immutable manager;

    /// @notice Gas limit for metadata renderer callbacks
    uint256 private constant METADATA_GAS_LIMIT = 500_000;

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
    /// @param tokenId The token whose delegation changed
    /// @param fromDelegate The previous delegate
    /// @param toDelegate The new delegate
    event TokenDelegateChanged(uint256 indexed tokenId, address indexed fromDelegate, address indexed toDelegate);

    /// @notice Emitted when a token's delegation is cleared
    /// @param tokenId The token whose delegation was cleared
    /// @param previousDelegate The delegate that was removed
    event TokenDelegationCleared(uint256 indexed tokenId, address indexed previousDelegate);

    /// @notice Emitted when the metadata renderer fails during mint
    /// @param tokenId The token id being minted
    /// @param renderer The metadata renderer address
    /// @param reason The revert data (empty if renderer returned false)
    /// @param returnedFalse Whether the renderer returned false instead of reverting
    event MetadataRendererFailed(uint256 indexed tokenId, address indexed renderer, bytes reason, bool returnedFalse);

    /// @notice Emitted when the batch size limit changes
    /// @param previousValue The previous batch size limit
    /// @param newValue The new batch size limit
    event MaxBatchSizeUpdated(uint256 previousValue, uint256 newValue);

    /// @notice Emitted when the checkpoint window changes
    /// @param previousValue The previous checkpoint window
    /// @param newValue The new checkpoint window
    event MaxCheckpointsUpdated(uint256 previousValue, uint256 newValue);

    /// @notice Emitted when the reserve mint counter is updated
    /// @param previousValue The previous reserve mint count
    /// @param newValue The new reserve mint count
    event ReserveMintedUpdated(uint256 previousValue, uint256 newValue);

    /// @dev Reverts when delegatee is address(0)
    error INVALID_DELEGATE();

    /// @dev Reverts when batch size exceeds maximum
    error BATCH_SIZE_EXCEEDED();

    /// @dev Reverts when batch size is invalid
    error INVALID_BATCH_SIZE();

    /// @dev Reverts when checkpoint window is invalid
    error INVALID_MAX_CHECKPOINTS();

    /// @dev Reverts when checkpoint configuration is locked
    error CHECKPOINTS_ALREADY_INITIALIZED();

    /// @dev Reverts when reserve mint count is invalid
    error INVALID_RESERVE_MINTED();

    /// @dev Reverts when mint count would overflow
    error CANNOT_MINT();

    /// @dev Reverts when a minter update includes the zero address
    error INVALID_MINTER();

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
        unchecked {
            ++reserveMinted;
        }
    }

    function mintBatchTo(uint256 amount, address recipient) external nonReentrant onlyAuctionOrMinter returns (uint256[] memory tokenIds) {
        if (amount > _batchSizeLimit()) revert BATCH_SIZE_EXCEEDED();

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
                if (settings.mintCount == type(uint88).max) revert CANNOT_MINT();
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

        try settings.metadataRenderer.onMinted{ gas: METADATA_GAS_LIMIT }(_tokenId) returns (bool success) {
            if (!success) {
                emit MetadataRendererFailed(_tokenId, address(settings.metadataRenderer), "", true);
            }
        } catch (bytes memory reason) {
            emit MetadataRendererFailed(_tokenId, address(settings.metadataRenderer), reason, false);
        }
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
        if (settings.totalSupply > 0 || settings.mintCount > 0) revert CANNOT_CHANGE_RESERVE();

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
        uint256 totalMintedFromReserve = reserveMinted;

        if (totalMintedFromReserve == 0 && settings.totalSupply >= settings.mintCount) {
            totalMintedFromReserve = settings.totalSupply - settings.mintCount;
        }

        if (totalMintedFromReserve >= reservedUntilTokenId) {
            return 0;
        }

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
            if (_minters[i].minter == address(0)) revert INVALID_MINTER();
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

    function setReserveMinted(uint256 newReserveMinted) external onlyOwner {
        if (newReserveMinted < reserveMinted || newReserveMinted > reservedUntilTokenId) {
            revert INVALID_RESERVE_MINTED();
        }

        uint256 previousValue = reserveMinted;
        reserveMinted = newReserveMinted;

        emit ReserveMintedUpdated(previousValue, newReserveMinted);
    }

    function setMetadataRenderer(IBaseMetadata newRenderer) external {
        if (msg.sender != address(manager)) {
            revert ONLY_MANAGER();
        }

        settings.metadataRenderer = newRenderer;
    }

    function maxBatchSize() external view returns (uint256) {
        return _batchSizeLimit();
    }

    function maxCheckpoints() external view returns (uint256) {
        return _maxCheckpoints();
    }

    function setMaxBatchSize(uint256 newMaxBatchSize) external onlyOwner {
        if (newMaxBatchSize == 0) revert INVALID_BATCH_SIZE();

        uint256 previousValue = _batchSizeLimit();
        maxBatchSizeValue = newMaxBatchSize;

        emit MaxBatchSizeUpdated(previousValue, newMaxBatchSize);
    }

    function setMaxCheckpoints(uint256 newMaxCheckpoints) external onlyOwner {
        if (newMaxCheckpoints == 0) revert INVALID_MAX_CHECKPOINTS();
        if (settings.totalSupply > 0 || settings.mintCount > 0) revert CHECKPOINTS_ALREADY_INITIALIZED();

        uint256 previousValue = _maxCheckpoints();
        maxCheckpointsValue = newMaxCheckpoints;

        emit MaxCheckpointsUpdated(previousValue, newMaxCheckpoints);
    }

    ///                                                          ///
    ///                         DELEGATION                       ///
    ///                                                          ///

    /// @notice Returns the delegate for a tokenId
    /// @param tokenId The token to query
    /// @return The delegate address (returns owner if no explicit delegation)
    function tokenDelegate(uint256 tokenId) external view returns (address) {
        address delegatee = tokenDelegates[tokenId];
        return delegatee == address(0) ? ownerOf(tokenId) : delegatee;
    }

    /// @notice Returns the raw delegate for a tokenId (address(0) if not explicitly delegated)
    /// @param tokenId The token to query
    /// @return The delegate address or address(0) if using implicit owner delegation
    function rawTokenDelegate(uint256 tokenId) external view returns (address) {
        return tokenDelegates[tokenId];
    }

    /// @notice Delegates specific tokenIds to a delegatee
    /// @param delegatee The address to delegate votes to
    /// @param tokenIds The token IDs to delegate
    function delegateTokenIds(address delegatee, uint256[] calldata tokenIds) external nonReentrant {
        if (delegatee == address(0)) revert INVALID_DELEGATE();
        if (tokenIds.length > _batchSizeLimit()) revert BATCH_SIZE_EXCEEDED();

        for (uint256 i = 0; i < tokenIds.length; ) {
            uint256 tokenId = tokenIds[i];

            address tokenOwner = ownerOf(tokenId);
            if (!_isOwnerOrApproved(tokenOwner, msg.sender, tokenId)) {
                revert ONLY_TOKEN_OWNER();
            }

            address currentDelegate = tokenDelegates[tokenId];
            address prevDelegate = currentDelegate == address(0) ? tokenOwner : currentDelegate;

            if (delegatee == tokenOwner) {
                if (currentDelegate != address(0)) {
                    delete tokenDelegates[tokenId];
                    emit TokenDelegationCleared(tokenId, currentDelegate);
                    _moveDelegateVotes(prevDelegate, tokenOwner, 1);
                }
            } else if (prevDelegate != delegatee) {
                tokenDelegates[tokenId] = delegatee;
                emit TokenDelegateChanged(tokenId, prevDelegate, delegatee);
                _moveDelegateVotes(prevDelegate, delegatee, 1);
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Clears delegation for specific tokenIds (returns votes to owner)
    /// @param tokenIds The token IDs to clear delegation for
    function clearTokenDelegation(uint256[] calldata tokenIds) external nonReentrant {
        if (tokenIds.length > _batchSizeLimit()) revert BATCH_SIZE_EXCEEDED();

        for (uint256 i = 0; i < tokenIds.length; ) {
            uint256 tokenId = tokenIds[i];

            address tokenOwner = ownerOf(tokenId);
            if (!_isOwnerOrApproved(tokenOwner, msg.sender, tokenId)) {
                revert ONLY_TOKEN_OWNER();
            }

            address prevDelegate = tokenDelegates[tokenId];
            if (prevDelegate != address(0)) {
                delete tokenDelegates[tokenId];
                emit TokenDelegationCleared(tokenId, prevDelegate);
                _moveDelegateVotes(prevDelegate, tokenOwner, 1);
            }

            unchecked {
                ++i;
            }
        }
    }

    /// @dev Returns true if spender is owner or approved for the token
    function _isOwnerOrApproved(
        address tokenOwner,
        address spender,
        uint256 tokenId
    ) internal view returns (bool) {
        return spender == tokenOwner || operatorApprovals[tokenOwner][spender] || tokenApprovals[tokenId] == spender;
    }

    function _batchSizeLimit() internal view returns (uint256) {
        return maxBatchSizeValue == 0 ? DEFAULT_MAX_BATCH_SIZE : maxBatchSizeValue;
    }

    function _maxCheckpoints() internal view override returns (uint256) {
        return maxCheckpointsValue == 0 ? MAX_CHECKPOINTS : maxCheckpointsValue;
    }

    /// @dev Handles vote accounting on transfer, including clearing per-token delegation
    /// @param _from The sender address
    /// @param _to The recipient address
    /// @param _tokenId The token being transferred
    function _afterTokenTransfer(
        address _from,
        address _to,
        uint256 _tokenId
    ) internal override(ERC721SplitVotes) {
        // Self-transfers should not affect delegation
        if (_from == _to) {
            super._afterTokenTransfer(_from, _to, _tokenId);
            return;
        }

        address currentDelegate = tokenDelegates[_tokenId];
        address prevDelegate = currentDelegate == address(0) ? _from : currentDelegate;
        address newDelegate = _to;

        // Clear any existing delegation override on transfer/burn
        if (currentDelegate != address(0)) {
            delete tokenDelegates[_tokenId];
            emit TokenDelegationCleared(_tokenId, currentDelegate);
        }

        // Move votes: from previous delegate to new owner (or address(0) for burn)
        _moveDelegateVotes(prevDelegate, newDelegate, 1);

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
