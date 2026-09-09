require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { SocksClient } = require('socks');
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
const AUDIT_LOG_FILE = path.join(__dirname, 'audit-log.json');
const DASHBOARD_PUBLIC_DIR = path.join(__dirname, 'dashboard');
const CENTRAL_LOG_CHANNEL = '1535252592198680607';
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || '0.0.0.0';
const DASHBOARD_PORT = Number.parseInt(process.env.PORT || process.env.SERVER_PORT || process.env.DASHBOARD_PORT || '25567', 10);
const generatedDashboardPassword = crypto.randomBytes(12).toString('base64url');
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || generatedDashboardPassword;
const DASHBOARD_SESSION_HOURS = Math.min(168, Math.max(1, Number.parseInt(process.env.DASHBOARD_SESSION_HOURS || '8', 10) || 8));
const dashboardLogs = new Map();
const dashboardEventClients = new Set();
const auditLog = [];
const pendingDiscordSpawns = new Set();
const DEFAULT_BONE_DROP_INTERVAL_SECONDS = 60;
const MIN_BONE_DROP_INTERVAL_SECONDS = 5;
const MAX_BONE_DROP_INTERVAL_SECONDS = 86400;

function loadDashboardUsers() {
    let entries = [];
    if (process.env.DASHBOARD_USERS) {
        try {
            const parsed = JSON.parse(process.env.DASHBOARD_USERS);
            if (!Array.isArray(parsed)) throw new Error('DASHBOARD_USERS must be a JSON array.');
            entries = parsed;
        } catch (error) {
            console.error(`Invalid DASHBOARD_USERS: ${error.message}`);
        }
    }
    if (!entries.length) entries = [{ username: 'admin', password: DASHBOARD_PASSWORD, role: 'admin' }];

    const users = new Map();
    for (const entry of entries) {
        const username = String(entry?.username || '').trim().toLowerCase();
        const password = String(entry?.password || '');
        const role = entry?.role === 'viewer' ? 'viewer' : 'admin';
        if (!/^[a-z0-9_.-]{1,32}$/.test(username) || !password) continue;
        users.set(username, { username, password, role });
    }
    if (!users.size) users.set('admin', { username: 'admin', password: DASHBOARD_PASSWORD, role: 'admin' });
    return users;
}

const dashboardUsers = loadDashboardUsers();
const dashboardCookieSecret = crypto.createHash('sha256').update(
    process.env.DASHBOARD_SESSION_SECRET ||
    JSON.stringify([...dashboardUsers.values()].map(user => [user.username, user.password, user.role]))
).digest();

function loadAuditLog() {
    try {
        if (!fs.existsSync(AUDIT_LOG_FILE)) return;
        const saved = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, 'utf8'));
        if (Array.isArray(saved)) auditLog.push(...saved.slice(-1000));
    } catch (error) {
        console.error(`Could not load audit log: ${error.message}`);
    }
}

function saveAuditLog() {
    try { fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(auditLog.slice(-1000), null, 2)); } catch (error) {}
}

function recordAudit(actor, action, target = null, details = null) {
    auditLog.push({
        time: new Date().toISOString(),
        actor: actor?.username || String(actor || 'system'),
        role: actor?.role || (String(actor || '').startsWith('discord:') ? 'discord' : 'system'),
        action,
        target,
        details
    });
    if (auditLog.length > 1000) auditLog.splice(0, auditLog.length - 1000);
    saveAuditLog();
}

loadAuditLog();

function stripDiscordFormatting(value) {
    return String(value ?? '')
        .replace(/```(?:json)?/gi, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .trim();
}

function addDashboardLog(sessionId, message) {
    const entries = dashboardLogs.get(sessionId) || [];
    const entry = { time: new Date().toISOString(), message: stripDiscordFormatting(message) };
    entries.push(entry);
    if (entries.length > 100) entries.splice(0, entries.length - 100);
    dashboardLogs.set(sessionId, entries);
    broadcastDashboardEvent('activity', { sessionId, entry });
}

function broadcastDashboardEvent(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of dashboardEventClients) {
        try { response.write(frame); } catch (error) { dashboardEventClients.delete(response); }
    }
}

function normalizeSessionMetrics(value = {}) {
    return {
        connections: Number.isInteger(value.connections) ? value.connections : 0,
        disconnects: Number.isInteger(value.disconnects) ? value.disconnects : 0,
        deaths: Number.isInteger(value.deaths) ? value.deaths : 0,
        boneDropRuns: Number.isInteger(value.boneDropRuns) ? value.boneDropRuns : 0,
        boneDropSuccesses: Number.isInteger(value.boneDropSuccesses) ? value.boneDropSuccesses : 0,
        boneDropFailures: Number.isInteger(value.boneDropFailures) ? value.boneDropFailures : 0,
        boneDropEmpty: Number.isInteger(value.boneDropEmpty) ? value.boneDropEmpty : 0,
        boneDropClicks: Number.isInteger(value.boneDropClicks) ? value.boneDropClicks : 0,
        sellAllClicks: Number.isInteger(value.sellAllClicks) ? value.sellAllClicks : 0,
        dashboardActions: Number.isInteger(value.dashboardActions) ? value.dashboardActions : 0,
        estimatedEarnings: Number.isFinite(value.estimatedEarnings) ? value.estimatedEarnings : 0,
        lastOnlineAt: value.lastOnlineAt || null
    };
}

function normalizeAnalytics(value = {}) {
    const samples = Array.isArray(value.samples) ? value.samples
        .filter(sample => sample && Number.isFinite(sample.time))
        .slice(-10080)
        .map(sample => ({
            time: sample.time,
            online: Boolean(sample.online),
            ping: Number.isFinite(sample.ping) ? Math.round(sample.ping) : null
        })) : [];
    return {
        samples,
        lastBalance: Number.isFinite(value.lastBalance) ? value.lastBalance : null,
        lastDirectEarningAt: Number.isFinite(value.lastDirectEarningAt) ? value.lastDirectEarningAt : 0,
        lastDirectEarningAmount: Number.isFinite(value.lastDirectEarningAmount) ? value.lastDirectEarningAmount : 0
    };
}

function ensureSessionAnalytics(session) {
    session.analytics = normalizeAnalytics(session.analytics);
    return session.analytics;
}

function availabilityPercentage(session, hours) {
    const since = Date.now() - hours * 3600000;
    const samples = ensureSessionAnalytics(session).samples.filter(sample => sample.time >= since);
    if (!samples.length) return session.bot?.entity && session.bot.isAlive ? 100 : 0;
    return Math.round(samples.filter(sample => sample.online).length / samples.length * 1000) / 10;
}

function parseEconomyAmount(value) {
    const normalized = String(value || '').replace(/,/g, '');
    const match = normalized.match(/(?:[$€£₹]\s*)?(\d+(?:\.\d+)?)\s*([kmbt])?/i);
    if (!match) return null;
    const multipliers = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
    return Number(match[1]) * (multipliers[(match[2] || '').toLowerCase()] || 1);
}

function recordEconomyMessage(session, message) {
    const plain = stripDiscordFormatting(message);
    const lower = plain.toLowerCase();
    const analytics = ensureSessionAnalytics(session);
    const metrics = ensureSessionMetrics(session);
    const balanceText = plain.match(/(?:balance|bal)[^\d$€£₹-]*([$€£₹]?\s*[\d,.]+\s*[kmbt]?)/i)?.[1];

    if (balanceText) {
        const balance = parseEconomyAmount(balanceText);
        if (Number.isFinite(balance)) {
            const increase = Number.isFinite(analytics.lastBalance) ? balance - analytics.lastBalance : 0;
            const recentlyCounted = Date.now() - analytics.lastDirectEarningAt < 30000 &&
                Math.abs(increase - analytics.lastDirectEarningAmount) <= Math.max(1, increase * 0.02);
            if (increase > 0 && !recentlyCounted) metrics.estimatedEarnings += increase;
            analytics.lastBalance = balance;
        }
        return;
    }

    if (lower.includes('sold') || lower.includes('earned')) {
        const earningText = plain.match(/(?:sold.*?(?:for)?|earned)\s*[:+-]?\s*([$€£₹]?\s*[\d,.]+\s*[kmbt]?)/i)?.[1];
        const earning = parseEconomyAmount(earningText);
        if (Number.isFinite(earning) && earning > 0) {
            metrics.estimatedEarnings += earning;
            analytics.lastDirectEarningAt = Date.now();
            analytics.lastDirectEarningAmount = earning;
        }
    }
}

function ensureSessionMetrics(session) {
    session.metrics = normalizeSessionMetrics(session.metrics);
    return session.metrics;
}

function recordBoneDropResult(session, result) {
    const metrics = ensureSessionMetrics(session);
    metrics.boneDropRuns++;
    metrics.boneDropClicks += result.dropActions || 0;
    if (result.dropActions === 0 && !result.soldAll) metrics.boneDropEmpty++;
    else metrics.boneDropSuccesses++;
    if (result.soldAll) metrics.sellAllClicks++;
    saveSessions();
}

function createSessionChannel(sessionId, discordChannel = null) {
    return {
        id: sessionId,
        send(message) {
            addDashboardLog(sessionId, message);
            if (discordChannel) return discordChannel.send(message);
            return Promise.resolve({ delete: () => Promise.resolve() });
        },
        delete() {
            return discordChannel ? discordChannel.delete() : Promise.resolve();
        }
    };
}

function normalizeBoneDropIntervalSeconds(value) {
    if (value == null || value === '') return DEFAULT_BONE_DROP_INTERVAL_SECONDS;
    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds < MIN_BONE_DROP_INTERVAL_SECONDS || seconds > MAX_BONE_DROP_INTERVAL_SECONDS) {
        throw new Error(`Bone Drop cooldown must be a whole number from ${MIN_BONE_DROP_INTERVAL_SECONDS} to ${MAX_BONE_DROP_INTERVAL_SECONDS} seconds.`);
    }
    return seconds;
}

function normalizeProxy(value = {}) {
    if (typeof value === 'string') {
        const address = optionalValue(value);
        if (!address) return null;
        const parsed = parseAddress(address, 1080);
        if (!parsed.explicitPort) throw new Error('Proxy address must include a port, for example proxy.example.com:1080.');
        value = parsed;
    }
    const host = String(value?.host || '').trim().replace(/^\[|\]$/g, '');
    const port = Number.parseInt(value?.port, 10);
    if (!host) return null;
    if (host.length > 255 || /\s/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Proxy must contain a valid host and port.');
    }
    return {
        host,
        port,
        username: String(value?.username || '').slice(0, 128),
        password: String(value?.password || '').slice(0, 256)
    };
}

function optionalValue(value) {
    const normalized = String(value ?? '').trim();
    return !normalized || ['-', 'none', 'null'].includes(normalized.toLowerCase()) ? null : normalized;
}

function parseAddress(value, defaultPort = 25565) {
    const address = String(value || '').trim();
    if (!address) throw new Error('A server address is required.');
    let host = address;
    let port = defaultPort;
    let explicitPort = false;
    const bracketed = address.match(/^\[([^\]]+)](?::(\d+))?$/);
    if (bracketed) {
        host = bracketed[1];
        if (bracketed[2]) {
            port = Number(bracketed[2]);
            explicitPort = true;
        }
    } else if ((address.match(/:/g) || []).length === 1) {
        const separator = address.lastIndexOf(':');
        host = address.slice(0, separator);
        port = Number(address.slice(separator + 1));
        explicitPort = true;
    }
    if (!host || /\s/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Server port must be between 1 and 65535.');
    }
    return { host, port, explicitPort };
}

function publicProxy(proxy) {
    const normalized = normalizeProxy(proxy);
    return normalized ? {
        enabled: true,
        host: normalized.host,
        port: normalized.port,
        address: `${normalized.host}:${normalized.port}`,
        username: normalized.username || null
    } : { enabled: false, address: null, username: null };
}

function parseServerAddress(value) {
    const { host, port } = parseAddress(value);
    return { host, port };
}

function normalizeMinecraftVersion(value) {
    const version = String(value || 'auto').trim();
    if (!version || version.toLowerCase() === 'auto') return null;
    if (!/^1\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Minecraft version must look like 1.21.1 or be auto.');
    return version;
}

function normalizeVersion(value) {
    return normalizeMinecraftVersion(value) || 'auto';
}

function normalizeJoinCommand(value) {
    const command = optionalValue(value);
    if (!command) return null;
    if (!command.startsWith('/') || command.length > 256) throw new Error('Join command must start with / and be at most 256 characters.');
    return command;
}

function detectCrackedAuthAction(message) {
    const text = String(message || '');
    if (/\/register\b|\/reg\b|please\s+register|not\s+registered|create\s+(?:a\s+)?password/i.test(text)) return 'register';
    if (/\/login\b|\/l\s+(?:password|<)|please\s+(?:log\s?in|authenticate)|already\s+registered|enter\s+(?:your\s+)?password/i.test(text)) return 'login';
    return null;
}

function isCrackedAuthSuccess(message) {
    return /successfully\s+(?:logged\s+in|registered|authenticated)|login\s+successful|registration\s+successful|you\s+are\s+now\s+(?:logged\s+in|authenticated)/i
        .test(String(message || ''));
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const scheduleFormatters = new Map();

function normalizeClockTime(value, fallback) {
    const time = String(value || fallback);
    const match = time.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? time : fallback;
}

function normalizeTimezone(value) {
    const timezone = String(value || 'Asia/Kolkata').slice(0, 80);
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
        return timezone;
    } catch (error) {
        return 'Asia/Kolkata';
    }
}

function normalizeSchedule(value = {}) {
    const rawTimes = Array.isArray(value.boneDropTimes)
        ? value.boneDropTimes
        : String(value.boneDropTimes || '').split(',');
    const boneDropTimes = [...new Set(rawTimes
        .map(time => normalizeClockTime(String(time).trim(), ''))
        .filter(Boolean))].sort();
    const days = [...new Set((Array.isArray(value.days) ? value.days : [0, 1, 2, 3, 4, 5, 6])
        .map(Number)
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6))];
    const sellIntervalSeconds = Number.parseInt(value.sellIntervalSeconds, 10);
    const highPingThreshold = Number.parseInt(value.highPingThreshold, 10);

    return {
        enabled: Boolean(value.enabled),
        timezone: normalizeTimezone(value.timezone),
        days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
        activeHoursEnabled: Boolean(value.activeHoursEnabled),
        startTime: normalizeClockTime(value.startTime, '06:00'),
        stopTime: normalizeClockTime(value.stopTime, '23:00'),
        boneDropScheduleEnabled: Boolean(value.boneDropScheduleEnabled),
        boneDropTimes,
        sellWindowEnabled: Boolean(value.sellWindowEnabled),
        sellStartTime: normalizeClockTime(value.sellStartTime, '06:00'),
        sellStopTime: normalizeClockTime(value.sellStopTime, '23:00'),
        sellIntervalSeconds: Number.isInteger(sellIntervalSeconds) && sellIntervalSeconds >= 1 && sellIntervalSeconds <= 86400 ? sellIntervalSeconds : 30,
        maintenanceEnabled: Boolean(value.maintenanceEnabled),
        maintenanceStartTime: normalizeClockTime(value.maintenanceStartTime, '03:00'),
        maintenanceStopTime: normalizeClockTime(value.maintenanceStopTime, '04:00'),
        highPingEnabled: Boolean(value.highPingEnabled),
        highPingThreshold: Number.isInteger(highPingThreshold) && highPingThreshold >= 50 && highPingThreshold <= 5000 ? highPingThreshold : 500,
        lastBoneDropRunKey: typeof value.lastBoneDropRunKey === 'string' ? value.lastBoneDropRunKey : null
    };
}

function timeToMinutes(value) {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
}

function scheduleClock(timezone, date = new Date()) {
    if (!scheduleFormatters.has(timezone)) {
        scheduleFormatters.set(timezone, new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            weekday: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        }));
    }
    const parts = Object.fromEntries(scheduleFormatters.get(timezone).formatToParts(date).map(part => [part.type, part.value]));
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    return {
        day,
        minutes: hour * 60 + minute,
        time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        dateKey: `${parts.year}-${parts.month}-${parts.day}`
    };
}

function isRecurringWindowActive(clock, days, startTime, stopTime) {
    const start = timeToMinutes(startTime);
    const stop = timeToMinutes(stopTime);
    if (start === stop) return days.includes(clock.day);
    if (start < stop) return days.includes(clock.day) && clock.minutes >= start && clock.minutes < stop;
    const previousDay = (clock.day + 6) % 7;
    return (days.includes(clock.day) && clock.minutes >= start) ||
        (days.includes(previousDay) && clock.minutes < stop);
}

function scheduleShouldPause(schedule, clock) {
    if (!schedule.enabled) return false;
    if (schedule.maintenanceEnabled && isRecurringWindowActive(
        clock, schedule.days, schedule.maintenanceStartTime, schedule.maintenanceStopTime)) return true;
    if (schedule.activeHoursEnabled && !isRecurringWindowActive(
        clock, schedule.days, schedule.startTime, schedule.stopTime)) return true;
    return false;
}

function nextScheduledAction(schedule, now = new Date()) {
    if (!schedule.enabled) return null;
    const clock = scheduleClock(schedule.timezone, now);
    const candidates = [];
    const addCandidate = (dayOffset, minute, label) => {
        const deltaMinutes = dayOffset * 1440 + minute - clock.minutes;
        if (deltaMinutes <= 0) return;
        candidates.push({ deltaMinutes, label, dayOffset, time: `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` });
    };

    for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
        const day = (clock.day + dayOffset) % 7;
        const previousDay = (day + 6) % 7;
        if (schedule.activeHoursEnabled) {
            if (schedule.days.includes(day)) addCandidate(dayOffset, timeToMinutes(schedule.startTime), 'Start bot');
            const overnight = timeToMinutes(schedule.stopTime) <= timeToMinutes(schedule.startTime);
            if ((overnight && schedule.days.includes(previousDay)) || (!overnight && schedule.days.includes(day))) {
                addCandidate(dayOffset, timeToMinutes(schedule.stopTime), 'Pause bot');
            }
        }
        if (schedule.boneDropScheduleEnabled && schedule.days.includes(day)) {
            for (const time of schedule.boneDropTimes) addCandidate(dayOffset, timeToMinutes(time), 'Run Bone Drop');
        }
        if (schedule.sellWindowEnabled) {
            if (schedule.days.includes(day)) addCandidate(dayOffset, timeToMinutes(schedule.sellStartTime), 'Enable Sell Macro');
            const overnight = timeToMinutes(schedule.sellStopTime) <= timeToMinutes(schedule.sellStartTime);
            if ((overnight && schedule.days.includes(previousDay)) || (!overnight && schedule.days.includes(day))) {
                addCandidate(dayOffset, timeToMinutes(schedule.sellStopTime), 'Disable Sell Macro');
            }
        }
        if (schedule.maintenanceEnabled) {
            if (schedule.days.includes(day)) addCandidate(dayOffset, timeToMinutes(schedule.maintenanceStartTime), 'Begin maintenance pause');
            const overnight = timeToMinutes(schedule.maintenanceStopTime) <= timeToMinutes(schedule.maintenanceStartTime);
            if ((overnight && schedule.days.includes(previousDay)) || (!overnight && schedule.days.includes(day))) {
                addCandidate(dayOffset, timeToMinutes(schedule.maintenanceStopTime), 'End maintenance pause');
            }
        }
    }

    candidates.sort((left, right) => left.deltaMinutes - right.deltaMinutes);
    const next = candidates[0];
    if (!next) return null;
    const dayLabel = next.dayOffset === 0 ? 'Today' : next.dayOffset === 1 ? 'Tomorrow' : DAY_NAMES[(clock.day + next.dayOffset) % 7];
    return { label: next.label, when: `${dayLabel} at ${next.time}`, minutes: next.deltaMinutes };
}

function extractMinecraftText(value, seen = new Set()) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try { return extractMinecraftText(JSON.parse(trimmed), seen); } catch (error) {}
        }
        return value;
    }
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(entry => extractMinecraftText(entry, seen)).filter(Boolean).join(' ');
    }
    if (value.type === 'string' && typeof value.value === 'string') return value.value;
    if (value.type && value.value !== undefined) return extractMinecraftText(value.value, seen);

    const parts = [];
    if (value.text !== undefined) parts.push(extractMinecraftText(value.text, seen));
    if (value.translate !== undefined) parts.push(extractMinecraftText(value.translate, seen));
    if (value.with !== undefined) parts.push(extractMinecraftText(value.with, seen));
    if (value.extra !== undefined) parts.push(extractMinecraftText(value.extra, seen));
    if (parts.some(Boolean)) return parts.filter(Boolean).join(' ');

    return Object.entries(value)
        .filter(([key]) => !['type', 'name', 'color', 'bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'].includes(key))
        .map(([, entry]) => extractMinecraftText(entry, seen))
        .filter(Boolean)
        .join(' ');
}

function menuTitle(window) {
    return extractMinecraftText(window?.title).replace(/\s+/g, ' ').trim();
}

function menuTitleDiagnostic(window) {
    const parsed = menuTitle(window);
    if (parsed) return parsed;
    try { return JSON.stringify(window?.title).slice(0, 300); } catch (error) { return 'unreadable title data'; }
}

function itemSearchText(item) {
    if (!item) return '';
    const parts = [
        item.name,
        item.displayName,
        extractMinecraftText(item.customName),
        extractMinecraftText(item.customLore)
    ];
    try { parts.push(JSON.stringify(item.components || item.nbt || {})); } catch (error) {}
    return parts.filter(Boolean).join(' ').toLowerCase();
}

function findMenuSlot(window, matcher) {
    if (!window?.slots) return -1;
    const menuEnd = Number.isInteger(window.inventoryStart)
        ? window.inventoryStart
        : Math.max(0, window.slots.length - 36);

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
    const controlStart = window.inventoryStart - 9;
    for (let slot = controlStart; slot < window.inventoryStart; slot++) {
        const item = window.slots[slot];
        if (!item) continue;
        const text = itemSearchText(item);
        if (text.includes('sell all') || text.includes('click to sell') || item.name === 'gold_ingot') return slot;
    }
    return -1;
}

function inspectSpawnerLoot(window) {
    if (!Number.isInteger(window?.inventoryStart) || window.inventoryStart < 18) {
        throw new Error('Safety stop: the detailed loot grid could not be identified.');
    }

    const lootEnd = window.inventoryStart - 9;
    const lootItems = window.slots.slice(0, lootEnd).filter(Boolean);
    const hasArrows = lootItems.some(item =>
        item.name === 'arrow' || item.name === 'spectral_arrow' ||
        item.name === 'tipped_arrow' || item.name.endsWith('_arrow') ||
        /\barrows?\b/.test(itemSearchText(item)));
    const boneStacks = lootItems.filter(item =>
        item.name === 'bone' || /\bbones?\b/.test(itemSearchText(item))).length;
    return { hasArrows, hasBones: boneStacks > 0, boneStacks };
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
    const currentTitle = menuTitle(bot.currentWindow).toLowerCase();
    if (currentTitle.includes('skeleton spawner')) return bot.currentWindow;
    await closeCurrentWindow(bot);

    const positions = bot.findBlocks({
        matching: block => block && ['spawner', 'monster_spawner'].includes(block.name),
        maxDistance: 6,
        count: 64
    });
    if (!positions.length) throw new Error('No spawner is within 6 blocks of the bot.');

    positions.sort((left, right) =>
        bot.entity.position.distanceSquared(left) - bot.entity.position.distanceSquared(right));

    const detectedTitles = [];
    for (const position of positions) {
        const spawner = bot.blockAt(position);
        if (!spawner) continue;
        try {
            await closeCurrentWindow(bot);
            await bot.activateBlock(spawner);
            const window = await waitUntil(() => bot.currentWindow, 2500);
            if (!window) continue;

            const title = menuTitleDiagnostic(window) || 'unknown';
            detectedTitles.push(title);
            if (title.toLowerCase().includes('skeleton spawner')) return window;
        } catch (error) {}
    }

    await closeCurrentWindow(bot);
    const found = [...new Set(detectedTitles)].slice(0, 4).join(', ') || 'no responsive spawner menus';
    throw new Error(`No reachable Skeleton spawner found. Server menus detected: ${found}`);
}

async function openSkeletonLootMenu(bot) {
    let window = await openSkeletonOverview(bot);
    if (findDropLootSlot(window, false) >= 0 || window.inventoryStart >= 45) return window;

    let storageSlot = findMenuSlot(window, (text, item) =>
        item.name === 'chest' || text.includes('spawner storage'));
    const overviewCenter = Number.isInteger(window.inventoryStart) && window.inventoryStart < 45
        ? Math.floor(window.inventoryStart / 2)
        : -1;
    if (storageSlot < 0 && overviewCenter >= 0 && window.slots[overviewCenter]) storageSlot = overviewCenter;
    if (storageSlot < 0) throw new Error('Spawner Storage button was not found in the Skeleton overview.');

    await bot.clickWindow(storageSlot, 0, 0);
    window = await waitUntil(() => {
        const candidate = bot.currentWindow;
        if (!menuTitle(candidate).toLowerCase().includes('skeleton spawner')) return null;
        return candidate.inventoryStart >= 45 || findDropLootSlot(candidate, false) >= 0 ? candidate : null;
    }, 4000);
    if (!window) throw new Error('Spawner Storage did not open the detailed Skeleton loot view.');
    return window;
}

async function runBoneDropCycle(bot) {
    if (!bot?.entity || !bot.isAlive) throw new Error('The Minecraft bot is not spawned and alive.');
    if (bot.boneDropBusy) throw new Error('A bone drop is already in progress.');

    bot.boneDropBusy = true;
    try {
        let dropActions = 0;
        await openSkeletonLootMenu(bot);

        while (true) {
            await new Promise(resolve => setTimeout(resolve, 250));
            const window = bot.currentWindow;
            if (!window || !menuTitle(window).toLowerCase().includes('skeleton spawner')) {
                throw new Error('Safety stop: the Skeleton loot menu changed before an action.');
            }

            const loot = inspectSpawnerLoot(window);
            if (loot.hasArrows) {
                const sellAllSlot = findSellAllSlot(window);
                if (sellAllSlot < 0) throw new Error('Arrows are visible, but the Sell All button was not found.');
                await bot.clickWindow(sellAllSlot, 0, 0);
                await new Promise(resolve => setTimeout(resolve, 350));
                await closeCurrentWindow(bot);
                return { dropActions, soldAll: true };
            }

            if (!loot.hasBones) {
                // The server refreshes this menu automatically. Keep it open and
                // wait for the next loot page instead of closing and reopening it.
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }

            const dropSlot = findDropLootSlot(window);
            if (dropSlot < 0) throw new Error('The Drop Loot button was not found.');
            await bot.clickWindow(dropSlot, 0, 0);
            dropActions++;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } finally {
        bot.boneDropBusy = false;
    }
}

function reportBoneDropProblem(session, error) {
    const errorMessage = error?.message || String(error);
    const now = Date.now();
    ensureSessionMetrics(session).boneDropFailures++;
    saveSessions();
    if (session.lastBoneDropError === errorMessage && now - (session.lastBoneDropErrorAt || 0) < 300000) return;
    session.lastBoneDropError = errorMessage;
    session.lastBoneDropErrorAt = now;
    session.discordChannel.send(`🦴 Bone Drop paused for this cycle: \`${errorMessage}\``).catch(() => {});
}

function startBoneDropMacro(bot, session) {
    if (bot.boneDropInterval) clearInterval(bot.boneDropInterval);
    session.boneDropEnabled = true;
    session.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(session.boneDropIntervalSeconds);
    bot.boneDropInterval = setInterval(async () => {
        if (session.stopped || session.bot !== bot) return;
        try {
            const result = await runBoneDropCycle(bot);
            recordBoneDropResult(session, result);
            session.lastBoneDropError = null;
            if (result.soldAll) {
                session.discordChannel.send(`🏹 Arrows detected after **${result.dropActions}** Drop Loot click(s). Clicked **Sell All** once.`).catch(() => {});
            }
        } catch (error) {
            reportBoneDropProblem(session, error);
        }
    }, session.boneDropIntervalSeconds * 1000);
}

// ==========================================
// 1. Session Persistence & Utilities
// ==========================================

function saveSessions() {
    const dataToSave = {};
    for (const [channelId, session] of botSessions.entries()) {
        dataToSave[channelId] = {
            source: session.source || 'discord',
            username: session.username,
            server_ip: session.server_ip,
            password: session.password,
            authType: session.authType,
            version: normalizeVersion(session.version),
            proxy: normalizeProxy(session.proxy),
            emergencyStopped: Boolean(session.emergencyStopped),
            metrics: ensureSessionMetrics(session),
            analytics: ensureSessionAnalytics(session),
            boneDropEnabled: Boolean(session.boneDropEnabled),
            boneDropIntervalSeconds: normalizeBoneDropIntervalSeconds(session.boneDropIntervalSeconds),
            schedule: normalizeSchedule(session.schedule)
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
                const source = s.source === 'dashboard' || channelId.startsWith('web-') ? 'dashboard' : 'discord';
                const discordChannel = source === 'discord'
                    ? await discordClient.channels.fetch(channelId)
                    : null;
                
                botSessions.set(channelId, {
                    source,
                    username: s.username,
                    server_ip: s.server_ip,
                    password: s.password,
                    authType: s.authType,
                    version: normalizeVersion(s.version),
                    proxy: normalizeProxy(s.proxy || (s.proxy_host ? {
                        host: s.proxy_host,
                        port: s.proxy_port
                    } : null)),
                    metrics: normalizeSessionMetrics(s.metrics),
                    analytics: normalizeAnalytics(s.analytics),
                    boneDropEnabled: Boolean(s.boneDropEnabled),
                    boneDropIntervalSeconds: normalizeBoneDropIntervalSeconds(s.boneDropIntervalSeconds),
                    schedule: normalizeSchedule(s.schedule),
                    discordChannel: createSessionChannel(channelId, discordChannel),
                    stopped: Boolean(s.emergencyStopped),
                    bot: null,
                    reconnectTimer: null,
                    lastBoneDropError: null,
                    lastBoneDropErrorAt: 0,
                    schedulePaused: false,
                    highPingHits: 0,
                    lastHighPingReconnectAt: 0,
                    emergencyStopped: Boolean(s.emergencyStopped)
                });
                
                const restoredSession = botSessions.get(channelId);
                const restoredClock = scheduleClock(restoredSession.schedule.timezone);
                if (restoredSession.emergencyStopped) {
                    addDashboardLog(channelId, `${restoredSession.username} remains stopped by Emergency Stop.`);
                } else if (scheduleShouldPause(restoredSession.schedule, restoredClock)) {
                    restoredSession.schedulePaused = true;
                    restoredSession.stopped = true;
                    addDashboardLog(channelId, `Scheduler kept ${restoredSession.username} paused after restart.`);
                } else {
                    spawnDynamicBot(channelId);
                }
                loadedCount++;
            } catch (err) {
                console.log(`[Auto-Spawn] Saved session for ${s.username} could not be restored. Removing it from database.`);
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

    const { host, port } = parseServerAddress(session.server_ip);

    const botOptions = {
        host,
        port,
        username: session.username,
        auth: session.authType,
        hideErrors: true,
        viewDistance: 2
    };
    const requestedVersion = normalizeVersion(session.version);
    if (requestedVersion !== 'auto') botOptions.version = requestedVersion;

    const proxy = normalizeProxy(session.proxy);
    if (proxy) {
        botOptions.connect = client => {
            SocksClient.createConnection({
                proxy: {
                    host: proxy.host,
                    port: proxy.port,
                    type: 5,
                    userId: proxy.username || undefined,
                    password: proxy.password || undefined
                },
                command: 'connect',
                destination: { host, port }
            }).then(info => {
                client.setSocket(info.socket);
                client.emit('connect');
            }).catch(error => {
                addDashboardLog(channelId, `Proxy connection failed: ${error.message}`);
                client.emit('error', error);
                client.emit('end');
            });
        };
        addDashboardLog(channelId, `Connecting through SOCKS5 proxy ${proxy.host}:${proxy.port}.`);
    }

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
    bot.scheduleSellInterval = null;
    bot.autoEatInterval = null; 
    bot.boneDropInterval = null;
    bot.boneDropBusy = false;

    // --- Minecraft Events ---

    bot.on('spawn', () => {
        const botName = bot.username;
        if (!bot.customPassword || session.authType === 'microsoft') bot.isAuthenticated = true;
        const metrics = ensureSessionMetrics(session);
        metrics.connections++;
        metrics.lastOnlineAt = new Date().toISOString();
        bot.onlineSince = Date.now();
        saveSessions();
        broadcastDashboardEvent('status', { sessionId: channelId, state: 'online' });
        session.detectedVersion = bot.version || requestedVersion;
        session.discordChannel.send(`✅ **${botName}** spawned using Minecraft **${session.detectedVersion || 'auto'}**.`).catch(() => {});
        
        if (bot.afkInterval) clearInterval(bot.afkInterval);

        // Turn off heavy physics calculations immediately to save CPU
        bot.physicsEnabled = false;

        // FatalMC-specific routing is kept only for FatalMC accounts. Other
        // cracked servers are not sent a network-specific command.
        if (/fatalmc/i.test(host)) bot.lifestealTimer = setTimeout(() => {
            if (session.stopped || session.bot !== bot || !bot.isAuthenticated) return;

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
            session.discordChannel.send(`🦴 Bone Drop restored with a **${session.boneDropIntervalSeconds}-second** cooldown.`).catch(() => {});
        }
    });

    bot.on('message', (jsonMsg, position) => {
        const message = jsonMsg.toString();
        
        if (!message || message.trim() === '') return;
        if (position === 'game_info') return;

        const lowerMsg = message.toLowerCase();
        session.discordChannel.send(`💬 ${message}`).catch(() => {});
        recordEconomyMessage(session, message);

        // Common cracked-server authentication prompts (AuthMe and similar).
        if (bot.customPassword && !bot.isAuthenticated && !bot.authSent) {
            const authAction = detectCrackedAuthAction(message);
            if (authAction === 'register') {
                bot.authSent = true;
                try { bot.chat(`/register ${bot.customPassword} ${bot.customPassword}`); } catch(e) {}
            } else if (authAction === 'login') {
                bot.authSent = true;
                try { bot.chat(`/login ${bot.customPassword}`); } catch(e) {}
            }
            if (bot.authSent) {
                setTimeout(() => {
                    if (session.bot === bot && !bot.isAuthenticated) bot.authSent = false;
                }, 7000);
            }
        }

        if (bot.customPassword && !bot.isAuthenticated && isCrackedAuthSuccess(message)) {
            
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
        ensureSessionMetrics(session).deaths++;
        saveSessions();
        const msg = `💀 **${botName}** died!`;
        session.discordChannel.send(msg).catch(() => {});
        logToCentral(msg);
    });

    bot.on('error', (err) => {
        const botName = bot.username || session.username;
        let errDesc = err.message;
        const msg = `🚨 **${botName}** encountered an error: \`${errDesc}\``;
        addDashboardLog(channelId, msg);
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
        ensureSessionMetrics(session).disconnects++;
        saveSessions();
        broadcastDashboardEvent('status', { sessionId: channelId, state: 'reconnecting' });
        session.discordChannel.send(`🔌 **${botName}** disconnected.`).catch(() => {});
        
        // --- Aggressive Memory Leak Cleanup ---
        if (bot.afkInterval) clearInterval(bot.afkInterval);
        if (bot.lifestealTimer) clearTimeout(bot.lifestealTimer);
        if (bot.sellInterval) clearInterval(bot.sellInterval);
        if (bot.scheduleSellInterval) clearInterval(bot.scheduleSellInterval);
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

function pauseSessionForSchedule(sessionId, session, reason) {
    if (session.schedulePaused && session.stopped) return;
    session.schedulePaused = true;
    session.stopped = true;
    session.highPingHits = 0;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    clearManagedBotTimers(session.bot);
    if (session.bot) {
        try { session.bot.quit(); } catch (error) {}
    }
    addDashboardLog(sessionId, `Scheduler paused ${session.username}: ${reason}.`);
    broadcastDashboardEvent('status', { sessionId, state: 'paused' });
}

function resumeSessionFromSchedule(sessionId, session) {
    if (!session.schedulePaused) return;
    session.schedulePaused = false;
    session.stopped = false;
    addDashboardLog(sessionId, `Scheduler resumed ${session.username}.`);
    if (!session.bot) spawnDynamicBot(sessionId);
    broadcastDashboardEvent('status', { sessionId, state: 'connecting' });
}

function updateScheduledSell(sessionId, session, clock) {
    const bot = session.bot;
    if (!bot) return;
    const schedule = session.schedule;
    const shouldRun = schedule.enabled && schedule.sellWindowEnabled &&
        isRecurringWindowActive(clock, schedule.days, schedule.sellStartTime, schedule.sellStopTime);

    if (shouldRun && !bot.scheduleSellInterval) {
        const sell = () => {
            if (bot?.entity && bot.isAlive && session.bot === bot && !session.schedulePaused) {
                try { bot.chat('/sell all'); } catch (error) {}
            }
        };
        sell();
        bot.scheduleSellInterval = setInterval(sell, schedule.sellIntervalSeconds * 1000);
        addDashboardLog(sessionId, `Scheduler enabled Sell Macro every ${schedule.sellIntervalSeconds} seconds.`);
    } else if (!shouldRun && bot.scheduleSellInterval) {
        clearInterval(bot.scheduleSellInterval);
        bot.scheduleSellInterval = null;
        addDashboardLog(sessionId, 'Scheduler disabled Sell Macro outside its configured window.');
    }
}

function evaluateSessionSchedule(sessionId, session, now = new Date()) {
    session.schedule = normalizeSchedule(session.schedule);
    const schedule = session.schedule;
    const clock = scheduleClock(schedule.timezone, now);

    if (session.emergencyStopped) return;

    if (!schedule.enabled) {
        if (session.schedulePaused) resumeSessionFromSchedule(sessionId, session);
        if (session.bot?.scheduleSellInterval) {
            clearInterval(session.bot.scheduleSellInterval);
            session.bot.scheduleSellInterval = null;
        }
        return;
    }

    const inMaintenance = schedule.maintenanceEnabled && isRecurringWindowActive(
        clock, schedule.days, schedule.maintenanceStartTime, schedule.maintenanceStopTime);
    const outsideActiveHours = schedule.activeHoursEnabled && !isRecurringWindowActive(
        clock, schedule.days, schedule.startTime, schedule.stopTime);

    if (inMaintenance || outsideActiveHours) {
        pauseSessionForSchedule(sessionId, session, inMaintenance ? 'maintenance window' : 'outside active hours');
        return;
    }

    if (session.schedulePaused) resumeSessionFromSchedule(sessionId, session);
    if (!session.bot?.entity || !session.bot.isAlive) return;

    updateScheduledSell(sessionId, session, clock);

    if (schedule.boneDropScheduleEnabled && schedule.days.includes(clock.day) &&
        schedule.boneDropTimes.includes(clock.time) && schedule.lastBoneDropRunKey !== `${clock.dateKey}:${clock.time}` &&
        !session.bot.boneDropBusy) {
        schedule.lastBoneDropRunKey = `${clock.dateKey}:${clock.time}`;
        saveSessions();
        addDashboardLog(sessionId, `Scheduler started Bone Drop at ${clock.time}.`);
        runBoneDropCycle(session.bot)
            .then(result => {
                recordBoneDropResult(session, result);
                addDashboardLog(sessionId, `Scheduled Bone Drop finished after ${result.dropActions} Drop Loot click(s).`);
            })
            .catch(error => reportBoneDropProblem(session, error));
    }

    if (schedule.highPingEnabled) {
        const ping = session.bot.player?.ping;
        session.highPingHits = Number.isFinite(ping) && ping > schedule.highPingThreshold
            ? (session.highPingHits || 0) + 1
            : 0;
        if (session.highPingHits >= 3 && Date.now() - (session.lastHighPingReconnectAt || 0) >= 120000) {
            session.highPingHits = 0;
            session.lastHighPingReconnectAt = Date.now();
            addDashboardLog(sessionId, `Ping remained above ${schedule.highPingThreshold} ms. Reconnecting.`);
            try { session.bot.quit(); } catch (error) {}
        }
    } else {
        session.highPingHits = 0;
    }
}

const scheduleEngine = setInterval(() => {
    for (const [sessionId, session] of botSessions.entries()) {
        try { evaluateSessionSchedule(sessionId, session); } catch (error) {
            addDashboardLog(sessionId, `Scheduler error: ${error.message}`);
        }
    }
}, 15000);
scheduleEngine.unref();

let performanceSnapshot = { cpuPercent: 0, memoryMb: Math.round(process.memoryUsage().rss / 1048576) };
let previousCpuUsage = process.cpuUsage();
let previousCpuTime = process.hrtime.bigint();
let analyticsTicks = 0;
const analyticsEngine = setInterval(() => {
    const now = Date.now();
    const currentCpuTime = process.hrtime.bigint();
    const elapsedMicros = Number(currentCpuTime - previousCpuTime) / 1000;
    const cpuDelta = process.cpuUsage(previousCpuUsage);
    const usedMicros = cpuDelta.user + cpuDelta.system;
    performanceSnapshot = {
        cpuPercent: Math.round(Math.min(999, usedMicros / Math.max(1, elapsedMicros) * 100) * 10) / 10,
        memoryMb: Math.round(process.memoryUsage().rss / 1048576)
    };
    previousCpuUsage = process.cpuUsage();
    previousCpuTime = currentCpuTime;

    for (const session of botSessions.values()) {
        const bot = session.bot;
        const samples = ensureSessionAnalytics(session).samples;
        samples.push({
            time: now,
            online: Boolean(bot?.entity && bot.isAlive && !session.stopped),
            ping: Number.isFinite(bot?.player?.ping) ? Math.round(bot.player.ping) : null
        });
        if (samples.length > 10080) samples.splice(0, samples.length - 10080);
    }
    analyticsTicks++;
    if (analyticsTicks % 5 === 0) saveSessions();
    broadcastDashboardEvent('status', { analytics: true });
}, 60000);
analyticsEngine.unref();

// ==========================================
// 3. Discord Bot Logic
// ==========================================

discordClient.once('clientReady', async () => {
    console.log(`Logged in to Discord as ${discordClient.user.tag}`);
    console.log('Use /spawn <username> <ip> <password> <auth> [proxy:port|-] [version|auto] to begin.');
    
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

        if (!username || !server_ip || !password) {
            return message.reply("❌ **Invalid Format.** Use: `/spawn <username> <server_ip> <password> <auth> [proxy:port|-] [version|auto]`").catch(() => {});
        }
        let proxy;
        let version;
        try {
            proxy = normalizeProxy(args[5] && args[5] !== '-' ? args[5] : null);
            version = normalizeVersion(args[6]);
        } catch (error) {
            return message.reply(`❌ **Invalid connection settings:** ${error.message}`).catch(() => {});
        }

        const existingSession = Array.from(botSessions.values()).find(s => s.username.toLowerCase() === username.toLowerCase());
        if (existingSession) {
            return message.reply(`Bot **${username}** is already running in <#${existingSession.discordChannel.id}>.`).catch(() => {});
        }

        const spawnKey = username.toLowerCase();
        if (pendingDiscordSpawns.has(spawnKey)) {
            return message.reply(`Bot **${username}** is already being created. Please wait.`).catch(() => {});
        }
        const expectedChannelName = `bot-${spawnKey}`;
        const existingChannel = message.guild.channels.cache.find(channel =>
            channel.type === ChannelType.GuildText && channel.name === expectedChannelName);
        if (existingChannel) {
            return message.reply(`A channel for **${username}** already exists at <#${existingChannel.id}>. Delete that stale channel before spawning it again.`).catch(() => {});
        }
        pendingDiscordSpawns.add(spawnKey);

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
                name: expectedChannelName,
                type: ChannelType.GuildText,
                parent: category.id, 
                permissionOverwrites: [
                    { id: message.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: message.author.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    { id: discordClient.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }
                ],
            });

            botSessions.set(newChannel.id, {
                source: 'discord',
                username: username,
                server_ip: server_ip,
                password: password === '-' ? '' : password,
                authType: authType,
                version,
                proxy,
                metrics: normalizeSessionMetrics(),
                analytics: normalizeAnalytics(),
                boneDropEnabled: false,
                boneDropIntervalSeconds: DEFAULT_BONE_DROP_INTERVAL_SECONDS,
                schedule: normalizeSchedule(),
                discordChannel: createSessionChannel(newChannel.id, newChannel),
                stopped: false,
                bot: null,
                reconnectTimer: null,
                lastBoneDropError: null,
                lastBoneDropErrorAt: 0,
                schedulePaused: false,
                    highPingHits: 0,
                    lastHighPingReconnectAt: 0,
                    emergencyStopped: false
            });

            saveSessions();
            recordAudit(`discord:${message.author.id}`, 'bot.create', username, {
                server: server_ip,
                authType,
                proxy: publicProxy(proxy).address,
                version
            });
            spawnDynamicBot(newChannel.id);

        } catch (error) {
            console.error(error);
            message.reply("❌ **Error:** Could not create a Discord channel.").catch(() => {});
        } finally {
            pendingDiscordSpawns.delete(spawnKey);
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
                    const source = sessionData.source === 'dashboard' || channelId.startsWith('web-') ? 'dashboard' : 'discord';
                    try {
                        channel = createSessionChannel(
                            channelId,
                            source === 'discord' ? await discordClient.channels.fetch(channelId) : null
                        );
                    } catch (e) { continue; }
                }

                if (!session || !session.bot || session.stopped) {
                    botSessions.set(channelId, {
                        source: sessionData.source === 'dashboard' || channelId.startsWith('web-') ? 'dashboard' : 'discord',
                        username: sessionData.username,
                        server_ip: sessionData.server_ip,
                        password: sessionData.password,
                        authType: sessionData.authType,
                        version: normalizeVersion(sessionData.version),
                        proxy: normalizeProxy(sessionData.proxy),
                        emergencyStopped: Boolean(sessionData.emergencyStopped),
                        metrics: normalizeSessionMetrics(sessionData.metrics),
                        analytics: normalizeAnalytics(sessionData.analytics),
                        boneDropEnabled: Boolean(sessionData.boneDropEnabled),
                        boneDropIntervalSeconds: normalizeBoneDropIntervalSeconds(sessionData.boneDropIntervalSeconds),
                        schedule: normalizeSchedule(sessionData.schedule),
                        discordChannel: channel,
                        stopped: Boolean(sessionData.emergencyStopped),
                        bot: null,
                        reconnectTimer: null,
                        lastBoneDropError: null,
                        lastBoneDropErrorAt: 0,
                        schedulePaused: false,
                        highPingHits: 0,
                        lastHighPingReconnectAt: 0
                    });
                    const restoredSession = botSessions.get(channelId);
                    const restoredClock = scheduleClock(restoredSession.schedule.timezone);
                    if (restoredSession.emergencyStopped) {
                        addDashboardLog(channelId, `${restoredSession.username} remains stopped by Emergency Stop.`);
                    } else if (scheduleShouldPause(restoredSession.schedule, restoredClock)) {
                        restoredSession.schedulePaused = true;
                        restoredSession.stopped = true;
                    } else {
                        spawnDynamicBot(channelId);
                        spawnedCount++;
                    }
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
        recordAudit(`discord:${message.author.id}`, 'fleet.stop-delete', 'all bots');
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
            recordAudit(`discord:${message.author.id}`, 'bot.remove', session.username);
            
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
        const discordActor = `discord:${message.author.id}`;
        if (/^!(?:bonedrop|sellmacro|autoeat)\b/i.test(content.trim())) {
            recordAudit(discordActor, 'bot.discord-command', currentSession.username, {
                command: content.trim().slice(0, 80)
            });
        }

        const boneDropOnMatch = content.trim().match(/^!bonedrop\s+on(?:\s+(\d+))?$/i);
        if (boneDropOnMatch) {
            try {
                currentSession.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(
                    boneDropOnMatch[1] || currentSession.boneDropIntervalSeconds
                );
            } catch (error) {
                return message.reply(`❌ ${error.message}`).catch(() => {});
            }

            startBoneDropMacro(activeBot, currentSession);
            saveSessions();
            return message.reply(`🦴 **Bone Drop enabled.** Cooldown: **${currentSession.boneDropIntervalSeconds} seconds**. It repeats Drop Loot until bones are gone and clicks Sell All once if arrows appear.`).catch(() => {});
        }

        if (content.toLowerCase() === '!bonedrop off') {
            currentSession.boneDropEnabled = false;
            if (activeBot.boneDropInterval) {
                clearInterval(activeBot.boneDropInterval);
                activeBot.boneDropInterval = null;
            }
            saveSessions();
            return message.reply('🛑 **Bone Drop disabled.**').catch(() => {});
        }

        const boneDropCooldownMatch = content.trim().match(/^!bonedrop\s+(?:cooldown|interval)\s+(\d+)$/i);
        if (boneDropCooldownMatch) {
            try {
                currentSession.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(boneDropCooldownMatch[1]);
                if (currentSession.boneDropEnabled) startBoneDropMacro(activeBot, currentSession);
                saveSessions();
                return message.reply(`⏱️ Bone Drop cooldown set to **${currentSession.boneDropIntervalSeconds} seconds**.`).catch(() => {});
            } catch (error) {
                return message.reply(`❌ ${error.message}`).catch(() => {});
            }
        }

        if (content.toLowerCase() === '!bonedrop status') {
            const status = currentSession.boneDropEnabled && activeBot.boneDropInterval ? 'running' : 'stopped';
            const seconds = normalizeBoneDropIntervalSeconds(currentSession.boneDropIntervalSeconds);
            return message.reply(`🦴 Bone Drop is **${status}**. Cooldown: **${seconds} seconds**.`).catch(() => {});
        }

        if (content.toLowerCase() === '!bonedrop now') {
            try {
                const result = await runBoneDropCycle(activeBot);
                recordBoneDropResult(currentSession, result);
                if (result.soldAll) {
                    return message.reply(`🏹 Arrows detected after **${result.dropActions}** Drop Loot click(s). Clicked **Sell All** once.`).catch(() => {});
                }
                if (result.dropActions === 0) {
                    return message.reply('🦴 No bones or arrows were available in the spawner storage.').catch(() => {});
                }
                return message.reply(`🦴 Cleared the available bones using **${result.dropActions}** Drop Loot click(s).`).catch(() => {});
            } catch (error) {
                ensureSessionMetrics(currentSession).boneDropFailures++;
                saveSessions();
                return message.reply(`❌ Bone Drop failed: \`${error.message}\``).catch(() => {});
            }
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

// ==========================================
// 4. Web Dashboard
// ==========================================

function safeStringEqual(left, right) {
    const received = crypto.createHash('sha256').update(String(left || '')).digest();
    const expected = crypto.createHash('sha256').update(String(right || '')).digest();
    return crypto.timingSafeEqual(received, expected);
}

function authenticateDashboardUser(username, password) {
    const requested = String(username || 'admin').trim().toLowerCase();
    const user = dashboardUsers.get(requested);
    return user && safeStringEqual(password, user.password)
        ? { username: user.username, role: user.role }
        : null;
}

function dashboardSessionToken(user) {
    const payload = Buffer.from(JSON.stringify({
        username: user.username,
        role: user.role,
        expiresAt: Date.now() + DASHBOARD_SESSION_HOURS * 3600000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', dashboardCookieSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

function dashboardRequestUser(request) {
    const cookies = Object.fromEntries(
        String(request.headers.cookie || '')
            .split(';')
            .map(part => part.trim().split('='))
            .filter(parts => parts.length === 2)
    );
    const [payload, signature] = String(cookies.dashboard_session || '').split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', dashboardCookieSecret).update(payload).digest('base64url');
    const receivedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        const configured = dashboardUsers.get(parsed.username);
        if (!configured || configured.role !== parsed.role || parsed.expiresAt <= Date.now()) return null;
        return { username: configured.username, role: configured.role, expiresAt: parsed.expiresAt };
    } catch (error) {
        return null;
    }
}

function requireDashboardAdmin(user) {
    if (user?.role !== 'admin') throw new Error('Administrator access is required for this action.');
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        ...extraHeaders
    });
    response.end(body);
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.on('data', chunk => {
            body += chunk;
            if (body.length > 65536) reject(new Error('Request is too large.'));
        });
        request.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (error) { reject(new Error('Invalid JSON request.')); }
        });
        request.on('error', reject);
    });
}

function dashboardInventory(bot) {
    if (!bot?.inventory) return [];
    try {
        const grouped = new Map();
        for (const item of bot.inventory.items()) {
            const key = item.name || item.displayName || 'unknown';
            const current = grouped.get(key) || {
                name: key,
                displayName: item.displayName || key.replace(/_/g, ' '),
                count: 0
            };
            current.count += item.count || 0;
            grouped.set(key, current);
        }
        return Array.from(grouped.values()).sort((left, right) => right.count - left.count);
    } catch (error) {
        return [];
    }
}

function dashboardBotSummary(id, session) {
    const bot = session.bot;
    const spawned = Boolean(bot?.entity);
    const position = bot?.entity?.position;
    let state = 'reconnecting';
    if (session.emergencyStopped) state = 'emergency';
    else if (session.schedulePaused) state = 'paused';
    else if (session.stopped) state = 'stopped';
    else if (spawned) state = 'online';
    else if (bot) state = 'connecting';
    const metrics = ensureSessionMetrics(session);
    const analytics = ensureSessionAnalytics(session);
    const boneDropTotal = metrics.boneDropSuccesses + metrics.boneDropFailures + metrics.boneDropEmpty;

    return {
        id,
        source: session.source || 'discord',
        username: session.username,
        server: session.server_ip,
        authType: session.authType,
        version: {
            requested: normalizeVersion(session.version),
            detected: session.detectedVersion || bot?.version || null
        },
        proxy: publicProxy(session.proxy),
        state,
        health: Number.isFinite(bot?.health) ? Math.round(bot.health * 10) / 10 : null,
        food: Number.isFinite(bot?.food) ? bot.food : null,
        ping: Number.isFinite(bot?.player?.ping) ? bot.player.ping : null,
        onlineSeconds: bot?.onlineSince ? Math.max(0, Math.floor((Date.now() - bot.onlineSince) / 1000)) : 0,
        position: position ? {
            x: Math.round(position.x * 10) / 10,
            y: Math.round(position.y * 10) / 10,
            z: Math.round(position.z * 10) / 10
        } : null,
        macros: {
            boneDrop: Boolean(session.boneDropEnabled && bot?.boneDropInterval),
            boneDropBusy: Boolean(bot?.boneDropBusy),
            boneDropCooldown: normalizeBoneDropIntervalSeconds(session.boneDropIntervalSeconds),
            sell: Boolean(bot?.sellInterval || bot?.scheduleSellInterval),
            autoEat: Boolean(bot?.autoEatInterval)
        },
        metrics,
        statistics: {
            uptimeDay: availabilityPercentage(session, 24),
            uptimeWeek: availabilityPercentage(session, 168),
            boneDropSuccessRate: boneDropTotal ? Math.round(metrics.boneDropSuccesses / boneDropTotal * 1000) / 10 : null,
            estimatedEarnings: Math.round(metrics.estimatedEarnings * 100) / 100,
            pingHistory: analytics.samples.filter(sample => Number.isFinite(sample.ping)).slice(-120)
        },
        inventory: dashboardInventory(bot),
        schedule: normalizeSchedule(session.schedule),
        nextScheduledAction: nextScheduledAction(normalizeSchedule(session.schedule)),
        logs: dashboardLogs.get(id) || []
    };
}

function createDashboardBot(payload) {
    const username = String(payload.username || '').trim();
    const server_ip = String(payload.server || '').trim();
    const password = String(payload.password || '').trim();
    const authType = String(payload.authType || 'offline').toLowerCase();
    const version = normalizeVersion(payload.version);
    const hasProxyDetails = ['proxyHost', 'proxyPort', 'proxyUsername', 'proxyPassword']
        .some(key => String(payload[key] || '').trim());
    if (hasProxyDetails && (!String(payload.proxyHost || '').trim() || !String(payload.proxyPort || '').trim())) {
        throw new Error('Enter both the SOCKS5 proxy host and port.');
    }
    const proxy = normalizeProxy(payload.proxy || (payload.proxyHost ? {
        host: payload.proxyHost,
        port: payload.proxyPort,
        username: payload.proxyUsername,
        password: payload.proxyPassword
    } : null));

    if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
        throw new Error('Minecraft username must be 1-16 letters, numbers, or underscores.');
    }
    if (!server_ip || server_ip.length > 255 || /\s/.test(server_ip)) {
        throw new Error('Enter a valid Minecraft server address.');
    }
    if (!['offline', 'microsoft'].includes(authType)) {
        throw new Error('Authentication must be offline or microsoft.');
    }
    const existing = Array.from(botSessions.values()).find(session =>
        session.username.toLowerCase() === username.toLowerCase());
    if (existing) throw new Error(`${username} is already managed.`);

    const id = `web-${username.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
    botSessions.set(id, {
        source: 'dashboard',
        username,
        server_ip,
        password: password === '-' ? '' : password,
        authType,
        version,
        proxy,
        metrics: normalizeSessionMetrics(),
        analytics: normalizeAnalytics(),
        boneDropEnabled: false,
        boneDropIntervalSeconds: DEFAULT_BONE_DROP_INTERVAL_SECONDS,
        schedule: normalizeSchedule(),
        discordChannel: createSessionChannel(id),
        stopped: false,
        bot: null,
        reconnectTimer: null,
        lastBoneDropError: null,
        lastBoneDropErrorAt: 0,
        schedulePaused: false,
        highPingHits: 0,
        lastHighPingReconnectAt: 0,
        emergencyStopped: false
    });
    addDashboardLog(id, `Dashboard created ${username} for ${server_ip}.`);
    saveSessions();
    spawnDynamicBot(id);
    return dashboardBotSummary(id, botSessions.get(id));
}

function clearManagedBotTimers(bot) {
    if (!bot) return;
    if (bot.afkInterval) clearInterval(bot.afkInterval);
    if (bot.lifestealTimer) clearTimeout(bot.lifestealTimer);
    if (bot.sellInterval) clearInterval(bot.sellInterval);
    if (bot.scheduleSellInterval) clearInterval(bot.scheduleSellInterval);
    if (bot.autoEatInterval) clearInterval(bot.autoEatInterval);
    if (bot.boneDropInterval) clearInterval(bot.boneDropInterval);
}

function removeManagedBot(id) {
    const session = botSessions.get(id);
    if (!session) throw new Error('Bot session was not found.');
    session.stopped = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    clearManagedBotTimers(session.bot);
    if (session.bot) {
        try { session.bot.quit(); } catch (error) {}
    }
    session.bot = null;
    botSessions.delete(id);
    saveSessions();
    if (session.source === 'discord') {
        setTimeout(() => session.discordChannel.delete().catch(() => {}), 1000);
    }
}

function startAutoEat(bot) {
    if (bot.autoEatInterval) clearInterval(bot.autoEatInterval);
    bot.autoEatInterval = setInterval(async () => {
        if (!bot?.entity || !bot.isAlive || bot.food >= 16) return;
        const foodList = ['golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'baked_potato', 'bread', 'apple', 'carrot', 'sweet_berries', 'glow_berries', 'melon_slice'];
        const foodItem = bot.inventory.items().find(item => foodList.includes(item.name));
        if (!foodItem) return;
        try {
            await bot.equip(foodItem, 'hand');
            await bot.consume();
        } catch (error) {}
    }, 5000);
}

async function runDashboardAction(id, payload) {
    const session = botSessions.get(id);
    if (!session) throw new Error('Bot session was not found.');
    const action = String(payload.action || '').toLowerCase();
    const bot = session.bot;

    if (action === 'stop') {
        session.stopped = true;
        session.emergencyStopped = false;
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
        clearManagedBotTimers(bot);
        if (bot) {
            try { bot.quit(); } catch (error) {}
        }
        return { message: `${session.username} was stopped without deleting its saved account.` };
    }

    if (action === 'remove') {
        removeManagedBot(id);
        return { message: `${session.username} was removed.` };
    }

    if (action === 'reconnect') {
        if (session.schedulePaused) {
            throw new Error('This bot is paused by its schedule. Change or disable the schedule first.');
        }
        session.emergencyStopped = false;
        session.stopped = false;
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        if (bot) {
            try { bot.quit(); } catch (error) {}
        } else {
            spawnDynamicBot(id);
        }
        return { message: `${session.username} is reconnecting.` };
    }

    if (action === 'schedule-save') {
        session.schedule = normalizeSchedule(payload.schedule);
        saveSessions();
        evaluateSessionSchedule(id, session);
        const next = nextScheduledAction(session.schedule);
        return {
            message: session.schedule.enabled
                ? `Schedule saved.${next ? ` Next: ${next.label} ${next.when}.` : ''}`
                : 'Schedule disabled.'
        };
    }

    if (action === 'connection-save') {
        session.version = normalizeVersion(payload.version);
        if (payload.proxyEnabled) {
            const existingProxy = normalizeProxy(session.proxy);
            session.proxy = normalizeProxy({
                host: payload.proxyHost,
                port: payload.proxyPort,
                username: payload.proxyUsername,
                password: String(payload.proxyPassword || '') || existingProxy?.password || ''
            });
        } else {
            session.proxy = null;
        }
        saveSessions();
        const reconnectNow = payload.reconnect !== false && !session.schedulePaused && !session.emergencyStopped;
        if (reconnectNow) {
            session.stopped = false;
            if (bot) {
                try { bot.quit(); } catch (error) {}
            } else {
                spawnDynamicBot(id);
            }
        }
        return { message: `Connection settings saved${reconnectNow ? ' and reconnecting.' : '. They will apply on the next connection.'}` };
    }

    if (!bot) throw new Error('The bot is currently disconnected. Try reconnecting it first.');

    if (action === 'send') {
        const text = String(payload.text || '').trim();
        if (!text || text.length > 256) throw new Error('Enter a command or chat message up to 256 characters.');
        if (!bot.entity) throw new Error('The bot has not finished connecting yet.');
        bot.chat(text);
        const safeText = /^\/(?:login|register|reg)\s+/i.test(text)
            ? `${text.split(/\s+/)[0]} [password hidden]`
            : text;
        addDashboardLog(id, `You sent: ${safeText}`);
        return { message: 'Message sent.' };
    }

    if (action === 'bonedrop-on') {
        session.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(payload.seconds || session.boneDropIntervalSeconds);
        startBoneDropMacro(bot, session);
        saveSessions();
        return { message: `Bone Drop enabled every ${session.boneDropIntervalSeconds} seconds.` };
    }
    if (action === 'bonedrop-off') {
        session.boneDropEnabled = false;
        if (bot.boneDropInterval) clearInterval(bot.boneDropInterval);
        bot.boneDropInterval = null;
        saveSessions();
        return { message: 'Bone Drop disabled.' };
    }
    if (action === 'bonedrop-now') {
        if (bot.boneDropBusy) throw new Error('A Bone Drop cycle is already running.');
        runBoneDropCycle(bot)
            .then(result => {
                recordBoneDropResult(session, result);
                addDashboardLog(id, `Bone Drop finished after ${result.dropActions} Drop Loot click(s).`);
            })
            .catch(error => reportBoneDropProblem(session, error));
        return { message: 'Bone Drop started. Watch the activity log for the result.' };
    }
    if (action === 'sell-on') {
        const seconds = Number.parseInt(payload.seconds || '30', 10);
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('Sell interval must be 1-86400 seconds.');
        if (bot.sellInterval) clearInterval(bot.sellInterval);
        if (bot.entity && bot.isAlive) bot.chat('/sell all');
        bot.sellInterval = setInterval(() => {
            if (bot?.entity && bot.isAlive) bot.chat('/sell all');
        }, seconds * 1000);
        return { message: `Sell Macro enabled every ${seconds} seconds.` };
    }
    if (action === 'sell-off') {
        if (bot.sellInterval) clearInterval(bot.sellInterval);
        bot.sellInterval = null;
        return { message: 'Sell Macro disabled.' };
    }
    if (action === 'autoeat-on') {
        startAutoEat(bot);
        return { message: 'Auto-Eat enabled.' };
    }
    if (action === 'autoeat-off') {
        if (bot.autoEatInterval) clearInterval(bot.autoEatInterval);
        bot.autoEatInterval = null;
        return { message: 'Auto-Eat disabled.' };
    }

    throw new Error('Unknown dashboard action.');
}

async function executeDashboardAction(id, payload, actor = null) {
    const targetName = botSessions.get(id)?.username || id;
    const result = await runDashboardAction(id, payload);
    const session = botSessions.get(id);
    if (session) {
        ensureSessionMetrics(session).dashboardActions++;
        if (payload.action !== 'send') addDashboardLog(id, `Dashboard: ${result.message}`);
        saveSessions();
    }
    if (actor) recordAudit(actor, `bot.${String(payload.action || 'unknown')}`, targetName, {
        seconds: payload.seconds == null ? null : Number(payload.seconds),
        scheduleEnabled: payload.action === 'schedule-save' ? Boolean(payload.schedule?.enabled) : null
    });
    broadcastDashboardEvent('status', { sessionId: id });
    return result;
}

async function runFleetAction(payload, actor = null) {
    const ids = Array.isArray(payload.ids) ? [...new Set(payload.ids.map(String))] : [];
    if (!ids.length || ids.length > 100) throw new Error('Select between 1 and 100 bots.');
    const allowed = new Set(['stop', 'reconnect', 'bonedrop-on', 'bonedrop-off', 'sell-on', 'sell-off', 'autoeat-on', 'autoeat-off']);
    if (!allowed.has(payload.action)) throw new Error('That action is not available for bulk control.');

    const results = await Promise.all(ids.map(async id => {
        try {
            const result = await executeDashboardAction(id, payload);
            return { id, ok: true, message: result.message };
        } catch (error) {
            return { id, ok: false, message: error.message };
        }
    }));
    const succeeded = results.filter(result => result.ok).length;
    if (actor) recordAudit(actor, `fleet.${payload.action}`, `${ids.length} bot(s)`, { succeeded });
    return { message: `Completed for ${succeeded} of ${results.length} selected bots.`, results };
}

function emergencyStopAll(actor) {
    let stopped = 0;
    for (const [id, session] of botSessions.entries()) {
        session.emergencyStopped = true;
        session.stopped = true;
        session.schedulePaused = false;
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
        clearManagedBotTimers(session.bot);
        if (session.bot) {
            try { session.bot.quit(); } catch (error) {}
            stopped++;
        }
        addDashboardLog(id, `Emergency Stop activated by ${actor.username}.`);
    }
    saveSessions();
    recordAudit(actor, 'fleet.emergency-stop', 'all bots', { stopped });
    broadcastDashboardEvent('status', { emergencyStop: true });
    return { message: `Emergency Stop activated for ${botSessions.size} managed bot(s).` };
}

function exportedConfiguration() {
    return {
        format: 'craftcontrol-settings',
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts: Array.from(botSessions.entries()).map(([id, session]) => {
            const schedule = normalizeSchedule(session.schedule);
            delete schedule.lastBoneDropRunKey;
            const proxy = normalizeProxy(session.proxy);
            return {
                id,
                username: session.username,
                server: session.server_ip,
                authType: session.authType,
                version: normalizeVersion(session.version),
                proxy: proxy ? {
                    host: proxy.host,
                    port: proxy.port,
                    username: proxy.username || ''
                } : null,
                boneDropEnabled: Boolean(session.boneDropEnabled),
                boneDropIntervalSeconds: normalizeBoneDropIntervalSeconds(session.boneDropIntervalSeconds),
                schedule
            };
        })
    };
}

function importConfiguration(payload, actor) {
    if (payload?.format !== 'craftcontrol-settings' || !Array.isArray(payload.accounts)) {
        throw new Error('This is not a valid CraftControl settings backup.');
    }
    if (payload.accounts.length > 100) throw new Error('A backup can contain at most 100 accounts.');
    let updated = 0;
    for (const imported of payload.accounts) {
        const match = [...botSessions.entries()].find(([id, session]) =>
            id === imported.id ||
            (session.username.toLowerCase() === String(imported.username || '').toLowerCase() &&
                session.server_ip === imported.server));
        if (!match) continue;
        const [id, session] = match;
        session.schedule = normalizeSchedule(imported.schedule);
        session.version = normalizeVersion(imported.version);
        session.boneDropEnabled = Boolean(imported.boneDropEnabled);
        session.boneDropIntervalSeconds = normalizeBoneDropIntervalSeconds(imported.boneDropIntervalSeconds);
        if (imported.proxy?.host) {
            const current = normalizeProxy(session.proxy);
            session.proxy = normalizeProxy({
                ...imported.proxy,
                password: current?.password || ''
            });
        } else {
            session.proxy = null;
        }
        evaluateSessionSchedule(id, session);
        updated++;
    }
    saveSessions();
    recordAudit(actor, 'settings.import', `${updated} account(s)`);
    return { message: `Imported settings for ${updated} matching account(s).` };
}

function serveDashboardFile(response, pathname) {
    const files = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
        '/styles.css': ['styles.css', 'text/css; charset=utf-8']
    };
    const match = files[pathname];
    if (!match) return false;
    try {
        const body = fs.readFileSync(path.join(DASHBOARD_PUBLIC_DIR, match[0]));
        response.writeHead(200, {
            'Content-Type': match[1],
            'Content-Length': body.length,
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
        });
        response.end(body);
    } catch (error) {
        response.writeHead(404).end('Dashboard file not found.');
    }
    return true;
}

function startDashboardServer() {
    if (!Number.isInteger(DASHBOARD_PORT) || DASHBOARD_PORT < 1 || DASHBOARD_PORT > 65535) {
        console.error('Dashboard was not started: invalid dashboard port.');
        return;
    }

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
        try {
            if (request.method === 'GET' && serveDashboardFile(response, url.pathname)) return;

            if (request.method === 'POST' && url.pathname === '/api/login') {
                const payload = await readJsonBody(request);
                const dashboardUser = authenticateDashboardUser(payload.username, payload.password);
                if (!dashboardUser) return sendJson(response, 401, { error: 'Incorrect dashboard username or password.' });
                recordAudit(dashboardUser, 'dashboard.login');
                const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
                return sendJson(response, 200, { ok: true, user: dashboardUser }, {
                    'Set-Cookie': `dashboard_session=${dashboardSessionToken(dashboardUser)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DASHBOARD_SESSION_HOURS * 3600}${secure}`
                });
            }

            if (request.method === 'POST' && url.pathname === '/api/logout') {
                return sendJson(response, 200, { ok: true }, {
                    'Set-Cookie': 'dashboard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
                });
            }

            const dashboardUser = dashboardRequestUser(request);
            if (!dashboardUser) {
                return sendJson(response, 401, { error: 'Log in to use the dashboard.' });
            }

            // Renew the signed session only when the browser reports recent
            // human input. Background status polling therefore cannot keep an
            // abandoned dashboard session alive forever.
            if (request.headers['x-dashboard-activity'] === '1') {
                const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
                response.setHeader(
                    'Set-Cookie',
                    `dashboard_session=${dashboardSessionToken(dashboardUser)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DASHBOARD_SESSION_HOURS * 3600}${secure}`
                );
            }

            if (request.method === 'GET' && url.pathname === '/api/events') {
                response.writeHead(200, {
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache, no-transform',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
                response.write('event: ready\ndata: {}\n\n');
                dashboardEventClients.add(response);
                request.on('close', () => dashboardEventClients.delete(response));
                return;
            }

            if (request.method === 'GET' && url.pathname === '/api/status') {
                return sendJson(response, 200, {
                    bots: Array.from(botSessions.entries()).map(([id, session]) => dashboardBotSummary(id, session)),
                    discord: discordClient.isReady(),
                    uptime: Math.floor(process.uptime()),
                    performance: performanceSnapshot,
                    user: { username: dashboardUser.username, role: dashboardUser.role },
                    liveEvents: true
                });
            }

            if (request.method === 'GET' && url.pathname === '/api/audit') {
                return sendJson(response, 200, { entries: auditLog.slice(-200).reverse() });
            }

            if (request.method === 'GET' && url.pathname === '/api/export') {
                requireDashboardAdmin(dashboardUser);
                recordAudit(dashboardUser, 'settings.export');
                return sendJson(response, 200, exportedConfiguration());
            }

            if (request.method === 'POST' && url.pathname === '/api/import') {
                requireDashboardAdmin(dashboardUser);
                return sendJson(response, 200, importConfiguration(await readJsonBody(request), dashboardUser));
            }

            if (request.method === 'POST' && url.pathname === '/api/emergency-stop') {
                requireDashboardAdmin(dashboardUser);
                const payload = await readJsonBody(request);
                if (payload.confirmation !== 'STOP ALL') throw new Error('Type STOP ALL to confirm the emergency stop.');
                return sendJson(response, 200, emergencyStopAll(dashboardUser));
            }

            if (request.method === 'POST' && url.pathname === '/api/bots') {
                requireDashboardAdmin(dashboardUser);
                const bot = createDashboardBot(await readJsonBody(request));
                recordAudit(dashboardUser, 'bot.create', bot.username, {
                    server: bot.server,
                    proxy: bot.proxy.enabled,
                    version: bot.version.requested
                });
                return sendJson(response, 201, { bot });
            }

            if (request.method === 'POST' && url.pathname === '/api/fleet/actions') {
                requireDashboardAdmin(dashboardUser);
                return sendJson(response, 200, await runFleetAction(await readJsonBody(request), dashboardUser));
            }

            const actionMatch = url.pathname.match(/^\/api\/bots\/([^/]+)\/actions$/);
            if (request.method === 'POST' && actionMatch) {
                requireDashboardAdmin(dashboardUser);
                const result = await executeDashboardAction(
                    decodeURIComponent(actionMatch[1]),
                    await readJsonBody(request),
                    dashboardUser
                );
                return sendJson(response, 200, result);
            }

            return sendJson(response, 404, { error: 'Not found.' });
        } catch (error) {
            return sendJson(response, 400, { error: error.message || 'Dashboard request failed.' });
        }
    });

    server.on('error', error => console.error(`Dashboard server error: ${error.message}`));
    const dashboardHeartbeat = setInterval(() => {
        for (const response of dashboardEventClients) {
            try { response.write(': keepalive\n\n'); } catch (error) { dashboardEventClients.delete(response); }
        }
    }, 25000);
    dashboardHeartbeat.unref();
    server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
        console.log(`Dashboard listening on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
        if (!process.env.DASHBOARD_PASSWORD && !process.env.DASHBOARD_USERS) {
            console.log(`Dashboard password (set DASHBOARD_PASSWORD to keep it after restart): ${generatedDashboardPassword}`);
        }
    });
    return server;
}

// Some Pterodactyl Node eggs launch JavaScript through `ts-node --esm`.
// In that mode `require.main` may not point at this module even though this is
// the selected startup file, so also compare the actual process entry path.
const launchedAsEntryPoint = require.main === module || (
    process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)
);

if (launchedAsEntryPoint) {
    startDashboardServer();
    discordClient.login(process.env.DISCORD_TOKEN).catch(error => {
        console.error(`Discord login failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    detectCrackedAuthAction,
    findSellAllSlot,
    inspectSpawnerLoot,
    isCrackedAuthSuccess,
    normalizeBoneDropIntervalSeconds,
    normalizeJoinCommand,
    normalizeMinecraftVersion,
    normalizeProxy,
    optionalValue,
    parseAddress,
    publicProxy,
    startDashboardServer
};
