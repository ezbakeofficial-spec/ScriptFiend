// At the top of your main.js file, with your other requires
const {app, BrowserWindow, ipcMain, Tray, Menu, nativeImage} = require('electron');
const path = require('path');  // Fixed your path import too (missing quotes)
const RPC = require("discord-rpc");
const https = require("https");
const updateApp = require('update-electron-app');  // ← Use this format

// Then call it right after
updateApp();

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