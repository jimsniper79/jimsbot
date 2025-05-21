import { Connection, Keypair, PublicKey, ParsedTransactionWithMeta, ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import { PumpAmmSdk, Direction } from '@pump-fun/pump-swap-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as fs from 'fs/promises';
import { watch } from 'fs';
import Sentiment from 'sentiment';
import twilio from 'twilio';
import { IDL, Pump } from './pump_idl';

// Load environment variables
dotenv.config();

// Configuration
const QUICKNODE_RPC = process.env.QUICKNODE_RPC || '';
const QUICKNODE_METIS_API = process.env.QUICKNODE_METIS_API || '';
const X_API_KEY = process.env.X_API_KEY || '';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
const USER_PHONE_NUMBER = process.env.USER_PHONE_NUMBER || '';
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfLPHqgasDCtF4WqW');
const BONDING_CURVE_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const AMA_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const MIN_LIQUIDITY = 10;
const CONFIG_FILE = 'config.json';
const CREATOR_SCORES_FILE = 'creator_scores.json';
const PRICE_CHECK_INTERVAL = 5000;
const MAX_CONCURRENT_TRADES = 3;

// User-defined parameters
let buyAmountSol = parseFloat(process.env.BUY_AMOUNT_SOL || '0.1');
let sellTargetSol = parseFloat(process.env.SELL_TARGET_SOL || '1.5');
let stopLossPercent = parseFloat(process.env.STOP_LOSS_PERCENT || '50');
let timeoutMinutes = parseFloat(process.env.TIMEOUT_MINUTES || '15');
let trailingStopPercent = parseFloat(process.env.TRAILING_STOP_PERCENT || '10');
let priorityFeeMicroLamports = parseFloat(process.env.PRIORITY_FEE_MICROLAMPORTS || '10000');
let xSearchIntervalMinutes = parseFloat(process.env.X_SEARCH_INTERVAL_MINUTES || '5');
let xSentimentThreshold = parseFloat(process.env.X_SENTIMENT_THRESHOLD || '0.5');
let minCreatorScore = parseFloat(process.env.MIN_CREATOR_SCORE || '0.5');
let emergencyStop = process.env.EMERGENCY_STOP === 'true';
let twilioEnabled = process.env.TWILIO_ENABLED === 'true';
let blacklistMints: string[] = [];
let blacklistCreators: string[] = [];
let whitelistMints: string[] = [];
let wallets: Keypair[] = (process.env.WALLET_PRIVATE_KEY || '').split(',').map(key => Keypair.fromSecretKey(Buffer.from(key.trim(), 'base64')));

// Initialize Solana connection
const connection = new Connection(QUICKNODE_RPC, 'confirmed');

// Initialize Pump Swap SDK
const pumpAmmSdk = new PumpAmmSdk();

// Initialize Twilio client
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize sentiment analysis
const sentiment = new Sentiment();

// Logging with SMS alerts
const log = async (message: string) => {
  console.log(`[${new Date().toISOString()}] ${message}`);
  if (twilioEnabled) {
    try {
      await twilioClient.messages.create({
        body: message,
        from: TWILIO_PHONE_NUMBER,
        to: USER_PHONE_NUMBER,
      });
    } catch (error) {
      console.error(`Error sending SMS: ${error}`);
    }
  }
};

// Load and watch config file
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(data);
    buyAmountSol = config.buyAmountSol || buyAmountSol;
    sellTargetSol = config.sellTargetSol || sellTargetSol;
    stopLossPercent = config.stopLossPercent || stopLossPercent;
    timeoutMinutes = config.timeoutMinutes || timeoutMinutes;
    trailingStopPercent = config.trailingStopPercent || trailingStopPercent;
    priorityFeeMicroLamports = config.priorityFeeMicroLamports || priorityFeeMicroLamports;
    xSearchIntervalMinutes = config.xSearchIntervalMinutes || xSearchIntervalMinutes;
    xSentimentThreshold = config.xSentimentThreshold || xSentimentThreshold;
    minCreatorScore = config.minCreatorScore || minCreatorScore;
    emergencyStop = config.emergencyStop || emergencyStop;
    twilioEnabled = config.twilioEnabled || twilioEnabled;
    blacklistMints = config.blacklistMints || blacklistMints;
    blacklistCreators = config.blacklistCreators || blacklistCreators;
    whitelistMints = config.whitelistMints || whitelistMints;
    wallets = config.wallets ? config.wallets.map((key: string) => Keypair.fromSecretKey(Buffer.from(key, 'base64'))) : wallets;
    await log(`Config updated: buy=${buyAmountSol}, sell=${sellTargetSol}, stop-loss=${stopLossPercent}%, timeout=${timeoutMinutes}min, trailing=${trailingStopPercent}%, priority=${priorityFeeMicroLamports}, xInterval=${xSearchIntervalMinutes}min, xSentiment=${xSentimentThreshold}, creatorScore=${minCreatorScore}, emergency=${emergencyStop}, twilio=${twilioEnabled}`);
  } catch (error) {
    await log(`Error loading config: ${error}`);
  }
}

function watchConfig() {
  watch(CONFIG_FILE, async (event) => {
    if (event === 'change') {
      await log('Config file changed, reloading...');
      await loadConfig();
    }
  });
}

// Creator scores for tracking performance
let creatorScores: Map<string, number> = new Map();

async function loadCreatorScores() {
  try {
    const data = await fs.readFile(CREATOR_SCORES_FILE, 'utf8');
    creatorScores = new Map(JSON.parse(data));
    await log('Loaded creator scores');
  } catch (error) {
    await log(`Error loading creator scores: ${error}`);
    Starting with empty scores`);
  }
}

async function saveCreatorScores() {
  try {
    await fs.writeFile(CREATOR_SCORES_FILE, JSON.stringify([...creatorScores]));
    await log('Saved creator scores');
  } catch (error) {
    await log(`Error saving creator scores: ${error}`);
  }
}

// Wallet Manager
class WalletManager {
  private wallets: Keypair[];
  private balances: Map<string, number> = new Map();

  constructor(wallets: Keypair[]) {
    this.wallets = wallets;
  }

  async updateBalances() {
    for (const wallet of this.wallets) {
      try {
        const balance = await connection.getBalance(wallet.publicKey);
        this.balances.set(wallet.publicKey.toString(), balance / 1e9);
      } catch (error) {
        await log(`Error fetching balance for ${wallet.publicKey.toString()}: ${error}`);
      }
    }
  }

  getWallet(): Keypair {
    let maxBalance = -1;
    let selectedWallet = this.wallets[0];
    for (const wallet of this.wallets) {
      const balance = this.balances.get(wallet.publicKey.toString()) || 0;
      if (balance > maxBalance) {
        maxBalance = balance;
        selectedWallet = wallet;
      }
    }
    return selectedWallet;
  }
}

const walletManager = new WalletManager(wallets);

// Track processed mints with timestamps
const processedMints = new Map<string, number>();

// Trade Manager
class TradeManager {
  private activeTrades: Map<string, { mint: PublicKey; buyTx: string; amountOut: number; buyTime: number; buySol: number; highestPrice: number; creator: PublicKey | null; wallet: Keypair }> = new Map();
  private successfulSells: number = 0;

  canBuy(): boolean {
    return !emergencyStop && this.activeTrades.size < MAX_CONCURRENT_TRADES && (this.successfulSells >= 2 || this.activeTrades.size === 0);
  }

  addTrade(mint: PublicKey, buyTx: string, amountOut: number, buySol: number, creator: PublicKey | null, wallet: Keypair) {
    this.activeTrades.set(mint.toString(), { mint, buyTx, amountOut, buyTime: Date.now(), buySol, highestPrice: buySol, creator, wallet });
    log(`Added trade for ${mint.toString()}. Active trades: ${this.activeTrades.size}`);
  }

  removeTrade(mint: PublicKey, profit: number) {
    const trade = this.activeTrades.get(mint.toString());
    if (trade && trade.creator) {
      const currentScore = creatorScores.get(trade.creator.toString()) || 0;
      creatorScores.set(trade.creator.toString(), currentScore + profit);
      saveCreatorScores();
    }
    this.activeTrades.delete(mint.toString());
    this.successfulSells++;
    log(`Removed trade for ${mint.toString()}. Successful sells: ${this.successfulSells}`);
  }

  getActiveTrades(): Array<{ mint: PublicKey; buyTx: string; amountOut: number; buyTime: number; buySol: number; highestPrice: number; creator: PublicKey | null; wallet: Keypair }> {
    return Array.from(this.activeTrades.values());
  }
}

const tradeManager = new TradeManager();

// Monitor new token mints using logsSubscribe
async function monitorNewTokens() {
  await log('Subscribing to Pump.fun programs');

  const mainSubscriptionId = connection.onLogs(
    PUMP_FUN_PROGRAM,
    async ({ signature, logs }) => {
      try {
        if (logs.some(log => log.includes('Instruction: Create'))) {
          const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
          if (tx && isCreateInstruction(tx)) {
            const tokenMint = extractMintFromTransaction(tx);
            if (tokenMint && !processedMints.has(tokenMint.toString())) {
              processedMints.set(tokenMint.toString(), Date.now());
              await log(`Detected new token (main): ${tokenMint.toString()}`);
              await snipeToken(tokenMint);
            }
          }
        }
      } catch (error) {
        await log(`Error processing main program log: ${error}`);
      }
    },
    'confirmed'
  ).catch((error) => {
    log(`Main subscription error: ${error}`);
    setTimeout(monitorNewTokens, 5000);
  });

  const bondingSubscriptionId = connection.onProgramAccountChange(
    BONDING_CURVE_PROGRAM,
    async (keyedAccountInfo) => {
      try {
        const signature = keyedAccountInfo.accountId.toString();
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        if (tx) {
          const tokenMint = extractMintFromTransactionGeneric(tx, BONDING_CURVE_PROGRAM);
          if (tokenMint && !processedMints.has(tokenMint.toString())) {
            processedMints.set(tokenMint.toString(), Date.now());
            await log(`Detected new token (bonding curve): ${tokenMint.toString()}`);
            await snipeToken(tokenMint);
          }
        }
      } catch (error) {
        await log(`Error processing bonding curve change: ${error}`);
      }
    },
    'confirmed'
  ).catch((error) => {
    log(`Bonding curve subscription error: ${error}`);
    setTimeout(monitorNewTokens, 5000);
  });

  const amaSubscriptionId = connection.onProgramAccountChange(
    AMA_PROGRAM,
    async (keyedAccountInfo) => {
      try {
        const signature = keyedAccountInfo.accountId.toString();
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        if (tx) {
          const tokenMint = extractMintFromTransactionGeneric(tx, AMA_PROGRAM);
          if (tokenMint && !processedMints.has(tokenMint.toString())) {
            processedMints.set(tokenMint.toString(), Date.now());
            await log(`Detected new token (AMA): ${tokenMint.toString()}`);
            await snipeToken(tokenMint);
          }
        }
      } catch (error) {
        await log(`Error processing AMA program change: ${error}`);
      }
    },
    'confirmed'
  ).catch((error) => {
    log(`AMA subscription error: ${error}`);
    setTimeout(monitorNewTokens, 5000);
  });
}

// Check if transaction is a 'create' instruction
function isCreateInstruction(tx: ParsedTransactionWithMeta): boolean {
  const instructions = tx.transaction.message.instructions;
  return instructions.some(ix => {
    return (
      'programId' in ix &&
      ix.programId.equals(PUMP_FUN_PROGRAM) &&
      'data' in ix &&
      Buffer.from(ix.data, 'base64').slice(0, 8).equals(Buffer.from(IDL.instructions[0].discriminator))
    );
  });
}

// Extract mint from main program transaction
function extractMintFromTransaction(tx: ParsedTransactionWithMeta): PublicKey | null {
  const instructions = tx.transaction.message.instructions;
  for (const ix of instructions) {
    if ('programId' in ix && ix.programId.equals(PUMP_FUN_PROGRAM) && 'accounts' in ix && ix.accounts.length > 0) {
      return new PublicKey(ix.accounts[0]);
    }
  }
  return null;
}

// Extract mint from generic program transaction
function extractMintFromTransactionGeneric(tx: ParsedTransactionWithMeta, programId: PublicKey): PublicKey | null {
  const instructions = tx.transaction.message.instructions;
  for (const ix of instructions) {
    if ('programId' in ix && ix.programId.equals(programId) && 'accounts' in ix && ix.accounts.length > 0) {
      return new PublicKey(ix.accounts[0]);
    }
  }
  return null;
}

// Fetch creator from bonding curve
async function getCreator(mint: PublicKey): Promise<PublicKey | null> {
  try {
    const bondingCurveSeeds = [Buffer.from('bonding-curve'), mint.toBuffer()];
    const [derivedBondingCurve] = PublicKey.findProgramAddressSync(bondingCurveSeeds, BONDING_CURVE_PROGRAM);
    const bondingCurveAccountInfo = await connection.getAccountInfo(derivedBondingCurve);
    if (!bondingCurveAccountInfo) {
      await log('Could not fetch BondingCurve account');
      return null;
    }
    return new PublicKey(bondingCurveAccountInfo.data.subarray(49, 81));
  } catch (error) {
    await log(`Failed to fetch creator for ${mint.toString()}: ${error}`);
    return null;
  }
}

// X integration for trending coins
async function searchX(query: string, fromDate: string, toDate: string): Promise<any[]> {
  try {
    const response = await axios.get('https://api.twitter.com/2/tweets/search/recent', {
      headers: { Authorization: `Bearer ${X_API_KEY}` },
      params: {
        query: `${query} min_faves:10`,
        start_time: fromDate,
        end_time: toDate,
        'tweet.fields': 'text,created_at',
        'user.fields': 'public_metrics',
        max_results: 100,
      },
    });
    return response.data.data || [];
  } catch (error) {
    await log(`Error searching X: ${error}`);
    return [];
  }
}

function extractMintsFromText(text: string): string[] {
  const mintRegex = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const mints = text.match(mintRegex) || [];
  return mints.filter(mint => {
    try {
      new PublicKey(mint);
      return true;
    } catch {
      return false;
    }
  });
}

function extractMintsFromPost(post: any): string[] {
  const mints = extractMintsFromText(post.text);
  const urlRegex = /https:\/\/pump\.fun\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/g;
  let match;
  while ((match = urlRegex.exec(post.text)) !== null) {
    mints.push(match[1]);
  }
  return [...new Set(mints)];
}

async function getTrendingCoins(): Promise<Array<{ mint: string; score: number }>> {
  const now = new Date();
  const fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const toDate = now.toISOString();
  const posts = await searchX('pump.fun', fromDate, toDate);
  const mintScores = new Map<string, number>();

  for (const post of posts) {
    const mints = extractMintsFromPost(post);
    const sentimentResult = sentiment.analyze(post.text);
    const sentimentScore = sentimentResult.score;
    const followerCount = post.user?.public_metrics?.followers_count || 1;
    const score = sentimentScore >= xSentimentThreshold ? sentimentScore * (1 + Math.log10(followerCount)) : 0;

    for (const mint of mints) {
      if (processedMints.has(mint) && (Date.now() - processedMints.get(mint)!) <= 24 * 60 * 60 * 1000) {
        mintScores.set(mint, (mintScores.get(mint) || 0) + score);
      }
    }
  }

  return Array.from(mintScores.entries())
    .map(([mint, score]) => ({ mint, score }))
    .sort((a, b) => b.score - a.score);
}

async function monitorTrendingCoins() {
  while (true) {
    if (emergencyStop) {
      await log('Emergency stop active, skipping trending coin check');
      await new Promise(resolve => setTimeout(resolve, PRICE_CHECK_INTERVAL));
      continue;
    }

    const trendingCoins = await getTrendingCoins();
    for (const { mint } of trendingCoins.slice(0, MAX_CONCURRENT_TRADES - tradeManager.getActiveTrades().length)) {
      if (!tradeManager.getActiveTrades().some(trade => trade.mint.toString() === mint)) {
        const tokenMint = new PublicKey(mint);
        await log(`Attempting to buy trending coin: ${mint}`);
        await snipeToken(tokenMint);
      }
    }
    await new Promise(resolve => setTimeout(resolve, xSearchIntervalMinutes * 60 * 1000));
  }
}

// Dynamic priority fee
async function getDynamicPriorityFee(): Promise<number> {
  try {
    const fees = await connection.getRecentPrioritizationFees();
    if (fees.length === 0) return priorityFeeMicroLamports;
    const averageFee = fees.reduce((sum, fee) => sum + fee.prioritizationFee, 0) / fees.length;
    return Math.ceil(averageFee * 1.1);
  } catch (error) {
    await log(`Error fetching priority fees: ${error}`);
    return priorityFeeMicroLamports;
  }
}

// Retry logic
async function retry<T>(fn: () => Promise<T>, retries: number = 3, delay: number = 1000): Promise<T | null> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      await log(`Retry ${i + 1}/${retries} failed: ${error}`);
      if (i < retries - 1) await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
  return null;
}

// Fetch swap quote using Metis API (placeholder, replace with actual pool logic)
async function getSwapQuote(tokenMint: PublicKey, amountIn: number): Promise<any> {
  return await retry(async () => {
    const response = await axios.post(QUICKNODE_METIS_API, {
      method: 'getQuote',
      params: {
        mint: tokenMint.toString(),
        amountIn: amountIn * 1e9,
        slippageBps: 500,
      },
    });
    return response.data.result;
  });
}

// Get token price in SOL
async function getTokenPrice(tokenMint: PublicKey, amount: number): Promise<number> {
  const quote = await getSwapQuote(tokenMint, amount / 1e9);
  if (!quote) return 0;
  return quote.amountOut / 1e9;
}

// Execute buy swap with priority fee
async function executeBuy(tokenMint: PublicKey, wallet: Keypair): Promise<string | null> {
  return await retry(async () => {
    await log(`Starting buy for ${tokenMint.toString()}`);
    const quote = await getSwapQuote(tokenMint, buyAmountSol);
    if (!quote || quote.liquidity < MIN_LIQUIDITY * 1e9) {
      await log(`Skipping ${tokenMint.toString()}: Insufficient liquidity (${(quote?.liquidity / 1e9) || 0} SOL)`);
      return null;
    }

    // Placeholder: Replace with actual pool fetching logic
    const pool = { mint: tokenMint }; // Need to fetch actual pool data
    const baseAmount = await pumpAmmSdk.swapAutocompleteBaseFromQuote(
      pool,
      buyAmountSol * 1e9,
      500,
      Direction.QuoteToBase
    );
    const priorityFee = await getDynamicPriorityFee();
    await log(`Preparing transaction with priority fee: ${priorityFee}`);
    const swapInstructions = await pumpAmmSdk.swapInstructions(
      pool,
      baseAmount,
      500,
      Direction.QuoteToBase,
      wallet.publicKey
    );
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...swapInstructions
    );

    await log(`Sending buy transaction for ${tokenMint.toString()}`);
    const signature = await connection.sendTransaction(tx, [wallet]);
    await log(`Confirming buy transaction: ${signature}`);
    await connection.confirmTransaction(signature, 'confirmed');
    await log(`Buy successful: ${signature}`);
    return signature;
  });
}

// Execute sell swap with priority fee
async function executeSell(tokenMint: PublicKey, amount: number, wallet: Keypair): Promise<boolean> {
  const result = await retry(async () => {
    await log(`Starting sell for ${tokenMint.toString()}`);
    const quote = await getSwapQuote(tokenMint, amount / 1e9);
    if (!quote) return false;

    const pool = { mint: tokenMint }; // Placeholder: Replace with actual pool
    const quoteAmount = await pumpAmmSdk.swapAutocompleteQuoteFromBase(
      pool,
      amount * 1e9,
      500,
      Direction.BaseToQuote
    );
    const priorityFee = await getDynamicPriorityFee();
    await log(`Preparing transaction with priority fee: ${priorityFee}`);
    const swapInstructions = await pumpAmmSdk.swapInstructions(
      pool,
      quoteAmount,
      500,
      Direction.BaseToQuote,
      wallet.publicKey
    );
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...swapInstructions
    );

    await log(`Sending sell transaction for ${tokenMint.toString()}`);
    const signature = await connection.sendTransaction(tx, [wallet]);
    await log(`Confirming sell transaction: ${signature}`);
    await connection.confirmTransaction(signature, 'confirmed');
    await log(`Sell successful: ${signature}`);
    return true;
  });
  return result !== null ? result : false;
}

// Monitor and sell active trades
async function monitorTrades() {
  while (true) {
    const trades = tradeManager.getActiveTrades();
    for (const trade of trades) {
      const price = await getTokenPrice(trade.mint, trade.amountOut);
      const timeElapsed = (Date.now() - trade.buyTime) / 1000 / 60; // Minutes
      if (price > trade.highestPrice) {
        trade.highestPrice = price;
      }
      const stopLossPrice = trade.highestPrice * (1 - trailingStopPercent / 100);
      const profit = price - trade.buySol;

      if (price >= sellTargetSol) {
        await log(`Selling ${trade.mint.toString()} at ${price} SOL (target reached)`);
        const success = await executeSell(trade.mint, trade.amountOut, trade.wallet);
        if (success) {
          tradeManager.removeTrade(trade.mint, profit);
        }
      } else if (price <= stopLossPrice) {
        await log(`Selling ${trade.mint.toString()} at ${price} SOL (trailing stop-loss triggered)`);
        const success = await executeSell(trade.mint, trade.amountOut, trade.wallet);
        if (success) {
          tradeManager.removeTrade(trade.mint, profit);
        }
      } else if (timeElapsed >= timeoutMinutes) {
        await log(`Selling ${trade.mint.toString()} at ${price} SOL (timeout triggered)`);
        const success = await executeSell(trade.mint, trade.amountOut, trade.wallet);
        if (success) {
          tradeManager.removeTrade(trade.mint, profit);
        }
      } else {
        await log(`Price for ${trade.mint.toString()}: ${price} SOL (Target: ${sellTargetSol}, Stop-Loss: ${stopLossPrice}, Time: ${timeElapsed.toFixed(2)} min)`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, PRICE_CHECK_INTERVAL));
  }
}

// Snipe a detected token
async function snipeToken(tokenMint: PublicKey) {
  if (!tradeManager.canBuy()) {
    await log(`Cannot buy ${tokenMint.toString()}: Trade limit reached or emergency stop active`);
    return;
  }

  if (blacklistMints.includes(tokenMint.toString())) {
    await log(`Skipping ${tokenMint.toString()}: Mint is blacklisted`);
    return;
  }

  const creator = await getCreator(tokenMint);
  if (creator && blacklistCreators.includes(creator.toString())) {
    await log(`Skipping ${tokenMint.toString()}: Creator is blacklisted`);
    return;
  }

  const creatorScore = creator ? creatorScores.get(creator.toString()) || 0 : 0;
  if (creator && creatorScore < minCreatorScore) {
    await log(`Skipping ${tokenMint.toString()}: Creator score ${creatorScore} below threshold ${minCreatorScore}`);
    return;
  }

  const quote = await getSwapQuote(tokenMint, buyAmountSol);
  if (!quote) return;

  const wallet = walletManager.getWallet();
  const buyTx = await executeBuy(tokenMint, wallet);
  if (buyTx) {
    tradeManager.addTrade(tokenMint, buyTx, quote.amountOut, buyAmountSol, creator, wallet);
  }
}

// Main function
async function main() {
  await log('Starting Solana Pump.fun Sniping Bot');
  await loadConfig();
  watchConfig();
  await loadCreatorScores();
  await walletManager.updateBalances();
  monitorTrades().catch(error => log(`Trade monitor error: ${error}`));
  monitorTrendingCoins().catch(error => log(`Trending coin monitor error: ${error}`));
  await monitorNewTokens();
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error}`);
});

// Start the bot
main().catch((error) => {
  log(`Fatal error: ${error}`);
});
