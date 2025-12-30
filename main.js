const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

let mainWindow;
let tray = null;

// --- アップデート管理 (v3.3.1 方式をベースに再構築) ---
const UPDATE_DIR = path.join(app.getPath('userData'), 'updates');
const LOCAL_PKG = path.join(UPDATE_DIR, 'package.json');
const LOCAL_INDEX = path.join(UPDATE_DIR, 'index.html');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 300,
        height: 400,
        minWidth: 300,
        minHeight: 400,
        maxWidth: 300,
        maxHeight: 400,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // --- バージョン比較と起動パスの決定 ---
    let useUpdate = false;
    const bundledPkgPath = path.join(app.getAppPath(), 'package.json');

    if (fs.existsSync(LOCAL_PKG) && fs.existsSync(LOCAL_INDEX)) {
        try {
            const updatePkg = JSON.parse(fs.readFileSync(LOCAL_PKG, 'utf8'));
            const bundledPkg = JSON.parse(fs.readFileSync(bundledPkgPath, 'utf8'));

            console.log(`🔎 バージョン比較: UserData(${updatePkg.version}) vs Bundled(${bundledPkg.version})`);

            if (compareVersions(updatePkg.version, bundledPkg.version) > 0) {
                useUpdate = true;
            } else {
                console.log('🧹 本体バージョンの方が新しいため、アップデート版は使用しません。');
            }
        } catch (e) {
            console.error('⚠️ バージョン比較エラー:', e);
        }
    }

    if (useUpdate) {
        console.log('✨ アップデート版 (userData/updates) を起動します。');
        app.effectiveAppPath = UPDATE_DIR;
        mainWindow.loadFile(LOCAL_INDEX);
    } else {
        console.log('🏠 オリジナル版 (AppPath) を起動します。');
        app.effectiveAppPath = app.getAppPath();
        mainWindow.loadFile('index.html');
    }

    // --- Utilities ---
    function compareVersions(v1, v2) {
        const p1 = v1.split('.').map(Number);
        const p2 = v2.split('.').map(Number);
        for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
            const n1 = p1[i] || 0;
            const n2 = p2[i] || 0;
            if (n1 > n2) return 1;
            if (n1 < n2) return -1;
        }
        return 0;
    }

    console.log('📂 実効アプリケーションパス:', app.effectiveAppPath);

    mainWindow.on('focus', () => {
        console.log('🔍 ウィンドウフォーカス: アップデートを確認します');
        if (mainWindow) mainWindow.webContents.send('window-focused');
        checkUpdates();
    });

    mainWindow.on('close', (event) => {
        if (!app.isQuiting) {
            event.preventDefault();
            mainWindow.hide(); // タスクバーから消してインジケーター（トレイ）に入れる
        }
        return false;
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // 2つ目のインスタンスが起動されたとき、既存のウィンドウを表示する
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        if (process.platform === 'win32') {
            app.setAppUserModelId('com.p2pfileshare.app');
        }
        createWindow();
        createTray();
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const icon = nativeImage.createFromPath(iconPath);

    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        { label: '表示', click: () => mainWindow.show() },
        {
            label: '終了', click: () => {
                app.isQuiting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('ProxiPass');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        mainWindow.show();
    });
}

// 定期監視 (API制限 60回/時 を考慮して 60秒間隔に変更)
setInterval(checkUpdates, 60000);

let lastUpdateCheck = 0;

async function checkUpdates() {
    if (!mainWindow) return;

    // API制限保護: 前回のチェックから5秒未満ならスキップ (フォーカス連打対策)
    const now = Date.now();
    if (now - lastUpdateCheck < 5000) return;
    lastUpdateCheck = now;

    // GitHub API (反映が早いため採用。ただし利用制限に注意)
    const options = {
        hostname: 'api.github.com',
        path: '/repos/Teru0822/ProxiPass/contents/package.json',
        headers: {
            'User-Agent': 'ProxiPass-App',
            'Accept': 'application/vnd.github.v3+json',
            'Cache-Control': 'no-cache'
        }
    };

    https.get(options, (res) => {
        if (res.statusCode !== 200) {
            console.warn(`⚠️ アップデート確認失敗: Status ${res.statusCode} (API制限の可能性あり)`);
            return;
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                const content = Buffer.from(json.content, 'base64').toString();
                const remotePkg = JSON.parse(content);
                const remoteVersion = remotePkg.version;

                // 物理ファイルから現在のバージョンを確実に読み取る
                const currentPkgPath = path.join(app.effectiveAppPath || app.getAppPath(), 'package.json');
                const localPkg = JSON.parse(fs.readFileSync(currentPkgPath, 'utf8'));
                const currentVersion = localPkg.version;

                if (remoteVersion !== currentVersion) {
                    console.log(`🚀 新バージョン検出! [Local: ${currentVersion}] -> [Remote: ${remoteVersion}]`);
                    lastUpdateNotified = Date.now();
                    mainWindow.webContents.send('update-available', remoteVersion);
                } else {
                    console.log(`✅ すでに最新版です (v${currentVersion})`);
                }
            } catch (e) {
                console.error('❌ バージョンチェック中にエラー:', e.message);
            }
        });
    }).on('error', (err) => {
        console.error('❌ GitHub API 通信エラー:', err.message);
    });
}

// IPCハンドラー (v3.3.1 で必要だったすべてのハンドラーを復元)

ipcMain.handle('get-app-version', async () => {
    try {
        const pkgPath = path.join(app.effectiveAppPath || app.getAppPath(), 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            return pkg.version;
        }
    } catch (e) { }
    return app.getVersion();
});

ipcMain.handle('download-update', async (event, url, fileName) => {
    return new Promise((resolve) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                resolve({ success: false, error: `Status Code: ${res.statusCode}` });
                return;
            }

            let data = [];
            res.on('data', (chunk) => { data.push(chunk); });
            res.on('end', () => {
                try {
                    const buffer = Buffer.concat(data);

                    if (!fs.existsSync(UPDATE_DIR)) {
                        fs.mkdirSync(UPDATE_DIR, { recursive: true });
                    }

                    const filePath = path.join(UPDATE_DIR, fileName);
                    fs.writeFileSync(filePath, buffer);

                    // アップデート後にパスを切り替え (再起動までの重複通知を防止)
                    app.effectiveAppPath = UPDATE_DIR;

                    if (process.platform !== 'win32' && (fileName.endsWith('.js') || fileName.endsWith('.sh'))) {
                        try { fs.chmodSync(filePath, 0o755); } catch (e) { }
                    }

                    console.log(`✅ 保存完了: ${filePath}`);
                    resolve({ success: true, filePath: filePath });
                } catch (err) {
                    resolve({ success: false, error: err.message });
                }
            });
        }).on('error', (err) => {
            resolve({ success: false, error: err.message });
        });
    });
});

ipcMain.handle('restart-app', async () => {
    console.log('🔄 アプリを再起動します...');
    app.relaunch();
    app.exit(0);
});

// ファイル共有関連のIPC
ipcMain.handle('save-file', async (event, fileName, fileData) => {
    try {
        const result = await dialog.showSaveDialog({ defaultPath: fileName });
        if (!result.canceled && result.filePath) {
            fs.writeFileSync(result.filePath, Buffer.from(fileData));
            return { success: true, filePath: result.filePath };
        }
        return { success: false };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? { success: false } : { success: true, folderPath: result.filePaths[0] };
});

ipcMain.handle('create-directory', async (event, dirPath) => {
    try {
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('save-file-to-path', async (event, filePath, fileData) => {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, Buffer.from(fileData));
        return { success: true, filePath: filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('show-item-in-folder', async (event, filePath) => {
    try {
        shell.showItemInFolder(filePath);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});