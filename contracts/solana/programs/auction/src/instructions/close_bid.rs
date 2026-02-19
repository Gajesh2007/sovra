use anchor_lang::prelude::*;

use crate::error::AuctionError;
use crate::state::Bid;

#[derive(Accounts)]
pub struct CloseBid<'info> {
    #[account(
        mut,
        close = bidder,
        seeds = [b"bid", bidder.key().as_ref()],
        bump = bid.bump,
        constraint = !bid.active @ AuctionError::BidStillActive,
        constraint = bid.bidder == bidder.key() @ AuctionError::WrongBidder,
    )]
    pub bid: Account<'info, Bid>,
    #[account(mut)]
    pub bidder: Signer<'info>,
}

pub fn handler(_ctx: Context<CloseBid>) -> Result<()> {
    Ok(())
}
