// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @title CartoonistAuction
/// @notice Simple USDC escrow for paid cartoon requests. Users bid anytime,
///         agent picks winners on its own schedule. No on-chain timing.
///         Request text and images are stored off-chain in the agent instance.
contract CartoonistAuction {
    struct Bid {
        uint256 amount;
        uint64 createdAt;
        uint64 updatedAt;
        bool active;
    }

    IERC20 public immutable usdc;
    address public agent;
    uint256 public minimumBid;
    uint256 public activeBidCount;

    mapping(address => Bid) public bids;

    event BidPlaced(address indexed bidder, uint256 amount);
    event BidUpdated(address indexed bidder, uint256 newAmount);
    event BidWithdrawn(address indexed bidder, uint256 amount);
    event BidSettled(address indexed winner, uint256 amount);
    event BidCancelled(address indexed bidder, uint256 amount);
    event MinimumBidUpdated(uint256 oldMinimum, uint256 newMinimum);

    error OnlyAgent();
    error BidTooLow();
    error BidNotActive();
    error AlreadyHasActiveBid();
    error TransferFailed();
    error AmountBelowMinimum();
    error InsufficientBid();

    modifier onlyAgent() {
        if (msg.sender != agent) revert OnlyAgent();
        _;
    }

    constructor(address _usdc, uint256 _minimumBid, address _agent) {
        usdc = IERC20(_usdc);
        agent = _agent;
        minimumBid = _minimumBid;
    }

    /// @notice Place a new bid. Caller must approve USDC first.
    ///         Reverts if caller already has an active bid (use updateBid instead).
    function placeBid(uint256 amount) external {
        if (amount < minimumBid) revert BidTooLow();
        if (bids[msg.sender].active) revert AlreadyHasActiveBid();

        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        bids[msg.sender] = Bid({
            amount: amount,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            active: true
        });

        activeBidCount++;

        emit BidPlaced(msg.sender, amount);
    }

    /// @notice Update an existing active bid amount. Positive = add USDC, negative = withdraw partial.
    function updateBid(int256 amountChange) external {
        Bid storage b = bids[msg.sender];
        if (!b.active) revert BidNotActive();

        if (amountChange > 0) {
            uint256 increase = uint256(amountChange);
            if (!usdc.transferFrom(msg.sender, address(this), increase)) revert TransferFailed();
            b.amount += increase;
        } else if (amountChange < 0) {
            uint256 decrease = uint256(-amountChange);
            if (decrease > b.amount) revert InsufficientBid();
            uint256 newAmount = b.amount - decrease;
            if (newAmount < minimumBid) revert AmountBelowMinimum();
            b.amount = newAmount;
            if (!usdc.transfer(msg.sender, decrease)) revert TransferFailed();
        }

        b.updatedAt = uint64(block.timestamp);

        emit BidUpdated(msg.sender, b.amount);
    }

    /// @notice Withdraw your entire bid and get USDC back.
    function withdrawBid() external {
        Bid storage b = bids[msg.sender];
        if (!b.active) revert BidNotActive();

        uint256 amount = b.amount;
        b.active = false;
        b.amount = 0;

        activeBidCount--;

        if (!usdc.transfer(msg.sender, amount)) revert TransferFailed();

        emit BidWithdrawn(msg.sender, amount);
    }

    /// @notice Agent picks a winner. Winner's USDC goes to agent.
    function settle(address winner) external onlyAgent {
        Bid storage b = bids[winner];
        if (!b.active) revert BidNotActive();

        uint256 amount = b.amount;
        b.active = false;
        b.amount = 0;

        activeBidCount--;

        if (!usdc.transfer(agent, amount)) revert TransferFailed();

        emit BidSettled(winner, amount);
    }

    /// @notice Agent can force-cancel a bid (refund USDC to bidder).
    function cancelBid(address bidder) external onlyAgent {
        Bid storage b = bids[bidder];
        if (!b.active) revert BidNotActive();

        uint256 amount = b.amount;
        b.active = false;
        b.amount = 0;

        activeBidCount--;

        if (!usdc.transfer(bidder, amount)) revert TransferFailed();

        emit BidCancelled(bidder, amount);
    }

    /// @notice Transfer agent role to a new address (agent only).
    function setAgent(address _agent) external onlyAgent {
        agent = _agent;
    }

    /// @notice Update minimum bid (agent only).
    function setMinimumBid(uint256 _minimumBid) external onlyAgent {
        uint256 oldMinimum = minimumBid;
        minimumBid = _minimumBid;
        emit MinimumBidUpdated(oldMinimum, _minimumBid);
    }

    // --- Views ---

    function getBid(address bidder) external view returns (
        uint256 amount,
        uint64 createdAt,
        uint64 updatedAt,
        bool active
    ) {
        Bid storage b = bids[bidder];
        return (b.amount, b.createdAt, b.updatedAt, b.active);
    }
}
