import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { CartoonistAuction } from "../target/types/cartoonist_auction";

describe("Escrow Auction (No Rounds, No Text On-Chain)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CartoonistAuction as Program<CartoonistAuction>;
  const agent = provider.wallet as anchor.Wallet;

  let usdcMint: PublicKey;
  let agentTreasury: PublicKey;
  let bidder1: Keypair;
  let bidder2: Keypair;
  let bidder3: Keypair;
  let bidder1Usdc: PublicKey;
  let bidder2Usdc: PublicKey;
  let bidder3Usdc: PublicKey;

  const MINIMUM_BID = 10_000_000; // 10 USDC

  function getAuctionStatePda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("auction_state")], program.programId);
    return pda;
  }

  function getEscrowPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("escrow")], program.programId);
    return pda;
  }

  function getBidPda(bidder: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("bid"), bidder.toBuffer()], program.programId);
    return pda;
  }

  async function getEscrowBalance(): Promise<number> {
    const escrow = await getAccount(provider.connection, getEscrowPda());
    return Number(escrow.amount);
  }

  async function getTreasuryBalance(): Promise<number> {
    const treasury = await getAccount(provider.connection, agentTreasury);
    return Number(treasury.amount);
  }

  async function getBidderBalance(ata: PublicKey): Promise<number> {
    const account = await getAccount(provider.connection, ata);
    return Number(account.amount);
  }

  before(async () => {
    usdcMint = await createMint(provider.connection, (agent as any).payer, agent.publicKey, null, 6);
    agentTreasury = await createAssociatedTokenAccount(provider.connection, (agent as any).payer, usdcMint, agent.publicKey);

    bidder1 = Keypair.generate();
    bidder2 = Keypair.generate();
    bidder3 = Keypair.generate();

    for (const bidder of [bidder1, bidder2, bidder3]) {
      const sig = await provider.connection.requestAirdrop(bidder.publicKey, 2e9);
      await provider.connection.confirmTransaction(sig);
    }

    bidder1Usdc = await createAssociatedTokenAccount(provider.connection, (agent as any).payer, usdcMint, bidder1.publicKey);
    bidder2Usdc = await createAssociatedTokenAccount(provider.connection, (agent as any).payer, usdcMint, bidder2.publicKey);
    bidder3Usdc = await createAssociatedTokenAccount(provider.connection, (agent as any).payer, usdcMint, bidder3.publicKey);

    await mintTo(provider.connection, (agent as any).payer, usdcMint, bidder1Usdc, agent.publicKey, 1000_000_000);
    await mintTo(provider.connection, (agent as any).payer, usdcMint, bidder2Usdc, agent.publicKey, 1000_000_000);
    await mintTo(provider.connection, (agent as any).payer, usdcMint, bidder3Usdc, agent.publicKey, 1000_000_000);
  });

  it("initializes the auction", async () => {
    await program.methods.initialize(new anchor.BN(MINIMUM_BID))
      .accounts({
        auctionState: getAuctionStatePda(), usdcMint, treasury: agentTreasury,
        escrow: getEscrowPda(), agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).rpc();

    const state = await program.account.auctionState.fetch(getAuctionStatePda());
    assert.equal(state.activeBidCount.toNumber(), 0);
    assert.equal(state.minimumBid.toNumber(), MINIMUM_BID);
  });

  it("bidder1 places a bid — 50 USDC", async () => {
    const balBefore = await getBidderBalance(bidder1Usdc);

    await program.methods.placeBid(new anchor.BN(50_000_000))
      .accounts({
        auctionState: getAuctionStatePda(), bid: getBidPda(bidder1.publicKey),
        bidderUsdc: bidder1Usdc, escrow: getEscrowPda(), usdcMint,
        bidder: bidder1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([bidder1]).rpc();

    const bid = await program.account.bid.fetch(getBidPda(bidder1.publicKey));
    assert.equal(bid.amount.toNumber(), 50_000_000);
    assert.isTrue(bid.active);
    assert.equal(await getEscrowBalance(), 50_000_000);
    assert.equal(await getBidderBalance(bidder1Usdc), balBefore - 50_000_000);
  });

  it("bidder2 places a bid — 100 USDC", async () => {
    await program.methods.placeBid(new anchor.BN(100_000_000))
      .accounts({
        auctionState: getAuctionStatePda(), bid: getBidPda(bidder2.publicKey),
        bidderUsdc: bidder2Usdc, escrow: getEscrowPda(), usdcMint,
        bidder: bidder2.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([bidder2]).rpc();

    assert.equal(await getEscrowBalance(), 150_000_000);
    const state = await program.account.auctionState.fetch(getAuctionStatePda());
    assert.equal(state.activeBidCount.toNumber(), 2);
  });

  it("rejects bid below minimum", async () => {
    try {
      await program.methods.placeBid(new anchor.BN(1_000_000))
        .accounts({
          auctionState: getAuctionStatePda(), bid: getBidPda(bidder3.publicKey),
          bidderUsdc: bidder3Usdc, escrow: getEscrowPda(), usdcMint,
          bidder: bidder3.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([bidder3]).rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.message, "BidTooLow");
    }
  });

  it("bidder1 increases bid by 20 USDC", async () => {
    await program.methods.updateBid(new anchor.BN(20_000_000))
      .accounts({
        auctionState: getAuctionStatePda(), bid: getBidPda(bidder1.publicKey),
        bidderUsdc: bidder1Usdc, escrow: getEscrowPda(), usdcMint,
        bidder: bidder1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([bidder1]).rpc();

    const bid = await program.account.bid.fetch(getBidPda(bidder1.publicKey));
    assert.equal(bid.amount.toNumber(), 70_000_000);
    assert.equal(await getEscrowBalance(), 170_000_000);
  });

  it("agent settles — bidder2 wins, bidder1 persists", async () => {
    const treasuryBefore = await getTreasuryBalance();
    const escrowBefore = await getEscrowBalance();

    await program.methods.settle()
      .accounts({
        auctionState: getAuctionStatePda(),
        winningBid: getBidPda(bidder2.publicKey), escrow: getEscrowPda(),
        treasury: agentTreasury, usdcMint, agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const winnerBid = await program.account.bid.fetch(getBidPda(bidder2.publicKey));
    assert.isFalse(winnerBid.active);

    const loserBid = await program.account.bid.fetch(getBidPda(bidder1.publicKey));
    assert.isTrue(loserBid.active);
    assert.equal(loserBid.amount.toNumber(), 70_000_000);

    assert.equal(await getTreasuryBalance(), treasuryBefore + 100_000_000);
    assert.equal(await getEscrowBalance(), escrowBefore - 100_000_000);
  });

  it("rejects settling an inactive bid", async () => {
    try {
      await program.methods.settle()
        .accounts({
          auctionState: getAuctionStatePda(),
          winningBid: getBidPda(bidder2.publicKey), escrow: getEscrowPda(),
          treasury: agentTreasury, usdcMint, agent: agent.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.message, "BidNotActive");
    }
  });

  it("rejects settle from non-agent", async () => {
    try {
      await program.methods.settle()
        .accounts({
          auctionState: getAuctionStatePda(),
          winningBid: getBidPda(bidder1.publicKey), escrow: getEscrowPda(),
          treasury: agentTreasury, usdcMint, agent: bidder1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([bidder1]).rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.message, "OnlyAgent");
    }
  });

  it("agent settles again — bidder1 wins", async () => {
    const treasuryBefore = await getTreasuryBalance();

    await program.methods.settle()
      .accounts({
        auctionState: getAuctionStatePda(),
        winningBid: getBidPda(bidder1.publicKey), escrow: getEscrowPda(),
        treasury: agentTreasury, usdcMint, agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    assert.equal(await getEscrowBalance(), 0);
    assert.equal(await getTreasuryBalance(), treasuryBefore + 70_000_000);
  });

  it("winner closes inactive bid PDA to reclaim rent", async () => {
    await program.methods.closeBid()
      .accounts({ bid: getBidPda(bidder1.publicKey), bidder: bidder1.publicKey })
      .signers([bidder1]).rpc();

    const info = await provider.connection.getAccountInfo(getBidPda(bidder1.publicKey));
    assert.isNull(info);
  });

  it("cannot close an active bid", async () => {
    await program.methods.placeBid(new anchor.BN(30_000_000))
      .accounts({
        auctionState: getAuctionStatePda(), bid: getBidPda(bidder1.publicKey),
        bidderUsdc: bidder1Usdc, escrow: getEscrowPda(), usdcMint,
        bidder: bidder1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([bidder1]).rpc();

    try {
      await program.methods.closeBid()
        .accounts({ bid: getBidPda(bidder1.publicKey), bidder: bidder1.publicKey })
        .signers([bidder1]).rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.message, "BidStillActive");
    }
  });

  it("bidder1 withdraws — gets full USDC back", async () => {
    const balBefore = await getBidderBalance(bidder1Usdc);

    await program.methods.withdrawBid()
      .accounts({
        auctionState: getAuctionStatePda(), bid: getBidPda(bidder1.publicKey),
        bidderUsdc: bidder1Usdc, escrow: getEscrowPda(), usdcMint,
        bidder: bidder1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([bidder1]).rpc();

    assert.equal(await getBidderBalance(bidder1Usdc), balBefore + 30_000_000);
    const info = await provider.connection.getAccountInfo(getBidPda(bidder1.publicKey));
    assert.isNull(info);
  });

  it("cannot withdraw an inactive bid", async () => {
    try {
      await program.methods.withdrawBid()
        .accounts({
          auctionState: getAuctionStatePda(), bid: getBidPda(bidder2.publicKey),
          bidderUsdc: bidder2Usdc, escrow: getEscrowPda(), usdcMint,
          bidder: bidder2.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        }).signers([bidder2]).rpc();
      assert.fail("Should have thrown");
    } catch (err: any) {
      assert.include(err.message, "BidNotActive");
    }
  });

  it("multiple bidders: settle one, others stay active", async () => {
    await program.methods.placeBid(new anchor.BN(25_000_000))
      .accounts({
        auctionState: getAuctionStatePda(), bid: getBidPda(bidder3.publicKey),
        bidderUsdc: bidder3Usdc, escrow: getEscrowPda(), usdcMint,
        bidder: bidder3.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([bidder3]).rpc();

    await program.methods.placeBid(new anchor.BN(40_000_000))
      .accounts({
        auctionState: getAuctionStatePda(), bid: getBidPda(bidder1.publicKey),
        bidderUsdc: bidder1Usdc, escrow: getEscrowPda(), usdcMint,
        bidder: bidder1.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([bidder1]).rpc();

    assert.equal((await program.account.auctionState.fetch(getAuctionStatePda())).activeBidCount.toNumber(), 2);

    await program.methods.settle()
      .accounts({
        auctionState: getAuctionStatePda(),
        winningBid: getBidPda(bidder1.publicKey), escrow: getEscrowPda(),
        treasury: agentTreasury, usdcMint, agent: agent.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).rpc();

    const b3 = await program.account.bid.fetch(getBidPda(bidder3.publicKey));
    assert.isTrue(b3.active);
    assert.equal(b3.amount.toNumber(), 25_000_000);
    assert.equal((await program.account.auctionState.fetch(getAuctionStatePda())).activeBidCount.toNumber(), 1);
  });

  it("escrow balance equals sum of all active bids", async () => {
    const escrowBalance = await getEscrowBalance();
    const allBids = await program.account.bid.all();
    const activeTotal = allBids
      .filter(b => b.account.active)
      .reduce((sum, b) => sum + b.account.amount.toNumber(), 0);
    assert.equal(escrowBalance, activeTotal);
  });
});
