use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Bid {
    pub bidder: Pubkey,
    pub amount: u64,
    pub created_at: i64,
    pub updated_at: i64,
    pub active: bool,
    pub bump: u8,
}
