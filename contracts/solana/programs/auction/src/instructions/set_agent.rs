use anchor_lang::prelude::*;

use crate::error::AuctionError;
use crate::state::AuctionState;

#[derive(Accounts)]
pub struct SetAgent<'info> {
    #[account(
        mut,
        seeds = [b"auction_state"],
        bump = auction_state.bump,
        has_one = agent @ AuctionError::OnlyAgent,
    )]
    pub auction_state: Account<'info, AuctionState>,
    pub agent: Signer<'info>,
    /// CHECK: The new agent address — no constraints needed, just stored.
    pub new_agent: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<SetAgent>) -> Result<()> {
    ctx.accounts.auction_state.agent = ctx.accounts.new_agent.key();
    Ok(())
}
