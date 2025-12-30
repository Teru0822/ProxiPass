const { ipcRenderer, desktopCapturer, screen } = require('electron');
const os = require('os');
const dgram = require('dgram');
const net = require('net');
const https = require('https');

// --- Configuration & Constants ---
const CONFIG = {
    VERSION: '...', // Will be loaded dynamically from main process
    PORTS: {
        BROADCAST: 45678,
        TRANSFER: 45679
    },
    INTERVALS: {
        BROADCAST: 3000,
        PEER_TIMEOUT: 10000
    },
    GITHUB: {
        BASE_URL: 'https://raw.githubusercontent.com/Teru0822/ProxiPass/main/',
        VERSION_URL: 'https://raw.githubusercontent.com/Teru0822/ProxiPass/main/package.json'
    }
};

// --- Utilities ---
const Utils = {
    getLocalIP() {
        const interfaces = os.networkInterfaces();
        let candidate = '127.0.0.1';
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    // 優先順位: 192.168 > 10. > 172.16 > その他
                    if (iface.address.startsWith('192.168.')) return iface.address;
                    if (iface.address.startsWith('10.')) candidate = iface.address;
                    if (iface.address.startsWith('172.') && !candidate.startsWith('10.')) candidate = iface.address;
                    if (candidate === '127.0.0.1') candidate = iface.address;
                }
            }
        }
        return candidate;
    },

    getNetworkInterfacesInfo() {
        const info = [];
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    info.push({
                        name: name,
                        address: iface.address,
                        netmask: iface.netmask,
                        mac: iface.mac
                    });
                }
            }
        }
        return info;
    },

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    },

    playNotificationSound() {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(600, audioContext.currentTime + 0.1);

            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.2);
        } catch (e) {
            console.warn('Audio play failed:', e);
        }
    },

    readFileAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    },

    getBroadcastAddresses() {
        const list = new Set();
        // Always try global broadcast
        list.add('255.255.255.255');

        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    try {
                        let broadcast;
                        if (iface.netmask) {
                            // Calculate broadcast address using bitwise operations
                            const addr = iface.address.split('.').map(Number);
                            const mask = iface.netmask.split('.').map(Number);
                            broadcast = addr.map((a, i) => (a | (~mask[i] & 255))).join('.');
                        } else {
                            // Fallback: assume /24
                            const parts = iface.address.split('.');
                            parts[3] = '255';
                            broadcast = parts.join('.');
                        }
                        list.add(broadcast);
                    } catch (e) {
                        console.warn('Calculating broadcast failed:', e);
                    }
                }
            }
        }
        const finalArray = Array.from(list);
        console.log('🌐 Broadcast Targets:', finalArray);
        return finalArray;
    }
};

// --- Network Logic Class ---
class NetworkManager {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.myName = '';
        this.myIP = '';
        this.broadcastSocket = null;
        this.transferServer = null;
        this.currentTransfer = null;
    }

    init(name, ip) {
        this.myName = name;
        this.myIP = ip;
        this.setupBroadcast();
        this.setupTransferServer();
        this.startBroadcasting();
    }

    updateName(name) {
        this.myName = name;
        this.broadcast(); // Immediately announce new name
    }

    setupBroadcast() {
        this.broadcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

        this.broadcastSocket.on('error', (err) => console.error('❌ Broadcast Error:', err));

        this.broadcastSocket.on('message', (msg, rinfo) => {
            try {
                const data = JSON.parse(msg.toString());
                if (rinfo.address !== this.myIP && data.type === 'announce') {
                    this.callbacks.onPeerDiscovered(data.name, rinfo.address);
                }
            } catch (err) { }
        });

        this.broadcastSocket.on('listening', () => {
            this.broadcastSocket.setBroadcast(true);
            const address = this.broadcastSocket.address();
            console.log(`✅ Broadcast Listener Ready: ${address.address}:${address.port}`);
        });

        // Bind to all interfaces explicitly
        this.broadcastSocket.bind(CONFIG.PORTS.BROADCAST, '0.0.0.0');
    }

    startBroadcasting() {
        setTimeout(() => this.broadcast(), 100);
        setInterval(() => this.broadcast(), CONFIG.INTERVALS.BROADCAST);
    }

    broadcast() {
        const message = JSON.stringify({
            type: 'announce',
            name: this.myName,
            ip: this.myIP
        });

        // 1. Send to Limited Broadcast Address (255.255.255.255)
        try {
            this.broadcastSocket.send(message, CONFIG.PORTS.BROADCAST, '255.255.255.255');
        } catch (err) { }

        // 2. Send to Directed Broadcast Addresses (e.g. 192.168.1.255)
        // これにより、デフォルトルート以外のインターフェースや特定のネットワーク構成でもパケットが届くようになる
        const addresses = Utils.getBroadcastAddresses();
        addresses.forEach(addr => {
            try {
                this.broadcastSocket.send(message, CONFIG.PORTS.BROADCAST, addr);
            } catch (err) { }
        });
    }

    setupTransferServer() {
        this.transferServer = net.createServer((socket) => {
            let receivedData = Buffer.alloc(0);
            let fileInfo = null;
            let expectedSize = 0;
            let isMessage = false;

            console.log('📥 Connection received:', socket.remoteAddress);

            socket.on('data', (data) => {
                receivedData = Buffer.concat([receivedData, data]);

                if (!fileInfo && receivedData.length >= 4) {
                    const headerSize = receivedData.readUInt32BE(0);

                    if (receivedData.length >= 4 + headerSize) {
                        const headerJSON = receivedData.slice(4, 4 + headerSize).toString('utf8');
                        fileInfo = JSON.parse(headerJSON);

                        if (fileInfo.type === 'message') {
                            isMessage = true;
                            expectedSize = 0;
                            this.callbacks.onMessageReceived(fileInfo);
                            socket.end();
                            return;
                        }

                        expectedSize = fileInfo.size;
                        receivedData = receivedData.slice(4 + headerSize);
                        this.callbacks.onTransferStart(fileInfo.name, fileInfo.size);
                    }
                }

                if (fileInfo && !isMessage && expectedSize > 0) {
                    this.callbacks.onTransferProgress(receivedData.length, expectedSize);
                }
            });

            socket.on('end', async () => {
                if (isMessage) return;

                if (fileInfo && receivedData.length === expectedSize) {
                    this.callbacks.onTransferComplete();
                    const result = await ipcRenderer.invoke('save-file', fileInfo.name, Array.from(receivedData));
                    this.callbacks.onFileSaved(result, fileInfo.name);
                }
            });

            socket.on('error', (err) => {
                console.error('❌ Socket error:', err);
                this.callbacks.onTransferError(err);
            });
        });

        this.transferServer.listen(CONFIG.PORTS.TRANSFER, () => {
            console.log('✅ Transfer Server Ready:', CONFIG.PORTS.TRANSFER);
        });
    }

    cancelTransfer() {
        if (this.currentTransfer) {
            this.currentTransfer.cancelled = true;
        }
    }

    async sendMessageData(targetIP, text, filesData, targetName) {
        return new Promise((resolve, reject) => {
            const client = new net.Socket();
            let connected = false;

            const timeout = setTimeout(() => {
                if (!connected) {
                    client.destroy();
                    reject(new Error('Connection Timeout'));
                }
            }, 10000);

            client.connect(CONFIG.PORTS.TRANSFER, targetIP, () => {
                connected = true;
                clearTimeout(timeout);

                const metadata = {
                    type: 'message',
                    text: text,
                    from: this.myName,
                    timestamp: Date.now(),
                    fileCount: filesData.length,
                    files: filesData
                };

                const headerBuffer = Buffer.from(JSON.stringify(metadata), 'utf8');
                const headerSize = Buffer.alloc(4);
                headerSize.writeUInt32BE(headerBuffer.length, 0);

                client.write(headerSize);
                client.write(headerBuffer, () => {
                    setTimeout(() => client.end(), 100);
                });
            });

            client.on('end', () => resolve());
            client.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    sendFileData(targetIP, file, onChunkSent, onComplete) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const fileData = Buffer.from(e.target.result);
            const fileInfo = { name: file.name, type: file.type, size: file.size };

            const client = net.createConnection({ port: CONFIG.PORTS.TRANSFER, host: targetIP }, () => {
                this.callbacks.onTransferStart(file.name, file.size);

                const headerJSON = JSON.stringify(fileInfo);
                const headerBuffer = Buffer.from(headerJSON, 'utf8');
                const headerSize = Buffer.alloc(4);
                headerSize.writeUInt32BE(headerBuffer.length, 0);

                client.write(headerSize);
                client.write(headerBuffer);

                const CHUNK_SIZE = 64 * 1024;
                let offset = 0;

                const sendChunk = () => {
                    if (this.currentTransfer && this.currentTransfer.cancelled) {
                        client.end();
                        this.callbacks.onTransferCancelled();
                        return;
                    }
                    if (offset >= fileData.length) {
                        client.end();
                        this.callbacks.onTransferComplete();
                        if (onComplete) onComplete();
                        return;
                    }
                    const chunk = fileData.slice(offset, offset + CHUNK_SIZE);
                    client.write(chunk, () => {
                        offset += chunk.length;
                        onChunkSent(offset, fileData.length);
                        setTimeout(sendChunk, 10); // Throttle slightly
                    });
                };

                this.currentTransfer = { cancelled: false };
                sendChunk();
            });

            client.on('error', (err) => {
                this.callbacks.onTransferError(err);
                if (onComplete) onComplete();
            });
        };
        reader.readAsArrayBuffer(file);
    }
}

// --- UI Manager Class ---
class UIManager {
    constructor() {
        this.els = {};
    }

    cacheElements() {
        const ids = [
            'statusText', 'myName', 'peerCount', 'peerList', 'sendBar',
            'selectedCount', 'progressOverlay', 'progressTitle', 'progressFile',
            'progressBar', 'progressText', 'nameModal', 'nameInput',
            'sendModal', 'sendModalTitle', 'messageInput', 'fileAttachSection',
            'fileAttachPlaceholder', 'attachedFileList', 'receivedModal',
            'receivedFrom', 'receivedMessageBody', 'receivedFiles',
            'updateModal', 'updateModalBody', 'appVersion', 'networkInfoBody'
        ];
        ids.forEach(id => this.els[id] = document.getElementById(id));

        // Inputs
        this.fileInput = document.getElementById('fileInput');
        this.attachFileInput = document.getElementById('attachFileInput');
        this.attachFolderInput = document.getElementById('attachFolderInput');

        // Screenshot elements
        this.screenshotOverlay = document.getElementById('screenshotOverlay');
        this.screenshotCanvas = document.getElementById('screenshotCanvas');
    }

    renderPeerList(peers, selectedPeerIPs) {
        this.els.peerCount.textContent = peers.length;

        if (peers.length === 0) {
            this.els.peerList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🔍</div>
                    <div>ネットワーク上にデバイスが見つかりません</div>
                </div>
            `;
        } else {
            this.els.peerList.innerHTML = peers.map(p => `
                <div class="peer-item" id="peer-${p.ip.replace(/\./g, '-')}"
                     ondragover="app.handleDragOver(event, '${p.ip}')"
                     ondragleave="app.handleDragLeave(event, '${p.ip}')"
                     ondrop="app.handleDrop(event, '${p.ip}')">
                    <input type="checkbox" class="peer-checkbox" 
                           ${selectedPeerIPs.has(p.ip) ? 'checked' : ''}
                           onchange="app.togglePeer('${p.ip}')">
                    <div class="peer-info">
                        <div class="peer-avatar">💻</div>
                        <div>
                            <div class="peer-name">${p.name}</div>
                            <div class="peer-ip">${p.ip}</div>
                        </div>
                    </div>
                    <button class="btn btn-send" onclick="app.openSendModal('${p.ip}', '${p.name}')">📤 送信</button>
                </div>
            `).join('');
        }
        this.updateSendBar(selectedPeerIPs.size);
    }

    updateSendBar(count) {
        if (count > 0) {
            this.els.sendBar.classList.add('show');
            this.els.selectedCount.textContent = `${count}人`;
        } else {
            this.els.sendBar.classList.remove('show');
        }
    }

    showProgress(title, fileName, initialSize) {
        this.els.progressTitle.textContent = title;
        this.els.progressFile.textContent = fileName;
        this.updateProgressBar(0, Math.max(1, initialSize));
        this.els.progressOverlay.classList.add('show');
    }

    updateProgressBar(current, total) {
        const percent = Math.round((current / total) * 100);
        this.els.progressBar.style.width = percent + '%';
        this.els.progressBar.textContent = percent + '%';
        this.els.progressText.textContent = `${Utils.formatBytes(current)} / ${Utils.formatBytes(total)}`;
    }

    hideProgress() {
        this.els.progressOverlay.classList.remove('show');
    }

    toggleModal(modalId, show) {
        const modal = this.els[modalId];
        if (show) {
            modal.style.display = 'flex'; // Force flex
            modal.classList.add('active'); // or 'show' depending on CSS
            if (modalId === 'nameModal') modal.classList.add('show');
        } else {
            modal.classList.remove('active');
            modal.classList.remove('show');
            modal.style.display = 'none';
        }
    }

    updateAttachedFileList(attachedFiles) {
        if (attachedFiles.length === 0) {
            this.els.fileAttachPlaceholder.style.display = 'block';
            this.els.attachedFileList.style.display = 'none';
            this.els.fileAttachSection.classList.remove('has-files');
        } else {
            this.els.fileAttachPlaceholder.style.display = 'none';
            this.els.attachedFileList.style.display = 'block';
            this.els.fileAttachSection.classList.add('has-files');

            this.els.attachedFileList.innerHTML = attachedFiles.map((item, index) => {
                const file = item.file || item;
                const path = item.path || file.name;
                const isFolder = item.isFolder || false;
                const icon = isFolder ? '📁' : '📄';
                const className = isFolder ? 'file-item folder' : 'file-item';

                return `
                    <div class="${className}">
                        <div class="file-item-info">
                            <span>${icon}</span>
                            <div>
                                <div class="file-path">${path}</div>
                                <div class="file-size">${Utils.formatBytes(file.size)}</div>
                            </div>
                        </div>
                        <button class="file-remove-btn" onclick="app.removeAttachedFile(${index}); event.stopPropagation();">×</button>
                    </div>
                `;
            }).join('');
        }
    }
}

// --- History Manager Class ---
class HistoryManager {
    constructor() {
        this.history = JSON.parse(localStorage.getItem('p2p_history') || '[]');
        this.container = document.getElementById('historyList');
    }

    addLog(type, targetName, details) {
        const log = {
            type: type, // 'send' or 'receive'
            target: targetName,
            details: details,
            timestamp: Date.now()
        };
        this.history.unshift(log);
        if (this.history.length > 50) this.history.pop();
        this.save();
        this.render();
    }

    save() {
        localStorage.setItem('p2p_history', JSON.stringify(this.history));
    }

    clear() {
        if (confirm('履歴をすべて削除しますか？')) {
            this.history = [];
            this.save();
            this.render();
        }
    }

    render() {
        if (this.history.length === 0) {
            this.container.innerHTML = `
                <div class="empty-state" style="padding: 20px;">
                    <div style="font-size: 20px; margin-bottom: 5px;">📝</div>
                    <div>履歴はありません</div>
                </div>`;
            return;
        }

        this.container.innerHTML = this.history.map(log => {
            const isSend = log.type === 'send';
            const badgeClass = isSend ? 'badge-send' : 'badge-receive';
            const badgeText = isSend ? '送信' : '受信';
            const timeStr = new Date(log.timestamp).toLocaleString('ja-JP', {
                month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            return `
                <div class="history-item">
                    <div class="history-content">
                        <div class="history-header">
                            <span class="history-badge ${badgeClass}">${badgeText}</span>
                            <span class="history-target">${isSend ? 'To: ' : 'From: '} ${log.target}</span>
                        </div>
                        <div class="history-detail">${log.details}</div>
                    </div>
                    <div class="history-time">${timeStr}</div>
                </div>
            `;
        }).join('');
    }
}

// --- Main Application ---
class P2PApp {
    constructor() {
        this.myName = localStorage.getItem('p2p_pc_name') || os.hostname() || 'Unknown PC';
        this.myIP = Utils.getLocalIP();
        this.discoveredPeers = new Map();
        this.selectedPeers = new Set();
        this.attachedFiles = [];
        this.receivedFilesData = [];
        this.currentSendTarget = null;

        this.ui = new UIManager();
        this.history = new HistoryManager(); // Init History
        this.network = new NetworkManager({
            onPeerDiscovered: (name, ip) => this.handlePeerDiscovered(name, ip),
            onMessageReceived: (fileInfo) => this.handleMessageReceived(fileInfo),
            onTransferStart: (name, size) => this.ui.showProgress('📥 受信中...', name, size),
            onTransferProgress: (current, total) => this.ui.updateProgressBar(current, total),
            onTransferComplete: () => this.ui.hideProgress(),
            onFileSaved: (result, name) => {
                Utils.playNotificationSound();
                if (result.success) {
                    // システム通知を表示
                    const notification = new Notification('📄 ファイルを受信しました', {
                        body: `ファイル: ${name}\n保存先: ${result.filePath}`,
                        icon: 'assets/icon.png' // アイコンがあれば
                    });

                    // クリックで保存先フォルダを開く
                    notification.onclick = () => {
                        ipcRenderer.invoke('show-item-in-folder', result.filePath);
                        window.focus();
                    };

                    alert(`✅ ファイル受信完了！\n\nファイル: ${name}\n保存先: ${result.filePath}`);
                }
            },
            onTransferError: (err) => {
                this.ui.hideProgress();
                alert('❌ 通信エラー: ' + err.message);
            },
            onTransferCancelled: () => {
                this.ui.hideProgress();
                console.log('Transfer cancelled');
            }
        });
    }

    async init() {
        // 現在の正式なバージョンを取得 (オーバーレイ対応)
        CONFIG.VERSION = await ipcRenderer.invoke('get-app-version');

        console.log(`🚀 P2P File Share v${CONFIG.VERSION} Started`);
        this.ui.cacheElements();

        // Initial UI State
        this.ui.els.myName.textContent = this.myName;
        this.ui.els.appVersion.textContent = `v${CONFIG.VERSION}`;
        // this.ui.els.statusText.textContent = `待機中 (${this.myIP})`;
        this.history.render(); // Render initial history

        // Start Network
        this.network.init(this.myName, this.myIP);

        // Event Listeners
        this.setupEventListeners();

        // メインプロセスからのアップデート通知を待機
        ipcRenderer.on('update-available', (event, version) => {
            console.log(`🔔 [Update] メインプロセスから新バージョン v${version} の通知を受信しました。`);

            // システム通知を表示
            const notification = new Notification('✨ 新しいバージョンが利用可能です', {
                body: `バージョン ${version} が公開されました。\nクリックして更新してください。`,
                icon: 'assets/icon.png',
                silent: false
            });

            notification.onclick = () => {
                ipcRenderer.send('show-window');
                this.performUpdate(version);
            };

            // アプリ内でも更新処理を開始（モーダル表示）
            this.performUpdate(version);
        });

        // フォーカス通知を受信
        ipcRenderer.on('window-focused', () => {
            console.log('%c✨ アプリにフォーカスされました: アップデートを確認中...', 'color: #00d1b2; font-weight: bold; font-size: 1.2em;');
        });

        // ピアリストの定期更新のみ残す
        setInterval(() => this.updatePeerListUI(), 1000);

        // Expose to global for HTML onclick handlers
        this.exposeGlobals();

        // Request Notification Permission
        if (Notification.permission !== 'granted') {
            Notification.requestPermission();
        }
        if (Notification.permission !== 'granted') {
            Notification.requestPermission();
        }
    }

    // --- UI Control Methods ---
    saveName() {
        const newName = this.ui.els.nameInput.value.trim();
        if (newName) {
            this.myName = newName;
            this.ui.els.myName.textContent = this.myName;
            localStorage.setItem('p2p_pc_name', this.myName);
            this.network.updateName(this.myName);
            this.ui.toggleModal('nameModal', false);
        }
    }

    openNameModal() {
        this.ui.els.nameInput.value = this.myName;
        this.ui.toggleModal('nameModal', true);
        setTimeout(() => this.ui.els.nameInput.focus(), 50);
    }

    closeNameModal() {
        this.ui.toggleModal('nameModal', false);
    }

    openNetworkInfoModal() {
        console.log('ℹ️ Opening Network Info Modal');
        const bodyEl = document.getElementById('networkInfoBody');
        if (!bodyEl) {
            console.error('❌ Network Info Body Element not found');
            alert('内部エラー: 情報表示用の要素が見つかりません。');
            return;
        }

        let infoHtml = `<div style="margin-bottom:15px; padding-bottom:10px; border-bottom:1px solid #eee;">
            <b>📱 アプリステータス:</b> <span style="color:#4ade80; font-weight:bold;">● 動作中 (v${CONFIG.VERSION})</span>
        </div>`;

        infoHtml += '<div class="info-section"><b style="color:#2563eb;">📡 アクティブなネットワークインターフェース:</b><br>';

        const interfaces = Utils.getNetworkInterfacesInfo();
        if (interfaces.length > 0) {
            interfaces.forEach(iface => {
                infoHtml += `
                <div style="background:#f8fafc; padding:8px; margin-top:5px; border-radius:4px; font-size:10px; border:1px solid #e2e8f0;">
                    <div><b>I/F:</b> ${iface.name}</div>
                    <div><b>IP:</b> <span style="font-family:monospace; color:#0f172a;">${iface.address}</span></div>
                    <div><b>Mask:</b> <span style="font-family:monospace; color:#64748b;">${iface.netmask}</span></div>
                    <div><b>MAC:</b> <span style="font-family:monospace; color:#64748b;">${iface.mac}</span></div>
                </div>`;
            });
        } else {
            infoHtml += '<div style="color:orange; margin-top:5px;">※ 有効なIPv4インターフェースが見つかりません</div>';
        }
        infoHtml += '</div>';

        infoHtml += '<div class="info-section" style="margin-top:15px;"><b>📢 ブロードキャスト送信ターゲット:</b><br>';
        const broadcasts = Utils.getBroadcastAddresses();
        if (broadcasts.length > 0) {
            broadcasts.forEach(addr => {
                infoHtml += `<span style="font-family:monospace; margin-left:10px; display:block; color:#059669;">Target: ${addr}</span>`;
            });
        } else {
            infoHtml += '<span style="color:orange; margin-left:10px;">- なし</span>';
        }
        infoHtml += '</div>';

        infoHtml += '<div class="info-section" style="margin-top:15px; padding-top:10px; border-top:1px solid #eee;"><b>🔌 ポート状態:</b><br>';
        infoHtml += `<span style="font-family:monospace; margin-left:10px;">UDP (Discovery): ${CONFIG.PORTS.BROADCAST}</span><br>`;
        infoHtml += `<span style="font-family:monospace; margin-left:10px;">TCP (Transfer) : ${CONFIG.PORTS.TRANSFER}</span></div>`;

        bodyEl.innerHTML = infoHtml;
        this.ui.toggleModal('networkInfoModal', true);
    }

    closeNetworkInfoModal() {
        this.ui.toggleModal('networkInfoModal', false);
    }

    exposeGlobals() {
        // Bind methods to window.app instead of polluting global namespace directly
        // But for compatibility with minimal HTML changes, we'll map them
        // Actually, I'll update the HTML to use `app.methodName()`
    }

    setupEventListeners() {
        this.ui.els.nameInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.saveName();
        });

        const handleFiles = (e, isFolder) => {
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            if (isFolder) {
                const folderFiles = files.map(file => ({
                    file: file,
                    path: (file.webkitRelativePath || file.name).replace(/\\/g, '/'),
                    isFolder: true
                }));
                this.attachedFiles.push(...folderFiles);
            } else {
                this.attachedFiles.push(...files);
            }
            this.ui.updateAttachedFileList(this.attachedFiles);
            e.target.value = '';
        };

        this.ui.attachFileInput.addEventListener('change', (e) => handleFiles(e, false));
        this.ui.attachFolderInput.addEventListener('change', (e) => handleFiles(e, true));
    }

    // --- Peer Management ---
    handlePeerDiscovered(name, ip) {
        this.discoveredPeers.set(ip, {
            name: name,
            ip: ip,
            lastSeen: Date.now()
        });
        this.updatePeerListUI();
    }

    updatePeerListUI() {
        const now = Date.now();
        for (const [ip, peer] of this.discoveredPeers) {
            if (now - peer.lastSeen > CONFIG.INTERVALS.PEER_TIMEOUT) {
                this.discoveredPeers.delete(ip);
                this.selectedPeers.delete(ip);
            }
        }
        const peers = Array.from(this.discoveredPeers.values());
        this.ui.renderPeerList(peers, this.selectedPeers);
    }

    compareVersions(v1, v2) {
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

    async performUpdate(newVersion) {
        // 二重実行・重複通知防止
        if (this.isUpdating) return;
        if (this.lastNotifiedVersion === newVersion) return;
        this.lastNotifiedVersion = newVersion;

        console.log(`🔔 アプリ内アップデートポップアップを表示: ${newVersion}`);

        this.ui.els.updateModalBody.innerHTML = `
            新しいバージョン <b>(${newVersion})</b> が公開されました。<br>
            現在のバージョン: ${CONFIG.VERSION}<br><br>
            「今すぐ更新」をクリックすると、最新のデータをダウンロードしてアプリを再起動します。
        `;
        this.ui.toggleModal('updateModal', true);
    }

    startUpdateFromModal() {
        this.ui.toggleModal('updateModal', false);
        this.executeAutoUpdate(this.lastNotifiedVersion);
    }

    async executeAutoUpdate(newVersion) {
        if (this.isUpdating) return;
        this.isUpdating = true;

        this.ui.showProgress('🚀 アップデート中...', '最新データをダウンロードしています', 100);

        const filesToUpdate = ['index.html', 'renderer.js', 'styles.css', 'main.js', 'package.json'];
        let successCount = 0;
        let errors = [];

        for (const file of filesToUpdate) {
            try {
                this.ui.updateProgressBar(successCount + 1, filesToUpdate.length);
                this.ui.els.progressText.textContent = `ダウンロード中: ${file}`;

                const url = CONFIG.GITHUB.BASE_URL + file + '?t=' + Date.now();
                const result = await ipcRenderer.invoke('download-update', url, file);

                if (result.success) {
                    successCount++;
                } else {
                    console.error(`Failed to update ${file}:`, result.error);
                    errors.push(`${file}: ${result.error}`);
                }
            } catch (err) {
                console.error(`Error updating ${file}:`, err);
                errors.push(`${file}: ${err.message}`);
            }
        }

        this.ui.hideProgress();

        if (successCount === filesToUpdate.length) {
            // 全ファイル成功
            ipcRenderer.invoke('restart-app');
        } else if (successCount > 0) {
            // 一部成功 (不整合の可能性があるが継続を打診)
            const proceed = confirm(`⚠️ 一部のファイルの更新に失敗しました。\n\nエラー内容:\n${errors.join('\n')}\n\nこのまま再起動しますか？（推奨しません）`);
            if (proceed) {
                ipcRenderer.invoke('restart-app');
            } else {
                this.isUpdating = false;
            }
        } else {
            // 全滅
            alert(`❌ アップデートに失敗しました。\n\n主な原因:\n${errors.join('\n')}`);
            this.isUpdating = false;
        }
    }

    togglePeer(ip) {
        if (this.selectedPeers.has(ip)) this.selectedPeers.delete(ip);
        else this.selectedPeers.add(ip);
        this.ui.updateSendBar(this.selectedPeers.size);
    }

    clearSelection() {
        this.selectedPeers.clear();
        this.updatePeerListUI();
    }

    // --- Send Logic ---
    sendToSelected() {
        if (this.selectedPeers.size === 0) return alert('送信先を選択してください');

        if (this.selectedPeers.size === 1) {
            const targetIP = Array.from(this.selectedPeers)[0];
            const peer = this.discoveredPeers.get(targetIP);
            this.openSendModal(targetIP, peer.name);
        } else {
            // Bulk file send
            const fileInput = this.ui.fileInput;
            fileInput.onchange = (e) => {
                const files = Array.from(e.target.files);
                if (files.length > 0) {
                    this.sendFilesToMultiple(Array.from(this.selectedPeers), files);
                }
                e.target.value = '';
            };
            fileInput.click();
        }
    }

    openSendModal(ip, name) {
        this.currentSendTarget = { ip, name };
        this.ui.els.sendModalTitle.textContent = `${name} へ送信`;
        this.ui.toggleModal('sendModal', true);
        this.attachedFiles = [];
        this.ui.updateAttachedFileList([]);
        this.ui.els.messageInput.value = '';
        setTimeout(() => this.ui.els.messageInput.focus(), 50);
    }

    closeSendModal() {
        this.ui.toggleModal('sendModal', false);
        this.currentSendTarget = null;
        this.attachedFiles = [];
    }

    async sendMessage() {
        const text = this.ui.els.messageInput.value.trim();
        if (!text && this.attachedFiles.length === 0) return alert('メッセージまたはファイルを指定してください');
        if (!this.currentSendTarget) return;

        const { ip, name } = this.currentSendTarget;
        const filesToSend = [...this.attachedFiles];
        this.closeSendModal();

        try {
            this.ui.showProgress('📤 送信中...', `${name} にメッセージを送信しています`, 0);

            const filesData = [];
            for (const item of filesToSend) {
                const file = item.file || item;
                const path = item.path || file.name;
                const data = await Utils.readFileAsArrayBuffer(file);
                filesData.push({
                    name: file.name,
                    path: path,
                    type: file.type,
                    size: file.size,
                    data: Array.from(new Uint8Array(data)),
                    isFolder: item.isFolder || false
                });
            }

            await this.network.sendMessageData(ip, text, filesData, name);

            // 履歴に追加
            let details = text;
            if (filesData.length > 0) {
                const fileSummary = filesData.length === 1 ? filesData[0].name : `${filesData.length}個のファイル`;
                details = text ? `${text} (📎 ${fileSummary})` : `📎 ${fileSummary}`;
            }
            this.history.addLog('send', name, details);

            this.ui.hideProgress();
            alert('✅ 送信完了！');
        } catch (err) {
            this.ui.hideProgress();
            alert('❌ 送信エラー: ' + err.message);
        }
    }

    sendFilesToMultiple(targets, files) {
        let targetIndex = 0, fileIndex = 0;

        const sendNext = () => {
            if (targetIndex >= targets.length) {
                return alert(`✅ 全送信完了！\n\n送信先: ${targets.length}台\nファイル数: ${files.length}`);
            }
            if (fileIndex >= files.length) {
                targetIndex++;
                fileIndex = 0;
                return setTimeout(sendNext, 500);
            }

            this.network.sendFileData(targets[targetIndex], files[fileIndex],
                (current, total) => this.ui.updateProgressBar(current, total),
                () => {
                    fileIndex++;
                    setTimeout(sendNext, 500);
                }
            );
        };
        sendNext();
    }

    // --- Receive Logic ---
    handleMessageReceived(info) {
        Utils.playNotificationSound();

        // 履歴に追加
        let details = info.text || '';
        if (info.files && info.files.length > 0) {
            const fileSummary = info.files.length === 1 ? info.files[0].name : `${info.files.length}個のファイル`;
            details = details ? `${details} (📎 ${fileSummary})` : `📎 ${fileSummary}`;
        }
        if (!details) details = '（メッセージなし）';

        this.history.addLog('receive', info.from, details);

        // システム通知を表示
        const notification = new Notification('📨 メッセージが届きました', {
            body: `From: ${info.from}\n${info.text || (info.files ? 'ファイルが添付されています' : '')}`,
        });

        notification.onclick = () => {
            ipcRenderer.send('show-window'); // メインプロセスにウィンドウ表示を依頼
            window.focus();
            this.ui.toggleModal('receivedModal', true);
        };

        this.ui.els.receivedFrom.textContent = `From: ${info.from}`;
        this.ui.els.receivedMessageBody.textContent = info.text || '（メッセージなし）';

        this.receivedFilesData = info.files || [];
        this.renderReceivedFiles(this.receivedFilesData);
        this.ui.toggleModal('receivedModal', true);
    }

    renderReceivedFiles(files) {
        const container = this.ui.els.receivedFiles;
        if (!files || files.length === 0) {
            container.innerHTML = '';
            return;
        }

        const folders = {};
        const standaloneFiles = [];

        files.forEach((file, index) => {
            if (file.path && file.path.includes('/')) {
                const folderName = file.path.split('/')[0];
                if (!folders[folderName]) folders[folderName] = [];
                folders[folderName].push({ file, index });
            } else {
                standaloneFiles.push({ file, index });
            }
        });

        let html = '';
        Object.keys(folders).forEach(folderName => {
            const folderFiles = folders[folderName];
            const totalSize = folderFiles.reduce((sum, item) => sum + item.file.size, 0);
            html += `
                <div class="received-file-item folder">
                    <div>
                        <div style="font-weight:bold;">📁 ${folderName}</div>
                        <div style="font-size:12px;color:#666;">${folderFiles.length}個 (${Utils.formatBytes(totalSize)})</div>
                    </div>
                    <button class="received-file-save-btn" onclick="app.saveFolderFiles('${folderName}')">💾 フォルダ保存</button>
                </div>`;
        });

        standaloneFiles.forEach(({ file, index }) => {
            html += `
                <div class="received-file-item">
                    <div>
                        <div style="font-weight:bold;">📄 ${file.name}</div>
                        <div style="font-size:12px;color:#666;">${Utils.formatBytes(file.size)}</div>
                    </div>
                    <button class="received-file-save-btn" onclick="app.saveReceivedFile(${index})">💾 保存</button>
                </div>`;
        });

        container.innerHTML = `<div style="margin-top:15px;padding-top:15px;border-top:1px solid #e5e7eb;">
            <div style="font-weight:bold;margin-bottom:10px;">📎 添付ファイル</div>${html}</div>`;
    }

    async saveReceivedFile(index) {
        const file = this.receivedFilesData[index];
        if (!file) return;
        try {
            const result = await ipcRenderer.invoke('save-file', file.name, file.data);
            if (result.success) alert(`✅ 保存完了！\n${result.filePath}`);
        } catch (err) { alert('❌ 保存エラー: ' + err.message); }
    }

    async saveFolderFiles(folderName) {
        const folderFiles = this.receivedFilesData.filter(f => f.path && f.path.startsWith(folderName + '/'));
        if (folderFiles.length === 0) return;

        try {
            const result = await ipcRenderer.invoke('select-folder');
            if (!result.success) return;

            let savedCount = 0;
            for (const file of folderFiles) {
                const saveResult = await ipcRenderer.invoke('save-file-to-path', `${result.folderPath}/${file.path}`, file.data);
                if (saveResult.success) savedCount++;
            }
            alert(`✅ 保存完了！\n${savedCount}ファイルを保存しました`);
        } catch (err) { alert('❌ 保存エラー: ' + err.message); }
    }

    closeReceivedModal() {
        this.ui.toggleModal('receivedModal', false);
    }

    copyReceivedMessage() {
        const text = this.ui.els.receivedMessageBody.textContent;
        if (text) navigator.clipboard.writeText(text).then(() => alert('✅ コピーしました'));
    }

    // --- Name Edit ---
    openNameModal() {
        this.ui.els.nameInput.value = this.myName;
        this.ui.toggleModal('nameModal', true);
        this.ui.els.nameInput.focus();
    }

    closeNameModal() {
        this.ui.toggleModal('nameModal', false);
    }

    saveName() {
        const newName = this.ui.els.nameInput.value.trim();
        if (newName) {
            this.myName = newName;
            localStorage.setItem('p2p_pc_name', newName);
            this.ui.els.myName.textContent = newName;
            this.network.updateName(newName);
            this.closeNameModal();
        }
    }

    // --- Drag & Drop Wrappers ---
    handleDragOver(e, ip) {
        e.preventDefault(); e.stopPropagation();
        document.getElementById('peer-' + ip.replace(/\./g, '-')).classList.add('drag-over');
    }
    handleDragLeave(e, ip) {
        e.preventDefault();
        document.getElementById('peer-' + ip.replace(/\./g, '-')).classList.remove('drag-over');
    }
    handleDrop(e, ip) {
        e.preventDefault(); e.stopPropagation();
        document.getElementById('peer-' + ip.replace(/\./g, '-')).classList.remove('drag-over');
        const files = [];
        if (e.dataTransfer.items) {
            for (let i = 0; i < e.dataTransfer.items.length; i++) {
                if (e.dataTransfer.items[i].kind === 'file') files.push(e.dataTransfer.items[i].getAsFile());
            }
        }
        if (files.length > 0) this.sendFilesToMultiple([ip], files);
    }

    handleFileAttachDragOver(e) {
        e.preventDefault(); e.stopPropagation();
        this.ui.els.fileAttachSection.style.borderColor = '#667eea';
        this.ui.els.fileAttachSection.style.background = '#f9fafb';
    }
    handleFileAttachDragLeave(e) {
        e.preventDefault(); e.stopPropagation();
        this.ui.updateAttachedFileList(this.attachedFiles); // Reset styles
    }
    handleFileAttachDrop(e) {
        e.preventDefault(); e.stopPropagation();
        const files = Array.from(e.dataTransfer.files);
        this.attachedFiles.push(...files);
        this.ui.updateAttachedFileList(this.attachedFiles);
    }

    removeAttachedFile(index) {
        this.attachedFiles.splice(index, 1);
        this.ui.updateAttachedFileList(this.attachedFiles);
    }

    cancelTransfer() {
        this.network.cancelTransfer();
        this.ui.hideProgress();
    }

    // --- Screenshot Logic ---
    async startScreenshotMode() {
        // 現在のウィンドウを少し隠すなどの処理があればここで行うが、今回はキャプチャ待ちする
        console.log('📸 スクリーンショットモード開始: 画面キャプチャを準備中...');

        // メインプロセスにウィンドウ最小化を依頼しても良いが、ここではシンプルに500ms待ってから撮る
        // 本来はウィンドウを非表示にしてから撮るのが望ましい

        const currentWindow = require('electron').remote?.getCurrentWindow() || { minimize: () => { }, restore: () => { }, focus: () => { } };
        // remoteが使えない環境(contextIsolation: falseならrequire('electron').remoteはundefinedになるかも)
        // 今回の環境設定では ipcRenderer.invoke('minimize-window') が良さそうだが、ハンドラがないので省略
        // ユーザーがウィンドウをどかす時間を考慮して少し待つか、ウィンドウを含めて撮るか。
        // ここでは「現在の画面」をそのまま撮る。

        try {
            // Get screen sources
            const inputSources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 1920, height: 1080 } // 仮サイズ、実際は画面サイズに合わせるべき
            });

            // Primary display setup
            const primarySource = inputSources[0]; // 単純化のため1つ目を選択

            // Full resolution capture
            const constraints = {
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: primarySource.id,
                        minWidth: 1280,
                        maxWidth: 4000,
                        minHeight: 720,
                        maxHeight: 2160
                    }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            const videoTrack = stream.getVideoTracks()[0];
            const { width, height } = videoTrack.getSettings();

            // Draw video frame to canvas
            const video = document.createElement('video');
            video.srcObject = stream;
            video.play();

            await new Promise(resolve => video.onloadedmetadata = resolve);

            // キャンバスサイズ設定
            this.ui.screenshotCanvas.width = width;
            this.ui.screenshotCanvas.height = height;

            // 描画
            const ctx = this.ui.screenshotCanvas.getContext('2d');
            ctx.drawImage(video, 0, 0, width, height);

            // ストリーム停止
            videoTrack.stop();

            // オーバーレイ表示
            this.ui.screenshotOverlay.style.display = 'block';
            this.screenshotImage = ctx.getImageData(0, 0, width, height); // 元データを保存

            // 矩形選択の初期化
            this.initScreenshotSelection(ctx, width, height);

        } catch (e) {
            console.error('Screenshot failed:', e);
            alert('スクリーンショットの取得に失敗しました: ' + e.message);
        }
    }

    initScreenshotSelection(ctx, width, height) {
        let isDrawing = false;
        let startX = 0;
        let startY = 0;
        let endX = 0;
        let endY = 0;

        const canvas = this.ui.screenshotCanvas;

        // 再描画用関数
        const draw = () => {
            // 元画像を描画
            ctx.putImageData(this.screenshotImage, 0, 0);

            // 暗くするオーバーレイ (全画面半透明黒)
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(0, 0, width, height);

            // 選択範囲をクリア (元の明るい画像を表示)
            // 選択範囲の座標計算
            const rectX = Math.min(startX, endX);
            const rectY = Math.min(startY, endY);
            const rectW = Math.abs(endX - startX);
            const rectH = Math.abs(endY - startY);

            if (rectW > 0 && rectH > 0) {
                // クリップして元画像を描画し直すことで「そこだけ明るい」を実現
                ctx.save();
                ctx.beginPath();
                ctx.rect(rectX, rectY, rectW, rectH);
                ctx.clip();
                ctx.putImageData(this.screenshotImage, 0, 0);

                // 枠線
                ctx.strokeStyle = '#00ff00';
                ctx.lineWidth = 2;
                ctx.strokeRect(rectX, rectY, rectW, rectH);
                ctx.restore();
            }

            this.selectionRect = { x: rectX, y: rectY, w: rectW, h: rectH };
        };

        // イベントリスナー (一度だけ設定するため、onを使って上書きするか、removeEventListenerが必要)
        canvas.onmousedown = (e) => {
            isDrawing = true;
            const rect = canvas.getBoundingClientRect();
            // 画面上の表示サイズとCanvas実サイズの比率計算
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;

            startX = (e.clientX - rect.left) * scaleX;
            startY = (e.clientY - rect.top) * scaleY;
            endX = startX;
            endY = startY;
            draw();
        };

        canvas.onmousemove = (e) => {
            if (!isDrawing) return;
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;

            endX = (e.clientX - rect.left) * scaleX;
            endY = (e.clientY - rect.top) * scaleY;
            draw();
        };

        canvas.onmouseup = () => {
            isDrawing = false;
        };

        // 初期描画（全体を暗く）
        draw();
    }

    confirmScreenshot() {
        if (!this.selectionRect || this.selectionRect.w === 0 || this.selectionRect.h === 0) {
            return alert('範囲を選択してください');
        }

        const { x, y, w, h } = this.selectionRect;

        // 切り抜き用キャンバス作成
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = w;
        cropCanvas.height = h;
        const cropCtx = cropCanvas.getContext('2d');

        cropCtx.putImageData(this.screenshotImage, -x, -y, x, y, w, h);

        // Blob化して添付ファイルに追加
        cropCanvas.toBlob((blob) => {
            const file = new File([blob], `screenshot_${Date.now()}.png`, { type: 'image/png' });
            this.attachedFiles.push({
                file: file,
                path: file.name,
                isFolder: false
            });
            this.ui.updateAttachedFileList(this.attachedFiles);
            this.cancelScreenshot(); // オーバーレイを閉じる
        }, 'image/png');
    }

    cancelScreenshot() {
        this.ui.screenshotOverlay.style.display = 'none';
        this.screenshotImage = null;
        this.selectionRect = null;
    }

    clearHistory() {
        this.history.clear();
    }
}

// Initialize
const app = new P2PApp();
window.app = app; // Expose to window for inline HTML events
document.addEventListener('DOMContentLoaded', async () => await app.init());
