const test = require('node:test');
const assert = require('node:assert/strict');

const {
    detectCrackedAuthAction,
    findSellAllSlot,
    inspectSpawnerLoot,
    isCrackedAuthSuccess,
    normalizeBoneDropIntervalSeconds,
    normalizeJoinCommand,
    normalizeMinecraftVersion,
    optionalValue,
    parseAddress
} = require('../index');

test('server addresses support domains, custom ports, IPv4, and bracketed IPv6', () => {
    assert.deepEqual(parseAddress('play.example.com', 25565), {
        host: 'play.example.com', port: 25565, explicitPort: false
    });
    assert.deepEqual(parseAddress('play.example.com:25566', 25565), {
        host: 'play.example.com', port: 25566, explicitPort: true
    });
    assert.deepEqual(parseAddress('192.0.2.10:25565', 25565), {
        host: '192.0.2.10', port: 25565, explicitPort: true
    });
    assert.deepEqual(parseAddress('[2001:db8::10]:25567', 25565), {
        host: '2001:db8::10', port: 25567, explicitPort: true
    });
    assert.throws(() => parseAddress('play.example.com:70000', 25565), /between 1 and 65535/);
});

test('automatic and fixed Minecraft version settings are normalized', () => {
    assert.equal(normalizeMinecraftVersion(undefined), null);
    assert.equal(normalizeMinecraftVersion('auto'), null);
    assert.equal(normalizeMinecraftVersion('1.8.8'), '1.8.8');
    assert.equal(normalizeMinecraftVersion('1.21.11'), '1.21.11');
    assert.throws(() => normalizeMinecraftVersion('bedrock'), /must look like/);
});

test('common cracked-server register and login prompts are recognized', () => {
    assert.equal(detectCrackedAuthAction('Please use /register <password> <password>'), 'register');
    assert.equal(detectCrackedAuthAction('Register using /reg password password'), 'register');
    assert.equal(detectCrackedAuthAction('Please log in with /login password'), 'login');
    assert.equal(detectCrackedAuthAction('Use /l password to continue'), 'login');
    assert.equal(detectCrackedAuthAction('Welcome to survival'), null);
});

test('common authentication success messages are recognized without generic false positives', () => {
    assert.equal(isCrackedAuthSuccess('You have successfully logged in!'), true);
    assert.equal(isCrackedAuthSuccess('Registration successful'), true);
    assert.equal(isCrackedAuthSuccess('Success! You won a crate key.'), false);
});

test('optional passwords and per-server join commands are normalized safely', () => {
    assert.equal(optionalValue('-'), null);
    assert.equal(optionalValue('none'), null);
    assert.equal(optionalValue('secret'), 'secret');
    assert.equal(normalizeJoinCommand('/server survival'), '/server survival');
    assert.throws(() => normalizeJoinCommand('server survival'), /must start with/);
});

test('Bone Drop cooldown accepts safe Discord values', () => {
    assert.equal(normalizeBoneDropIntervalSeconds(undefined), 60);
    assert.equal(normalizeBoneDropIntervalSeconds('90'), 90);
    assert.throws(() => normalizeBoneDropIntervalSeconds('4'), /from 5 to 86400/);
    assert.throws(() => normalizeBoneDropIntervalSeconds('1.5'), /whole number/);
});

test('Skeleton storage distinguishes bones and arrows and locates Sell All in the control row', () => {
    const slots = Array(90).fill(null);
    slots[0] = { name: 'bone', displayName: 'Bone', count: 64 };
    slots[1] = { name: 'arrow', displayName: 'Arrow', count: 64 };
    slots[53] = { name: 'gold_ingot', displayName: 'Sell All' };
    const window = { inventoryStart: 54, slots };

    assert.deepEqual(inspectSpawnerLoot(window), {
        hasArrows: true,
        hasBones: true,
        boneStacks: 1
    });
    assert.equal(findSellAllSlot(window), 53);
});
