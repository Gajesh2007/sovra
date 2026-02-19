use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::error::AuctionError;
use crate::event::BidUpdated;
use crate::state::{AuctionState, Bid};
use crate::USDC_DECIMALS;

#[derive(Accounts)]
pub struct UpdateBid<'info> {
    #[account(
        seeds = [b"auction_state"],
        bump = auction_state.bump,
        has_one = usdc_mint,
    )]
    pub auction_state: Account<'info, AuctionState>,
    #[account(
        mut,
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

pub fn handler(ctx: Context<UpdateBid>, amount_change: i64) -> Result<()> {
    let state = &ctx.accounts.auction_state;
    let bid = &mut ctx.accounts.bid;
    let clock = Clock::get()?;

    if amount_change > 0 {
        let increase = amount_change as u64;
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
            increase,
            USDC_DECIMALS,
        )?;
        bid.amount = bid
            .amount
            .checked_add(increase)
            .ok_or(AuctionError::ArithmeticOverflow)?;
    } else if amount_change < 0 {
        let decrease = amount_change
            .checked_abs()
            .ok_or(AuctionError::InvalidAmountChange)? as u64;
        let new_amount = bid.amount.checked_sub(decrease).ok_or(AuctionError::InsufficientEscrow)?;
        require!(new_amount >= state.minimum_bid, AuctionError::AmountBelowMinimum);

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
            decrease,
            USDC_DECIMALS,
        )?;
        bid.amount = new_amount;
    }

    bid.updated_at = clock.unix_timestamp;

    emit!(BidUpdated {
        bidder: ctx.accounts.bidder.key(),
        new_amount: bid.amount,
    });

    Ok(())
}
