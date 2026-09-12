'use strict';

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

    if (!host || /\s/.test(host)) throw new Error('Enter a valid Minecraft server hostname or IP address.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Server port must be between 1 and 65535.');
    }
    return { host, port, explicitPort };
}

function normalizeMinecraftVersion(value) {
    const version = optionalValue(value);
    if (!version || version.toLowerCase() === 'auto') return null;
    if (!/^\d{1,2}\.\d+(?:\.\d+)?$/.test(version)) {
        throw new Error('Minecraft version must look like 1.21.1 or 26.1, or be auto.');
    }
    return version;
}

function versionPreference(value) {
    return normalizeMinecraftVersion(value) || 'auto';
}

function compatibilityFallbackVersion(requestedVersion, activeVersion, reason) {
    // A manually selected version is authoritative. Automatic mode can fall
    // back when a modern proxy accepts the connection but its game backend
    // cannot handle the proxy-advertised protocol.
    if (normalizeMinecraftVersion(requestedVersion)) return null;

    const message = String(reason || '').toLowerCase();
    const looksLikeProtocolFailure =
        /internal\s+(?:server\s+connection\s+)?error/.test(message) ||
        /unable\s+to\s+connect\s+to\s+\S+.*internal/.test(message) ||
        /outdated\s+(?:client|server)/.test(message) ||
        /unsupported\s+(?:client|protocol|version)/.test(message) ||
        /incompatible\s+(?:client|protocol|version)/.test(message);

    if (!looksLikeProtocolFailure || activeVersion === '1.21.1') return null;
    return '1.21.1';
}

function normalizeJoinCommand(value) {
    const command = optionalValue(value);
    if (!command) return null;
    if (!command.startsWith('/') || command.length > 256) {
        throw new Error('The post-login command must start with / and be at most 256 characters.');
    }
    if (/^\/(?:login|l|register|reg)\b/i.test(command)) {
        throw new Error('Put authentication secrets in the password field, not the post-login command.');
    }
    return command;
}

function defaultJoinCommandForHost(host) {
    return /(^|\.)fatalmc\.(?:org|net)$/i.test(String(host || '')) ? '/server lifesteal' : null;
}

function resolvedJoinCommand(value, host) {
    return normalizeJoinCommand(value) || defaultJoinCommandForHost(host);
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

function validateAccountName(value, authType) {
    const username = String(value || '').trim();
    if (authType === 'microsoft') {
        if (!username || username.length > 254 || /\s/.test(username)) {
            throw new Error('Enter the Microsoft account email or username without spaces.');
        }
    } else if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
        throw new Error('Offline Minecraft usernames must be 1-16 letters, numbers, or underscores.');
    }
    return username;
}

module.exports = {
    compatibilityFallbackVersion,
    defaultJoinCommandForHost,
    detectCrackedAuthAction,
    isCrackedAuthSuccess,
    normalizeJoinCommand,
    normalizeMinecraftVersion,
    optionalValue,
    parseAddress,
    resolvedJoinCommand,
    validateAccountName,
    versionPreference
};
