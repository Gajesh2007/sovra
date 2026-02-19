// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import "../src/CartoonistAuction.sol";

contract MockUSDC is IERC20 {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract CartoonistAuctionTest is Test {
    CartoonistAuction auction;
    MockUSDC usdc;
    address agent = address(this);
    address bidder1 = address(0x1);
    address bidder2 = address(0x2);
    address bidder3 = address(0x3);

    uint256 constant MIN_BID = 10e6;  // 10 USDC
    uint256 constant BID_1 = 50e6;    // 50 USDC
    uint256 constant BID_2 = 100e6;   // 100 USDC

    function setUp() public {
        usdc = new MockUSDC();
        auction = new CartoonistAuction(address(usdc), MIN_BID, agent);

        usdc.mint(bidder1, 1000e6);
        usdc.mint(bidder2, 1000e6);
        usdc.mint(bidder3, 1000e6);

        vm.prank(bidder1);
        usdc.approve(address(auction), type(uint256).max);
        vm.prank(bidder2);
        usdc.approve(address(auction), type(uint256).max);
        vm.prank(bidder3);
        usdc.approve(address(auction), type(uint256).max);
    }

    // --- Place bid ---

    function test_placeBid() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);

        (uint256 amount,,, bool active) = auction.getBid(bidder1);
        assertEq(amount, BID_1);
        assertTrue(active);
        assertEq(usdc.balanceOf(address(auction)), BID_1);
        assertEq(auction.activeBidCount(), 1);
    }

    function test_placeBid_multipleBidders() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);
        vm.prank(bidder2);
        auction.placeBid(BID_2);

        assertEq(auction.activeBidCount(), 2);
        assertEq(usdc.balanceOf(address(auction)), BID_1 + BID_2);
    }

    function test_revert_placeBid_tooLow() public {
        vm.prank(bidder1);
        vm.expectRevert(CartoonistAuction.BidTooLow.selector);
        auction.placeBid(1e6);
    }

    function test_revert_placeBid_alreadyActive() public {
        vm.startPrank(bidder1);
        auction.placeBid(BID_1);
        vm.expectRevert(CartoonistAuction.AlreadyHasActiveBid.selector);
        auction.placeBid(BID_1);
        vm.stopPrank();
    }

    // --- Update bid ---

    function test_updateBid_increase() public {
        vm.startPrank(bidder1);
        auction.placeBid(BID_1);
        auction.updateBid(int256(20e6));
        vm.stopPrank();

        (uint256 amount,,, bool active) = auction.getBid(bidder1);
        assertEq(amount, BID_1 + 20e6);
        assertTrue(active);
        assertEq(usdc.balanceOf(address(auction)), BID_1 + 20e6);
    }

    function test_updateBid_decrease() public {
        vm.startPrank(bidder1);
        auction.placeBid(BID_1);
        auction.updateBid(-int256(20e6));
        vm.stopPrank();

        (uint256 amount,,,) = auction.getBid(bidder1);
        assertEq(amount, BID_1 - 20e6);
        assertEq(usdc.balanceOf(bidder1), 1000e6 - BID_1 + 20e6);
    }

    function test_updateBid_zeroChange() public {
        vm.startPrank(bidder1);
        auction.placeBid(BID_1);
        auction.updateBid(0); // just updates timestamp
        vm.stopPrank();

        (uint256 amount,,,) = auction.getBid(bidder1);
        assertEq(amount, BID_1);
    }

    function test_revert_updateBid_notActive() public {
        vm.prank(bidder1);
        vm.expectRevert(CartoonistAuction.BidNotActive.selector);
        auction.updateBid(0);
    }

    function test_revert_updateBid_belowMinimum() public {
        vm.startPrank(bidder1);
        auction.placeBid(MIN_BID);
        vm.expectRevert(CartoonistAuction.AmountBelowMinimum.selector);
        auction.updateBid(-int256(1e6));
        vm.stopPrank();
    }

    // --- Withdraw ---

    function test_withdrawBid() public {
        vm.startPrank(bidder1);
        auction.placeBid(BID_1);
        uint256 balBefore = usdc.balanceOf(bidder1);
        auction.withdrawBid();
        vm.stopPrank();

        assertEq(usdc.balanceOf(bidder1) - balBefore, BID_1);
        (,,, bool active) = auction.getBid(bidder1);
        assertFalse(active);
        assertEq(auction.activeBidCount(), 0);
    }

    function test_revert_withdrawBid_notActive() public {
        vm.prank(bidder1);
        vm.expectRevert(CartoonistAuction.BidNotActive.selector);
        auction.withdrawBid();
    }

    // --- Settle ---

    function test_settle() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);
        vm.prank(bidder2);
        auction.placeBid(BID_2);

        uint256 agentBalBefore = usdc.balanceOf(agent);
        auction.settle(bidder2);

        assertEq(usdc.balanceOf(agent) - agentBalBefore, BID_2);
        (,,, bool active) = auction.getBid(bidder2);
        assertFalse(active);
        assertEq(auction.activeBidCount(), 1);

        // bidder1 still active
        (uint256 b1Amount,,, bool b1Active) = auction.getBid(bidder1);
        assertEq(b1Amount, BID_1);
        assertTrue(b1Active);
    }

    function test_revert_settle_notAgent() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);

        vm.prank(bidder1);
        vm.expectRevert(CartoonistAuction.OnlyAgent.selector);
        auction.settle(bidder1);
    }

    function test_revert_settle_notActive() public {
        vm.expectRevert(CartoonistAuction.BidNotActive.selector);
        auction.settle(bidder1);
    }

    // --- Cancel ---

    function test_cancelBid() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);

        uint256 bidder1BalBefore = usdc.balanceOf(bidder1);
        auction.cancelBid(bidder1);

        assertEq(usdc.balanceOf(bidder1) - bidder1BalBefore, BID_1);
        (,,, bool active) = auction.getBid(bidder1);
        assertFalse(active);
        assertEq(auction.activeBidCount(), 0);
    }

    function test_revert_cancelBid_notAgent() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);

        vm.prank(bidder1);
        vm.expectRevert(CartoonistAuction.OnlyAgent.selector);
        auction.cancelBid(bidder1);
    }

    // --- Set agent ---

    function test_setAgent() public {
        auction.setAgent(bidder1);
        assertEq(auction.agent(), bidder1);

        // Old agent can no longer act
        vm.expectRevert(CartoonistAuction.OnlyAgent.selector);
        auction.setMinimumBid(1);
    }

    // --- Set minimum bid ---

    function test_setMinimumBid() public {
        vm.expectEmit(false, false, false, true);
        emit CartoonistAuction.MinimumBidUpdated(MIN_BID, 20e6);
        auction.setMinimumBid(20e6);
        assertEq(auction.minimumBid(), 20e6);
    }

    // --- Full flow ---

    function test_fullFlow() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);
        vm.prank(bidder2);
        auction.placeBid(BID_2);
        vm.prank(bidder3);
        auction.placeBid(30e6);

        assertEq(auction.activeBidCount(), 3);

        // bidder1 increases
        vm.prank(bidder1);
        auction.updateBid(int256(60e6)); // now 110 USDC
        (uint256 b1Amount,,,) = auction.getBid(bidder1);
        assertEq(b1Amount, 110e6);

        // Agent settles bidder1
        uint256 agentBefore = usdc.balanceOf(agent);
        auction.settle(bidder1);
        assertEq(usdc.balanceOf(agent) - agentBefore, 110e6);
        assertEq(auction.activeBidCount(), 2);

        // bidder3 withdraws
        uint256 b3Before = usdc.balanceOf(bidder3);
        vm.prank(bidder3);
        auction.withdrawBid();
        assertEq(usdc.balanceOf(bidder3) - b3Before, 30e6);

        // Agent cancels bidder2
        uint256 b2Before = usdc.balanceOf(bidder2);
        auction.cancelBid(bidder2);
        assertEq(usdc.balanceOf(bidder2) - b2Before, BID_2);

        assertEq(usdc.balanceOf(address(auction)), 0);
        assertEq(auction.activeBidCount(), 0);
    }

    // --- Re-bid after settlement ---

    function test_reBidAfterSettlement() public {
        vm.prank(bidder1);
        auction.placeBid(BID_1);
        auction.settle(bidder1);

        vm.prank(bidder1);
        auction.placeBid(BID_2);
        (uint256 amount,,, bool active) = auction.getBid(bidder1);
        assertEq(amount, BID_2);
        assertTrue(active);
    }

}
