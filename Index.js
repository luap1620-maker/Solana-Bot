require("dotenv").config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");
const fetch = require("node-fetch");
const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=" + process.env.HELIUS_API_KEY, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
const WALLETS_TO_TRACK = process.env.WALLETS_TO_TRACK.split(",");
const TRADE_AMOUNT = parseFloat(process.env.TRADE_AMOUNT_SOL) || 0.1;
const MAX_LOSS = parseFloat(process.env.MAX_LOSS_PERCENT) || 20;
const DAILY_TARGET = parseFloat(process.env.DAILY_PROFIT_TARGET) || 30;
let startBalance = 0;
let isRunning = true;
async function getBalance() { const b = await connection.getBalance(wallet.publicKey); return b / 1e9; }
async function swapToken(inputMint, outputMint, amount) {
try {
const quote = await fetch("https://quote-api.jup.ag/v6/quote?inputMint=" + inputMint + "&outputMint=" + outputMint + "&amount=" + amount + "&slippageBps=300").then(r => r.json());
if (!quote || quote.error) return;
const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
method: "POST", headers: {"Content-Type": "application/json"},
body: JSON.stringify({quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true})
}).then(r => r.json());
if (!swapRes.swapTransaction) return;
const swapTx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
swapTx.sign([wallet]);
const txid = await connection.sendRawTransaction(swapTx.serialize());
console.log("Trade execute! TX:", txid);
return txid;
} catch(e) { console.error("Swap erreur:", e.message); }
}
async function monitorWallet(walletAddress) {
console.log("Monitoring:", walletAddress);
const pubkey = new PublicKey(walletAddress);
let lastSig = null;
setInterval(async () => {
if (!isRunning) return;
try {
const sigs = await connection.getSignaturesForAddress(pubkey, {limit: 1});
if (!sigs.length || sigs[0].signature === lastSig) return;
lastSig = sigs[0].signature;
const balance = await getBalance();
const pnl = ((balance - startBalance) / startBalance) * 100;
if (pnl <= -MAX_LOSS) { console.log("Stop loss!", pnl.toFixed(2) + "%"); isRunning = false; return; }
if (pnl >= DAILY_TARGET) { console.log("Objectif atteint!", pnl.toFixed(2) + "%"); isRunning = false; return; }
console.log("Trade detecte sur", walletAddress, "| PnL:", pnl.toFixed(2) + "%");
} catch(e) { console.error("Erreur:", e.message); }
}, 2000);
}
async function main() {
console.log("Bot demarre");
console.log("Wallet:", wallet.publicKey.toString());
startBalance = await getBalance();
console.log("Balance:", startBalance, "SOL");
for (const w of WALLETS_TO_TRACK) { await monitorWallet(w.trim()); }
console.log("Bot en ecoute...");
}
main().catch(console.error);
