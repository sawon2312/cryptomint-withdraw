import fs from 'fs';
import path from 'path';

// Load .env automatically if available
try {
  process.loadEnvFile();
} catch (e) {
  // Ignore if .env does not exist
}

// ================= CONFIGURATION ================= //
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '8798489865:AAGRkExHDwGrD3EQ9NYRER9H0X73sEMpKQU',
  CHANNEL_ID: process.env.DESTINATION_CHANNEL || '@cryptomintwithdraw',
  
  // Monitored BSC Wallets (lowercase) or '*' for all BSC network withdrawals
  MONITORED_WALLETS: new Set(
    (process.env.MONITOR_WALLETS 
      ? process.env.MONITOR_WALLETS.split(',') 
      : ['*']
    ).map(a => a.trim().toLowerCase())
  ),

  // USD Amount Boundaries (Strictly $0.15 to $1.00)
  MIN_USD_AMOUNT: parseFloat(process.env.MIN_USD_AMOUNT || '0.15'), // Min $0.15
  MAX_USD_AMOUNT: parseFloat(process.env.MAX_USD_AMOUNT || '1.00'), // Max $1.00

  // Pacing: 1 post every 20 seconds = Exactly 3 posts per minute max!
  DISPATCH_INTERVAL_MS: 20000,

  // Instant live sync (only 5 blocks lookback so it starts scanning live blocks in 1 second)
  LOOKBACK_BLOCKS: 5,

  RPC_ENDPOINTS: [
    'https://bsc-dataseed.binance.org/',
    'https://bsc-dataseed1.defibit.io/',
    'https://bsc-dataseed2.defibit.io/',
    'https://bsc-dataseed1.ninicoin.io/',
    'https://bsc.blockpi.network/v1/rpc/public',
    'https://rpc.ankr.com/bsc',
    'https://1rpc.io/bnb',
  ],
};

// ONLY USD Stablecoins allowed (USDT, BUSD, USDC)
const ALLOWED_USD_TOKENS = {
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', decimals: 18 },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
};

// FIFO queue of unique withdrawals waiting to be dispatched
const withdrawalQueue = [];

// Persist sent transaction hashes so NO duplicate is EVER sent
const SENT_TX_FILE = path.join(process.cwd(), '.sent_withdrawals.json');
let sentTxHashes = new Set();
if (fs.existsSync(SENT_TX_FILE)) {
  try {
    const raw = fs.readFileSync(SENT_TX_FILE, 'utf8');
    sentTxHashes = new Set(JSON.parse(raw));
    console.log(`[Init] Loaded ${sentTxHashes.size} already sent transactions from history.`);
  } catch (err) {
    console.error('[Init] Error reading sent transactions file:', err.message);
  }
}

function saveSentTx() {
  try {
    const txArray = Array.from(sentTxHashes).slice(-10000);
    fs.writeFileSync(SENT_TX_FILE, JSON.stringify(txArray, null, 2), 'utf8');
  } catch (err) {
    console.error('[Storage Error] Could not save sent transactions:', err.message);
  }
}

let currentRpcIndex = 0;
async function rpcCall(method, params = []) {
  for (let attempt = 0; attempt < CONFIG.RPC_ENDPOINTS.length; attempt++) {
    const endpoint = CONFIG.RPC_ENDPOINTS[currentRpcIndex];
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const data = await res.json();
      if (data && data.result !== undefined) {
        return data.result;
      }
    } catch (e) {
      currentRpcIndex = (currentRpcIndex + 1) % CONFIG.RPC_ENDPOINTS.length;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Send message to Telegram Channel
 */
async function sendTelegramMessage(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set!');
    return false;
  }

  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.CHANNEL_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[Telegram API Error]', data.description);
      return false;
    } else {
      return true;
    }
  } catch (err) {
    console.error('[Telegram Network Error]', err.message);
    return false;
  }
}

function shortAddr(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatAmount(rawBigInt, decimals) {
  const divisor = BigInt(10 ** decimals);
  const integerPart = rawBigInt / divisor;
  const fractionalPart = (rawBigInt % divisor).toString().padStart(decimals, '0').slice(0, 4);
  return `${integerPart}.${fractionalPart}`;
}

/**
 * Inspect and queue strictly UNIQUE, non-duplicate USD transactions
 */
function inspectAndQueueTransaction(tx) {
  const txHash = tx.hash;
  if (!txHash) return;

  // STRICT CHECK: If already sent before, NEVER send again!
  if (sentTxHashes.has(txHash)) return;

  // If already in queue, don't re-add
  if (withdrawalQueue.some(q => q.txHash === txHash)) return;

  const senderAddr = (tx.from || '').toLowerCase();
  const allowAll = CONFIG.MONITORED_WALLETS.has('*') || CONFIG.MONITORED_WALLETS.has('all') || CONFIG.MONITORED_WALLETS.size === 0;
  if (!allowAll && !CONFIG.MONITORED_WALLETS.has(senderAddr)) return;

  const input = tx.input || '0x';

  // Check if it is a BEP-20 token transfer: transfer(address,uint256) -> methodID 0xa9059cbb
  if (input.startsWith('0xa9059cbb') && input.length >= 138) {
    const tokenContract = (tx.to || '').toLowerCase();
    
    // STRICT FILTER: ONLY ALLOW USD TOKENS (USDT, BUSD, USDC)
    const tokenInfo = ALLOWED_USD_TOKENS[tokenContract];
    if (!tokenInfo) return;
    
    const recipient = '0x' + input.slice(34, 74);
    const rawValue = BigInt('0x' + input.slice(74, 138));
    const amountStr = formatAmount(rawValue, tokenInfo.decimals);
    const numAmount = parseFloat(amountStr);

    // Amount Filter: strictly between $0.15 and $100.00
    if (numAmount < CONFIG.MIN_USD_AMOUNT || numAmount > CONFIG.MAX_USD_AMOUNT) {
      return;
    }

    const txItem = {
      txHash,
      amountStr,
      numAmount,
      symbol: tokenInfo.symbol,
      from: shortAddr(senderAddr),
      fromFull: senderAddr,
      to: shortAddr(recipient),
      toFull: recipient,
    };

    withdrawalQueue.push(txItem);
    // Sort queue ascending: smallest amounts (e.g. $0.10, $0.15, $0.20) dispatched first!
    withdrawalQueue.sort((a, b) => a.numAmount - b.numAmount);
    if (withdrawalQueue.length > 100) {
      withdrawalQueue.pop(); // Drop highest amount if queue exceeds 100
    }
    console.log(`📥 [Queued Smallest First] $${amountStr} ${tokenInfo.symbol} from ${shortAddr(senderAddr)} (Queue: ${withdrawalQueue.length})`);
  }
}

let lastScannedBlock = null;

/**
 * Continuous Block Scanner
 */
async function startScannerLoop() {
  while (true) {
    try {
      const latestBlockHex = await rpcCall('eth_blockNumber');
      if (latestBlockHex) {
        const latestBlock = parseInt(latestBlockHex, 16);

        if (lastScannedBlock === null) {
          lastScannedBlock = latestBlock - CONFIG.LOOKBACK_BLOCKS;
          console.log(`[Connected] Initializing scanner lookback at block #${lastScannedBlock} to latest #${latestBlock}...`);
        }

        if (lastScannedBlock < latestBlock) {
          const nextBlock = lastScannedBlock + 1;
          const blockHex = '0x' + nextBlock.toString(16);
          const block = await rpcCall('eth_getBlockByNumber', [blockHex, true]);
          
          if (block && Array.isArray(block.transactions)) {
            for (const tx of block.transactions) {
              inspectAndQueueTransaction(tx);
            }
            lastScannedBlock = nextBlock;
            if (lastScannedBlock < latestBlock) {
              await sleep(30);
              continue;
            }
          } else if (block === null) {
            await sleep(500);
            continue;
          }
        }
      }
    } catch (err) {
      console.error('[Scanner Loop Error]', err.message);
    }
    await sleep(2000);
  }
}

function generateRandomUserId() {
  // Generates unique random 10-digit user id like 8418046445
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

function buildMessage(item) {
  const nowTime = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Dhaka',
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
  const bscScanUrl = `https://bscscan.com/tx/${item.txHash}`;
  const recipientUrl = `https://bscscan.com/address/${item.toFull}`;
  const randomUserId = generateRandomUserId();

  return (
    `🚀 <b>New Withdrawal Confirmed! (BSC Network)</b>\n\n` +
    `🌐 <b>Username:</b> @user_${randomUserId}\n` +
    `💰 <b>Amount:</b> <code>${item.amountStr} ${item.symbol}</code>\n` +
    `📤 <b>From:</b> <code>${item.from}</code>\n` +
    `📥 <b>To:</b> <a href="${recipientUrl}"><code>${item.to}</code></a>\n` +
    `🌐 <b>Network:</b> Binance Smart Chain (BEP-20)\n` +
    `🕒 <b>Time:</b> <code>${nowTime}</code>\n` +
    `🤖 <b>Bot:</b> @cryptomintnftbot\n\n` +
    `🔗 <a href="${bscScanUrl}"><b>View on BscScan</b></a>`
  );
}

/**
 * Strictly Unique Dispatcher Loop (Each Tx sent ONLY ONCE, spaced by 20s)
 * Prioritizes smaller amounts (~85% small amounts like $0.15-$0.45, ~15% up to $1.00)
 */
async function startDispatcherLoop() {
  while (true) {
    if (withdrawalQueue.length > 0) {
      // 85% probability: pick from lowest amounts in the queue
      // 15% probability: pick any amount up to $1.00 for natural variation
      let itemIndex = 0;
      if (Math.random() < 0.85 && withdrawalQueue.length > 1) {
        itemIndex = Math.floor(Math.random() * Math.min(4, withdrawalQueue.length));
      } else {
        itemIndex = Math.floor(Math.random() * withdrawalQueue.length);
      }

      const [item] = withdrawalQueue.splice(itemIndex, 1);

      // Double check to be 100% sure it was never sent before
      if (sentTxHashes.has(item.txHash)) {
        continue;
      }

      const msg = buildMessage(item);
      const success = await sendTelegramMessage(msg);

      if (success) {
        sentTxHashes.add(item.txHash);
        saveSentTx();
        console.log(`🚀 [Sent 100% Unique] $${item.amountStr} ${item.symbol} from ${item.from} (Remaining in queue: ${withdrawalQueue.length})`);
      } else {
        // Put back in queue on network error
        withdrawalQueue.unshift(item);
      }

      // Wait 20 seconds before next post (3 posts per minute max)
      await sleep(CONFIG.DISPATCH_INTERVAL_MS);
    } else {
      // If queue is empty, check every 2 seconds
      await sleep(2000);
    }
  }
}

async function start() {
  console.log('========================================================');
  console.log('🚀 BSC USD Zero-Duplicate Scanner & Dispatcher (3 msgs/min)');
  console.log(`📢 Telegram Channel:  ${CONFIG.CHANNEL_ID}`);
  console.log(`💵 Token Filter:       ONLY USD (USDT, BUSD, USDC)`);
  console.log(`💵 Amount Filter:      $${CONFIG.MIN_USD_AMOUNT} to $${CONFIG.MAX_USD_AMOUNT}`);
  console.log(`🔒 Duplicate Rule:     STRICT ZERO DUPLICATES (Each Tx only ONCE)`);
  console.log(`⏱️ Dispatch Rate:      1 post every 20s (= Max 3 msgs/min)`);
  if (CONFIG.MONITORED_WALLETS.has('*') || CONFIG.MONITORED_WALLETS.has('all')) {
    console.log('🎯 Monitored Scope:    🌐 ENTIRE BSC NETWORK (Live $0.15 - $1.00 USD Payouts)');
  } else {
    console.log(`🎯 Monitored Wallets (${CONFIG.MONITORED_WALLETS.size}):`);
    for (const w of CONFIG.MONITORED_WALLETS) {
      console.log(`   • ${w}`);
    }
  }
  console.log('========================================================\n');

  startScannerLoop();
  startDispatcherLoop();
}

start();
