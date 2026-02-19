use anchor_lang::prelude::*;

use crate::error::AuctionError;
use crate::state::AuctionState;

#[derive(Accounts)]
pub struct SetMinimumBid<'info> {
    #[account(
        mut,
        seeds = [b"auction_state"],
        bump = auction_state.bump,
        has_one = agent @ AuctionError::OnlyAgent,
    )]
    pub auction_state: Account<'info, AuctionState>,
    pub agent: Signer<'info>,
}

pub fn handler(ctx: Context<SetMinimumBid>, minimum_bid: u64) -> Result<()> {
    ctx.accounts.auction_state.minimum_bid = minimum_bid;
    Ok(())
}
