require("dotenv").config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");
const fetch = require("node-fetch");
const fs = require("fs");

const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=" + process.env.HELIUS_API_KEY, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
const WALLETS_TO_TRACK = ["65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE","4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk"];
const TRADE_AMOUNT = 0.10;
const TRADE_AMOUNT_REBUY = 0.05;
const MAX_LOSS = parseFloat(process.env.MAX_LOSS_PERCENT) || 20;
const DAILY_TARGET = 50;
const POSITION_STOP_LOSS = -0.50;
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

async function isTokenTradable(mint) {
try {
const quote = await fetch("https://api.jup.ag/swap/v1/quote?inputMint=" + SOL_MINT + "&outputMint=" + mint + "&amount=100000000&slippageBps=2500").then(r => r.json());
if (!quote || quote.error) { console.log("Token non tradable:", mint.slice(0,8)); return false; }
return true;
} catch(e) { return false; }
}

async function swapTokenWithRetry(inputMint, outputMint, amount, maxRetries = 3) {
const slippages = [500, 1000, 2500];
for (let i = 0; i < maxRetries; i++) {
try {
const slippage = slippages[i] || 2500;
const quote = await fetch("https://api.jup.ag/swap/v1/quote?inputMint=" + inputMint + "&outputMint=" + outputMint + "&amount=" + amount + "&slippageBps=" + slippage).then(r => r.json());
if (!quote || quote.error) { console.log("Quote erreur tentative", i+1); continue; }
const swapRes = await fetch("https://api.jup.ag/swap/v1/swap", {
method: "POST", headers: {"Content-Type": "application/json"},
body: JSON.stringify({quoteResponse: quote, userPublicKey: wallet.publicKey.toString(), wrapAndUnwrapSol: true})
}).then(r => r.json());
if (!swapRes.swapTransaction) { console.log("Swap erreur tentative", i+1); continue; }
const swapTx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, "base64"));
swapTx.sign([wallet]);
const txid = await connection.sendRawTransaction(swapTx.serialize());
console.log("Trade execute! TX:", txid);
return txid;
} catch(e) {
console.log("Tentative", i+1, "echouee:", e.message);
await new Promise(r => setTimeout(r, 2000));
}
}
console.error("Swap echoue apres", maxRetries, "tentatives");
return null;
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
if (postAmount > preAmount && post.mint !== SOL_MINT) { return { action: "buy", mint: post.mint, solAmount: Math.abs(solSpent) }; }
if (postAmount < preAmount && post.mint !== SOL_MINT) { return { action: "sell", mint: post.mint, solAmount: 0 }; }
}
return null;
} catch(e) { console.error("Analyse erreur:", e.message); return null; }
}

async function getTokenBalance(mint) {
try {
await new Promise(r => setTimeout(r, 3000));
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(mint)});
if (tokenAccounts.value.length > 0) {
return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
}
return "0";
} catch(e) { return "0"; }
}

async function checkTakeProfit(mint) {
try {
if (!positions[mint]) return;
const pos = positions[mint];
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(mint)});
if (!tokenAccounts.value.length) return;
const currentTokenAmount = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
if (parseInt(currentTokenAmount) === 0) {
console.log("Position " + mint.slice(0,8) + "... solde 0 tokens — suppression");
delete positions[mint];
savePositions();
return;
}
const quote = await fetch("https://api.jup.ag/swap/v1/quote?inputMint=" + mint + "&outputMint=" + SOL_MINT + "&amount=" + currentTokenAmount + "&slippageBps=300").then(r => r.json());
if (!quote || quote.error) return;
const currentValueSOL = parseInt(quote.outAmount) / 1e9;
const totalValueSOL = currentValueSOL + pos.solRecovered;
const globalRoi = (totalValueSOL - pos.buyAmountSOL) / pos.buyAmountSOL;
console.log("Position " + mint.slice(0,8) + "... ROI: " + (globalRoi * 100).toFixed(0) + "% | Valeur: " + currentValueSOL.toFixed(4) + " SOL");
if (globalRoi <= POSITION_STOP_LOSS && !pos.halfSold) {
console.log("Stop loss -50% sur " + mint.slice(0,8) + "... Vente totale");
if (parseInt(currentTokenAmount) > 0) {
await swapTokenWithRetry(mint, SOL_MINT, currentTokenAmount);
delete positions[mint];
savePositions();
}
} else if (globalRoi >= 1 && !pos.halfSold) {
console.log("Take profit x2! Vente 70%");
const amount70 = Math.floor(parseInt(currentTokenAmount) * 0.7).toString();
const txid = await swapTokenWithRetry(mint, SOL_MINT, amount70);
if (txid) {
positions[mint].halfSold = true;
positions[mint].solRecovered += currentValueSOL * 0.7;
positions[mint].tokenAmount = Math.floor(parseInt(currentTokenAmount) * 0.3).toString();
savePositions();
}
}
} catch(e) { console.error("Take profit erreur:", e.message); }
}

async function monitorPositions() {
console.log("Surveillance positions independante: 30s");
setInterval(async () => {
if (!isRunning) return;
const mints = Object.keys(positions);
if (mints.length === 0) return;
console.log("Verification", mints.length, "position(s)...");
for (const mint of mints) { await checkTakeProfit(mint); }
}, 30000);
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
console.log("Ignore - trop petit:", tradeInfo.solAmount.toFixed(4), "SOL");
return;
}
const tradable = await isTokenTradable(tradeInfo.mint);
if (!tradable) return;
if (positions[tradeInfo.mint]) {
if (positions[tradeInfo.mint].halfSold) {
console.log("Rachat apres x2! 0.05 SOL sur " + tradeInfo.mint.slice(0,8) + "...");
const txid = await swapTokenWithRetry(SOL_MINT, tradeInfo.mint, Math.floor(TRADE_AMOUNT_REBUY * 1e9));
if (txid) {
const tokenAmount = await getTokenBalance(tradeInfo.mint);
positions[tradeInfo.mint].tokenAmount = tokenAmount;
positions[tradeInfo.mint].buyAmountSOL += TRADE_AMOUNT_REBUY;
savePositions();
}
} else {
console.log("Position existante ignore:", tradeInfo.mint.slice(0,8));
}
return;
}
console.log("Signal! " + tradeInfo.solAmount.toFixed(3) + " SOL de " + walletAddress.slice(0,8) + "... -> achat 0.10 SOL");
const txid = await swapTokenWithRetry(SOL_MINT, tradeInfo.mint, Math.floor(TRADE_AMOUNT * 1e9));
if (txid) {
const tokenAmount = await getTokenBalance(tradeInfo.mint);
positions[tradeInfo.mint] = { buyTx: txid, buyTime: Date.now(), buyAmountSOL: TRADE_AMOUNT, tokenAmount: tokenAmount, solRecovered: 0, halfSold: false };
savePositions();
console.log("Position ouverte:", tradeInfo.mint.slice(0,8), "| Tokens:", tokenAmount);
}
}
if (tradeInfo.action === "sell" && positions[tradeInfo.mint]) {
console.log("Vente detectee sur " + walletAddress.slice(0,8) + "... -> vente position");
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
if (tokenAccounts.value.length > 0) {
const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
if (parseInt(tokenBalance) > 0) {
await swapTokenWithRetry(tradeInfo.mint, SOL_MINT, tokenBalance);
delete positions[tradeInfo.mint];
savePositions();
}
}
}
} catch(e) { console.error("Erreur:", e.message); }
}, 7000);
}

async function main() {
console.log("Bot demarre - Version finale v28");
console.log("Wallet:", wallet.publicKey.toString());
loadPositions();
startBalance = await getBalance();
console.log("Balance:", startBalance, "SOL");
console.log("Trade: 0.10 SOL | SL: -50% | TP: +100%=70% | Retry: 3 | Check wallet: 7s | Check positions: 30s");
console.log("Wallets tracked: 2 (jijo + PULL) | RPC: Helius | ROI correct");
await monitorPositions();
for (const w of WALLETS_TO_TRACK) { await monitorWallet(w); }
console.log("Bot en ecoute...");
}

main().catch(console.error);
