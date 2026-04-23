require("dotenv").config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");
const fetch = require("node-fetch");
const fs = require("fs");

const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=" + process.env.HELIUS_API_KEY, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
const WALLETS_TO_TRACK = ["65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE","4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk","FHGL93a95byonJbk8PzZFhCNuxDwgqRwUXcUkdkfeMNA","HfN9JFxwS89fERT8of2dt1it6G3P2ia5sJc5J8GkwU5k"];
const TRADE_AMOUNT_NORMAL = 0.15;
const TRADE_AMOUNT_SMALL = 0.10;
const MAX_LOSS = parseFloat(process.env.MAX_LOSS_PERCENT) || 20;
const DAILY_TARGET = 50;
const POSITION_STOP_LOSS = 0.50;
const MIN_TRADE_SOL = 0.05;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const POSITIONS_FILE = "positions.json";
let startBalance = 0;
let isRunning = true;
let positions = {};
let processedSigs = {};

function savePositions() {
try { fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positions)); } catch(e) { console.error("Erreur save positions:", e.message); }
}

function loadPositions() {
try {
if (fs.existsSync(POSITIONS_FILE)) {
positions = JSON.parse(fs.readFileSync(POSITIONS_FILE));
console.log("Positions chargees:", Object.keys(positions).length, "tokens");
}
} catch(e) { console.error("Erreur load positions:", e.message); positions = {}; }
}

async function getBalance() { const b = await connection.getBalance(wallet.publicKey); return b / 1e9; }

async function getDynamicSlippage(mint) {
try {
const res = await fetch("https://api.jup.ag/swap/v1/quote?inputMint=" + SOL_MINT + "&outputMint=" + mint + "&amount=150000000&slippageBps=1000").then(r => r.json());
if (!res || res.error) return 500;
const impact = parseFloat(res.priceImpactPct || 1);
if (impact < 1) return 300;
if (impact < 3) return 500;
if (impact < 5) return 1000;
return 1500;
} catch(e) { return 500; }
}

async function swapToken(inputMint, outputMint, amount) {
try {
const slippage = await getDynamicSlippage(outputMint === SOL_MINT ? inputMint : outputMint);
const quote = await fetch("https://api.jup.ag/swap/v1/quote?inputMint=" + inputMint + "&outputMint=" + outputMint + "&amount=" + amount + "&slippageBps=" + slippage).then(r => r.json());
if (!quote || quote.error) { console.log("Quote erreur:", quote); return; }
const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", {
method: "POST", headers: {"Content-Type": "application/json"},
body: JSON.stringify({quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true})
}).then(r => r.json());
if (!swapRes.swapTransaction) { console.log("Swap erreur:", swapRes); return; }
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
const solSpent = (tx.meta.preBalances[0] - tx.meta.postBalances[0]) / 1e9;
const preBalances = tx.meta.preTokenBalances || [];
const postBalances = tx.meta.postTokenBalances || [];
for (const post of postBalances) {
const pre = preBalances.find(p => p.mint === post.mint && p.accountIndex === post.accountIndex);
const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmount || 0) : 0;
const postAmount = parseFloat(post.uiTokenAmount.uiAmount || 0);
if (postAmount > preAmount && post.mint !== SOL_MINT) { return { action: "buy", mint: post.mint, solAmount: solSpent }; }
if (postAmount < preAmount && post.mint !== SOL_MINT) { return { action: "sell", mint: post.mint, solAmount: 0 }; }
}
return null;
} catch(e) { console.error("Analyse erreur:", e.message); return null; }
}

async function checkTakeProfit(mint) {
try {
if (!positions[mint]) return;
const pos = positions[mint];
const quote = await fetch("https://api.jup.ag/swap/v1/quote?inputMint=" + mint + "&outputMint=" + SOL_MINT + "&amount=" + pos.tokenAmount + "&slippageBps=300").then(r => r.json());
if (!quote || quote.error) return;
const currentValueSOL = parseInt(quote.outAmount) / 1e9;
const roi = currentValueSOL / pos.buyAmountSOL;
console.log("Position " + mint.slice(0,8) + "... ROI: " + (roi * 100).toFixed(0) + "%");
if (roi <= POSITION_STOP_LOSS) {
console.log("Stop loss position! -50% sur " + mint.slice(0,8) + "... Vente totale");
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(mint)});
if (tokenAccounts.value.length > 0) {
const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
if (parseInt(tokenBalance) > 0) {
await swapToken(mint, SOL_MINT, tokenBalance);
delete positions[mint];
savePositions();
}
}
} else if (roi >= 5 && !pos.bigSold) {
console.log("Take profit 5x! Vente 80%");
const amount80 = Math.floor(parseInt(pos.tokenAmount) * 0.8).toString();
await swapToken(mint, SOL_MINT, amount80);
positions[mint].bigSold = true;
savePositions();
} else if (roi >= 2 && !pos.halfSold) {
console.log("Take profit 2x! Vente 50%");
const halfAmount = Math.floor(parseInt(pos.tokenAmount) / 2).toString();
await swapToken(mint, SOL_MINT, halfAmount);
positions[mint].halfSold = true;
savePositions();
}
} catch(e) { console.error("Take profit erreur:", e.message); }
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
if (processedSigs[sigs[0].signature]) return;
processedSigs[sigs[0].signature] = true;
const balance = await getBalance();
if (startBalance > 0) {
const pnl = ((balance - startBalance) / startBalance) * 100;
if (pnl <= -MAX_LOSS) { console.log("Stop loss global!", pnl.toFixed(2) + "%"); isRunning = false; return; }
if (pnl >= DAILY_TARGET) { console.log("Objectif journalier atteint!", pnl.toFixed(2) + "%"); isRunning = false; return; }
}
const tradeInfo = await analyzeTransaction(sigs[0].signature);
if (!tradeInfo) return;
if (tradeInfo.action === "buy") {
if (tradeInfo.solAmount < MIN_TRADE_SOL) {
console.log("Ignore - trop petit:", tradeInfo.solAmount.toFixed(4), "SOL < 0.05 SOL");
return;
}
if (positions[tradeInfo.mint]) { console.log("Position existante sur " + tradeInfo.mint.slice(0,8) + "... ignore"); return; }
if (tradeInfo.solAmount >= 0.5) {
console.log("Signal fort! " + tradeInfo.solAmount.toFixed(3) + " SOL de " + walletAddress.slice(0,8) + "... -> achat 0.15 SOL");
const txid = await swapToken(SOL_MINT, tradeInfo.mint, Math.floor(TRADE_AMOUNT_NORMAL * 1e9));
if (txid) {
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
const tokenAmount = tokenAccounts.value.length > 0 ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount : "0";
positions[tradeInfo.mint] = { buyTx: txid, buyTime: Date.now(), buyAmountSOL: TRADE_AMOUNT_NORMAL, tokenAmount: tokenAmount, halfSold: false, bigSold: false };
savePositions();
}
} else {
console.log("Signal moyen! " + tradeInfo.solAmount.toFixed(3) + " SOL de " + walletAddress.slice(0,8) + "... -> achat 0.10 SOL");
const txid = await swapToken(SOL_MINT, tradeInfo.mint, Math.floor(TRADE_AMOUNT_SMALL * 1e9));
if (txid) {
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
const tokenAmount = tokenAccounts.value.length > 0 ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount : "0";
positions[tradeInfo.mint] = { buyTx: txid, buyTime: Date.now(), buyAmountSOL: TRADE_AMOUNT_SMALL, tokenAmount: tokenAmount, halfSold: false, bigSold: false };
savePositions();
}
}
}
if (tradeInfo.action === "sell" && positions[tradeInfo.mint]) {
console.log("Vente detectee sur " + walletAddress.slice(0,8) + "... -> vente position");
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
if (tokenAccounts.value.length > 0) {
const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
if (parseInt(tokenBalance) > 0) {
await swapToken(tradeInfo.mint, SOL_MINT, tokenBalance);
delete positions[tradeInfo.mint];
savePositions();
}
}
}
for (const mint of Object.keys(positions)) { await checkTakeProfit(mint); }
} catch(e) { console.error("Erreur:", e.message); }
}, 3000);
}

async function main() {
console.log("Bot demarre - Version finale v16");
console.log("Wallet:", wallet.publicKey.toString());
loadPositions();
startBalance = await getBalance();
console.log("Balance:", startBalance, "SOL");
console.log("Trade: 0.15 SOL (>0.5) / 0.10 SOL (<0.5) | Min: 0.05 SOL | SL: -50% | TP: 2x=50% 5x=80%");
console.log("Wallets tracked: 4 | RPC: Helius | Slippage: dynamique ameliore");
for (const w of WALLETS_TO_TRACK) { await monitorWallet(w); }
console.log("Bot en ecoute...");
}

main().catch(console.error);
