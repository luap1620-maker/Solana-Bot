require("dotenv").config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require("@solana/web3.js");
const bs58 = require("bs58");
const fetch = require("node-fetch");

const connection = new Connection("https://solemn-radial-putty.solana-mainnet.quiknode.pro/cd42ac6fe3a3e34e390b754cc8a6c1e3dfa516a8/", "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
const WALLETS_TO_TRACK = ["65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE","4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk","HfN9JFxwS89fERT8of2dt1it6G3P2ia5sJc5J8GkwU5k","FHGL93a95byonJbk8PzZFhCNuxDwgqRwUXcUkdkfeMNA"];
const TRADE_AMOUNT_NORMAL = 0.15;
const TRADE_AMOUNT_SMALL = 0.10;
const MAX_LOSS = parseFloat(process.env.MAX_LOSS_PERCENT) || 20;
const DAILY_TARGET = 50;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const MIN_LIQUIDITY_SOL = 5;
let startBalance = 0;
let isRunning = true;
let positions = {};
const walletAverages = {
"65paNEG8m7mCVoASVF2KbRdU21aKXdASSB9G3NjCSQuE": 1.859,
"4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk": 1.145,
"HfN9JFxwS89fERT8of2dt1it6G3P2ia5sJc5J8GkwU5k": 1.660,
"FHGL93a95byonJbk8PzZFhCNuxDwgqRwUXcUkdkfeMNA": 1.832
};

async function getBalance() { const b = await connection.getBalance(wallet.publicKey); return b / 1e9; }

async function checkLiquidity(mint) {
try {
const res = await fetch("https://quote-api.jup.ag/v6/quote?inputMint=" + SOL_MINT + "&outputMint=" + mint + "&amount=1000000000&slippageBps=1000").then(r => r.json());
if (!res || res.error) return 0;
const priceImpact = parseFloat(res.priceImpactPct || 100);
if (priceImpact > 5) return 0;
return MIN_LIQUIDITY_SOL + 1;
} catch(e) { return 0; }
}

async function getDynamicSlippage(mint) {
try {
const res = await fetch("https://quote-api.jup.ag/v6/quote?inputMint=" + SOL_MINT + "&outputMint=" + mint + "&amount=150000000&slippageBps=1000").then(r => r.json());
if (!res || res.error) return 300;
const impact = parseFloat(res.priceImpactPct || 1);
if (impact < 1) return 100;
if (impact < 3) return 300;
if (impact < 5) return 500;
return 1000;
} catch(e) { return 300; }
}

async function swapToken(inputMint, outputMint, amount) {
try {
const slippage = await getDynamicSlippage(outputMint === SOL_MINT ? inputMint : outputMint);
const quote = await fetch("https://quote-api.jup.ag/v6/quote?inputMint=" + inputMint + "&outputMint=" + outputMint + "&amount=" + amount + "&slippageBps=" + slippage).then(r => r.json());
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
const quote = await fetch("https://quote-api.jup.ag/v6/quote?inputMint=" + mint + "&outputMint=" + SOL_MINT + "&amount=" + pos.tokenAmount + "&slippageBps=300").then(r => r.json());
if (!quote || quote.error) return;
const currentValueSOL = parseInt(quote.outAmount) / 1e9;
const roi = currentValueSOL / pos.buyAmountSOL;
if (roi >= 5 && !pos.bigSold) {
console.log("Take profit 5x! Vente 80%");
const amount80 = Math.floor(parseInt(pos.tokenAmount) * 0.8).toString();
await swapToken(mint, SOL_MINT, amount80);
positions[mint].bigSold = true;
} else if (roi >= 2 && !pos.halfSold) {
console.log("Take profit 2x! Vente 50%");
const halfAmount = Math.floor(parseInt(pos.tokenAmount) / 2).toString();
await swapToken(mint, SOL_MINT, halfAmount);
positions[mint].halfSold = true;
}
} catch(e) { console.error("Take profit erreur:", e.message); }
}

async function monitorWallet(walletAddress) {
console.log("Monitoring:", walletAddress);
const pubkey = new PublicKey(walletAddress);
let lastSig = null;
const average = walletAverages[walletAddress] || 1.0;
setInterval(async () => {
if (!isRunning) return;
try {
const sigs = await connection.getSignaturesForAddress(pubkey, {limit: 1});
if (!sigs.length || sigs[0].signature === lastSig) return;
lastSig = sigs[0].signature;
const balance = await getBalance();
if (startBalance > 0) {
const pnl = ((balance - startBalance) / startBalance) * 100;
if (pnl <= -MAX_LOSS) { console.log("Stop loss global!", pnl.toFixed(2) + "%"); isRunning = false; return; }
if (pnl >= DAILY_TARGET) { console.log("Objectif journalier atteint!", pnl.toFixed(2) + "%"); isRunning = false; return; }
}
const tradeInfo = await analyzeTransaction(sigs[0].signature);
if (!tradeInfo) return;
if (tradeInfo.action === "buy") {
const highThreshold = average * 1.5;
const lowThreshold = average * 0.8;
if (tradeInfo.solAmount < lowThreshold) {
console.log("Ignore - montant", tradeInfo.solAmount.toFixed(3), "< seuil min", lowThreshold.toFixed(3));
return;
}
if (positions[tradeInfo.mint]) return;
const liquidity = await checkLiquidity(tradeInfo.mint);
if (liquidity < MIN_LIQUIDITY_SOL) { console.log("Liquidite insuffisante, ignore"); return; }
if (tradeInfo.solAmount >= highThreshold) {
console.log("Signal fort! " + tradeInfo.solAmount.toFixed(3) + " SOL -> achat 0.15 SOL");
const txid = await swapToken(SOL_MINT, tradeInfo.mint, Math.floor(TRADE_AMOUNT_NORMAL * 1e9));
if (txid) {
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
const tokenAmount = tokenAccounts.value.length > 0 ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount : "0";
positions[tradeInfo.mint] = { buyTx: txid, buyTime: Date.now(), buyAmountSOL: TRADE_AMOUNT_NORMAL, tokenAmount: tokenAmount, halfSold: false, bigSold: false };
}
} else {
console.log("Signal moyen! " + tradeInfo.solAmount.toFixed(3) + " SOL -> achat 0.10 SOL");
const txid = await swapToken(SOL_MINT, tradeInfo.mint, Math.floor(TRADE_AMOUNT_SMALL * 1e9));
if (txid) {
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
const tokenAmount = tokenAccounts.value.length > 0 ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount : "0";
positions[tradeInfo.mint] = { buyTx: txid, buyTime: Date.now(), buyAmountSOL: TRADE_AMOUNT_SMALL, tokenAmount: tokenAmount, halfSold: false, bigSold: false };
}
}
}
if (tradeInfo.action === "sell" && positions[tradeInfo.mint]) {
const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {mint: new PublicKey(tradeInfo.mint)});
if (tokenAccounts.value.length > 0) {
const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
if (parseInt(tokenBalance) > 0) {
await swapToken(tradeInfo.mint, SOL_MINT, tokenBalance);
delete positions[tradeInfo.mint];
}
}
}
for (const mint of Object.keys(positions)) { await checkTakeProfit(mint); }
} catch(e) { console.error("Erreur:", e.message); }
}, 3000);
}

async function main() {
console.log("Bot demarre - Version finale v8");
console.log("Wallet:", wallet.publicKey.toString());
startBalance = await getBalance();
console.log("Balance:", startBalance, "SOL");
console.log("Trade: 0.15 SOL fort / 0.10 SOL moyen | Liquidite: 5 SOL | TP: 2x=50% 5x=80% | Daily: 50%");
console.log("Wallets tracked: 4 | RPC: QuickNode | Check: 3s | Moyennes: fixes");
for (const w of WALLETS_TO_TRACK) { await monitorWallet(w); }
console.log("Bot en ecoute...");
}

main().catch(console.error);
