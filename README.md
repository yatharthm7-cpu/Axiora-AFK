# Multi-Server Mineflayer AFK Bot

A multi-account AFK bot for supported Minecraft Java servers, controlled through Discord. New connections automatically detect the server protocol, support common cracked-server authentication prompts, and do not assume a particular network or game mode.

## 🚀 Features

*   **Discord + Web Dashboard:** Control and monitor all your bots from Discord or a password-protected browser dashboard.
*   **Multi-Account Support:** Spawns isolated, secure Discord text channels for each active bot.
*   **Auto-Authentication:** Automatically detects login prompts and handles `/register` or `/login` commands (AuthMe support).
*   **Multi-Version Connections:** Automatically detects supported Minecraft Java versions (currently 1.8.8 through 1.21.11), with an optional fixed-version override.
*   **Optional Network Navigation:** Saves a different post-login command for each bot instead of forcing a specific hub or game mode.
*   **Custom Anti-AFK:** Periodically shifts camera angles, sneaks, and swings arms to mimic real player behavior.
*   **Auto-Reconnect:** Gracefully handles unexpected server kicks or Wi-Fi drops and automatically reconnects when the network is restored.
*   **Skeleton Bone Drop:** Keeps the loot menu open, repeatedly uses Drop Loot as the menu refreshes, then clicks Sell All once when arrows appear. Its cooldown is configurable per bot.
*   **Per-Account Scheduling:** Gives every account its own active hours, Bone Drop times, Sell Macro window, maintenance pause, and high-ping reconnect rule.

---

## 📋 Prerequisites

Before you begin, ensure you have the following installed on your system:
*   [Node.js](https://nodejs.org/) (v16.14 or higher)
*   A Discord Bot Token (Created via the [Discord Developer Portal](https://discord.com/developers/applications))

---

## 🛠️ Installation & Setup

**1. Clone or Download the Repository**
Extract the project files into a folder (e.g., `mineflayer-afk-bot`).

**2. Install Dependencies**
Open your terminal in the project folder and run:
```bash
npm install
```

**3. Configure the Environment Variables**

Create a file named .env in the root directory of your project and add your Discord Bot Token:

```env
DISCORD_TOKEN=your_discord_bot_token_here
DASHBOARD_PASSWORD=use-a-long-unique-password
DASHBOARD_PORT=25567
DASHBOARD_HOST=127.0.0.1
```

On hosts that provide `SERVER_PORT` or `PORT` automatically, that assigned port is used for the dashboard. The server listens on all network interfaces by default.

**4. Invite the Discord Bot**

Generate an OAuth2 URL in the Discord Developer Portal with the following scopes and permissions:

Scopes: bot, applications.commands

Permissions: Manage Channels, Read Messages/View Channels, Send Messages, Manage Roles (Optional, for channel isolation).
Invite the bot to your Discord server.

## 🖥️ Web Dashboard

After the app starts, open:

```text
http://localhost:25567
```

Sign in with `DASHBOARD_PASSWORD`. From the dashboard you can:

* Add offline/cracked or Microsoft-authenticated accounts.
* View connection status, health, hunger, position, active macros, and recent activity.
* Watch activity update live and inspect each account's current inventory.
* Select multiple bots and apply reconnect or macro controls to the whole group.
* Track persistent connection, disconnect, death, and Bone Drop statistics.
* Send Minecraft commands or chat messages.
* Enable or disable Bone Drop, Sell Macro, and Auto-Eat.
* Run Bone Drop immediately, reconnect a bot, or remove its saved session.
* Configure separate schedules for every account and see the next scheduled action.

If `DASHBOARD_PASSWORD` is missing, the app creates a temporary password and prints it in the hosting console. It changes after every restart, so setting the environment variable is recommended. Because the provided address uses plain HTTP, use a unique dashboard password that you do not use anywhere else. HTTPS through a domain or secure tunnel is recommended for access over the public internet.

## 🎮 Discord Controls

Once the bot is running, you control it entirely through Discord.

### Starting a Bot

Type the following command in any channel your Discord bot can read:

```text
/spawn <username> <server[:port]> <password|-> [offline|microsoft]
```

username: The Minecraft username for the bot.

server: The Java server hostname or IP. Add `:port` only for a non-default port. Bracket IPv6 addresses when adding a port, for example `[2001:db8::10]:25565`.

password: The cracked-server password. Use `-` if that server has no `/login` plugin or when using Microsoft authentication.

auth: Use `offline` for cracked servers or `microsoft` for premium accounts. The default is `offline`.

Example:

```text
/spawn IAMCRAFTY1 play.example.com MySecretPass offline
/spawn IAMCRAFTY2 play.example.com:25566 MySecretPass offline
/spawn PremiumName play.example.com - microsoft
```

The bot will automatically create a private Discord channel named #bot-iamcrafty1 where it will stream the game chat and events.

### Interacting with the Bot

Inside the bot's dedicated Discord channel, you can:

Chat: Type any standard message to have the bot say it in-game.

Commands: Type any command (e.g., /server survival, /balance) to execute it in-game.

Minecraft commands beginning with `/` can be sent directly from the account's Discord channel.

### Compatibility limits

This project targets Minecraft **Java Edition** versions supported by the installed Mineflayer release. It automatically handles the common `/register password password` and `/login password` flows used by AuthMe-style plugins. No client can guarantee compatibility with every cracked server: custom CAPTCHA challenges, website linking, modded clients, custom encryption, unsupported protocol versions, or server anti-bot rules can still require manual action or server-specific code. Use the bot only where automation is permitted.

### Automatic Bone Drops

Place the Minecraft bot within six blocks of the skeleton spawner, then use these commands in its private Discord channel:

* `!bonedrop on [seconds]` — enable the macro, optionally setting its cooldown (default: 60 seconds).
* `!bonedrop off` — disable automatic bone drops.
* `!bonedrop status` — check whether the macro is active.
* `!bonedrop cooldown <seconds>` — change and save the cooldown while the macro is running or stopped.
* `!bonedrop interval <seconds>` — alias for `!bonedrop cooldown`.
* `!bonedrop now` — run a complete collection cycle immediately for testing.

At each interval, the bot confirms the **Skeleton Spawners** menu and opens its storage. It keeps that menu open and repeatedly clicks **Drop Loot** as the server refreshes the loot page. If normal, spectral, tipped, or custom-labeled arrows appear, it clicks the gold-ingot **Sell All** control exactly once and closes the menu. There is no fixed click limit. The enabled setting and cooldown are restored after reconnects or manager restarts.

Examples:

```text
!bonedrop on 60
!bonedrop cooldown 90
```

Run `!bonedrop now` first. If it reports that no spawner was found, move the bot closer and retry. Make sure this automation is permitted by the Minecraft server's rules.

### Per-Account Automation Schedules

Open an account with **Manage**, then use **Automation schedule**. Each account stores its own settings:

* **Bot active hours** connects at the start time and pauses at the stop time.
* **Scheduled Bone Drop** accepts one or more 24-hour times separated by commas, such as `09:00, 14:30, 21:00`.
* **Sell Macro window** runs `/sell all` at the selected interval only during that window.
* **Maintenance pause** disconnects the account during planned downtime.
* **High-ping reconnect** reconnects after three consecutive high readings and has a two-minute safety cooldown.

Select the days that each rule applies to, then save the schedule. Times use the time zone displayed in the schedule panel. Start/stop and maintenance windows can cross midnight. The account card and control panel show the next scheduled action.

### Stopping a Bot

Inside the bot's specific channel, type:

```text
!stop
```

This safely disconnects the bot from the Minecraft server and deletes the dedicated Discord channel.

## ▲ Local Dashboard and Vercel

The dashboard now runs directly on the same computer as the bot at `http://localhost:25567`. Keep `DASHBOARD_HOST=127.0.0.1` to prevent other devices from connecting to it.

A Vercel deployment cannot connect to `localhost` on your computer. Remote dashboard access would require a secure HTTPS tunnel or another publicly reachable backend. Do not set `BOT_BACKEND_URL` to `localhost` in Vercel because that would refer to Vercel's own server rather than your computer.

## ⚙️ Running 24/7 in the Background (PM2)

To keep the bot running even if you close your terminal, it is recommended to use PM2.

1. Install PM2 globally:

```bash
npm install -g pm2
```

2. Start the bot using the included PM2 configuration:

```bash
pm2 start ecosystem.config.js
pm2 save
```

Open `http://localhost:25567` in the browser on that computer. Useful controls are:

```bash
pm2 status
pm2 logs axiora-afk
pm2 restart axiora-afk
pm2 stop axiora-afk
```

(Optional) Start on Windows Boot:
If you are hosting locally on Windows and want the bot to resurrect if your computer restarts:

```bash
npm install pm2-windows-startup -g
pm2-startup install
pm2 save
```

## ⚠️ Disclaimer

This script is provided for educational purposes. Please ensure you have permission to run AFK bots on the target server, as violating server rules may result in account bans.
