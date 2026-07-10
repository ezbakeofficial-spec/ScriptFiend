// At the top of your main.js file, with your other requires
const {app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell} = require('electron');
const path = require('path');
const fs = require('fs');
const RPC = require("discord-rpc");
const https = require("https");

const UPDATE_OWNER = 'ezbakeofficial-spec';
const UPDATE_REPO = 'ScriptFiend';
let latestReleaseInfo = null;
let downloadedUpdatePath = null;

function normalizeVersion(version) {
    return String(version || '').replace(/^v/i, '').trim();
}

function compareVersions(a, b) {
    const left = normalizeVersion(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
    const right = normalizeVersion(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
    const maxLength = Math.max(left.length, right.length);

    for (let i = 0; i < maxLength; i += 1) {
        const leftPart = left[i] || 0;
        const rightPart = right[i] || 0;

        if (leftPart > rightPart) return 1;
        if (leftPart < rightPart) return -1;
    }

    return 0;
}

function fetchLatestRelease() {
    return new Promise((resolve, reject) => {
        const requestOptions = {
            hostname: 'api.github.com',
            path: `/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`,
            method: 'GET',
            headers: {
                'User-Agent': `${UPDATE_REPO}-updater`,
                'Accept': 'application/vnd.github.v3+json'
            }
        };

        const request = https.request(requestOptions, (response) => {
            let body = '';

            response.on('data', (chunk) => {
                body += chunk;
            });

            response.on('end', () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`GitHub release lookup failed with status ${response.statusCode}`));
                    return;
                }

                try {
                    resolve(JSON.parse(body));
                } catch (err) {
                    reject(err);
                }
            });
        });

        let requestCompleted = false;

        // Fail the request if it takes too long — prevents indefinite "checking" state
        request.setTimeout(15000, () => {
            if (requestCompleted) {
                return;
            }

            //abort the request to free up resources. but when an abort is not needed, do not call it, as it will throw an error if the request has already completed.
            request.abort();
            reject(new Error('GitHub release lookup timed out'));
            console.warn('GitHub release lookup timed out');
        });

        request.on('response', (response) => {
            requestCompleted = true;
        });

        request.on('error', (err) => {
            if (!requestCompleted) {
                reject(err);
            }
        });

        request.end();
    });
}

function sendUpdateStatus(payload) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('update-status', payload);
    } else {
        console.warn('sendUpdateStatus: mainWindow not ready, payload=', payload);
    }
}

function getLatestRelease() {
    const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

    function performRequest(useAuth) {
        return new Promise((resolve, reject) => {
            const requestOptions = {
                hostname: 'api.github.com',
                path: `/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`,
                method: 'GET',
                headers: {
                    'User-Agent': `${UPDATE_REPO}-updater`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            };

            if (useAuth && ghToken) {
                requestOptions.headers.Authorization = `token ${ghToken}`;
            }

            const request = https.request(requestOptions, (response) => {
                let body = '';

                response.on('data', (chunk) => {
                    body += chunk;
                });

                response.on('end', () => {
                    if (response.statusCode === 200) {
                        try {
                            resolve(JSON.parse(body));
                        } catch (err) {
                            reject(err);
                        }
                        return;
                    }

                    const url = `https://${requestOptions.hostname}${requestOptions.path}`;
                    const bodySnippet = body ? (body.length > 1000 ? body.slice(0, 1000) + '...' : body) : '';
                    resolve({ __errorStatus: response.statusCode, url, bodySnippet });
                });
            });

            request.setTimeout(15000, () => {
                request.abort();
                reject(new Error('GitHub release lookup timed out'));
            });

            request.on('error', (err) => {
                reject(err);
            });

            request.end();
        });
    }

    return performRequest(Boolean(ghToken)).then(async (result) => {
        if (result && result.__errorStatus) {
            if (result.__errorStatus === 401 && ghToken) {
                const retry = await performRequest(false);
                if (retry && retry.__errorStatus) {
                    throw new Error(`GitHub release lookup failed with status ${retry.__errorStatus} for ${retry.url}: ${retry.bodySnippet}`);
                }
                return retry;
            }

            throw new Error(`GitHub release lookup failed with status ${result.__errorStatus} for ${result.url}: ${result.bodySnippet}`);
        }

        return result;
    });
}

async function checkForUpdatesInternal() {
    try {
        // notify renderer we're checking
        sendUpdateStatus({ state: 'checking' });
        const releaseInfo = await getLatestRelease();
        latestReleaseInfo = releaseInfo;

        const latestVersion = normalizeVersion(releaseInfo.tag_name || releaseInfo.name || '');
        const currentVersion = normalizeVersion(app.getVersion());

        if (!latestVersion) {
            const message = 'Latest release version could not be determined.';
            sendUpdateStatus({ state: 'error', message });
            return { success: false, error: message };
        }

        if (compareVersions(latestVersion, currentVersion) <= 0) {
            sendUpdateStatus({ state: 'not-available' });
            return { success: true, available: false };
        }

        const releaseNotes = String(releaseInfo.body || '').trim();
        sendUpdateStatus({ state: 'available', version: latestVersion, releaseNotes });

        return { success: true, available: true, version: latestVersion, releaseNotes };
    } catch (err) {
        const message = err && err.message ? err.message : 'Failed to check for updates.';
        sendUpdateStatus({ state: 'error', message });
        return { success: false, error: message };
    }
}

async function downloadUpdateAsset() {
    if (!latestReleaseInfo) {
        const checkResult = await checkForUpdatesInternal();
        if (!checkResult.success || !checkResult.available) {
            throw new Error(checkResult.error || 'No update is available.');
        }
    }

    const asset = Array.isArray(latestReleaseInfo.assets)
        ? latestReleaseInfo.assets.find((entry) => {
            const name = String(entry.name || '').toLowerCase();
            return entry.browser_download_url && name.endsWith('.exe');
        })
        : null;

    if (!asset) {
        throw new Error('No Windows installer asset found in the latest release.');
    }

        const baseName = String(asset.name || 'update').replace(/\.exe$/i, '');
        const targetPath = path.join(app.getPath('temp'), `${baseName}-${Date.now()}.exe`);
    if (fs.existsSync(targetPath)) {
        try {
            fs.unlinkSync(targetPath);
        } catch {}
    }

    // Download helper that writes to destPath and returns a promise.
    function startDownload(destPath) {
        const MAX_REDIRECTS = 5;
        return new Promise((resolve, reject) => {
            let aborted = false;

            function doRequest(urlToGet, redirectsLeft) {
                if (!redirectsLeft) {
                    reject(new Error('Too many redirects while downloading update.'));
                    return;
                }

                const fileStream = fs.createWriteStream(destPath);
                const req = https.get(urlToGet, {
                    headers: {
                        'User-Agent': `${UPDATE_REPO}-updater`,
                        'Accept': 'application/octet-stream'
                    }
                }, (response) => {
                    // Handle redirects (301/302/303/307/308)
                    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers && response.headers.location) {
                        try { fileStream.close(); } catch {}
                        try { fs.unlinkSync(destPath); } catch {}
                        const location = response.headers.location;
                        // Follow relative or absolute location
                        const nextUrl = location.startsWith('http') ? location : new URL(location, urlToGet).toString();
                        // Consume response to free socket
                        response.resume();
                        doRequest(nextUrl, redirectsLeft - 1);
                        return;
                    }

                    if (response.statusCode !== 200) {
                        try { fileStream.close(); } catch {}
                        try { fs.unlinkSync(destPath); } catch {}
                        reject(new Error(`Update download failed with status ${response.statusCode}.`));
                        return;
                    }

                    response.pipe(fileStream);

                    fileStream.on('finish', () => {
                        fileStream.close(() => {
                            downloadedUpdatePath = destPath;
                            sendUpdateStatus({ state: 'downloaded' });
                            resolve(destPath);
                        });
                    });
                });

                req.on('error', (err) => {
                    try { fileStream.close(); } catch {}
                    try { fs.unlinkSync(destPath); } catch {}
                    if (!aborted) reject(err);
                });

                fileStream.on('error', (err) => {
                    try { fileStream.close(); } catch {}
                    try { fs.unlinkSync(destPath); } catch {}
                    if (!aborted) reject(err);
                });
            }

            doRequest(asset.browser_download_url, MAX_REDIRECTS);
        });
    }

    try {
        return await startDownload(targetPath);
    } catch (err) {
        // If writing to Temp fails due to permissions, fall back to userData folder.
        if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
            const fallbackPath = path.join(app.getPath('userData'), `${baseName}-${Date.now()}.exe`);
            try {
                return await startDownload(fallbackPath);
            } catch (err2) {
                throw err2;
            }
        }

        throw err;
    }
}

async function installDownloadedUpdate() {
    if (!downloadedUpdatePath || !fs.existsSync(downloadedUpdatePath)) {
        throw new Error('No downloaded update available.');
    }

    const result = await shell.openPath(downloadedUpdatePath);
    if (result) {
        throw new Error(result);
    }

    app.quit();
    return true;
}
//Okay so like...this app will only work if you have a completely unmodified discord client intalled on your computer. if you have a modified client such as BetterDiscord, Powercord, or Replugged, this app will not work. This is because those clients block the Discord RPC API. If you have a modified client installed, please uninstall it and install the official Discord client from https://discord.com/download.


let mainWindow;
let rpcClient = null;
let rpcInterval = null;
let tray = null;

app.isQuitting = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 820,
        minWidth: 900,
        minHeight: 760,
        resizable: true,
        show: false,
        backgroundColor: '#020402',
        icon: path.join(__dirname, 'icon.png'), // <-- 1. SETS WINDOW/TASKBAR ICON
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Disable the default File, Edit, View menu bar completely
    mainWindow.setMenu(null); // <-- 2. REMOVES DEFAULT WINDOW MENU BAR

    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => {
        if (mainWindow) mainWindow.show();
    });


    // Hide to tray when clicking X
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // Hide to tray when minimized
    mainWindow.on('minimize', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });
}

app.whenReady().then(() => {
    createWindow();

    // Update checks are triggered from the renderer UI after startup.

    const iconPath = path.join(__dirname, 'icon.png');

    let trayIcon;

    try {
        trayIcon = nativeImage.createFromPath(iconPath);

        if (trayIcon.isEmpty()) {
            throw new Error('icon.png not found');
        }
    } catch {
        trayIcon = nativeImage.createEmpty();
        console.warn('icon.png not found. Tray icon may be invisible.');
    }

    tray = new Tray(trayIcon);

    const trayMenu = Menu.buildFromTemplate([
        {
            label: 'Open ScriptFiend',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        {
            type: 'separator'
        },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;

                if (rpcInterval) {
                    clearInterval(rpcInterval);
                    rpcInterval = null;
                }

                if (rpcClient) {
                    try {
                        rpcClient.clearActivity();
                    } catch {}

                    try {
                        rpcClient.destroy();
                    } catch {}

                    rpcClient = null;
                }

                app.quit();
            }
        }
    ]);

    tray.setToolTip('ScriptFiend');
    tray.setContextMenu(trayMenu);

    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
});

app.on('window-all-closed', (event) => {
    event.preventDefault();
});

app.on('activate', () => {
    if (!mainWindow) {
        createWindow();
    } else {
        mainWindow.show();
        mainWindow.focus();
    }
});

ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) {
        return { success: false, message: 'Update checks only work in packaged builds.' };
    }

    // Guard the update check with a server-side timeout to ensure we always respond.
        const TIMEOUT_MS = 60000;
    try {
        return await Promise.race([
            checkForUpdatesInternal(),
            new Promise((resolve) => {
                setTimeout(() => {
                    const message = 'Update check timed out.';
                    try { sendUpdateStatus({ state: 'error', message }); } catch (e) {}
                    resolve({ success: false, error: message });
                }, TIMEOUT_MS);
            })
        ]);
    } catch (err) {
        const message = err && err.message ? err.message : 'Update check failed.';
        sendUpdateStatus({ state: 'error', message });
        return { success: false, error: message };
    }
});

ipcMain.handle('is-app-packaged', () => {
    return { success: true, packaged: app.isPackaged };
});

ipcMain.handle('get-app-version', () => {
    return { success: true, version: app.getVersion() };
});

ipcMain.handle('download-update', async () => {
    if (!app.isPackaged) {
        return { success: false, message: 'Update downloads only work in packaged builds.' };
    }

    try {
        await downloadUpdateAsset();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('install-update', async () => {
    if (!app.isPackaged) {
        return { success: false, message: 'Update install only works in packaged builds.' };
    }

    try {
        await installDownloadedUpdate();
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('start-rpc', async (event, data) => {
    try {
        if (rpcInterval) {
            clearInterval(rpcInterval);
            rpcInterval = null;
        }

        if (rpcClient) {
            try {
                rpcClient.destroy();
            } catch (err) {
                console.error('Failed to destroy previous RPC client:', err);
            }

            rpcClient = null;
        }

        const CLIENT_ID = String(data.clientId || '').trim();

        if (!CLIENT_ID) {
            console.error('No Discord Application ID provided.');
            return;
        }

        // Split the entered text into individual status lines.
        const statuses = String(data.lyrics || '')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean);

        if (statuses.length === 0) {
            console.error('No statuses provided.');
            return;
        }

        // Read the update interval from the form and convert it to milliseconds.
        const intervalSeconds = Number.parseInt(String(data.intervalSeconds || '15').trim(), 10); // 15 seconds default
        const updateIntervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0
            ? intervalSeconds * 1000
            : 15000;

        console.log('Starting Discord RPC...');
        console.log('Client ID:', CLIENT_ID);
        console.log('Update interval (ms):', updateIntervalMs);

        rpcClient = new RPC.Client({
            transport: 'ipc'
        });

        rpcClient.on('ready', () => {
            console.log('Discord RPC Ready');
        });

        rpcClient.on('error', (err) => {
            console.error('Discord RPC Error:', err);
        });

        let index = 0;
        const startTime = new Date();

        async function updateStatus() {
            if (!rpcClient) return;

            const buttons = [];

            if (data.btn1Label && data.btn1Url) {
                buttons.push({
                    label: data.btn1Label,
                    url: data.btn1Url
                });
            }

            if (data.btn2Label && data.btn2Url) {
                buttons.push({
                    label: data.btn2Label,
                    url: data.btn2Url
                });
            }

            const stateLabel = String(data.stateLabel || '').trim() || 'Made by eZbake with JavaScript';

            const activityPayload = {
                details: statuses[index],
                state: stateLabel,
                startTimestamp: startTime,
                instance: false,

                // Remove these if you don't have an asset
                // named "avatar" in your Discord app.
                largeImageKey: 'avatar',
                largeImageText: 'Discord Status Looper'
            };

            if (buttons.length > 0) {
                activityPayload.buttons = buttons;
            }

            console.log('Updating status:', statuses[index]);

            try {
                await rpcClient.setActivity(activityPayload);
                console.log('Presence updated successfully.');
            } catch (err) {
                console.error('setActivity failed:', err);
            }

            index = (index + 1) % statuses.length;
        }

        console.log('Logging into Discord RPC...');

        await rpcClient.login({
            clientId: CLIENT_ID
        });

        console.log('Discord login successful.');

        // Send the first presence update immediately, then rotate it on a timer.
        await updateStatus();
        rpcInterval = setInterval(updateStatus, updateIntervalMs);

    } catch (err) {
        console.error('Failed to start RPC:', err);
    }
});

ipcMain.on('stop-rpc', () => {
    console.log('Stopping Discord RPC...');

    if (rpcInterval) {
        clearInterval(rpcInterval);
        rpcInterval = null;
    }

    if (rpcClient) {
        try {
            rpcClient.clearActivity();
        } catch (err) {
            console.error('Failed to clear activity:', err);
        }

        try {
            rpcClient.destroy();
        } catch (err) {
            console.error('Failed to destroy RPC client:', err);
        }

        rpcClient = null;
    }

    console.log('Discord RPC stopped.');
});

ipcMain.handle('get-run-at-startup', () => {
    try {
        const settings = app.getLoginItemSettings();
        return { success: true, enabled: settings.openAtLogin || false };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('set-run-at-startup', (event, enable) => {
    try {
        app.setLoginItemSettings({
            openAtLogin: Boolean(enable),
            path: process.execPath,
            args: []
        });
        const settings = app.getLoginItemSettings();
        return { success: true, enabled: settings.openAtLogin || false };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// Send a simple Discord webhook message from the toolkit UI.
ipcMain.on('send-webhook', async (event, data) => {
    try {
        const url = String(data.webhookUrl || '').trim();
        const content = String(data.content || '').trim();

        if (!url || !content) {
            event.reply('webhook-status', { success: false, message: 'Webhook URL and message are required.' });
            return;
        }

        const payload = JSON.stringify({ content });
        const parsedUrl = new URL(url);

        const request = https.request({
            protocol: parsedUrl.protocol,
            hostname: parsedUrl.hostname,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (response) => {
            let responseBody = '';
            response.on('data', (chunk) => {
                responseBody += chunk;
            });
            response.on('end', () => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    event.reply('webhook-status', { success: true, message: 'Webhook sent successfully.' });
                } else {
                    event.reply('webhook-status', { success: false, message: `Webhook failed: ${response.statusCode} ${responseBody}` });
                }
            });
        });

        request.on('error', (err) => {
            event.reply('webhook-status', { success: false, message: `Webhook error: ${err.message}` });
        });

        request.write(payload);
        request.end();
    } catch (err) {
        event.reply('webhook-status', { success: false, message: `Webhook error: ${err.message}` });
    }
});