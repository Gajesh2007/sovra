import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CartoonistAuction } from "../target/types/cartoonist_auction";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CartoonistAuction as Program<CartoonistAuction>;
  const agent = provider.wallet as anchor.Wallet;

  const usdcMint = new PublicKey("3NgvNYJeyyLFnfZc2i3UQ2bLZMdjdfigg9ufyax6REo1");
  const treasury = new PublicKey("3yDRUQQm7Yw4tPKdwT4j5HyfMssgK7Zg248ftB3G6WAK");

  const [auctionStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("auction_state")],
    program.programId
  );
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow")],
    program.programId
  );

  console.log("Program ID:", program.programId.toBase58());
  console.log("Agent:", agent.publicKey.toBase58());
  console.log("Auction State PDA:", auctionStatePda.toBase58());
  console.log("Escrow PDA:", escrowPda.toBase58());
  console.log("USDC Mint:", usdcMint.toBase58());
  console.log("Treasury:", treasury.toBase58());

  const minimumBid = new anchor.BN(10_000_000); // 10 USDC

  console.log("\nInitializing auction with minimum bid: 10 USDC...");

  const tx = await program.methods
    .initialize(minimumBid)
    .accounts({
      auctionState: auctionStatePda,
      usdcMint,
      treasury,
      escrow: escrowPda,
      agent: agent.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("TX:", tx);

  const state = await program.account.auctionState.fetch(auctionStatePda);
  console.log("\nAuction initialized!");
  console.log("  Agent:", state.agent.toBase58());
  console.log("  USDC Mint:", state.usdcMint.toBase58());
  console.log("  Treasury:", state.treasury.toBase58());
  console.log("  Minimum Bid:", state.minimumBid.toNumber() / 1_000_000, "USDC");
  console.log("  Current Round ID:", state.currentRoundId.toNumber());
}

if (process.env.RUN_INIT_DEVNET === "1") {
  main().catch(console.error);
}
