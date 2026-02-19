use anchor_lang::prelude::*;

mod error;
mod event;
mod instructions;
mod state;

use instructions::*;

declare_id!("2UDUA7vCqZ87c4kCXbshF7S5uuxMXJvykwn9LJ1JnMU2");

pub const USDC_DECIMALS: u8 = 6;

#[program]
pub mod cartoonist_auction {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, minimum_bid: u64) -> Result<()> {
        instructions::initialize::handler(ctx, minimum_bid)
    }

    pub fn place_bid(ctx: Context<PlaceBid>, amount: u64) -> Result<()> {
        instructions::place_bid::handler(ctx, amount)
    }

    pub fn update_bid(ctx: Context<UpdateBid>, amount_change: i64) -> Result<()> {
        instructions::update_bid::handler(ctx, amount_change)
    }

    pub fn withdraw_bid(ctx: Context<WithdrawBid>) -> Result<()> {
        instructions::withdraw_bid::handler(ctx)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::handler(ctx)
    }

    pub fn close_bid(ctx: Context<CloseBid>) -> Result<()> {
        instructions::close_bid::handler(ctx)
    }

    pub fn set_minimum_bid(ctx: Context<SetMinimumBid>, minimum_bid: u64) -> Result<()> {
        instructions::set_minimum_bid::handler(ctx, minimum_bid)
    }

    pub fn set_agent(ctx: Context<SetAgent>) -> Result<()> {
        instructions::set_agent::handler(ctx)
    }
}
