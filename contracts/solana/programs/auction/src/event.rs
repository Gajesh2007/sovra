use anchor_lang::prelude::*;

#[event]
pub struct BidPlaced {
    pub bidder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BidUpdated {
    pub bidder: Pubkey,
    pub new_amount: u64,
}

#[event]
pub struct BidWithdrawn {
    pub bidder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BidSettled {
    pub winner: Pubkey,
    pub amount: u64,
}
