require("dotenv").config();

const { Connection, PublicKey, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");

// ⚠️ Node 18+ → fetch déjà dispo
const fetch = global.fetch || require("node-fetch");

// 🔥 ANTI-CRASH GLOBAL
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});

// 🔐 CHECK ENV
if (!process.env.HELIUS_API_KEY) {
  console.error("❌ HELIUS_API_KEY manquant");
  process.exit(1);
}

if (!process.env.WALLET_PRIVATE_KEY) {
  console.error("❌ WALLET_PRIVATE_KEY manquant");
  process.exit(1);
}

// 🔐 INIT WALLET SAFE
let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
} catch (e) {
  console.error("❌ Erreur clé privée:", e.message);
  process.exit(1);
}

const connection = new Connection(
  "https://mainnet.helius-rpc.com/?api-key=" + process.env.HELIUS_API_KEY,
  "confirmed"
);

const WALLETS_TO_TRACK = [
  "65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE"
];

const TRADE_AMOUNT = 0.15;
const SOL_MINT = "So11111111111111111111111111111111111111112";

let isRunning = true;
let lastSigMap = {};

async function getBalance() {
  try {
    const b = await connection.getBalance(wallet.publicKey);
    return b / 1e9;
  } catch (e) {
    console.error("Erreur balance:", e.message);
    return 0;
  }
}

async function analyzeTransaction(signature) {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta) return null;

    const solSpent =
      (tx.meta.preBalances[0] - tx.meta.postBalances[0]) / 1e9;

    if (solSpent > 0.05) {
      return { action: "buy", mint: "UNKNOWN", solAmount: solSpent };
    }

    return null;
  } catch (e) {
    console.error("Erreur analyse:", e.message);
    return null;
  }
}

async function swapToken(inputMint, outputMint, amount) {
  try {
    console.log("Swap lancé...");

    const quote = await fetch(
      `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`
    ).then((r) => r.json());

    if (!quote || quote.error) {
      console.log("❌ Quote échouée");
      return;
    }

    const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
      }),
    }).then((r) => r.json());

    if (!swapRes.swapTransaction) {
      console.log("❌ Swap échoué");
      return;
    }

    const swapTx = VersionedTransaction.deserialize(
      Buffer.from(swapRes.swapTransaction, "base64")
    );

    swapTx.sign([wallet]);

    const txid = await connection.sendRawTransaction(
      swapTx.serialize()
    );

    console.log("✅ Trade exécuté:", txid);
  } catch (e) {
    console.error("Erreur swap:", e.message);
  }
}

async function monitorWallet(walletAddress) {
  console.log("👀 Monitoring:", walletAddress);

  const pubkey = new PublicKey(walletAddress);

  setInterval(async () => {
    if (!isRunning) return;

    try {
      const sigs = await connection.getSignaturesForAddress(pubkey, {
        limit: 1,
      });

      if (!sigs.length) return;

      const sig = sigs[0].signature;

      if (lastSigMap[walletAddress] === sig) return;

      lastSigMap[walletAddress] = sig;

      console.log("📡 Nouvelle TX:", sig);

      const trade = await analyzeTransaction(sig);

      if (!trade) {
        console.log("Aucun trade intéressant");
        return;
      }

      console.log("🔥 Signal détecté:", trade.solAmount, "SOL");

      const amountLamports = Math.floor(TRADE_AMOUNT * 1e9);

      await swapToken(SOL_MINT, SOL_MINT, amountLamports); // test

    } catch (e) {
      console.error("Erreur monitoring:", e.message);
    }
  }, 3000); // moins agressif
}

async function main() {
  console.log("🚀 Bot démarré");
  console.log("Wallet:", wallet.publicKey.toString());

  const balance = await getBalance();
  console.log("Balance:", balance, "SOL");

  for (const w of WALLETS_TO_TRACK) {
    await monitorWallet(w);
  }
}

main();