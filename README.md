# CryptoMint Telegram Forwarder Bot (Cloudflare Workers)

A serverless, lightning-fast Telegram bot built on Cloudflare Workers that automatically forwards/copies all posts from **@demoviplaty** to **@CryptoMint_Withdraw** in real-time.

---

## 📌 Architecture & Features

- **Source Channel:** `@demoviplaty`
- **Destination Channel:** `@CryptoMint_Withdraw`
- **Admin User ID:** `8829204942`
- **Preserves Full Content:** Uses Telegram's `copyMessage` API to accurately replicate text formatting (HTML/Markdown entities), captions, photos, videos, animations (GIFs), documents, audio, and media groups.
- **Duplicate Prevention:** Built-in in-memory deduplication cache prevents duplicate forwards even during Telegram network retries.
- **Security:** Telegram Bot Token is stored strictly in Cloudflare Worker Secrets (never committed or exposed).
- **Admin Management:** Dedicated `/status` diagnostic command accessible only by the admin ID (`8829204942`).

---

## 🛠️ Step 1: Telegram Channel & Bot Setup

### 1. Get your Telegram Bot Token
1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to create your bot.
3. BotFather will give you a token (e.g. `123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ`). **Keep this secret!**

### 2. Add the Bot to the Source Channel (`@demoviplaty`)
1. Open the source channel **@demoviplaty** in Telegram.
2. Go to **Channel Settings** ➔ **Administrators** ➔ **Add Administrator**.
3. Search for your bot username and add it.
4. Grant the bot the following administrator permissions:
   - ✅ **Post Messages** (or view/manage channel messages so Telegram delivers `channel_post` webhook events to the bot).

### 3. Add the Bot to the Destination Channel (`@CryptoMint_Withdraw`)
1. Open the destination channel **@CryptoMint_Withdraw** in Telegram.
2. Go to **Channel Settings** ➔ **Administrators** ➔ **Add Administrator**.
3. Search for your bot username and add it.
4. Grant the bot the following administrator permissions:
   - ✅ **Post Messages** (Required so the bot can publish the copied posts).

---

## 💻 Step 2: PowerShell Commands (Quick Setup & Deployment)

Open **Windows PowerShell** and navigate to your project directory:

```powershell
cd "c:\Users\User\Desktop\CryptoMint Withdraw"
```

### 1. Install Dependencies
```powershell
npm install
```

### 2. Log in to Cloudflare
```powershell
npx wrangler login
```
*(A browser window will open asking you to authorize Cloudflare Wrangler).*

### 3. Deploy the Worker to Cloudflare
```powershell
npx wrangler deploy
```
After deployment, Wrangler will print your live worker URL, for example:
`https://cryptomint-withdraw-forwarder.<your-subdomain>.workers.dev`

### 4. Set the Telegram Bot Token Secret
Run the following command in PowerShell. Wrangler will securely prompt you to paste your bot token:
```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
```
*(Paste your bot token when prompted and press `Enter`).*

### 5. Register the Telegram Webhook
Run this PowerShell command to tell Telegram to send updates to your Cloudflare Worker (replace `<YOUR_WORKER_URL>` and `<YOUR_BOT_TOKEN>`):

```powershell
$BOT_TOKEN = "PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE"
$WORKER_URL = "https://cryptomint-withdraw-forwarder.<your-subdomain>.workers.dev"

Invoke-RestMethod -Uri "https://api.telegram.org/bot$BOT_TOKEN/setWebhook?url=$WORKER_URL" -Method Get
```

You will receive a response:
```json
{"ok": true, "result": true, "description": "Webhook was set"}
```

---

## 🔍 Step 3: Verify & Monitor

### 1. Check Webhook Info
To verify Telegram is successfully connected to your Worker:
```powershell
Invoke-RestMethod -Uri "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" -Method Get
```

### 2. Test in Telegram
1. **Test Start:** Open a direct message with your bot in Telegram and send `/start`. The bot will respond with confirmation details.
2. **Test Admin Status:** Send `/status` to the bot. Since your Telegram ID is `8829204942`, the bot will return health and forwarding statistics.
3. **Test Auto-Forward:** Post a message/photo/video in `@demoviplaty`. It will immediately appear in `@CryptoMint_Withdraw`.

### 3. View Live Real-time Logs
To watch live logs and forwarded messages as they happen:
```powershell
npx wrangler tail
```

---

## 📂 Project Structure

```
CryptoMint Withdraw/
├── src/
│   └── index.js           # Core Cloudflare Worker logic (copyMessage, deduplication, commands)
├── wrangler.jsonc         # Cloudflare Worker configuration & environment variables
├── package.json           # Node.js project manifest & scripts
├── .dev.vars.example      # Local development environment template
└── README.md              # Documentation & deployment guide
```
