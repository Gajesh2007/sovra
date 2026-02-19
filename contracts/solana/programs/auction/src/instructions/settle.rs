use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::error::AuctionError;
use crate::event::BidSettled;
use crate::state::{AuctionState, Bid};
use crate::USDC_DECIMALS;

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(
        mut,
        seeds = [b"auction_state"],
        bump = auction_state.bump,
        has_one = agent @ AuctionError::OnlyAgent,
        has_one = treasury,
        has_one = usdc_mint,
    )]
    pub auction_state: Account<'info, AuctionState>,
    #[account(
        mut,
        constraint = winning_bid.active @ AuctionError::BidNotActive,
    )]
    pub winning_bid: Account<'info, Bid>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = auction_state,
        seeds = [b"escrow"],
        bump = auction_state.escrow_bump,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub agent: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Settle>) -> Result<()> {
    let state = &mut ctx.accounts.auction_state;
    let winning_bid = &mut ctx.accounts.winning_bid;

    winning_bid.active = false;

    state.active_bid_count = state
        .active_bid_count
        .checked_sub(1)
        .ok_or(AuctionError::ArithmeticOverflow)?;

    let state_bump = state.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"auction_state", &[state_bump]]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.auction_state.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
            },
            signer_seeds,
        ),
        winning_bid.amount,
        USDC_DECIMALS,
    )?;

    emit!(BidSettled {
        winner: winning_bid.bidder,
        amount: winning_bid.amount,
    });

    Ok(())
}
