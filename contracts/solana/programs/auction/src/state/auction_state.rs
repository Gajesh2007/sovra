use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct AuctionState {
    pub agent: Pubkey,
    pub usdc_mint: Pubkey,
    pub treasury: Pubkey,
    pub escrow_bump: u8,
    pub minimum_bid: u64,
    pub active_bid_count: u64,
    pub bump: u8,
}
