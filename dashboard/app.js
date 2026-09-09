const loginView = document.querySelector('#loginView');
const dashboardView = document.querySelector('#dashboardView');
const loginForm = document.querySelector('#loginForm');
const loginError = document.querySelector('#loginError');
const createDialog = document.querySelector('#createDialog');
const controlDialog = document.querySelector('#controlDialog');
const createForm = document.querySelector('#createForm');
const botGrid = document.querySelector('#botGrid');
const emptyState = document.querySelector('#emptyState');
const toast = document.querySelector('#toast');

let bots = [];
let selectedBotId = null;
const selectedBots = new Set();
let refreshTimer = null;
let toastTimer = null;
let eventStream = null;
let liveRefreshTimer = null;
let scheduleDirty = false;
let connectionDirty = false;
let currentUser = null;
let lastAuditRefresh = 0;
let lastUserActivityAt = Date.now();

for (const eventName of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(eventName, () => { lastUserActivityAt = Date.now(); }, { passive: true });
}

function browserTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
}

function defaultSchedule() {
    return {
        enabled: false,
        timezone: browserTimezone(),
        days: [0, 1, 2, 3, 4, 5, 6],
        activeHoursEnabled: false,
        startTime: '06:00',
        stopTime: '23:00',
        boneDropScheduleEnabled: false,
        boneDropTimes: [],
        sellWindowEnabled: false,
        sellStartTime: '06:00',
        sellStopTime: '23:00',
        sellIntervalSeconds: 30,
        maintenanceEnabled: false,
        maintenanceStartTime: '03:00',
        maintenanceStopTime: '04:00',
        highPingEnabled: false,
        highPingThreshold: 500
    };
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'X-Dashboard-Activity': Date.now() - lastUserActivityAt < 60000 ? '1' : '0',
            ...(options.headers || {})
        }
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && url !== '/api/login') showLogin();
    if (!response.ok) throw new Error(data.error || 'The request failed.');
    return data;
}

function showLogin() {
    dashboardView.classList.add('hidden');
    loginView.classList.remove('hidden');
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    if (eventStream) eventStream.close();
    eventStream = null;
    currentUser = null;
    document.body.classList.remove('viewer');
}

function showDashboard() {
    loginView.classList.add('hidden');
    dashboardView.classList.remove('hidden');
    if (!refreshTimer) refreshTimer = setInterval(refreshStatus, 3000);
}

function connectLiveEvents() {
    if (eventStream) return;
    eventStream = new EventSource('/api/events');
    const scheduleRefresh = () => {
        clearTimeout(liveRefreshTimer);
        liveRefreshTimer = setTimeout(refreshStatus, 180);
    };
    eventStream.addEventListener('activity', scheduleRefresh);
    eventStream.addEventListener('status', scheduleRefresh);
    eventStream.onerror = () => {
        if (eventStream?.readyState === EventSource.CLOSED) eventStream = null;
    };
}

function showToast(message, error = false) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast show${error ? ' error' : ''}`;
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3200);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
}

function formatUptime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
    return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}

function formatLogTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatMoney(value) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function applyCurrentUser(user) {
    currentUser = user || null;
    document.body.classList.toggle('viewer', currentUser?.role === 'viewer');
    document.querySelector('#currentUser').textContent = currentUser
        ? `${currentUser.username} · ${currentUser.role}`
        : '';
}

function botCard(bot) {
    const position = bot.position ? `${bot.position.x}, ${bot.position.y}, ${bot.position.z}` : '—';
    const health = bot.health == null ? '—' : `${bot.health}/20`;
    const food = bot.food == null ? '—' : `${bot.food}/20`;
    const ping = bot.ping == null ? '—' : `${bot.ping} ms`;
    const tags = [
        ['Bone Drop', bot.macros.boneDrop],
        ['Sell Macro', bot.macros.sell],
        ['Auto-Eat', bot.macros.autoEat]
    ].map(([name, active]) => `<span class="tag${active ? ' active' : ''}">${name}</span>`).join('');
    const nextAction = bot.nextScheduledAction
        ? `${bot.nextScheduledAction.label} · ${bot.nextScheduledAction.when}`
        : bot.schedule?.enabled ? 'No scheduled action configured' : 'Schedule disabled';

    return `
        <article class="bot-card${selectedBots.has(bot.id) ? ' selected' : ''}">
            <label class="bot-select" title="Select ${escapeHtml(bot.username)}">
                <input type="checkbox" data-select="${encodeURIComponent(bot.id)}" ${selectedBots.has(bot.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(bot.username)}">
            </label>
            <div class="bot-head">
                <div class="bot-identity">
                    <div class="avatar">${escapeHtml(bot.username.slice(0, 1).toUpperCase())}</div>
                    <div>
                        <h3>${escapeHtml(bot.username)}</h3>
                        <p class="muted">${escapeHtml(bot.server)} · ${escapeHtml(bot.version?.detected || bot.version?.requested || 'auto')}</p>
                    </div>
                </div>
                <span class="status-pill ${escapeHtml(bot.state)}">${escapeHtml(bot.state)}</span>
            </div>
            <div class="bot-stats">
                <div class="stat"><span>HEALTH</span><strong>${health}</strong></div>
                <div class="stat"><span>FOOD</span><strong>${food}</strong></div>
                <div class="stat"><span>POSITION</span><strong>${position}</strong></div>
                <div class="stat"><span>PING</span><strong>${ping}</strong></div>
            </div>
            <div class="macro-tags">${tags}</div>
            <div class="connection-line">${bot.proxy?.enabled ? `SOCKS5 · ${escapeHtml(bot.proxy.address)}` : 'Direct connection'} · 24h uptime ${escapeHtml(bot.statistics?.uptimeDay ?? 0)}%</div>
            <div class="next-chip"><span>NEXT</span>${escapeHtml(nextAction)}</div>
            <div class="card-actions">
                <span class="source-label">${escapeHtml(bot.source)} control</span>
                <button class="ghost manage-button" type="button" data-manage="${encodeURIComponent(bot.id)}">Manage</button>
            </div>
        </article>`;
}

function renderStatus(data) {
    bots = data.bots;
    applyCurrentUser(data.user);
    const currentIds = new Set(bots.map(bot => bot.id));
    for (const id of selectedBots) if (!currentIds.has(id)) selectedBots.delete(id);
    document.querySelector('#totalBots').textContent = bots.length;
    document.querySelector('#onlineBots').textContent = bots.filter(bot => bot.state === 'online').length;
    document.querySelector('#uptime').textContent = formatUptime(data.uptime);
    document.querySelector('#activeMacros').textContent = bots.reduce((total, bot) =>
        total + Number(bot.macros.boneDrop) + Number(bot.macros.sell) + Number(bot.macros.autoEat), 0);
    document.querySelector('#memoryUsage').textContent = `${data.performance?.memoryMb || 0} MB`;
    document.querySelector('#cpuUsage').textContent = `${data.performance?.cpuPercent || 0}%`;
    document.querySelector('#lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    document.querySelector('#discordState').classList.toggle('online', data.discord);
    if (data.liveEvents !== false) {
        connectLiveEvents();
    } else if (eventStream) {
        eventStream.close();
        eventStream = null;
    }
    botGrid.innerHTML = bots.map(botCard).join('');
    botGrid.classList.toggle('hidden', bots.length === 0);
    emptyState.classList.toggle('hidden', bots.length !== 0);
    document.querySelector('#fleetToolbar').classList.toggle('hidden', bots.length === 0);

    document.querySelectorAll('[data-manage]').forEach(button => {
        button.addEventListener('click', () => openControls(decodeURIComponent(button.dataset.manage)));
    });
    document.querySelectorAll('[data-select]').forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const id = decodeURIComponent(checkbox.dataset.select);
            if (checkbox.checked) selectedBots.add(id); else selectedBots.delete(id);
            checkbox.closest('.bot-card').classList.toggle('selected', checkbox.checked);
            updateFleetSelection();
        });
    });
    updateFleetSelection();
    updateControlDialog();
}

function updateFleetSelection() {
    document.querySelector('#selectedCount').textContent = `${selectedBots.size} selected`;
    const selectAll = document.querySelector('#selectAllBots');
    selectAll.checked = bots.length > 0 && selectedBots.size === bots.length;
    selectAll.indeterminate = selectedBots.size > 0 && selectedBots.size < bots.length;
}

async function refreshStatus() {
    try {
        renderStatus(await api('/api/status'));
        showDashboard();
        if (Date.now() - lastAuditRefresh > 15000) refreshAudit();
    } catch (error) {
        if (!dashboardView.classList.contains('hidden')) showToast(error.message, true);
    }
}

function openControls(id) {
    selectedBotId = id;
    scheduleDirty = false;
    connectionDirty = false;
    updateControlDialog();
    controlDialog.showModal();
    updateControlDialog();
}

function populateScheduleForm(bot) {
    const schedule = { ...defaultSchedule(), ...(bot.schedule || {}) };
    document.querySelector('#scheduleEnabled').checked = schedule.enabled;
    document.querySelector('#scheduleTimezone').value = schedule.timezone || browserTimezone();
    document.querySelector('#scheduleTimezoneLabel').textContent = schedule.timezone || browserTimezone();
    document.querySelector('#activeHoursEnabled').checked = schedule.activeHoursEnabled;
    document.querySelector('#scheduleStartTime').value = schedule.startTime;
    document.querySelector('#scheduleStopTime').value = schedule.stopTime;
    document.querySelector('#boneDropScheduleEnabled').checked = schedule.boneDropScheduleEnabled;
    document.querySelector('#boneDropTimes').value = (schedule.boneDropTimes || []).join(', ');
    document.querySelector('#sellWindowEnabled').checked = schedule.sellWindowEnabled;
    document.querySelector('#sellStartTime').value = schedule.sellStartTime;
    document.querySelector('#sellStopTime').value = schedule.sellStopTime;
    document.querySelector('#scheduledSellSeconds').value = schedule.sellIntervalSeconds;
    document.querySelector('#maintenanceEnabled').checked = schedule.maintenanceEnabled;
    document.querySelector('#maintenanceStartTime').value = schedule.maintenanceStartTime;
    document.querySelector('#maintenanceStopTime').value = schedule.maintenanceStopTime;
    document.querySelector('#highPingEnabled').checked = schedule.highPingEnabled;
    document.querySelector('#highPingThreshold').value = schedule.highPingThreshold;
    document.querySelector('#nextScheduledAction').textContent = bot.nextScheduledAction
        ? `${bot.nextScheduledAction.label} · ${bot.nextScheduledAction.when}`
        : schedule.enabled ? 'No timed action configured yet.' : 'Schedule is disabled.';
    document.querySelectorAll('[name="scheduleDay"]').forEach(input => {
        input.checked = schedule.days.includes(Number(input.value));
    });
}

function populateConnectionForm(bot) {
    document.querySelector('#connectionVersion').value = bot.version?.requested || 'auto';
    document.querySelector('#detectedVersion').textContent = bot.version?.detected
        ? `Detected ${bot.version.detected}`
        : 'Detects automatically on connect';
    document.querySelector('#connectionProxyEnabled').checked = Boolean(bot.proxy?.enabled);
    document.querySelector('#connectionProxyHost').value = bot.proxy?.host || '';
    document.querySelector('#connectionProxyPort').value = bot.proxy?.port || '';
    document.querySelector('#connectionProxyUsername').value = bot.proxy?.username || '';
    document.querySelector('#connectionProxyPassword').value = '';
}

function renderPingChart(samples = []) {
    const chart = document.querySelector('#pingChart');
    const values = samples.map(sample => Number(sample.ping)).filter(Number.isFinite);
    if (!values.length) {
        chart.innerHTML = '<text x="300" y="70" text-anchor="middle">Ping history will appear after monitoring begins.</text>';
        document.querySelector('#pingRange').textContent = '';
        return;
    }
    const width = 600;
    const height = 130;
    const padding = 12;
    const maximum = Math.max(100, ...values);
    const minimum = Math.min(...values);
    const points = values.map((value, index) => {
        const x = values.length === 1 ? width / 2 : index / (values.length - 1) * width;
        const y = height - padding - value / maximum * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    chart.innerHTML = `
        <line x1="0" y1="${height - padding}" x2="${width}" y2="${height - padding}" class="chart-axis"></line>
        <polyline points="${points}" class="chart-line"></polyline>
    `;
    document.querySelector('#pingRange').textContent = `${minimum}–${Math.max(...values)} ms · ${values.length} samples`;
}

function updateControlDialog() {
    if (!selectedBotId || !controlDialog.open) return;
    const bot = bots.find(item => item.id === selectedBotId);
    if (!bot) {
        controlDialog.close();
        selectedBotId = null;
        return;
    }
    document.querySelector('#controlName').textContent = bot.username;
    document.querySelector('#controlServer').textContent = `${bot.server} · ${bot.state}`;
    document.querySelector('#boneStatus').textContent = bot.macros.boneDropBusy
        ? 'Cycle running'
        : bot.macros.boneDrop ? 'Enabled' : 'Stopped';
    document.querySelector('#sellStatus').textContent = bot.macros.sell ? 'Enabled' : 'Stopped';
    document.querySelector('#eatStatus').textContent = bot.macros.autoEat ? 'Enabled' : 'Stopped';
    document.querySelector('#boneSeconds').value = bot.macros.boneDropCooldown;
    const metrics = bot.metrics || {};
    const statistics = bot.statistics || {};
    document.querySelector('#detailUptime').textContent = bot.state === 'online' ? formatUptime(bot.onlineSeconds || 0) : '—';
    document.querySelector('#detailPing').textContent = bot.ping == null ? '—' : `${bot.ping} ms`;
    document.querySelector('#detailUptimeDay').textContent = `${statistics.uptimeDay ?? 0}%`;
    document.querySelector('#detailUptimeWeek').textContent = `${statistics.uptimeWeek ?? 0}%`;
    document.querySelector('#detailConnections').textContent = metrics.connections || 0;
    document.querySelector('#detailDisconnects').textContent = metrics.disconnects || 0;
    document.querySelector('#detailDeaths').textContent = metrics.deaths || 0;
    document.querySelector('#detailDropClicks').textContent = metrics.boneDropClicks || 0;
    document.querySelector('#detailDropSuccess').textContent = statistics.boneDropSuccessRate == null ? '—' : `${statistics.boneDropSuccessRate}%`;
    document.querySelector('#detailEarnings').textContent = formatMoney(statistics.estimatedEarnings);
    renderPingChart(statistics.pingHistory || []);
    if (!scheduleDirty) populateScheduleForm(bot);
    if (!connectionDirty) populateConnectionForm(bot);

    const inventory = document.querySelector('#inventoryGrid');
    const inventoryItems = bot.inventory || [];
    const totalItems = inventoryItems.reduce((total, item) => total + item.count, 0);
    document.querySelector('#inventoryCount').textContent = `${totalItems} item${totalItems === 1 ? '' : 's'}`;
    inventory.innerHTML = inventoryItems.length
        ? inventoryItems.map(item => `
            <div class="inventory-item">
                <div class="item-icon">${escapeHtml(item.name.slice(0, 2).toUpperCase())}</div>
                <div class="item-info"><strong>${escapeHtml(item.displayName)}</strong><span>× ${item.count}</span></div>
            </div>`).join('')
        : '<div class="muted">Inventory is empty or unavailable.</div>';

    const activity = document.querySelector('#activityLog');
    const wasAtBottom = activity.scrollHeight - activity.scrollTop - activity.clientHeight < 30;
    activity.innerHTML = bot.logs.length
        ? bot.logs.map(entry => `<div class="log-line"><span class="log-time">${escapeHtml(formatLogTime(entry.time))}</span>${escapeHtml(entry.message)}</div>`).join('')
        : '<div class="muted">No activity recorded yet.</div>';
    if (wasAtBottom) activity.scrollTop = activity.scrollHeight;
}

async function performAction(action, values = {}) {
    if (!selectedBotId) return;
    const message = document.querySelector('#controlMessage');
    message.textContent = 'Working…';
    message.classList.remove('error');
    try {
        const result = await api(`/api/bots/${encodeURIComponent(selectedBotId)}/actions`, {
            method: 'POST', body: JSON.stringify({ action, ...values })
        });
        message.textContent = result.message;
        showToast(result.message);
        if (action === 'remove') {
            controlDialog.close();
            selectedBotId = null;
        }
        if (action === 'schedule-save') scheduleDirty = false;
        if (action === 'connection-save') connectionDirty = false;
        await refreshStatus();
    } catch (error) {
        message.textContent = error.message;
        message.classList.add('error');
        showToast(error.message, true);
    }
}

async function refreshAudit() {
    try {
        const data = await api('/api/audit');
        lastAuditRefresh = Date.now();
        const container = document.querySelector('#auditLog');
        container.innerHTML = data.entries?.length
            ? data.entries.map(entry => `
                <div class="audit-entry">
                    <time>${escapeHtml(formatLogTime(entry.time))}</time>
                    <strong>${escapeHtml(entry.actor)}</strong>
                    <span>${escapeHtml(entry.action)}</span>
                    <small>${escapeHtml(entry.target || '')}</small>
                </div>`).join('')
            : '<p class="muted">No audit activity yet.</p>';
    } catch (error) {
        if (error.message !== 'Log in to use the dashboard.') showToast(error.message, true);
    }
}

async function exportSettings() {
    try {
        const data = await api('/api/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `craftcontrol-settings-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(url);
        showToast('Settings backup downloaded. Passwords were not included.');
        refreshAudit();
    } catch (error) {
        showToast(error.message, true);
    }
}

loginForm.addEventListener('submit', async event => {
    event.preventDefault();
    loginError.textContent = '';
    try {
        await api('/api/login', {
            method: 'POST',
            body: JSON.stringify({
                username: document.querySelector('#loginUsername').value,
                password: document.querySelector('#loginPassword').value
            })
        });
        document.querySelector('#loginPassword').value = '';
        await refreshStatus();
    } catch (error) {
        loginError.textContent = error.message;
    }
});

document.querySelector('#logoutButton').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
    showLogin();
});

document.querySelector('#refreshButton').addEventListener('click', refreshStatus);
document.querySelector('#refreshAuditButton').addEventListener('click', refreshAudit);
document.querySelector('#exportButton').addEventListener('click', exportSettings);
document.querySelector('#importButton').addEventListener('click', () => document.querySelector('#importFile').click());
document.querySelector('#importFile').addEventListener('change', async event => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
        const backup = JSON.parse(await file.text());
        if (!window.confirm('Import this backup into matching accounts? Passwords and running connections will not be changed.')) return;
        const result = await api('/api/import', { method: 'POST', body: JSON.stringify(backup) });
        showToast(result.message);
        await refreshStatus();
        refreshAudit();
    } catch (error) {
        showToast(error.message || 'The backup file is invalid.', true);
    } finally {
        event.currentTarget.value = '';
    }
});
document.querySelector('#emergencyButton').addEventListener('click', async () => {
    const confirmation = window.prompt('This immediately disconnects every bot and stops every macro. Type STOP ALL to continue.');
    if (confirmation !== 'STOP ALL') return showToast('Emergency Stop cancelled.', true);
    try {
        const result = await api('/api/emergency-stop', {
            method: 'POST',
            body: JSON.stringify({ confirmation })
        });
        showToast(result.message);
        await refreshStatus();
        refreshAudit();
    } catch (error) {
        showToast(error.message, true);
    }
});
document.querySelector('#showCreateButton').addEventListener('click', () => createDialog.showModal());
document.querySelectorAll('.create-trigger').forEach(button => button.addEventListener('click', () => createDialog.showModal()));
document.querySelector('#closeCreateButton').addEventListener('click', () => createDialog.close());
document.querySelector('#cancelCreateButton').addEventListener('click', () => createDialog.close());
document.querySelector('#closeControlButton').addEventListener('click', () => controlDialog.close());

document.querySelector('#scheduleForm').addEventListener('input', () => {
    scheduleDirty = true;
});

document.querySelector('#connectionForm').addEventListener('input', () => {
    connectionDirty = true;
});

document.querySelector('#connectionForm').addEventListener('submit', async event => {
    event.preventDefault();
    const proxyEnabled = document.querySelector('#connectionProxyEnabled').checked;
    const proxyHost = document.querySelector('#connectionProxyHost').value.trim();
    const proxyPort = document.querySelector('#connectionProxyPort').value;
    if (proxyEnabled && (!proxyHost || !proxyPort)) {
        return showToast('Enter both the proxy host and port.', true);
    }
    await performAction('connection-save', {
        version: document.querySelector('#connectionVersion').value,
        proxyEnabled,
        proxyHost,
        proxyPort,
        proxyUsername: document.querySelector('#connectionProxyUsername').value,
        proxyPassword: document.querySelector('#connectionProxyPassword').value,
        reconnect: true
    });
    connectionDirty = false;
});

document.querySelector('#scheduleForm').addEventListener('submit', async event => {
    event.preventDefault();
    const days = [...document.querySelectorAll('[name="scheduleDay"]:checked')].map(input => Number(input.value));
    if (!days.length) return showToast('Select at least one schedule day.', true);

    const boneDropTimes = document.querySelector('#boneDropTimes').value
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    if (boneDropTimes.some(value => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
        return showToast('Bone Drop times must use 24-hour HH:MM format, separated by commas.', true);
    }

    const schedule = {
        enabled: document.querySelector('#scheduleEnabled').checked,
        timezone: document.querySelector('#scheduleTimezone').value || browserTimezone(),
        days,
        activeHoursEnabled: document.querySelector('#activeHoursEnabled').checked,
        startTime: document.querySelector('#scheduleStartTime').value,
        stopTime: document.querySelector('#scheduleStopTime').value,
        boneDropScheduleEnabled: document.querySelector('#boneDropScheduleEnabled').checked,
        boneDropTimes,
        sellWindowEnabled: document.querySelector('#sellWindowEnabled').checked,
        sellStartTime: document.querySelector('#sellStartTime').value,
        sellStopTime: document.querySelector('#sellStopTime').value,
        sellIntervalSeconds: Number(document.querySelector('#scheduledSellSeconds').value),
        maintenanceEnabled: document.querySelector('#maintenanceEnabled').checked,
        maintenanceStartTime: document.querySelector('#maintenanceStartTime').value,
        maintenanceStopTime: document.querySelector('#maintenanceStopTime').value,
        highPingEnabled: document.querySelector('#highPingEnabled').checked,
        highPingThreshold: Number(document.querySelector('#highPingThreshold').value)
    };
    await performAction('schedule-save', { schedule });
});

document.querySelector('#selectAllBots').addEventListener('change', event => {
    selectedBots.clear();
    if (event.currentTarget.checked) bots.forEach(bot => selectedBots.add(bot.id));
    document.querySelectorAll('[data-select]').forEach(checkbox => {
        checkbox.checked = event.currentTarget.checked;
        checkbox.closest('.bot-card').classList.toggle('selected', checkbox.checked);
    });
    updateFleetSelection();
});

function updateBulkSeconds() {
    const action = document.querySelector('#bulkAction').value;
    const seconds = document.querySelector('#bulkSeconds');
    const needsSeconds = action === 'bonedrop-on' || action === 'sell-on';
    seconds.classList.toggle('hidden', !needsSeconds);
    if (action === 'bonedrop-on') {
        seconds.min = '5';
        if (Number(seconds.value) < 5) seconds.value = '60';
    } else if (action === 'sell-on') {
        seconds.min = '1';
        if (Number(seconds.value) < 1) seconds.value = '30';
    }
}

document.querySelector('#bulkAction').addEventListener('change', updateBulkSeconds);
document.querySelector('#runBulkAction').addEventListener('click', async () => {
    if (!selectedBots.size) return showToast('Select at least one bot first.', true);
    const action = document.querySelector('#bulkAction').value;
    if (action === 'stop' && !window.confirm(`Stop ${selectedBots.size} selected bot(s)? Their saved accounts will remain available.`)) return;
    const payload = { action, ids: [...selectedBots] };
    if (action === 'bonedrop-on' || action === 'sell-on') {
        payload.seconds = document.querySelector('#bulkSeconds').value;
    }
    try {
        const result = await api('/api/fleet/actions', { method: 'POST', body: JSON.stringify(payload) });
        showToast(result.message, result.results.some(item => !item.ok));
        await refreshStatus();
    } catch (error) {
        showToast(error.message, true);
    }
});
updateBulkSeconds();

createForm.addEventListener('submit', async event => {
    event.preventDefault();
    const formData = new FormData(createForm);
    const createError = document.querySelector('#createError');
    createError.textContent = '';
    try {
        await api('/api/bots', {
            method: 'POST',
            body: JSON.stringify(Object.fromEntries(formData.entries()))
        });
        const username = formData.get('username');
        createForm.reset();
        createDialog.close();
        showToast(`${username} is connecting.`);
        await refreshStatus();
    } catch (error) {
        createError.textContent = error.message;
    }
});

document.querySelector('#sendForm').addEventListener('submit', async event => {
    event.preventDefault();
    const input = event.currentTarget.elements.text;
    await performAction('send', { text: input.value });
    input.value = '';
});

document.querySelectorAll('#controlDialog [data-action]').forEach(button => {
    button.addEventListener('click', async () => {
        const action = button.dataset.action;
        if (action === 'remove' && !window.confirm('Remove this bot and its saved session? Its Discord channel will also be removed if it has one.')) return;
        if (action === 'stop' && !window.confirm('Stop this bot? Its saved account will remain available.')) return;
        const values = {};
        if (action === 'bonedrop-on') values.seconds = document.querySelector('#boneSeconds').value;
        if (action === 'sell-on') values.seconds = document.querySelector('#sellSeconds').value;
        await performAction(action, values);
    });
});

refreshStatus();
