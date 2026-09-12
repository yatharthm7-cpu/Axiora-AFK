const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../connection-utils');

test('server addresses support domains, custom ports, IPv4, and bracketed IPv6', () => {
    assert.deepEqual(parseAddress('play.potionmc.net'), {
        host: 'play.potionmc.net', port: 25565, explicitPort: false
    });
    assert.deepEqual(parseAddress('play.example.com:25566'), {
        host: 'play.example.com', port: 25566, explicitPort: true
    });
    assert.deepEqual(parseAddress('[2001:db8::10]:25567'), {
        host: '2001:db8::10', port: 25567, explicitPort: true
    });
    assert.throws(() => parseAddress('play.example.com:70000'), /between 1 and 65535/);
});

test('automatic and fixed old/new Minecraft version formats are normalized', () => {
    assert.equal(normalizeMinecraftVersion(undefined), null);
    assert.equal(normalizeMinecraftVersion('auto'), null);
    assert.equal(normalizeMinecraftVersion('1.21.1'), '1.21.1');
    assert.equal(normalizeMinecraftVersion('26.1'), '26.1');
    assert.equal(versionPreference(undefined), 'auto');
    assert.throws(() => normalizeMinecraftVersion('bedrock'), /must look like/);
});

test('automatic mode falls back for proxy/backend protocol failures', () => {
    assert.equal(
        compatibilityFallbackVersion('auto', '26.1', 'Unable to connect to lifesteal: An internal server connection error occurred.'),
        '1.21.1'
    );
    assert.equal(compatibilityFallbackVersion('auto', '26.1', 'Outdated client!'), '1.21.1');
    assert.equal(compatibilityFallbackVersion('1.21.4', '1.21.4', 'Outdated client!'), null);
    assert.equal(compatibilityFallbackVersion('auto', '1.21.1', 'Internal server connection error'), null);
    assert.equal(compatibilityFallbackVersion('auto', '26.1', 'You are banned'), null);
});

test('common cracked-server register and login prompts are recognized safely', () => {
    assert.equal(detectCrackedAuthAction('Please use /register <password> <password>'), 'register');
    assert.equal(detectCrackedAuthAction('Register using /reg password password'), 'register');
    assert.equal(detectCrackedAuthAction('Please log in with /login password'), 'login');
    assert.equal(detectCrackedAuthAction('Use /l password to continue'), 'login');
    assert.equal(detectCrackedAuthAction('Welcome to survival'), null);
    assert.equal(isCrackedAuthSuccess('You have successfully logged in!'), true);
    assert.equal(isCrackedAuthSuccess('Registration successful'), true);
    assert.equal(isCrackedAuthSuccess('Success! You won a crate key.'), false);
});

test('network-specific routing is isolated and custom routing is supported', () => {
    assert.equal(defaultJoinCommandForHost('play.fatalmc.org'), '/server lifesteal');
    assert.equal(defaultJoinCommandForHost('play.potionmc.net'), null);
    assert.equal(resolvedJoinCommand('/server survival', 'play.potionmc.net'), '/server survival');
    assert.equal(normalizeJoinCommand('-'), null);
    assert.throws(() => normalizeJoinCommand('server survival'), /must start with/);
    assert.throws(() => normalizeJoinCommand('/login secret'), /password field/);
});

test('offline usernames and Microsoft account identifiers are validated separately', () => {
    assert.equal(validateAccountName('PotionBot_1', 'offline'), 'PotionBot_1');
    assert.equal(validateAccountName('player@example.com', 'microsoft'), 'player@example.com');
    assert.throws(() => validateAccountName('player@example.com', 'offline'), /Offline Minecraft usernames/);
    assert.equal(optionalValue('-'), null);
});
