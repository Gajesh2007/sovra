use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::error::AuctionError;
use crate::state::AuctionState;
use crate::USDC_DECIMALS;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = agent,
        space = 8 + AuctionState::INIT_SPACE,
        seeds = [b"auction_state"],
        bump,
    )]
    pub auction_state: Account<'info, AuctionState>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = usdc_mint, token::authority = agent)]
    pub treasury: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = agent,
        token::mint = usdc_mint,
        token::authority = auction_state,
        seeds = [b"escrow"],
        bump,
    )]
    pub escrow: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Initialize>, minimum_bid: u64) -> Result<()> {
    require!(
        ctx.accounts.usdc_mint.decimals == USDC_DECIMALS,
        AuctionError::InvalidMintDecimals
    );

    let state = &mut ctx.accounts.auction_state;
    state.agent = ctx.accounts.agent.key();
    state.usdc_mint = ctx.accounts.usdc_mint.key();
    state.treasury = ctx.accounts.treasury.key();
    state.escrow_bump = ctx.bumps.escrow;
    state.minimum_bid = minimum_bid;
    state.active_bid_count = 0;
    state.bump = ctx.bumps.auction_state;
    Ok(())
}
