import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import input from 'input';
import fs from 'fs';
import path from 'path';

// --- Configuration ---
const API_ID = 31748812;
const API_HASH = 'cf5bfbcadd05ac0a163d68f189810951';

const SOURCE_CHANNEL = 'demoviplaty'; // Source channel (without @)
const DESTINATION_CHANNEL = 'CryptoMint_Withdraw'; // Destination channel (without @)

const SESSION_FILE = path.join(process.cwd(), '.session_string');

// Load saved session if exists
let savedSession = '';
if (fs.existsSync(SESSION_FILE)) {
  try {
    savedSession = fs.readFileSync(SESSION_FILE, 'utf8').trim();
  } catch (e) {
    console.error('Could not read existing session file:', e.message);
  }
}

const session = new StringSession(savedSession);
const client = new TelegramClient(session, API_ID, API_HASH, {
  connectionRetries: 10,
});

async function main() {
  console.log('====================================================');
  console.log('🚀 Starting Telegram Channel Auto-Forwarder UserBot');
  console.log(`📥 Source: @${SOURCE_CHANNEL}`);
  console.log(`📤 Destination: @${DESTINATION_CHANNEL}`);
  console.log('====================================================\n');

  await client.start({
    phoneNumber: async () => await input.text('📱 Enter your Telegram phone number (with country code, e.g. +8801...): '),
    password: async () => await input.text('🔑 Enter your 2FA password (if enabled): '),
    phoneCode: async () => await input.text('📩 Enter the login code you received in Telegram: '),
    onError: (err) => console.error('Authentication Error:', err),
  });

  console.log('\n✅ Successfully logged into Telegram!');

  // Save session string for automatic login next time
  const currentSession = client.session.save();
  fs.writeFileSync(SESSION_FILE, currentSession, 'utf8');
  console.log('💾 Session saved locally. You will not need to log in again.\n');

  // Verify channels
  let sourcePeer;
  let destPeer;

  try {
    sourcePeer = await client.getEntity(SOURCE_CHANNEL);
    console.log(`✅ Connected to Source Channel: @${SOURCE_CHANNEL} (ID: ${sourcePeer.id})`);
  } catch (err) {
    console.error(`⚠️ Could not find source channel @${SOURCE_CHANNEL}. Make sure your account has joined this channel! Error: ${err.message}`);
  }

  try {
    destPeer = await client.getEntity(DESTINATION_CHANNEL);
    console.log(`✅ Connected to Destination Channel: @${DESTINATION_CHANNEL} (ID: ${destPeer.id})`);
  } catch (err) {
    console.error(`⚠️ Could not find destination channel @${DESTINATION_CHANNEL}. Make sure your account is an Admin/Member there! Error: ${err.message}`);
  }

  console.log('\n👀 Listening for new messages in real-time... (Press Ctrl+C to stop)\n');

  // Listen for new messages
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      const chat = await message.getChat();
      const chatUsername = chat?.username?.toLowerCase();
      const chatId = chat?.id?.toString();

      // Check if message is from source channel
      const isSource = 
        (chatUsername && chatUsername === SOURCE_CHANNEL.toLowerCase()) ||
        (sourcePeer && chat && chat.id && chat.id.toString() === sourcePeer.id.toString());

      if (!isSource) return;

      const now = new Date().toLocaleTimeString();
      console.log(`[${now}] 📩 New post detected (ID: ${message.id}) in @${SOURCE_CHANNEL}`);

      // Forward to destination channel (dropAuthor: true removes "Forwarded from" header so it looks native)
      await client.forwardMessages(destPeer || DESTINATION_CHANNEL, {
        messages: [message.id],
        fromPeer: message.peerId || sourcePeer,
        dropAuthor: true, // Clean copy without forwarded tag
      });

      console.log(`[${now}] 🚀 Successfully copied message to @${DESTINATION_CHANNEL}!\n`);
    } catch (err) {
      console.error(`❌ Error while forwarding message:`, err.message);
    }
  }, new NewMessage({}));
}

main().catch((err) => {
  console.error('Fatal Error:', err);
});
