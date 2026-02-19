use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::error::AuctionError;
use crate::event::BidPlaced;
use crate::state::{AuctionState, Bid};
use crate::USDC_DECIMALS;

#[derive(Accounts)]
pub struct PlaceBid<'info> {
    #[account(
        mut,
        seeds = [b"auction_state"],
        bump = auction_state.bump,
        has_one = usdc_mint,
    )]
    pub auction_state: Account<'info, AuctionState>,
    #[account(
        init,
        payer = bidder,
        space = 8 + Bid::INIT_SPACE,
        seeds = [b"bid", bidder.key().as_ref()],
        bump,
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
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBid>, amount: u64) -> Result<()> {
    let state = &mut ctx.accounts.auction_state;
    let bid = &mut ctx.accounts.bid;
    let clock = Clock::get()?;

    require!(amount >= state.minimum_bid, AuctionError::BidTooLow);

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.bidder_usdc.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.bidder.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
            },
        ),
        amount,
        USDC_DECIMALS,
    )?;

    bid.bidder = ctx.accounts.bidder.key();
    bid.amount = amount;
    bid.created_at = clock.unix_timestamp;
    bid.updated_at = clock.unix_timestamp;
    bid.active = true;
    bid.bump = ctx.bumps.bid;

    state.active_bid_count = state
        .active_bid_count
        .checked_add(1)
        .ok_or(AuctionError::ArithmeticOverflow)?;

    emit!(BidPlaced {
        bidder: ctx.accounts.bidder.key(),
        amount,
    });

    Ok(())
}
