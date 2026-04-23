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
const SOL_MINT = "So11111111111111111111111111111111111111112";
let startBalance = 0;
let isRunning = true;
let positions = {};
async function getBalance() { const b = await connection.getBalance(wallet.publicKey); return b / 1e9; }
async function swapToken(inputMint, outputMint, amount) {
try {
const quote = await fetch("https://quote-api.jup.ag/v6/quote?inputMint=" + inputMint + "&outputMint=" + outputMint + "&amount=" + amount + "&slippageBps=300").then(r => r.json());
if (!quote || quote.error) { console.log("Quote erreur"); return; }
const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
method: "POST", headers: {"Content-Type": "application/json"},
body: JSON.stringify({quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true})
}).then(r => r.json());
if (!swapRes.swapTransaction) { console.log("Swap erreur"); return; }
const swapTx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
swapTx.sign([wallet]);
const txid = await connection.sendRawTransaction(swapTx.serialize());
console.log("Trade execute! TX:", txid);
return txid;
} catch(e) { console.error("Swap erreur:", e.message); }
}
async function analyzeTransaction(signature) {
try {
const tx = await connection.getTransaction(signature, {maxSupportedTransactionVersion: 0});
if (!tx || !tx.meta) return null;
const preBalances = tx.meta.preTokenBalances || [];
const postBalances = tx.meta.postTokenBalances || [];
for (const post of postBalances) {
const pre = preBalances.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmount || 0) : 0;
const postAmount = parseFloat(post.uiTokenAmount.uiAmount || 0);
if (postAmount > preAmount && post.mint !== SOL_MINT) {
return { action: "buy", mint: post.mint };
}
if (postAmount < preAmount && post.mint !== SOL_MINT) {
return { action: "sell", mint: post.mint };
}
}
return null;
} catch(e) { console.error("Analyse erreur:", e.message); return null; }
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
if (startBalance > 0) {
const pnl = ((balance - startBalance) / startBalance) * 100;
if (pnl <= -MAX_LOSS) { console.log("Stop loss!", pnl.toFixed(2) + "%"); isRunning = false; return; }
if (pnl >= DAILY_TARGET) { console.log("Objectif atteint!", pnl.toFixed(2) + "%"); isRunning = false; return; }
}
const tradeInfo = await analyzeTransaction(sigs[0].signature);
if (!tradeInfo) return;
console.log("Trade detecte:", tradeInfo.action, tradeInfo.mint);
if (tradeInfo.action === "buy" && !positions[tradeInfo.mint]) {
console.log("Achat en cours:", tradeInfo.mint);
const amountLamports = Math.floor(TRADE_AMOUNT * 1e9);
const txid = await swapToken(SOL_MINT, tradeInfo.mint, amountLamports);
if (txid) { positions[tradeInfo.mint] = { buyTx: txid, buyTime: Date.now() }; }
}
if (tradeInfo.action === "sell" && positions[tradeInfo.mint]) {
console.log("Vente en cours:", tradeInfo.mint);
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
if (tokenAccounts.value.length > 0) {
const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
if (parseInt(tokenBalance) > 0) {
await swapToken(tradeInfo.mint, SOL_MINT, tokenBalance);
delete positions[tradeInfo.mint];
}
}
}
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
