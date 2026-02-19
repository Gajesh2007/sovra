use anchor_lang::prelude::*;

#[error_code]
pub enum AuctionError {
    #[msg("Only the agent can perform this action")]
    OnlyAgent,
    #[msg("Bid below minimum")]
    BidTooLow,
    #[msg("Bid is not active")]
    BidNotActive,
    #[msg("Bid amount would fall below minimum")]
    AmountBelowMinimum,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrow,
    #[msg("Bid does not belong to this bidder")]
    WrongBidder,
    #[msg("Bid is still active — withdraw first or wait to win")]
    BidStillActive,
    #[msg("Arithmetic overflow or underflow")]
    ArithmeticOverflow,
    #[msg("Invalid mint decimals")]
    InvalidMintDecimals,
    #[msg("Invalid amount change")]
    InvalidAmountChange,
}
