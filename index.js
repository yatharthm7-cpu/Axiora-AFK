require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { SocksClient } = require('socks'); // Import SocksClient
const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');

const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Key = Discord Channel ID, Value = Session Object
const botSessions = new Map(); 
const reconnectInterval = 5000;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const CENTRAL_LOG_CHANNEL = '1535252592198680607';
const DEFAULT_BONE_DROP_INTERVAL_SECONDS = 60;
const MIN_BONE_DROP_INTERVAL_SECONDS = 5;
const MAX_BONE_DROP_INTERVAL_SECONDS = 86400;

function normalizeBoneDropIntervalSeconds(value) {
    if (value == null || value === '') return DEFAULT_BONE_DROP_INTERVAL_SECONDS;
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < MIN_BONE_DROP_INTERVAL_SECONDS || seconds > MAX_BONE_DROP_INTERVAL_SECONDS) {
        throw new Error(`Bone Drop cooldown must be ${MIN_BONE_DROP_INTERVAL_SECONDS}-${MAX_BONE_DROP_INTERVAL_SECONDS} seconds.`);
    }
    return seconds;
}

function extractMinecraftText(value, seen = new Set()) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try { return extractMinecraftText(JSON.parse(trimmed), seen); } catch (error) {}
        }
        return value;
    }
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    if (Array.isArray(value)) return value.map(entry => extractMinecraftText(entry, seen)).filter(Boolean).join(' ');
    if (value.type === 'string' && typeof value.value === 'string') return value.value;
    if (value.type && value.value !== undefined) return extractMinecraftText(value.value, seen);
    const parts = [];
    if (value.text !== undefined) parts.push(extractMinecraftText(value.text, seen));
    if (value.translate !== undefined) parts.push(extractMinecraftText(value.translate, seen));
    if (value.with !== undefined) parts.push(extractMinecraftText(value.with, seen));
    if (value.extra !== undefined) parts.push(extractMinecraftText(value.extra, seen));
    return parts.filter(Boolean).join(' ');
}

function menuTitle(window) {
    return extractMinecraftText(window?.title).replace(/\s+/g, ' ').trim();
}

function itemSearchText(item) {
    if (!item) return '';
    const parts = [item.name, item.displayName, extractMinecraftText(item.customName), extractMinecraftText(item.customLore)];
    try { parts.push(JSON.stringify(item.components || item.nbt || {})); } catch (error) {}
    return parts.filter(Boolean).join(' ').toLowerCase();
}

function findMenuSlot(window, matcher) {
    if (!window?.slots) return -1;
    const menuEnd = Number.isInteger(window.inventoryStart) ? window.inventoryStart : Math.max(0, window.slots.length - 36);
    for (let slot = 0; slot < menuEnd; slot++) {
        const item = window.slots[slot];
        if (item && matcher(itemSearchText(item), item, slot)) return slot;
    }
    return -1;
}

function findDropLootSlot(window, allowLayoutFallback = true) {
    const namedSlot = findMenuSlot(window, (text, item) =>
        item.name === 'dispenser' || text.includes('drop loot') || text.includes('click to drop'));
    if (namedSlot >= 0) return namedSlot;
    if (!allowLayoutFallback || !Number.isInteger(window?.inventoryStart) || window.inventoryStart < 45) return -1;
    const bottomCenterSlot = window.inventoryStart - 5;
    return window.slots[bottomCenterSlot] ? bottomCenterSlot : -1;
}

function findSellAllSlot(window) {
    if (!Number.isInteger(window?.inventoryStart) || window.inventoryStart < 18) return -1;
    for (let slot = window.inventoryStart - 9; slot < window.inventoryStart; slot++) {
        const item = window.slots[slot];
        if (!item) continue;
        const text = itemSearchText(item);
        if (text.includes('sell all') || text.includes('click to sell') || item.name === 'gold_ingot') return slot;
    }
    return -1;
}

function inspectSpawnerLoot(window) {
    if (!Number.isInteger(window?.inventoryStart) || window.inventoryStart < 18) {
        throw new Error('The detailed Skeleton loot grid could not be identified.');
    }
    const lootItems = window.slots.slice(0, window.inventoryStart - 9).filter(Boolean);
    return {
        hasArrows: lootItems.some(item => item.name === 'arrow' || item.name === 'spectral_arrow' || item.name === 'tipped_arrow' || /\barrows?\b/.test(itemSearchText(item))),
        hasBones: lootItems.some(item => item.name === 'bone' || /\bbones?\b/.test(itemSearchText(item)))
    };
}

function spawnerLootFingerprint(window) {
    if (!Number.isInteger(window?.inventoryStart)) return '';
    return window.slots.slice(0, Math.max(0, window.inventoryStart - 9)).map((item, slot) =>
        item ? `${slot}:${item.name}:${item.count || 0}:${item.metadata ?? ''}` : `${slot}:`).join('|');
}

async function waitUntil(check, timeoutMs = 4000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    return null;
}

async function closeCurrentWindow(bot) {
    if (!bot.currentWindow) return;
    bot.closeWindow(bot.currentWindow);
    await waitUntil(() => !bot.currentWindow, 1000, 50);
}

async function openSkeletonOverview(bot) {
    if (menuTitle(bot.currentWindow).toLowerCase().includes('skeleton spawner')) return bot.currentWindow;
    await closeCurrentWindow(bot);

    const candidates = [];
    const candidateKeys = new Set();
    const addCandidate = block => {
        if (!block?.position) return;
        const key = `${block.position.x}:${block.position.y}:${block.position.z}`;
        if (candidateKeys.has(key)) return;
        candidateKeys.add(key);
        candidates.push(block);
    };

    // Custom-spawner servers may disguise the clickable block, so first try
    // exactly what the account is looking at.
    try { addCandidate(bot.blockAtCursor(8)); } catch (error) {}

    let positions = [];
    try {
        positions = bot.findBlocks({
            matching: block => block && String(block.name || '').includes('spawner'),
            maxDistance: 8,
            count: 64
        });
    } catch (error) {}
    positions.sort((left, right) => bot.entity.position.distanceSquared(left) - bot.entity.position.distanceSquared(right));
    for (const position of positions) addCandidate(bot.blockAt(position));

    if (!candidates.length) {
        throw new Error('No block is visible in front of the bot and no spawner block is loaded within 8 blocks. Face the spawner and try !bonedrop now.');
    }

    for (const spawner of candidates) {
        try {
            await closeCurrentWindow(bot);
            await bot.lookAt(spawner.position.offset(0.5, 0.5, 0.5), true);
            await bot.activateBlock(spawner);
            const window = await waitUntil(() => bot.currentWindow, 2500);
            if (window && menuTitle(window).toLowerCase().includes('skeleton spawner')) return window;
        } catch (error) {}
    }
    await closeCurrentWindow(bot);
    const checked = [...new Set(candidates.map(block => block.name || 'unknown'))].join(', ');
    throw new Error(`No Skeleton spawner menu opened. Checked: ${checked}. Face the clickable spawner block and try !bonedrop now.`);
}

async function openSkeletonLootMenu(bot) {
    let window = await openSkeletonOverview(bot);
    if (findDropLootSlot(window, false) >= 0) return window;
    let storageSlot = findMenuSlot(window, (text, item) => item.name === 'chest' || text.includes('spawner storage'));
    if (storageSlot < 0 && Number.isInteger(window.inventoryStart) && window.inventoryStart < 45) {
        const center = Math.floor(window.inventoryStart / 2);
        if (window.slots[center]) storageSlot = center;
    }
    if (storageSlot < 0) throw new Error('Spawner Storage button was not found.');
    await bot.clickWindow(storageSlot, 0, 0);
    window = await waitUntil(() => {
        const candidate = bot.currentWindow;
        return candidate && menuTitle(candidate).toLowerCase().includes('skeleton spawner') && findDropLootSlot(candidate, false) >= 0
            ? candidate : null;
    }, 4000);
    if (!window) throw new Error('Spawner Storage did not open the detailed loot view.');
    return window;
}

async function runBoneDropCycle(bot) {
    if (!bot?.entity || !bot.isAlive) throw new Error('The Minecraft bot is not spawned and alive.');
    if (bot.boneDropBusy) throw new Error('A Bone Drop cycle is already running.');
    bot.boneDropBusy = true;
    try {
        let dropActions = 0;
        await openSkeletonLootMenu(bot);
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 250));
            const window = bot.currentWindow;
            if (!window || !menuTitle(window).toLowerCase().includes('skeleton spawner')) {
                throw new Error('The Skeleton loot menu closed or changed.');
            }
            const loot = inspectSpawnerLoot(window);
            if (loot.hasArrows) {
                const sellAllSlot = findSellAllSlot(window);
                if (sellAllSlot < 0) throw new Error('Arrows are visible, but Sell All was not found.');
                await bot.clickWindow(sellAllSlot, 0, 0);
                await new Promise(resolve => setTimeout(resolve, 350));
                await closeCurrentWindow(bot);
                return { dropActions, soldAll: true };
            }
            if (!loot.hasBones) {
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }
            const dropSlot = findDropLootSlot(window);
            if (dropSlot < 0) throw new Error('Drop Loot was not found.');
            const previous = spawnerLootFingerprint(window);
            await bot.clickWindow(dropSlot, 0, 0);
            dropActions++;
            await waitUntil(() => {
                const candidate = bot.currentWindow;
                if (!candidate || !menuTitle(candidate).toLowerCase().includes('skeleton spawner')) return null;
                const nextLoot = inspectSpawnerLoot(candidate);
                return nextLoot.hasArrows || spawnerLootFingerprint(candidate) !== previous;
            }, 3500, 100);
        }
    } finally {
        bot.boneDropBusy = false;
    }
}

async function triggerBoneDropCycle(bot, session) {
    if (session.stopped || session.bot !== bot || bot.boneDropBusy) return;
    try {
        const result = await runBoneDropCycle(bot);
        session.discordChannel.send(`🏹 Bone Drop finished after **${result.dropActions}** Drop Loot click(s). Clicked **Sell All** once.`).catch(() => {});
    } catch (error) {
        session.discordChannel.send(`❌ Bone Drop failed: \`${error.message}\``).catch(() => {});
    }
}

function startBoneDropMacro(bot, session) {
    if (bot.boneDropInterval) clearInterval(bot.boneDropInterval);
    session.boneDropEnabled = true;
    session.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(session.boneDropIntervalSeconds);
    bot.boneDropInterval = setInterval(() => triggerBoneDropCycle(bot, session), session.boneDropIntervalSeconds * 1000);
}

// ==========================================
// 1. Session Persistence & Utilities
// ==========================================

function saveSessions() {
    const dataToSave = {};
    for (const [channelId, session] of botSessions.entries()) {
        dataToSave[channelId] = {
            username: session.username,
            server_ip: session.server_ip,
            password: session.password,
            authType: session.authType,
            // Save proxy details
            proxy_host: session.proxy_host,
            proxy_port: session.proxy_port,
            boneDropEnabled: Boolean(session.boneDropEnabled),
            boneDropIntervalSeconds: normalizeBoneDropIntervalSeconds(session.boneDropIntervalSeconds)
        };
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(dataToSave, null, 4));
}

async function loadSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return;

    try {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        let loadedCount = 0;
        let needsSave = false; 

        for (const channelId in data) {
            const s = data[channelId];
            try {
                const channel = await discordClient.channels.fetch(channelId);
                
                botSessions.set(channelId, {
                    username: s.username,
                    server_ip: s.server_ip,
                    password: s.password,
                    authType: s.authType,
                    // Load proxy details
                    proxy_host: s.proxy_host,
                    proxy_port: s.proxy_port,
                    boneDropEnabled: Boolean(s.boneDropEnabled),
                    boneDropIntervalSeconds: normalizeBoneDropIntervalSeconds(s.boneDropIntervalSeconds),
                    discordChannel: channel,
                    stopped: false,
                    bot: null,
                    reconnectTimer: null
                });
                
                spawnDynamicBot(channelId);
                loadedCount++;
            } catch (err) {
                console.log(`[Auto-Spawn] Channel for ${s.username} no longer exists. Removing from database.`);
                delete data[channelId]; 
                needsSave = true;
            }
        }
        
        if (needsSave) {
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 4));
        }
        
        if (loadedCount > 0) {
            console.log(`[Auto-Spawn] Successfully restored ${loadedCount} bot sessions.`);
        }
    } catch (err) {
        console.error("Error loading sessions.json:", err);
    }
}

async function logToCentral(message) {
    try {
        const channel = await discordClient.channels.fetch(CENTRAL_LOG_CHANNEL);
        if (channel) {
            await channel.send(message).catch(() => {});
        }
    } catch (err) {}
}

// ==========================================
// 2. Bot Spawning & Management
// ==========================================

function spawnDynamicBot(channelId) {
    const session = botSessions.get(channelId);
    if (!session || session.stopped) return;

    let host = session.server_ip;
    let port = 25565;

    if (session.server_ip.includes(':')) {
        const parts = session.server_ip.split(':');
        host = parts[0];
        port = parseInt(parts[1], 10);
    }

    // Prepare createBot options
    const botOptions = {
        host: host,
        port: port,
        username: session.username,
        auth: session.authType,
        version: '1.21.1',
        hideErrors: true,
        viewDistance: 2
    };

    // ====== PROXY LOGIC ======
    // If proxy details exist, create a custom connect handler
    if (session.proxy_host && session.proxy_port) {
        session.discordChannel.send(`🛡️ Connecting via SOCKS5 proxy: \`${session.proxy_host}:${session.proxy_port}\``).catch(() => {});

        botOptions.connect = (client) => {
            const options = {
                proxy: {
                    host: session.proxy_host,
                    port: session.proxy_port,
                    type: 5 // SOCKS5
                },
                command: 'connect',
                destination: {
                    host: host,
                    port: port
                }
            };

            SocksClient.createConnection(options, (err, info) => {
                if (err) {
                    // Log proxy connection errors to Discord
                    const errMsg = `🚨 [Proxy Error] **${session.username}** failed to connect to proxy: \`${err.message}\``;
                    session.discordChannel.send(errMsg).catch(() => {});
                    logToCentral(errMsg);

                    // Force a restart trigger via 'end' event
                    client.emit('end');
                    return;
                }

                client.setSocket(info.socket);
                client.emit('connect');
            });
        };
    }
    // =========================

    // Create bot with potential proxy settings
    const bot = mineflayer.createBot(botOptions);

    session.bot = bot;
    bot.customPassword = session.password;
    bot.targetHost = host;
    bot.discordChannelId = channelId; 
    bot.isAuthenticated = false;
    bot.authSent = false; 
    bot.hubRoutingCooldown = false;

    bot.afkInterval = null; 
    bot.lifestealTimer = null;
    bot.sellInterval = null; 
    bot.autoEatInterval = null; 
    bot.boneDropInterval = null;
    bot.boneDropBusy = false;

    // --- Minecraft Events ---

    bot.on('spawn', () => {
        const botName = bot.username;
        session.discordChannel.send(`✅ **${botName}** spawned! *(Waiting 10 seconds to route...)*`).catch(() => {});

        if (bot.afkInterval) clearInterval(bot.afkInterval);

        // Turn off heavy physics calculations immediately to save CPU
        bot.physicsEnabled = false;

        // 10-Second Auto-Route Logic
        bot.lifestealTimer = setTimeout(() => {
            if (session.stopped || session.bot !== bot) return;

            session.discordChannel.send(`➡️ 10 seconds passed. Sent \`/server lifesteal\`...`).catch(() => {});

            if (bot.afkInterval) {
                clearInterval(bot.afkInterval);
                bot.afkInterval = null;
            }
            bot.clearControlStates();
            bot.physicsEnabled = false;

            try { bot.chat('/server lifesteal'); } catch(e) {}

        }, 10000);

        // Light Weight Anti-AFK (Zero Physics calculation)
        setTimeout(() => {
            if (session.stopped || session.bot !== bot) return;

            bot.afkInterval = setInterval(() => {
                if (bot && bot.entity && bot.isAlive) { 
                    if (typeof bot.entity.yaw === 'number' && typeof bot.entity.pitch === 'number') {
                        const yaw = bot.entity.yaw + (Math.random() - 0.5);
                        const pitch = bot.entity.pitch + (Math.random() - 0.5);
                        try { bot.look(yaw, pitch, true); } catch(e) {}
                    }
                    if (Math.random() > 0.5) {
                        try { bot.swingArm(); } catch(e) {} 
                    }
                }
            }, 15000); 
        }, 5000);

        if (session.boneDropEnabled) {
            startBoneDropMacro(bot, session);
            session.discordChannel.send(`🦴 Bone Drop restored every **${session.boneDropIntervalSeconds} seconds**.`).catch(() => {});
        }
    });

    bot.on('message', (jsonMsg, position) => {
        const message = jsonMsg.toString();

        if (!message || message.trim() === '') return;
        if (position === 'game_info') return;

        const lowerMsg = message.toLowerCase();
        session.discordChannel.send(`💬 ${message}`).catch(() => {});

        // Authentication Logic
        if (bot.customPassword && !bot.isAuthenticated && !bot.authSent) {
            if (lowerMsg.includes('/register')) {
                bot.authSent = true;
                try { bot.chat(`/register ${bot.customPassword} ${bot.customPassword}`); } catch(e) {}
            } else if (lowerMsg.includes('/login')) {
                bot.authSent = true;
                try { bot.chat(`/login ${bot.customPassword}`); } catch(e) {}
            }
        }

        if (bot.customPassword && !bot.isAuthenticated &&
           (lowerMsg.includes('successfully') || lowerMsg.includes('logged in') || lowerMsg.includes('authenticated') || lowerMsg.includes('success'))) {

            bot.isAuthenticated = true;
            session.discordChannel.send(`🔑 **${bot.username}** authenticated!`).catch(() => {});
        }

        // Hub Recovery
        const isHubMessage = lowerMsg.includes('fastclient') || lowerMsg.includes('fatalmc') || lowerMsg.includes('store.fatalmc.org');

        if (isHubMessage && bot.isAuthenticated && !bot.hubRoutingCooldown) {
            bot.hubRoutingCooldown = true;
            session.discordChannel.send(`⚠️ **${bot.username}** detected in Hub! Automatically transferring to Lifesteal...`).catch(() => {});

            if (bot.afkInterval) {
                clearInterval(bot.afkInterval);
                bot.afkInterval = null;
            }
            bot.clearControlStates();
            bot.physicsEnabled = false;

            try { bot.chat('/server lifesteal'); } catch(e) {}

            setTimeout(() => {
                if (bot) bot.hubRoutingCooldown = false;
            }, 25000);
        }
    });

    bot.on('death', () => {
        const botName = bot.username || session.username;
        const msg = `💀 **${botName}** died!`;
        session.discordChannel.send(msg).catch(() => {});
        logToCentral(msg);
    });

    bot.on('error', (err) => {
        const botName = bot.username || session.username;
        // Adjust error message if it looks like a proxy error caught by mineflayer
        let errDesc = err.message;
        if (session.proxy_host && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
            errDesc += ' (Possible proxy issue)';
        }
        const msg = `🚨 **${botName}** encountered an error: \`${errDesc}\``;
        logToCentral(msg);
    });

    bot.on('kicked', async (reason) => {
        let parsedReason = String(reason);
        if (typeof reason === 'object') {
            try {
                if (reason.value && reason.value.text && reason.value.text.value) {
                    parsedReason = reason.value.text.value;
                } else {
                    parsedReason = JSON.stringify(reason, null, 2);
                }
            } catch (e) {
                parsedReason = "Unknown Object";
            }
        }

        const botName = bot.username || session.username;
        const logMsg = `⚠️ **${botName}** kicked from ${host}:\n\`\`\`json\n${parsedReason}\n\`\`\``;

        logToCentral(logMsg);
        const kickMessage = await session.discordChannel.send(logMsg).catch(() => {});

        const lowerReason = parsedReason.toLowerCase();
        if (kickMessage && (lowerReason.includes('logging in too fast') || lowerReason.includes('internal error'))) {
            setTimeout(() => {
                kickMessage.delete().catch(() => {});
            }, 5000);
        }
    });

    bot.on('end', () => {
        const botName = session.username;
        session.discordChannel.send(`🔌 **${botName}** disconnected.`).catch(() => {});
        
        // --- Aggressive Memory Leak Cleanup ---
        if (bot.afkInterval) clearInterval(bot.afkInterval);
        if (bot.lifestealTimer) clearTimeout(bot.lifestealTimer);
        if (bot.sellInterval) clearInterval(bot.sellInterval);
        if (bot.autoEatInterval) clearInterval(bot.autoEatInterval); 
        if (bot.boneDropInterval) clearInterval(bot.boneDropInterval);
        
        // Completely sever the connection between the session and the dead bot
        session.bot = null; 

        if (!session.stopped) {
            session.discordChannel.send(`🔄 **${botName}** reconnecting in ${reconnectInterval / 1000}s...`).catch(() => {});
            session.reconnectTimer = setTimeout(() => {
                spawnDynamicBot(channelId);
            }, reconnectInterval);
        }
    });
}

// ==========================================
// 3. Discord Bot Logic
// ==========================================

discordClient.once('clientReady', async () => {
    console.log(`Logged in to Discord as ${discordClient.user.tag}`);
    console.log('Use /spawn <username> <ip> <password> <auth> [proxy_host:port] to begin.');
    
    await loadSessions();
});

discordClient.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const content = message.content;

    if (content.startsWith('/spawn ')) {
        const args = content.split(' ');
        const username = args[1];
        const server_ip = args[2];
        const password = args[3];
        const authType = args[4] || 'offline';
        const proxyArg = args[5]; // Optional argument

        if (!username || !server_ip || !password) {
            return message.reply("❌ **Invalid Format.** Use: `/spawn <username> <server_ip> <password> <auth> [proxy_host:port]`").catch(() => {});
        }

        // Parse Proxy Argument if exists
        let proxy_host = null;
        let proxy_port = null;
        if (proxyArg) {
            if (proxyArg.includes(':')) {
                const proxyParts = proxyArg.split(':');
                proxy_host = proxyParts[0];
                proxy_port = parseInt(proxyParts[1], 10);

                if (isNaN(proxy_port)) {
                    return message.reply("❌ **Invalid Proxy Port.** Format must be `host:port`").catch(() => {});
                }
            } else {
                return message.reply("❌ **Invalid Proxy Format.** Use `host:port`").catch(() => {});
            }
        }

        const existingSession = Array.from(botSessions.values()).find(s => s.username.toLowerCase() === username.toLowerCase());
        if (existingSession) {
            return message.reply(`Bot **${username}** is already running in <#${existingSession.discordChannel.id}>.`).catch(() => {});
        }

        message.delete().catch(() => {});
        const tempReply = await message.channel.send(`⏳ Creating secure channel and spawning **${username}**...`).catch(() => {});
        if (tempReply) setTimeout(() => tempReply.delete().catch(() => {}), 5000);

        try {
            const categoryName = 'Minecraft Bots';
            let category = message.guild.channels.cache.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
            
            if (!category) {
                category = await message.guild.channels.create({
                    name: categoryName,
                    type: ChannelType.GuildCategory,
                    reason: 'To organize AFK bot channels'
                });
            }

            const newChannel = await message.guild.channels.create({
                name: `bot-${username.toLowerCase()}`,
                type: ChannelType.GuildText,
                parent: category.id, 
                permissionOverwrites: [
                    { id: message.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: message.author.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: discordClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                ],
            });

            botSessions.set(newChannel.id, {
                username: username,
                server_ip: server_ip,
                password: password,
                authType: authType,
                // Store proxy details in session
                proxy_host: proxy_host,
                proxy_port: proxy_port,
                boneDropEnabled: false,
                boneDropIntervalSeconds: DEFAULT_BONE_DROP_INTERVAL_SECONDS,
                discordChannel: newChannel,
                stopped: false,
                bot: null,
                reconnectTimer: null
            });

            saveSessions();
            spawnDynamicBot(newChannel.id);

        } catch (error) {
            console.error(error);
            message.reply("❌ **Error:** Could not create a Discord channel.").catch(() => {});
        }
        return; 
    }

    if (content === '!spawnall') {
        if (!fs.existsSync(SESSIONS_FILE)) {
            return message.reply("⚠️ No saved bot sessions found in database.").catch(() => {});
        }

        try {
            const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            const channelIds = Object.keys(data);
            if (channelIds.length === 0) return message.reply("⚠️ No saved bots in database.").catch(() => {});

            let spawnedCount = 0;
            for (const channelId of channelIds) {
                const sessionData = data[channelId];
                let session = botSessions.get(channelId);
                let channel = session ? session.discordChannel : null;
                if (!channel) {
                    try { channel = await discordClient.channels.fetch(channelId); } catch (e) { continue; }
                }

                if (!session || !session.bot || session.stopped) {
                    botSessions.set(channelId, {
                        username: sessionData.username,
                        server_ip: sessionData.server_ip,
                        password: sessionData.password,
                        authType: sessionData.authType,
                        // Load proxy details on !spawnall
                        proxy_host: sessionData.proxy_host,
                        proxy_port: sessionData.proxy_port,
                        boneDropEnabled: Boolean(sessionData.boneDropEnabled),
                        boneDropIntervalSeconds: normalizeBoneDropIntervalSeconds(sessionData.boneDropIntervalSeconds),
                        discordChannel: channel,
                        stopped: false,
                        bot: null,
                        reconnectTimer: null
                    });
                    spawnDynamicBot(channelId);
                    spawnedCount++;
                }
            }

            if (spawnedCount > 0) return message.reply(`🚀 Spawning/restarting **${spawnedCount}** bot(s)...`).catch(() => {});
            else return message.reply("⚠️ All saved bots are already active and running!").catch(() => {});
        } catch (err) {
            return message.reply("❌ Error executing `!spawnall`.").catch(() => {});
        }
    }

    if (content === '!stopall') {
        if (botSessions.size === 0) return message.reply("⚠️ There are no active bots to stop.").catch(() => {});
        message.reply(`🛑 Initiating global shutdown. Stopping all **${botSessions.size}** active bots and deleting their channels in 5 seconds...`).catch(() => {});

        for (const [channelId, session] of botSessions.entries()) {
            session.stopped = true; 
            if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
            if (session.bot && session.bot.sellInterval) clearInterval(session.bot.sellInterval);
            if (session.bot && session.bot.autoEatInterval) clearInterval(session.bot.autoEatInterval); 
            if (session.bot && session.bot.boneDropInterval) clearInterval(session.bot.boneDropInterval);
            
            if (session.bot) session.bot.quit();
            session.bot = null; // Prevent leaks
            
            setTimeout(() => { session.discordChannel.delete().catch(() => {}); }, 5000);
        }

        botSessions.clear();
        saveSessions();
        return;
    }

    if (content.startsWith('!stop')) {
        const session = botSessions.get(message.channel.id);
        if (session) {
            session.stopped = true; 
            if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
            if (session.bot && session.bot.sellInterval) clearInterval(session.bot.sellInterval);
            if (session.bot && session.bot.autoEatInterval) clearInterval(session.bot.autoEatInterval); 
            if (session.bot && session.bot.boneDropInterval) clearInterval(session.bot.boneDropInterval);
            
            if (session.bot) session.bot.quit();
            session.bot = null; // Prevent leaks
            
            botSessions.delete(message.channel.id);
            saveSessions();
            
            message.reply(`🛑 Stopping **${session.username}** and deleting channel in 5 seconds...`).catch(() => {});
            setTimeout(() => { message.channel.delete().catch(() => {}); }, 5000);
        } else {
            message.reply("This channel is not linked to an active bot.").catch(() => {});
        }
        return;
    }

    const currentSession = botSessions.get(message.channel.id);
    if (currentSession && currentSession.bot) {
        const activeBot = currentSession.bot;

        const boneDropOnMatch = content.trim().match(/^!bonedrop\s+on(?:\s+(\d+))?$/i);
        if (boneDropOnMatch) {
            try {
                currentSession.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(
                    boneDropOnMatch[1] || currentSession.boneDropIntervalSeconds
                );
                startBoneDropMacro(activeBot, currentSession);
                saveSessions();
                void triggerBoneDropCycle(activeBot, currentSession);
                return message.reply(`🦴 Bone Drop started now and will repeat every **${currentSession.boneDropIntervalSeconds} seconds**.`).catch(() => {});
            } catch (error) {
                return message.reply(`❌ ${error.message}`).catch(() => {});
            }
        }

        if (content.toLowerCase() === '!bonedrop off') {
            currentSession.boneDropEnabled = false;
            if (activeBot.boneDropInterval) clearInterval(activeBot.boneDropInterval);
            activeBot.boneDropInterval = null;
            saveSessions();
            return message.reply('🛑 Bone Drop disabled.').catch(() => {});
        }

        const boneDropIntervalMatch = content.trim().match(/^!bonedrop\s+(?:cooldown|interval)\s+(\d+)$/i);
        if (boneDropIntervalMatch) {
            try {
                currentSession.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(boneDropIntervalMatch[1]);
                if (currentSession.boneDropEnabled) startBoneDropMacro(activeBot, currentSession);
                saveSessions();
                return message.reply(`⏱️ Bone Drop interval set to **${currentSession.boneDropIntervalSeconds} seconds**.`).catch(() => {});
            } catch (error) {
                return message.reply(`❌ ${error.message}`).catch(() => {});
            }
        }

        if (content.toLowerCase() === '!bonedrop status') {
            const state = currentSession.boneDropEnabled && activeBot.boneDropInterval ? 'enabled' : 'disabled';
            return message.reply(`🦴 Bone Drop is **${state}** with a **${normalizeBoneDropIntervalSeconds(currentSession.boneDropIntervalSeconds)}-second** interval.`).catch(() => {});
        }

        if (content.toLowerCase() === '!bonedrop now') {
            if (activeBot.boneDropBusy) return message.reply('⚠️ A Bone Drop cycle is already running.').catch(() => {});
            void triggerBoneDropCycle(activeBot, currentSession);
            return message.reply('🦴 Bone Drop cycle started.').catch(() => {});
        }

        if (content.toLowerCase() === '!autoeat on') {
            if (activeBot.autoEatInterval) return message.reply("⚠️ Auto-Eat is already running.").catch(() => {});

            activeBot.autoEatInterval = setInterval(async () => {
                if (activeBot && activeBot.entity && activeBot.isAlive && activeBot.food < 16) {
                    const foodList = ['golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'baked_potato', 'bread', 'apple', 'carrot', 'sweet_berries', 'glow_berries', 'melon_slice'];
                    const foodItem = activeBot.inventory.items().find(item => foodList.includes(item.name));
                    
                    if (foodItem) {
                        try {
                            await activeBot.equip(foodItem, 'hand');
                            await activeBot.consume();
                        } catch (err) {}
                    }
                }
            }, 5000);
            return message.reply("🍔 **Auto-Eat Enabled!** Bot will automatically consume food if hunger drops below 16.").catch(() => {});
        }

        if (content.toLowerCase() === '!autoeat off') {
            if (activeBot.autoEatInterval) {
                clearInterval(activeBot.autoEatInterval);
                activeBot.autoEatInterval = null;
                return message.reply("🛑 **Auto-Eat Disabled.**").catch(() => {});
            }
        }

        if (content.toLowerCase().startsWith('!sellmacro on')) {
            const args = content.split(' ');
            let seconds = 30;
            if (args[2] && !isNaN(args[2])) seconds = Math.max(1, parseInt(args[2], 10));

            if (activeBot.sellInterval) {
                clearInterval(activeBot.sellInterval);
                activeBot.sellInterval = null;
            }

            try { if (activeBot && activeBot.entity && activeBot.isAlive) activeBot.chat('/sell all'); } catch (e) {}

            activeBot.sellInterval = setInterval(() => {
                try {
                    if (activeBot && activeBot.entity && activeBot.isAlive) {
                        activeBot.chat('/sell all');
                    }
                } catch (e) {}
            }, seconds * 1000);

            return message.reply(`✅ Started the \`/sell all\` macro (Running every **${seconds}s**).`).catch(() => {});
        }

        if (content.toLowerCase() === '!sellmacro off') {
            if (activeBot.sellInterval) {
                clearInterval(activeBot.sellInterval);
                activeBot.sellInterval = null;
                return message.reply("🛑 Stopped the `/sell all` macro.").catch(() => {});
            }
        }

        if (content.startsWith('/')) {
            if (content.toLowerCase().startsWith('/server ')) {
                if (activeBot.afkInterval) {
                    clearInterval(activeBot.afkInterval);
                    activeBot.afkInterval = null; 
                }
                activeBot.clearControlStates();
                activeBot.physicsEnabled = false;
            }
            try { activeBot.chat(content); } catch(e) {}
            message.react('🕹️').catch(() => {}); 
        } else {
            try { activeBot.chat(`${message.author.username}: ${content}`); } catch(e) {}
            message.react('💬').catch(() => {}); 
        }
    }
});

discordClient.login(process.env.DISCORD_TOKEN);
