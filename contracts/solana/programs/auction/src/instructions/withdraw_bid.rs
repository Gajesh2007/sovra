use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::error::AuctionError;
use crate::event::BidWithdrawn;
use crate::state::{AuctionState, Bid};
use crate::USDC_DECIMALS;

#[derive(Accounts)]
pub struct WithdrawBid<'info> {
    #[account(
        mut,
        seeds = [b"auction_state"],
        bump = auction_state.bump,
        has_one = usdc_mint,
    )]
    pub auction_state: Account<'info, AuctionState>,
    #[account(
        mut,
        close = bidder,
        seeds = [b"bid", bidder.key().as_ref()],
        bump = bid.bump,
        constraint = bid.bidder == bidder.key() @ AuctionError::WrongBidder,
        constraint = bid.active @ AuctionError::BidNotActive,
    )]
    pub bid: Account<'info, Bid>,
    #[account(mut, token::mint = usdc_mint, token::authority = bidder)]
    pub bidder_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = auction_state,
        seeds = [b"escrow"],
        bump = auction_state.escrow_bump,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub bidder: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<WithdrawBid>) -> Result<()> {
    let amount = ctx.accounts.bid.amount;
    let bidder = ctx.accounts.bid.bidder;
    let state_bump = ctx.accounts.auction_state.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"auction_state", &[state_bump]]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.bidder_usdc.to_account_info(),
                authority: ctx.accounts.auction_state.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        USDC_DECIMALS,
    )?;

    ctx.accounts.auction_state.active_bid_count = ctx
        .accounts
        .auction_state
        .active_bid_count
        .checked_sub(1)
        .ok_or(AuctionError::ArithmeticOverflow)?;

    emit!(BidWithdrawn { bidder, amount });

    Ok(())
}
