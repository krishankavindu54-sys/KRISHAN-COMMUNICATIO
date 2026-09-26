
// Database Initialization
const db = new Dexie('KrishanPOS_DB');
db.version(1).stores({
    items: '++id, name, barcode, category, type', // type: 'product' | 'service'
    repairs: '++id, customerName, phoneModel, status, createdAt',
    sales: '++id, date, total, paymentMethod', // date is ISO string
    expenses: '++id, date, category',
    creditors: '++id, name, amount, lastUpdated, type' // type: 'payable' | 'receivable'
});

// Update for versioning if needed - strictly keeping v1 for simplicity unless migration needed.
// Dexie handles schema changes dynamically often, but best practice is versioning.
// Since we are adding a store, we can just add it to the existing definition if the DB hasn't been blocked.
// However, the cleanest way for a running app is to bump version.
db.version(2).stores({
    items: '++id, name, barcode, category, type',
    repairs: '++id, customerName, phoneModel, status, createdAt',
    sales: '++id, date, total, paymentMethod',
    expenses: '++id, date, category',
    creditors: '++id, name, amount, lastUpdated, type'
});

db.version(5).stores({
    items: '++id, name, barcode, category, type',
    repairs: '++id, customerName, phoneModel, status, createdAt',
    sales: '++id, date, total, paymentMethod',
    expenses: '++id, date, category',
    creditors: '++id, name, amount, lastUpdated, type',
    categorySettings: 'name',
    bankTransactions: '++id, date, type, amount, note',
    suppliers: '++id, name, company',
    purchaseBills: '++id, supplierId, date, status'
});

db.version(6).stores({
    items: '++id, name, barcode, category, type',
    repairs: '++id, customerName, phoneModel, status, createdAt',
    sales: '++id, date, total, paymentMethod',
    expenses: '++id, date, category',
    creditors: '++id, name, amount, lastUpdated, type',
    categorySettings: 'name',
    bankTransactions: '++id, date, type, amount, note',
    suppliers: '++id, name, company',
    purchaseBills: '++id, supplierId, date, status',
    photoFrames: '++id, customerName, size, frameType, status, dueDate, createdAt'
});

// Seed initial data if empty
db.on('populate', () => {
    db.items.bulkAdd([
        { name: "Photocopy (A4)", category: "Service", type: "service", price: 10, cost: 2, barcode: "SERV001", stock: 0 },
        { name: "Passport Photo", category: "Studio", type: "service", price: 350, cost: 50, barcode: "SERV002", stock: 0 },
        { name: "Tempered Glass", category: "Accessories", type: "product", price: 500, cost: 150, barcode: "ACC001", stock: 20, minStock: 5 },
        { name: "CR Books", category: "Stationery", type: "product", price: 250, cost: 180, barcode: "STAT001", stock: 50, minStock: 10 }
    ]);
});

// App Logic
const app = {
    state: {
        cart: [],
        currentView: 'dashboard',
        posCategory: null, // null means "Category Selection Mode"
        inventoryCategory: 'All',
        lastAddedCategory: 'General', // Default for new items
        selectedCreditor: null, // For POS credit sales
        whatsapp: {
            connected: false,
            status: 'disconnected',
            qr: null,
            user: null,
            modalOpen: false
        }
    },
    whatsapp: {
        connected: false,
        status: 'disconnected',
        qr: null,
        user: null,
        modalOpen: false
    },

    getServerUrl: () => {
        const saved = localStorage.getItem('krishan_pos_custom_server_url');
        if (saved && saved.trim()) {
            return saved.trim().replace(/\/+$/, '');
        }
        if (window.location.protocol === 'file:' || (window.location.port !== '3000' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))) {
            return 'http://localhost:3000';
        }
        if (window.location.hostname.endsWith('github.io')) {
            return saved ? saved.trim().replace(/\/+$/, '') : '';
        }
        return window.location.origin;
    },

    getApiBase: () => {
        return app.getServerUrl() || '';
    },

    playChime: () => {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
            osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08); // A5
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);
        } catch (e) {}
    },

    getApiUrl: (path) => {
        const serverUrl = app.getServerUrl();
        const cleanPath = path.startsWith('/') ? path : '/' + path;
        if (serverUrl) {
            return `${serverUrl}${cleanPath}`;
        }
        return cleanPath;
    },

    getAuthHeaders: (customHeaders = {}) => {
        const headers = { 'Content-Type': 'application/json', ...customHeaders };
        const token = localStorage.getItem('pos_token');
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        const socketId = app.realtime?.getSocketId?.();
        if (socketId) {
            headers['x-socket-id'] = socketId;
        }
        return headers;
    },

    currentUser: null,

    // Realtime Multi-Device Sync Engine (Socket.io + HTTP Polling Fallback + IndexedDB)
    realtime: {
        socket: null,
        status: 'connecting', // 'connected' | 'syncing' | 'offline'
        syncMode: 'websocket', // 'websocket' | 'polling'
        deviceCount: 1,
        lastSyncTime: null,
        pendingQueue: JSON.parse(localStorage.getItem('pos_offline_queue') || '[]'),
        pollingInterval: null,
        keepAliveInterval: null,

        init: () => {
            app.realtime.startKeepAlive();
            const serverUrl = app.getServerUrl();
            const isVercel = window.location.hostname.includes('vercel.app') || 
                             window.location.hostname.includes('vercel') ||
                             (window.location.protocol === 'https:' && !window.location.hostname.includes('localhost'));
            const isGitHubPages = window.location.hostname.endsWith('github.io');

            // On Vercel (Serverless REST cloud), start Cloud REST Polling Sync immediately
            if (isVercel || (!serverUrl && isGitHubPages)) {
                console.log('⚡ [Realtime] Initializing Cloud REST Sync Engine for Vercel/Cloud...');
                app.realtime.syncMode = 'polling';
                app.realtime.setStatus('connected');
                app.realtime.startPollingFallback();
                app.syncWithBackend(false);
                return;
            }

            try {
                if (typeof io === 'undefined') {
                    console.warn('Socket.io library not detected. Starting HTTP Cloud Polling fallback.');
                    app.realtime.syncMode = 'polling';
                    app.realtime.setStatus('connected');
                    app.realtime.startPollingFallback();
                    app.syncWithBackend(false);
                    return;
                }

                const socketUrl = serverUrl || window.location.origin;

                const socket = io(socketUrl, {
                    reconnection: true,
                    reconnectionAttempts: 5,
                    reconnectionDelay: 2000,
                    reconnectionDelayMax: 10000,
                    timeout: 10000,
                    transports: ['websocket', 'polling']
                });

                app.realtime.socket = socket;

                socket.on('connect', () => {
                    console.log('⚡ [Realtime] Connected to POS WebSocket, Socket ID:', socket.id);
                    app.realtime.syncMode = 'websocket';
                    app.realtime.setStatus('connected');
                    app.realtime.flushOfflineQueue();
                    app.syncWithBackend(true);
                });

                socket.on('disconnect', (reason) => {
                    console.warn('🔌 [Realtime] WebSocket disconnected (switching to HTTP Cloud Polling):', reason);
                    app.realtime.syncMode = 'polling';
                    app.realtime.setStatus('connected');
                    app.realtime.startPollingFallback();
                });

                socket.on('connect_error', (err) => {
                    console.warn('⚠️ [Realtime] WebSocket connection issue (using HTTP Cloud Polling):', err?.message);
                    app.realtime.syncMode = 'polling';
                    app.realtime.setStatus('connected');
                    app.realtime.startPollingFallback();
                });

                socket.on('sync:welcome', (data) => {
                    if (data && data.deviceCount !== undefined) {
                        app.realtime.deviceCount = data.deviceCount;
                        app.realtime.updateStatusUI();
                    }
                });

                socket.on('sync:device_count', (data) => {
                    if (data && data.count !== undefined) {
                        app.realtime.deviceCount = data.count;
                        app.realtime.updateStatusUI();
                    }
                });

                socket.on('sync:event', (event) => {
                    app.realtime.handleIncomingEvent(event);
                });

                socket.on('whatsapp:status', (data) => {
                    app.updateWhatsAppStatus(data);
                });

            } catch (err) {
                console.error('Socket init error:', err);
                app.realtime.syncMode = 'polling';
                app.realtime.setStatus('connected');
                app.realtime.startPollingFallback();
            }
        },

        // Cloud Keep-Alive: Sends ping for persistent VPS/Render servers (skipped on Vercel serverless)
        startKeepAlive: () => {
            if (app.realtime.keepAliveInterval) clearInterval(app.realtime.keepAliveInterval);
            // Serverless platforms like Vercel do not require keepalive pings
            const isVercel = window.location.hostname.includes('vercel');
            if (isVercel) return;

            app.realtime.keepAliveInterval = setInterval(async () => {
                if (!localStorage.getItem('pos_token')) return; // Only ping if authenticated
                const targetUrl = app.getApiUrl('/api/auth/me');
                try {
                    await fetch(targetUrl, { method: 'GET', headers: app.getAuthHeaders(), credentials: 'include' });
                } catch (e) {
                    // Ignore background ping errors
                }
            }, 30000);
        },

        // HTTP Cloud Polling Fallback (ensures Vercel Serverless / Free Cloud stays 100% Live with realtime stock sync)
        startPollingFallback: () => {
            if (app.realtime.pollingInterval) return; // Already polling

            console.log('🔄 [Realtime] Started HTTP Cloud Polling & Stock Sync fallback...');
            let isSyncing = false;

            const executePoll = async () => {
                if (isSyncing) return;
                isSyncing = true;
                try {
                    const targetUrl = app.getApiUrl('/api/items');
                    const res = await fetch(targetUrl, { method: 'GET', headers: app.getAuthHeaders(), credentials: 'include' });
                    if (res.ok) {
                        const serverItems = await res.json();
                        if (Array.isArray(serverItems)) {
                            let hasChanges = false;
                            const localItems = await db.items.toArray();
                            const localMap = new Map(localItems.map(i => [i.id, i]));

                            for (const sItem of serverItems) {
                                const lItem = localMap.get(sItem.id);
                                if (!lItem || lItem.stock !== sItem.stock || lItem.price !== sItem.price || lItem.name !== sItem.name) {
                                    await db.items.put(sItem);
                                    hasChanges = true;
                                }
                            }

                            // If stock or items changed, immediately update UI without disrupting inputs
                            if (hasChanges) {
                                console.log('⚡ [Cloud Stock Sync] Live stock change synced from cloud, updating view...');
                                if (app.state.currentView === 'pos') app.renderPOS();
                                if (app.state.currentView === 'products') app.renderInventory();
                                if (app.state.currentView === 'dashboard') app.renderDashboard();
                            }

                            app.realtime.syncMode = 'polling';
                            app.realtime.setStatus('connected');
                            app.realtime.lastSyncTime = new Date();

                            // Also flush offline queue if any
                            if (app.realtime.pendingQueue.length > 0) {
                                await app.realtime.flushOfflineQueue();
                            }
                        }
                    } else if (res.status === 401) {
                        // Backend is active and responded
                        app.realtime.syncMode = 'polling';
                        app.realtime.setStatus('connected');
                    }
                } catch (err) {
                    console.warn('Polling check:', err?.message);
                } finally {
                    isSyncing = false;
                }
            };

            // Run first poll immediately
            executePoll();
            app.realtime.pollingInterval = setInterval(executePoll, 2500);
        },

        setStatus: (status) => {
            app.realtime.status = status;
            app.realtime.updateStatusUI();
        },

        updateStatusUI: () => {
            const widget = document.getElementById('realtime-sync-widget');
            const pulse = document.getElementById('sync-pulse');
            const dot = document.getElementById('sync-dot');
            const text = document.getElementById('sync-status-text');
            const badge = document.getElementById('sync-device-badge');

            if (!widget) return;

            const count = app.realtime.deviceCount || 1;
            const mode = app.realtime.syncMode || 'websocket';

            if (app.realtime.status === 'connected') {
                widget.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-bold cursor-pointer transition-all hover:scale-105 shadow-sm';
                if (pulse) pulse.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75';
                if (dot) dot.className = 'relative inline-flex rounded-full h-2 w-2 bg-emerald-500';
                if (text) text.textContent = mode === 'polling' ? 'Cloud Live' : 'Live';
                if (badge) {
                    badge.textContent = mode === 'polling' ? 'Cloud Sync' : (count > 1 ? `${count} devices` : 'Live');
                    badge.className = 'px-1.5 py-0.2 rounded-full bg-emerald-200/60 dark:bg-emerald-800/60 text-[10px]';
                }
                widget.title = `Realtime Live Sync Active (${mode === 'polling' ? 'HTTP Cloud Sync' : count + ' connected device(s)'}). Click for details.`;
            } else if (app.realtime.status === 'syncing') {
                widget.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-xs font-bold cursor-pointer transition-all hover:scale-105 shadow-sm';
                if (pulse) pulse.className = 'animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75';
                if (dot) dot.className = 'relative inline-flex rounded-full h-2 w-2 bg-amber-500';
                if (text) text.textContent = 'Syncing...';
                if (badge) {
                    badge.textContent = '...';
                    badge.className = 'px-1.5 py-0.2 rounded-full bg-amber-200/60 dark:bg-amber-800/60 text-[10px]';
                }
                widget.title = 'Synchronizing with server...';
            } else {
                // Offline
                widget.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-xs font-bold cursor-pointer transition-all hover:scale-105 shadow-sm';
                if (pulse) pulse.className = 'hidden';
                if (dot) dot.className = 'relative inline-flex rounded-full h-2 w-2 bg-rose-500';
                if (text) text.textContent = 'Offline';
                if (badge) {
                    const qCount = app.realtime.pendingQueue.length;
                    badge.textContent = qCount > 0 ? `${qCount} queued` : 'Local';
                    badge.className = 'px-1.5 py-0.2 rounded-full bg-rose-200/60 dark:bg-rose-800/60 text-[10px]';
                }
                widget.title = 'Offline mode (Working locally). Click for diagnostics & Server URL setup.';
            }
        },

        getSocketId: () => {
            return app.realtime.socket?.id || null;
        },

        queueOfflineMutation: (type, targetId, payload) => {
            const op = {
                id: 'op_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                type,
                targetId,
                payload,
                queuedAt: new Date().toISOString()
            };
            app.realtime.pendingQueue.push(op);
            localStorage.setItem('pos_offline_queue', JSON.stringify(app.realtime.pendingQueue));
            app.realtime.updateStatusUI();
            console.log('📦 Queued offline action:', op);
        },

        flushOfflineQueue: async () => {
            if (app.realtime.pendingQueue.length === 0) return;
            console.log(`📤 Flushing ${app.realtime.pendingQueue.length} offline operations to server...`);
            try {
                const res = await fetch(app.getApiUrl('/api/sync/batch'), {
                    method: 'POST',
                    headers: app.getAuthHeaders(),
                    credentials: 'include',
                    body: JSON.stringify({ operations: app.realtime.pendingQueue })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.success) {
                        console.log('✅ Offline queue synced successfully:', data.processed);
                        app.realtime.pendingQueue = [];
                        localStorage.removeItem('pos_offline_queue');
                        app.realtime.updateStatusUI();
                        await app.syncWithBackend(false);
                    }
                }
            } catch (err) {
                console.warn('Could not flush offline queue:', err);
            }
        },

        handleIncomingEvent: async (event) => {
            if (!event || !event.type) return;
            console.log('⚡ [Realtime Sync Event]:', event.type, event.data);
            app.realtime.lastSyncTime = new Date();
            app.playChime();

            try {
                switch (event.type) {
                    case 'ITEM_CREATED':
                    case 'ITEM_UPDATED': {
                        const item = event.data;
                        if (item && item.id) {
                            await db.items.put(item);
                            if (app.state.currentView === 'pos') app.renderPOS();
                            if (app.state.currentView === 'products') app.renderInventory();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                        }
                        break;
                    }
                    case 'ITEM_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.items.delete(Number(id));
                            if (app.state.currentView === 'pos') app.renderPOS();
                            if (app.state.currentView === 'products') app.renderInventory();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                        }
                        break;
                    }
                    case 'STOCK_CHANGED': {
                        const { id, stock } = event.data || {};
                        if (id && stock !== undefined) {
                            await db.items.update(Number(id), { stock: Number(stock) });
                            if (app.state.currentView === 'pos') app.renderPOS();
                            if (app.state.currentView === 'products') app.renderInventory();
                        }
                        break;
                    }
                    case 'SALE_CREATED': {
                        const { sale, items, cashier } = event.data || {};
                        if (sale) {
                            await db.sales.put(sale);
                            if (items && Array.isArray(items) && items.length > 0) {
                                for (const it of items) {
                                    await db.items.put(it);
                                }
                            }
                            if (app.state.currentView === 'pos') app.renderPOS();
                            if (app.state.currentView === 'sales') app.renderSalesHistory();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                            if (app.state.currentView === 'reports') app.renderReports();
                            if (app.state.currentView === 'credits') app.renderCredits();

                            const cashierName = cashier ? ` (${cashier})` : '';
                            Swal.fire({
                                toast: true,
                                position: 'top-end',
                                icon: 'info',
                                title: `🛒 New Sale: LKR ${Number(sale.total).toFixed(2)}${cashierName}`,
                                timer: 2500,
                                showConfirmButton: false
                            });
                        }
                        break;
                    }
                    case 'SALE_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.sales.delete(Number(id));
                            if (app.state.currentView === 'sales') app.renderSalesHistory();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                        }
                        break;
                    }
                    case 'REPAIR_CREATED':
                    case 'REPAIR_UPDATED': {
                        const repair = event.data;
                        if (repair && repair.id) {
                            await db.repairs.put(repair);
                            if (app.state.currentView === 'repairs') app.renderRepairs();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();

                            Swal.fire({
                                toast: true,
                                position: 'top-end',
                                icon: 'info',
                                title: `🔧 Repair Updated: ${repair.phoneModel} (${repair.status})`,
                                timer: 2500,
                                showConfirmButton: false
                            });
                        }
                        break;
                    }
                    case 'REPAIR_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.repairs.delete(Number(id));
                            if (app.state.currentView === 'repairs') app.renderRepairs();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                        }
                        break;
                    }
                    case 'FRAME_CREATED':
                    case 'FRAME_UPDATED': {
                        const frame = event.data;
                        if (frame && frame.id) {
                            await db.photoFrames.put(frame);
                            if (app.state.currentView === 'frames') app.renderPhotoFrames();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();

                            Swal.fire({
                                toast: true,
                                position: 'top-end',
                                icon: 'info',
                                title: `🖼️ Frame Order: #${String(frame.id).padStart(4, '0')} (${frame.customerName || 'Customer'})`,
                                timer: 2500,
                                showConfirmButton: false
                            });
                        }
                        break;
                    }
                    case 'FRAME_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.photoFrames.delete(Number(id));
                            if (app.state.currentView === 'frames') app.renderPhotoFrames();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                        }
                        break;
                    }
                    case 'EXPENSE_CREATED': {
                        const expense = event.data;
                        if (expense && expense.id) {
                            await db.expenses.put(expense);
                            if (app.state.currentView === 'expenses') app.renderExpenses();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                            if (app.state.currentView === 'reports') app.renderReports();
                        }
                        break;
                    }
                    case 'EXPENSE_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.expenses.delete(Number(id));
                            if (app.state.currentView === 'expenses') app.renderExpenses();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                        }
                        break;
                    }
                    case 'CREDITOR_CREATED':
                    case 'CREDITOR_UPDATED': {
                        const creditor = event.data;
                        if (creditor && creditor.id) {
                            await db.creditors.put(creditor);
                            if (app.state.currentView === 'credits') app.renderCredits();
                            if (app.state.currentView === 'pos') app.renderPOS();
                        }
                        break;
                    }
                    case 'CREDITOR_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.creditors.delete(Number(id));
                            if (app.state.currentView === 'credits') app.renderCredits();
                            if (app.state.currentView === 'pos') app.renderPOS();
                        }
                        break;
                    }
                    case 'BANK_TX_CREATED': {
                        const tx = event.data;
                        if (tx && tx.id) {
                            await db.bankTransactions.put(tx);
                            if (app.state.currentView === 'bank') app.renderBankTracker();
                            if (app.state.currentView === 'dashboard') app.renderDashboard();
                        }
                        break;
                    }
                    case 'BANK_TX_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.bankTransactions.delete(Number(id));
                            if (app.state.currentView === 'bank') app.renderBankTracker();
                        }
                        break;
                    }
                    case 'SUPPLIER_CREATED': {
                        const supplier = event.data;
                        if (supplier && supplier.id) {
                            await db.suppliers.put(supplier);
                            if (app.state.currentView === 'suppliers') app.renderSuppliers();
                        }
                        break;
                    }
                    case 'SUPPLIER_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.suppliers.delete(Number(id));
                            if (app.state.currentView === 'suppliers') app.renderSuppliers();
                        }
                        break;
                    }
                    case 'BILL_CREATED':
                    case 'BILL_UPDATED': {
                        const bill = event.data;
                        if (bill && bill.id) {
                            await db.purchaseBills.put(bill);
                            if (app.state.currentView === 'suppliers') app.renderSuppliers();
                        }
                        break;
                    }
                    case 'BILL_DELETED': {
                        const { id } = event.data || {};
                        if (id) {
                            await db.purchaseBills.delete(Number(id));
                            if (app.state.currentView === 'suppliers') app.renderSuppliers();
                        }
                        break;
                    }
                    case 'SETTINGS_UPDATED': {
                        const { key, value } = event.data || {};
                        if (key) {
                            localStorage.setItem(`krishan_pos_${key}`, value);
                            app.updateShopProfileHeader();
                        }
                        break;
                    }
                    case 'BATCH_SYNC_COMPLETED': {
                        await app.syncWithBackend(false);
                        break;
                    }
                    default:
                        break;
                }
            } catch (eventErr) {
                console.error('Error handling incoming realtime event:', eventErr);
            }
        }
    },

    // Unified socket-aware API Caller with direct Supabase & offline queue fallback
    apiCall: async (pathOrTable, method = 'GET', data = null, offlineAction = null, offlineId = null) => {
        const serverUrl = app.getServerUrl();
        const isGitHubPages = window.location.hostname.endsWith('github.io');

        // 1. Try Backend API fetch (Local / VPS / Render / Vercel API)
        if (serverUrl || !isGitHubPages || typeof supabase === 'undefined') {
            try {
                const url = app.getApiUrl(pathOrTable);
                const headers = app.getAuthHeaders();
                const options = {
                    method,
                    headers,
                    credentials: 'include'
                };

                if (data && method !== 'GET') {
                    options.body = JSON.stringify(data);
                }

                const res = await fetch(url, options);
                if (res.ok) {
                    return await res.json();
                }
            } catch (err) {
                // Backend not reachable, fall through to Supabase or Offline Queue
            }
        }

        // 2. Direct Supabase Fallback (for static hosting or when backend server is not running)
        if (typeof supabase !== 'undefined' && supabase && typeof supabase.from === 'function') {
            try {
                let rawTable = pathOrTable.replace(/^\/?api\//, '').split('/')[0];
                rawTable = rawTable.replace(/-/g, '_');
                const tableMap = {
                    'bank_transactions': 'bank_transactions',
                    'purchase_bills': 'purchase_bills',
                    'items': 'items',
                    'sales': 'sales',
                    'repairs': 'repairs',
                    'expenses': 'expenses',
                    'creditors': 'creditors',
                    'suppliers': 'suppliers',
                    'settings': 'settings',
                    'users': 'users'
                };
                const tableName = tableMap[rawTable] || rawTable;

                // Format data fields for Supabase schema
                const toSb = (tbl, item) => {
                    if (!item || typeof item !== 'object') return item;
                    const rec = { ...item };
                    if (tbl === 'sales') {
                        if (rec.paymentMethod !== undefined) { rec.payment_method = rec.paymentMethod; delete rec.paymentMethod; }
                        if (rec.cashReceived !== undefined) { rec.cash_received = rec.cashReceived; delete rec.cashReceived; }
                        if (rec.items !== undefined) { rec.items_json = rec.items; delete rec.items; }
                        if (rec.customerName !== undefined) { rec.customer_name = rec.customerName; delete rec.customerName; }
                        if (rec.customerPhone !== undefined) { rec.customer_phone = rec.customerPhone; delete rec.customerPhone; }
                        if (rec.userId !== undefined) { rec.user_id = rec.userId; delete rec.userId; }
                        if (rec.isUtility !== undefined) { rec.is_utility = rec.isUtility; delete rec.isUtility; }
                    } else if (tbl === 'repairs') {
                        if (rec.customerName !== undefined) { rec.customer_name = rec.customerName; delete rec.customerName; }
                        if (rec.phoneModel !== undefined) { rec.phone_model = rec.phoneModel; delete rec.phoneModel; }
                        if (rec.estimatedCost !== undefined) { rec.estimated_cost = rec.estimatedCost; delete rec.estimatedCost; }
                        if (rec.advancePayment !== undefined) { rec.advance_payment = rec.advancePayment; delete rec.advancePayment; }
                        if (rec.createdAt !== undefined) { rec.created_at = rec.createdAt; delete rec.createdAt; }
                    } else if (tbl === 'creditors') {
                        if (rec.lastUpdated !== undefined) { rec.last_updated = rec.lastUpdated; delete rec.lastUpdated; }
                    } else if (tbl === 'purchase_bills') {
                        if (rec.supplierId !== undefined) { rec.supplier_id = rec.supplierId; delete rec.supplierId; }
                        if (rec.supplierName !== undefined) { rec.supplier_name = rec.supplierName; delete rec.supplierName; }
                        if (rec.billNumber !== undefined) { rec.bill_number = rec.billNumber; delete rec.billNumber; }
                        if (rec.totalAmount !== undefined) { rec.total_amount = rec.totalAmount; delete rec.totalAmount; }
                        if (rec.items !== undefined) { rec.items_json = rec.items; delete rec.items; }
                    } else if (tbl === 'items') {
                        if (rec.minStock !== undefined) { rec.min_stock = rec.minStock; delete rec.minStock; }
                    }
                    return rec;
                };

                if (method === 'GET') {
                    const { data: resData, error } = await supabase.from(tableName).select('*');
                    if (error) throw error;
                    return resData;
                } else if (method === 'POST') {
                    if (tableName === 'settings' && data && data.key) {
                        const { data: resData, error } = await supabase.from('settings').upsert([data]).select();
                        if (error) throw error;
                        return resData ? resData[0] : null;
                    }
                    if (pathOrTable.includes('/adjust-stock')) {
                        const idMatch = pathOrTable.match(/items\/(\d+)\/adjust-stock/);
                        if (idMatch && data && data.delta !== undefined) {
                            const itemId = Number(idMatch[1]);
                            const { data: curItem } = await supabase.from('items').select('stock').eq('id', itemId).single();
                            if (curItem) {
                                const newStock = (curItem.stock || 0) + Number(data.delta);
                                await supabase.from('items').update({ stock: newStock }).eq('id', itemId);
                            }
                            return { success: true };
                        }
                    }
                    const payload = toSb(tableName, data);
                    const { data: resData, error } = await supabase.from(tableName).upsert([payload]).select();
                    if (error) throw error;
                    return resData ? resData[0] : null;
                } else if (method === 'PUT') {
                    const id = (data && data.id) || pathOrTable.split('/').pop();
                    const updateData = toSb(tableName, data);
                    delete updateData.id;
                    const { data: resData, error } = await supabase.from(tableName).update(updateData).eq('id', id).select();
                    if (error) throw error;
                    return resData ? resData[0] : null;
                } else if (method === 'DELETE') {
                    const id = pathOrTable.split('/').pop();
                    const { error } = await supabase.from(tableName).delete().eq('id', id);
                    if (error) throw error;
                    return { success: true };
                }
            } catch (sbErr) {
                console.warn(`Supabase fallback call failed for ${pathOrTable}:`, sbErr.message);
            }
        }

        // 3. Fallback to Offline Queue
        if (offlineAction && data) {
            app.realtime.queueOfflineMutation(offlineAction, offlineId, data);
        }
        return null;
    },

    // Full Backend & Cloud Database Synchronization
    syncWithBackend: async (refreshView = false) => {
        // 1. Try Backend API Full Sync endpoint
        try {
            const res = await fetch(app.getApiUrl('/api/sync/full'), {
                method: 'GET',
                headers: app.getAuthHeaders(),
                credentials: 'include'
            });
            if (res.ok) {
                const payload = await res.json();
                if (payload && payload.success && payload.data) {
                    const data = payload.data;

                    if (Array.isArray(data.items) && data.items.length > 0) {
                        await db.items.clear();
                        await db.items.bulkPut(data.items);
                    }
                    if (Array.isArray(data.sales) && data.sales.length > 0) {
                        await db.sales.clear();
                        await db.sales.bulkPut(data.sales);
                    }
                    if (Array.isArray(data.repairs) && data.repairs.length > 0) {
                        await db.repairs.clear();
                        await db.repairs.bulkPut(data.repairs);
                    }
                    if (Array.isArray(data.frames) && data.frames.length > 0) {
                        await db.photoFrames.clear();
                        await db.photoFrames.bulkPut(data.frames);
                    }
                    if (Array.isArray(data.expenses) && data.expenses.length > 0) {
                        await db.expenses.clear();
                        await db.expenses.bulkPut(data.expenses);
                    }
                    if (Array.isArray(data.creditors) && data.creditors.length > 0) {
                        await db.creditors.clear();
                        await db.creditors.bulkPut(data.creditors);
                    }
                    if (Array.isArray(data.bankTransactions) && data.bankTransactions.length > 0) {
                        await db.bankTransactions.clear();
                        await db.bankTransactions.bulkPut(data.bankTransactions);
                    }
                    if (Array.isArray(data.suppliers) && data.suppliers.length > 0) {
                        await db.suppliers.clear();
                        await db.suppliers.bulkPut(data.suppliers);
                    }
                    if (Array.isArray(data.purchaseBills) && data.purchaseBills.length > 0) {
                        await db.purchaseBills.clear();
                        await db.purchaseBills.bulkPut(data.purchaseBills);
                    }
                    if (data.settings) {
                        for (const k in data.settings) {
                            localStorage.setItem(`krishan_pos_${k}`, data.settings[k]);
                        }
                        app.updateShopProfileHeader();
                    }

                    app.realtime.lastSyncTime = new Date();

                    if (app.state.currentView === 'dashboard') {
                        app.renderDashboard();
                    } else if (app.state.currentView === 'pos') {
                        app.renderPOS();
                    } else if (app.state.currentView === 'products') {
                        app.renderInventory();
                    } else if (app.state.currentView === 'sales') {
                        app.renderSalesHistory();
                    } else if (app.state.currentView === 'repairs') {
                        app.renderRepairs();
                    } else if (refreshView && app.state.currentView) {
                        app.navigate(app.state.currentView);
                    }
                    return true;
                }
            }
        } catch (e) {
            // Backend full sync endpoint unreachable
        }

        // 2. Direct Supabase Multi-Table Sync Fallback
        if (typeof supabase !== 'undefined' && supabase && typeof supabase.from === 'function') {
            try {
                const [itemsRes, salesRes, repairsRes, expensesRes, credRes, bankRes, supRes, billsRes, setRes] = await Promise.all([
                    supabase.from('items').select('*').catch(() => ({ data: null })),
                    supabase.from('sales').select('*').catch(() => ({ data: null })),
                    supabase.from('repairs').select('*').catch(() => ({ data: null })),
                    supabase.from('expenses').select('*').catch(() => ({ data: null })),
                    supabase.from('creditors').select('*').catch(() => ({ data: null })),
                    supabase.from('bank_transactions').select('*').catch(() => ({ data: null })),
                    supabase.from('suppliers').select('*').catch(() => ({ data: null })),
                    supabase.from('purchase_bills').select('*').catch(() => ({ data: null })),
                    supabase.from('settings').select('*').catch(() => ({ data: null }))
                ]);

                if (itemsRes.data && itemsRes.data.length > 0) {
                    const formatted = itemsRes.data.map(i => ({
                        ...i,
                        minStock: i.min_stock !== undefined ? i.min_stock : (i.minStock || 5)
                    }));
                    await db.items.clear();
                    await db.items.bulkPut(formatted);
                }
                if (salesRes.data && salesRes.data.length > 0) {
                    const formatted = salesRes.data.map(s => ({
                        id: s.id,
                        date: s.date,
                        total: Number(s.total || 0),
                        discount: Number(s.discount || 0),
                        paymentMethod: s.payment_method || s.paymentMethod || 'cash',
                        cashReceived: Number(s.cash_received !== undefined ? s.cash_received : (s.cashReceived || 0)),
                        change: Number(s.change_amount !== undefined ? s.change_amount : (s.change || 0)),
                        items: typeof s.items_json === 'string' ? JSON.parse(s.items_json) : (s.items_json || s.items || []),
                        customerName: s.customer_name || s.customerName || '',
                        customerPhone: s.customer_phone || s.customerPhone || '',
                        userId: s.user_id || s.userId || null,
                        isUtility: Boolean(s.is_utility || s.isUtility)
                    }));
                    await db.sales.clear();
                    await db.sales.bulkPut(formatted);
                }
                if (repairsRes.data && repairsRes.data.length > 0) {
                    const formatted = repairsRes.data.map(r => ({
                        id: r.id,
                        customerName: r.customer_name || r.customerName || '',
                        phoneModel: r.phone_model || r.phoneModel || '',
                        issue: r.issue || '',
                        estimatedCost: Number(r.estimated_cost !== undefined ? r.estimated_cost : (r.estimatedCost || 0)),
                        advancePayment: Number(r.advance_payment !== undefined ? r.advance_payment : (r.advancePayment || 0)),
                        status: r.status || 'pending',
                        contact: r.contact || '',
                        createdAt: r.created_at || r.createdAt || new Date().toISOString()
                    }));
                    await db.repairs.clear();
                    await db.repairs.bulkPut(formatted);
                }
                if (expensesRes.data && expensesRes.data.length > 0) {
                    await db.expenses.clear();
                    await db.expenses.bulkPut(expensesRes.data);
                }
                if (credRes.data && credRes.data.length > 0) {
                    const formatted = credRes.data.map(c => ({
                        id: c.id,
                        name: c.name,
                        phone: c.phone || '',
                        amount: Number(c.amount || 0),
                        type: c.type || 'receivable',
                        lastUpdated: c.last_updated || c.lastUpdated || new Date().toISOString()
                    }));
                    await db.creditors.clear();
                    await db.creditors.bulkPut(formatted);
                }
                if (bankRes.data && bankRes.data.length > 0) {
                    await db.bankTransactions.clear();
                    await db.bankTransactions.bulkPut(bankRes.data);
                }
                if (supRes.data && supRes.data.length > 0) {
                    await db.suppliers.clear();
                    await db.suppliers.bulkPut(supRes.data);
                }
                if (billsRes.data && billsRes.data.length > 0) {
                    const formatted = billsRes.data.map(b => ({
                        id: b.id,
                        supplierId: b.supplier_id || b.supplierId || null,
                        supplierName: b.supplier_name || b.supplierName || '',
                        billNumber: b.bill_number || b.billNumber || '',
                        date: b.date,
                        totalAmount: Number(b.total_amount !== undefined ? b.total_amount : (b.totalAmount || 0)),
                        status: b.status || 'pending',
                        items: typeof b.items_json === 'string' ? JSON.parse(b.items_json) : (b.items_json || b.items || [])
                    }));
                    await db.purchaseBills.clear();
                    await db.purchaseBills.bulkPut(formatted);
                }
                if (setRes.data && Array.isArray(setRes.data)) {
                    for (const s of setRes.data) {
                        if (s.key && s.value) {
                            localStorage.setItem(`krishan_pos_${s.key}`, s.value);
                        }
                    }
                    app.updateShopProfileHeader();
                }

                app.realtime.lastSyncTime = new Date();
                if (refreshView && app.state.currentView) {
                    app.navigate(app.state.currentView);
                }
                return true;
            } catch (sbSyncErr) {
                console.warn('Supabase direct sync error:', sbSyncErr.message);
            }
        }

        return false;
    },

    triggerManualSync: async () => {
        const icon = document.getElementById('manual-sync-icon');
        if (icon) icon.classList.add('fa-spin');
        app.realtime.setStatus('syncing');

        try {
            await app.realtime.flushOfflineQueue();
            await app.syncWithBackend(true);
            app.realtime.setStatus('connected');
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'success',
                title: 'Data Synced Successfully!',
                timer: 1500,
                showConfirmButton: false
            });
        } catch (e) {
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'error',
                title: 'Sync failed: ' + (e.message || 'Server offline'),
                timer: 2000,
                showConfirmButton: false
            });
        } finally {
            if (icon) icon.classList.remove('fa-spin');
        }
    },

    showSyncStatusModal: () => {
        const status = app.realtime.status;
        const mode = app.realtime.syncMode || 'websocket';
        const count = app.realtime.deviceCount || 1;
        const lastSync = app.realtime.lastSyncTime ? new Date(app.realtime.lastSyncTime).toLocaleTimeString() : 'Just now';
        const queueCount = app.realtime.pendingQueue.length;
        const statusColor = status === 'connected' ? 'text-emerald-600 dark:text-emerald-400' : (status === 'syncing' ? 'text-amber-500' : 'text-rose-500');
        const statusBadge = status === 'connected' ? (mode === 'polling' ? '🟢 Cloud Live (Polling Sync)' : '🟢 Live (WebSocket)') : (status === 'syncing' ? '🟡 Syncing...' : '🔴 Offline Mode');
        const customUrl = localStorage.getItem('krishan_pos_custom_server_url') || '';
        const serverHost = customUrl || (window.location.host || 'http://localhost:3000');

        Swal.fire({
            title: '<div class="flex items-center justify-center gap-2 text-xl font-bold"><i class="fa-solid fa-tower-broadcast text-violet-600"></i> Realtime Sync Status</div>',
            html: `
                <div class="text-left space-y-4 my-2 text-sm">
                    <div class="p-4 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-2.5">
                        <div class="flex justify-between items-center">
                            <span class="font-semibold text-slate-500 dark:text-slate-400">Connection State:</span>
                            <span class="font-bold ${statusColor}">${statusBadge}</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="font-semibold text-slate-500 dark:text-slate-400">Sync Mode:</span>
                            <span class="font-bold text-slate-700 dark:text-slate-200 uppercase text-xs">${mode}</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="font-semibold text-slate-500 dark:text-slate-400">Connected Devices:</span>
                            <span class="font-bold text-slate-800 dark:text-white">${count} active device(s)</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="font-semibold text-slate-500 dark:text-slate-400">Last Synced:</span>
                            <span class="font-bold text-slate-800 dark:text-white">${lastSync}</span>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="font-semibold text-slate-500 dark:text-slate-400">Pending Offline Queue:</span>
                            <span class="font-bold ${queueCount > 0 ? 'text-amber-600' : 'text-slate-800 dark:text-white'}">${queueCount} actions</span>
                        </div>
                        <div class="flex justify-between items-center text-xs text-slate-400 pt-1 border-t border-slate-200 dark:border-slate-700">
                            <span>Backend Server URL:</span>
                            <span class="font-mono text-[11px] truncate max-w-[200px]" title="${serverHost}">${serverHost}</span>
                        </div>
                    </div>

                    <div class="flex gap-2">
                        <button type="button" onclick="app.configureServerUrlModal()" class="w-full py-2 px-3 rounded-xl bg-violet-50 dark:bg-violet-950/50 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 font-bold text-xs hover:bg-violet-100 transition-colors flex items-center justify-center gap-1.5">
                            <i class="fa-solid fa-cloud-arrow-up"></i> Configure Cloud Server URL
                        </button>
                    </div>

                    <p class="text-xs text-slate-400 leading-relaxed">
                        ✨ Sales, inventory stock, repairs, expenses, and credit records are synced live across all counter PCs, mobile phones, and laptops in real time.
                    </p>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: '<i class="fa-solid fa-arrows-rotate mr-1.5"></i> Force Full Sync',
            cancelButtonText: 'Close',
            confirmButtonColor: '#7c3aed'
        }).then((res) => {
            if (res.isConfirmed) {
                app.triggerManualSync();
            }
        });
    },

    showMobileConnectModal: async () => {
        let lanUrl = window.location.origin;
        let localIp = '127.0.0.1';
        let port = '3000';
        let quickCashierUrl = '';
        let quickAdminUrl = '';
        let customerMenuUrl = '';

        try {
            const apiBase = app.getApiBase();
            const res = await fetch(`${apiBase}/api/network-info`);
            if (res.ok) {
                const info = await res.json();
                if (info.lanUrl) lanUrl = info.lanUrl;
                if (info.localIp) localIp = info.localIp;
                if (info.port) port = info.port;
                if (info.quickCashierUrl) quickCashierUrl = info.quickCashierUrl;
                if (info.quickAdminUrl) quickAdminUrl = info.quickAdminUrl;
                if (info.customerMenuUrl) customerMenuUrl = info.customerMenuUrl;
            }
        } catch (e) {
            console.log('Could not fetch dynamic LAN info, using fallback');
        }

        const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const baseLanUrl = (isLocalHost && localIp !== '127.0.0.1') ? `http://${localIp}:${port}` : window.location.origin;
        const cashierUrl = quickCashierUrl || `${baseLanUrl}/login?quick=cashier`;
        const adminUrl = quickAdminUrl || `${baseLanUrl}/login?quick=admin`;
        const customerCatalogUrl = customerMenuUrl || `${baseLanUrl}/catalog`;
        const deviceCount = app.realtime?.deviceCount || 1;

        Swal.fire({
            title: `
                <div class="flex flex-col items-center gap-1">
                    <div class="inline-flex items-center gap-2 text-xl font-black text-slate-900 dark:text-white">
                        <i class="fa-solid fa-qrcode text-violet-600"></i> Wi-Fi Device Connect & QR Login
                    </div>
                    <span class="text-xs font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                        🟢 ${deviceCount} Active Device(s) Connected on Network
                    </span>
                </div>
            `,
            html: `
                <div class="text-left space-y-3.5 my-1 text-sm">
                    <!-- Tab Selector -->
                    <div class="flex p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl gap-1 text-center">
                        <button type="button" id="tab-cashier-qr" class="qr-tab-btn flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all bg-white dark:bg-slate-700 text-violet-700 dark:text-violet-300 shadow-sm border border-slate-200/50 dark:border-slate-600">
                            ⚡ Cashier
                        </button>
                        <button type="button" id="tab-admin-qr" class="qr-tab-btn flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                            🛡️ Admin
                        </button>
                        <button type="button" id="tab-customer-qr" class="qr-tab-btn flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                            🛍️ Customer
                        </button>
                        <button type="button" id="tab-standard-qr" class="qr-tab-btn flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                            🌐 Wi-Fi
                        </button>
                    </div>

                    <!-- QR Code Canvas Container -->
                    <div class="flex flex-col items-center justify-center p-3 sm:p-4 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-inner">
                        <div id="qrcode-canvas-container" class="w-48 h-48 flex items-center justify-center bg-white p-2 rounded-xl overflow-hidden"></div>
                        <span id="qr-caption" class="text-[11px] font-bold text-violet-600 dark:text-violet-400 mt-2 flex items-center gap-1.5">
                            <i class="fa-solid fa-bolt text-amber-500"></i> Scan to Auto-Login as Cashier
                        </span>
                    </div>

                    <!-- Direct URL & Copy Button -->
                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-1.5">
                        <div class="flex items-center justify-between text-xs font-bold text-slate-500 dark:text-slate-400">
                            <span><i class="fa-solid fa-wifi text-emerald-500 mr-1"></i> Target Wi-Fi URL:</span>
                            <button type="button" id="btn-copy-qr-url" class="text-violet-600 dark:text-violet-400 font-bold hover:underline flex items-center gap-1">
                                <i class="fa-regular fa-copy"></i> Copy Link
                            </button>
                        </div>
                        <div id="qr-display-url" class="p-2 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-mono text-xs font-bold text-slate-800 dark:text-slate-200 break-all select-all text-center">
                            ${cashierUrl}
                        </div>
                    </div>

                    <!-- Sinhala & English Step-by-Step Guide -->
                    <div id="qr-step-guide" class="p-3 rounded-xl bg-violet-50/80 dark:bg-violet-950/40 border border-violet-100 dark:border-violet-900/50 text-xs text-violet-900 dark:text-violet-200 space-y-1">
                        <div class="font-bold flex items-center gap-1.5 text-violet-800 dark:text-violet-300">
                            <i class="fa-solid fa-circle-question text-violet-600"></i> Phone එකෙන් Connect වන ආකාරය:
                        </div>
                        <div class="pl-2 border-l-2 border-violet-300 dark:border-violet-700 space-y-0.5 text-[11px] leading-relaxed">
                            <div>1. Phone එක Main PC එකේ Wi-Fi එකට සම්බන්ධ කරන්න.</div>
                            <div>2. Phone Camera එකෙන් මෙම QR Code එක Scan කරන්න.</div>
                            <div>3. කිසිදු Password එකක් Type නොකර කෙලින්ම POS එකට Login වන්න!</div>
                            <div>4. Chrome/Safari හි <b>"Add to Home Screen"</b> ලබා දී App එකක් මෙන් භාවිතා කරන්න.</div>
                        </div>
                    </div>
                </div>
            `,
            showConfirmButton: true,
            confirmButtonText: '<i class="fa-solid fa-check mr-1.5"></i> Done',
            confirmButtonColor: '#7c3aed',
            didOpen: () => {
                let currentUrl = cashierUrl;
                window._activeQrUrl = currentUrl;

                const renderQr = (targetUrl, captionText) => {
                    window._activeQrUrl = targetUrl;
                    const urlBox = document.getElementById('qr-display-url');
                    if (urlBox) urlBox.textContent = targetUrl;
                    const cap = document.getElementById('qr-caption');
                    if (cap) cap.innerHTML = captionText;

                    const container = document.getElementById('qrcode-canvas-container');
                    if (!container) return;
                    container.innerHTML = '';

                    try {
                        if (typeof QRCode !== 'undefined') {
                            new QRCode(container, {
                                text: targetUrl,
                                width: 180,
                                height: 180,
                                colorDark: "#0f172a",
                                colorLight: "#ffffff",
                                correctLevel: QRCode.CorrectLevel.M
                            });
                        } else {
                            container.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(targetUrl)}" class="w-44 h-44 rounded-xl object-contain shadow-sm" alt="QR Code"/>`;
                        }
                    } catch (e) {
                        container.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(targetUrl)}" class="w-44 h-44 rounded-xl object-contain shadow-sm" alt="QR Code"/>`;
                    }
                };

                const switchTab = (activeId, url, caption) => {
                    document.querySelectorAll('.qr-tab-btn').forEach(btn => {
                        btn.className = 'qr-tab-btn flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer';
                    });
                    const activeBtn = document.getElementById(activeId);
                    if (activeBtn) {
                        activeBtn.className = 'qr-tab-btn flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all bg-white dark:bg-slate-700 text-violet-700 dark:text-violet-300 shadow-sm border border-slate-200/50 dark:border-slate-600 cursor-pointer';
                    }
                    renderQr(url, caption);
                };

                document.getElementById('tab-cashier-qr')?.addEventListener('click', () => {
                    switchTab('tab-cashier-qr', cashierUrl, '<i class="fa-solid fa-bolt text-amber-500"></i> Scan to Auto-Login as Cashier');
                });

                document.getElementById('tab-admin-qr')?.addEventListener('click', () => {
                    switchTab('tab-admin-qr', adminUrl, '<i class="fa-solid fa-shield-halved text-violet-500"></i> Scan to Auto-Login as Admin');
                });

                document.getElementById('tab-customer-qr')?.addEventListener('click', () => {
                    switchTab('tab-customer-qr', customerCatalogUrl, '<i class="fa-solid fa-store text-emerald-500"></i> Customer Catalog / Price List (පාරිභෝගිකයින්ට බඩු බැලීමට)');
                });

                document.getElementById('tab-standard-qr')?.addEventListener('click', () => {
                    switchTab('tab-standard-qr', baseLanUrl, '<i class="fa-solid fa-wifi text-emerald-500"></i> Standard Shop Wi-Fi Portal');
                });

                document.getElementById('btn-copy-qr-url')?.addEventListener('click', () => {
                    if (window._activeQrUrl) {
                        navigator.clipboard.writeText(window._activeQrUrl).then(() => {
                            Swal.showValidationMessage('Link copied to clipboard! ✔');
                            setTimeout(() => Swal.resetValidationMessage(), 2500);
                        }).catch(() => {});
                    }
                });

                // Initial render with Cashier QR
                renderQr(cashierUrl, '<i class="fa-solid fa-bolt text-amber-500"></i> Scan to Auto-Login as Cashier');
            }
        });
    },

    showCustomerCatalogModal: async () => {
        let localIp = '127.0.0.1';
        let port = '3000';
        let customerMenuUrl = '';
        let shopName = 'Krishan Communication & Studio';
        let phone = '076 928 1880';

        try {
            const apiBase = app.getApiBase();
            const res = await fetch(`${apiBase}/api/network-info`);
            if (res.ok) {
                const info = await res.json();
                if (info.localIp) localIp = info.localIp;
                if (info.port) port = info.port;
                if (info.customerMenuUrl) customerMenuUrl = info.customerMenuUrl;
            }
            const sRes = await fetch(`${apiBase}/api/settings`);
            if (sRes.ok) {
                const settings = await sRes.json();
                if (settings.shop_name) shopName = settings.shop_name;
                if (settings.phone) phone = settings.phone;
            }
        } catch (e) {
            console.log('Error fetching customer qr info', e);
        }

        const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
        const baseLanUrl = (isLocalHost && localIp !== '127.0.0.1') ? `http://${localIp}:${port}` : window.location.origin;
        const catalogUrl = customerMenuUrl || `${baseLanUrl}/catalog`;

        Swal.fire({
            title: `
                <div class="flex flex-col items-center gap-1">
                    <div class="inline-flex items-center gap-2 text-xl font-black text-slate-900 dark:text-white">
                        <i class="fa-solid fa-store text-emerald-600"></i> Customer Items QR Code
                    </div>
                    <span class="text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                        🛍️ පාරිභෝගිකයින්ට බඩු සහ මිල බැලීමට පමණි
                    </span>
                </div>
            `,
            html: `
                <div class="text-left space-y-3.5 my-1 text-sm">
                    <p class="text-xs text-slate-600 dark:text-slate-300 text-center leading-relaxed">
                        කස්ටමර්ලාට ඔවුන්ගේ Phone එකෙන් ඔබගේ කඩේ ඇති බඩු සහ මිල ගණන් (Price List) පමණක් බැලීමට මෙම QR Code එක පෙන්වන්න. (Cost Price හෝ Admin දත්ත නොපෙනේ).
                    </p>

                    <!-- QR Code Canvas Container -->
                    <div class="flex flex-col items-center justify-center p-4 bg-white dark:bg-slate-900 rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 shadow-sm relative">
                        <div id="customer-qrcode-container" class="w-52 h-52 flex items-center justify-center bg-white p-2 rounded-xl overflow-hidden"></div>
                        <span class="text-xs font-bold text-emerald-600 dark:text-emerald-400 mt-2 flex items-center gap-1.5">
                            <i class="fa-solid fa-qrcode"></i> Scan to view ${shopName} Items
                        </span>
                    </div>

                    <!-- Direct URL & Copy Button -->
                    <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 space-y-1.5">
                        <div class="flex items-center justify-between text-xs font-bold text-slate-500 dark:text-slate-400">
                            <span><i class="fa-solid fa-link text-emerald-500 mr-1"></i> Customer Catalog URL:</span>
                            <div class="flex items-center gap-2">
                                <button type="button" id="btn-copy-customer-url" class="text-emerald-600 dark:text-emerald-400 font-bold hover:underline flex items-center gap-1">
                                    <i class="fa-regular fa-copy"></i> Copy
                                </button>
                                <a href="${catalogUrl}" target="_blank" class="text-violet-600 dark:text-violet-400 font-bold hover:underline flex items-center gap-1">
                                    <i class="fa-solid fa-arrow-up-right-from-square"></i> Open
                                </a>
                            </div>
                        </div>
                        <div class="p-2 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 font-mono text-xs font-bold text-slate-800 dark:text-slate-200 break-all select-all text-center">
                            ${catalogUrl}
                        </div>
                    </div>

                    <!-- Quick Print Counter Standee Button -->
                    <div class="pt-1">
                        <button type="button" id="btn-print-qr-standee" class="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-bold text-xs shadow-md shadow-emerald-600/20 flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer">
                            <i class="fa-solid fa-print text-sm"></i> කවුන්ටරයේ තැබීමට Print කරන්න (Print QR Standee)
                        </button>
                    </div>

                    <!-- Instructions -->
                    <div class="p-3 rounded-xl bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/50 text-xs text-emerald-900 dark:text-emerald-200 space-y-1">
                        <div class="font-bold flex items-center gap-1.5 text-emerald-800 dark:text-emerald-300">
                            <i class="fa-solid fa-circle-info text-emerald-600"></i> පාරිභෝගිකයින්ට භාවිතා කරන ආකාරය:
                        </div>
                        <div class="pl-2 border-l-2 border-emerald-300 dark:border-emerald-700 space-y-0.5 text-[11px] leading-relaxed">
                            <div>1. Phone Camera එකෙන් මෙම QR Code එක Scan කරන්න.</div>
                            <div>2. වෙළඳසැලේ ඇති සියලු බඩු වර්ග, මිල ගණන් සහ Available Stock පෙනේ.</div>
                            <div>3. ඕනෑම බඩුවක නම හෝ Barcode එක Type කර පහසුවෙන් Search කළ හැක.</div>
                            <div>4. බඩු තෝරා "List එකට" දමා කවුන්ටරයට පෙන්විය හැක.</div>
                        </div>
                    </div>
                </div>
            `,
            showConfirmButton: true,
            confirmButtonText: 'Done',
            confirmButtonColor: '#059669',
            didOpen: () => {
                const container = document.getElementById('customer-qrcode-container');
                if (container) {
                    try {
                        if (typeof QRCode !== 'undefined') {
                            new QRCode(container, {
                                text: catalogUrl,
                                width: 200,
                                height: 200,
                                colorDark: "#064e3b",
                                colorLight: "#ffffff",
                                correctLevel: QRCode.CorrectLevel.M
                            });
                        } else {
                            container.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(catalogUrl)}" class="w-48 h-48 rounded-xl object-contain shadow-sm" alt="QR Code"/>`;
                        }
                    } catch (e) {
                        container.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(catalogUrl)}" class="w-48 h-48 rounded-xl object-contain shadow-sm" alt="QR Code"/>`;
                    }
                }

                document.getElementById('btn-copy-customer-url')?.addEventListener('click', () => {
                    navigator.clipboard.writeText(catalogUrl).then(() => {
                        Swal.showValidationMessage('Catalog Link copied! ✔');
                        setTimeout(() => Swal.resetValidationMessage(), 2500);
                    }).catch(() => {});
                });

                document.getElementById('btn-print-qr-standee')?.addEventListener('click', () => {
                    app.printCustomerQrStandee(catalogUrl, shopName, phone);
                });
            }
        });
    },

    printCustomerQrStandee: (url, shopName, phone) => {
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            Swal.fire('Popup Blocked', 'Please allow popups to print the QR standee.', 'warning');
            return;
        }

        const qrImgUrl = `/api/qr?text=${encodeURIComponent(url)}&format=svg`;

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <title>${shopName} - Customer QR Standee</title>
                <link rel="preconnect" href="https://fonts.googleapis.com">
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;900&display=swap" rel="stylesheet">
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: 'Outfit', sans-serif;
                        background: #f8fafc;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        min-height: 100vh;
                        padding: 20px;
                    }
                    .standee-card {
                        background: #ffffff;
                        width: 100%;
                        max-width: 440px;
                        border-radius: 28px;
                        border: 3px solid #059669;
                        padding: 32px 28px;
                        text-align: center;
                        box-shadow: 0 20px 40px -15px rgba(0,0,0,0.15);
                    }
                    .store-badge {
                        display: inline-block;
                        background: #ecfdf5;
                        color: #047857;
                        border: 1px solid #a7f3d0;
                        padding: 6px 16px;
                        border-radius: 50px;
                        font-size: 13px;
                        font-weight: 700;
                        margin-bottom: 12px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .store-title {
                        font-size: 24px;
                        font-weight: 900;
                        color: #0f172a;
                        margin-bottom: 6px;
                        line-height: 1.2;
                    }
                    .store-sub {
                        font-size: 13px;
                        color: #64748b;
                        margin-bottom: 22px;
                    }
                    .qr-wrapper {
                        background: #ffffff;
                        padding: 16px;
                        border-radius: 22px;
                        border: 2px dashed #059669;
                        display: inline-block;
                        margin-bottom: 18px;
                    }
                    .qr-wrapper img {
                        width: 220px;
                        height: 220px;
                        display: block;
                    }
                    .scan-callout {
                        font-size: 18px;
                        font-weight: 800;
                        color: #047857;
                        margin-bottom: 6px;
                    }
                    .sinhala-text {
                        font-size: 13px;
                        color: #334155;
                        font-weight: 600;
                        margin-bottom: 18px;
                        line-height: 1.4;
                    }
                    .features-grid {
                        display: flex;
                        justify-content: center;
                        gap: 12px;
                        border-top: 1px solid #e2e8f0;
                        padding-top: 16px;
                        margin-bottom: 16px;
                    }
                    .feature-item {
                        font-size: 11px;
                        font-weight: 700;
                        color: #475569;
                    }
                    .footer-info {
                        font-size: 12px;
                        color: #64748b;
                        font-weight: 600;
                    }
                    @media print {
                        body { background: transparent; padding: 0; }
                        .standee-card { box-shadow: none; border: 2px solid #059669; margin: auto; }
                        .no-print { display: none !important; }
                    }
                </style>
            </head>
            <body>
                <div class="standee-card">
                    <div class="store-badge">Official Digital Menu</div>
                    <h1 class="store-title">${shopName}</h1>
                    <div class="store-sub">Browse Our Products & Live Prices</div>

                    <div class="qr-wrapper">
                        <img src="${qrImgUrl}" alt="Customer QR Code" />
                    </div>

                    <div class="scan-callout">📱 Scan with Phone Camera</div>
                    <div class="sinhala-text">
                        අපගේ සියලුම භාණ්ඩ, සේවා හා නවතම මිල ගණන් ඔබගේ දුරකථනයෙන් පහසුවෙන් බැලීමට මෙම QR Code එක Scan කරන්න.
                    </div>

                    <div class="features-grid">
                        <div class="feature-item">🔍 Item Search</div>
                        <div class="feature-item">•</div>
                        <div class="feature-item">💰 Live Prices</div>
                        <div class="feature-item">•</div>
                        <div class="feature-item">📦 Stock Status</div>
                    </div>

                    <div class="footer-info">
                        ${phone ? `📞 Tel: ${phone}` : ''}
                    </div>

                    <div class="no-print" style="margin-top: 24px;">
                        <button onclick="window.print()" style="background: #059669; color: white; border: none; padding: 10px 24px; border-radius: 12px; font-weight: bold; font-size: 14px; cursor: pointer;">
                            🖨️ Print Standee
                        </button>
                    </div>
                </div>

                <script>
                    window.onload = function() {
                        setTimeout(() => {
                            window.print();
                        }, 500);
                    };
                <\/script>
            </body>
            </html>
        `);
        printWindow.document.close();
    },

    showPwaInstallButton: () => {
        const btn = document.getElementById('pwa-install-header-btn');
        if (btn) {
            btn.classList.remove('hidden');
            btn.classList.add('inline-flex');
        }
    },

    promptPwaInstall: async () => {
        const promptEvent = window.pwaInstallPrompt || (typeof deferredPrompt !== 'undefined' ? deferredPrompt : null);
        
        if (promptEvent) {
            try {
                promptEvent.prompt();
                const choice = await promptEvent.userChoice;
                if (choice.outcome === 'accepted') {
                    console.log('✔ User installed the Krishan POS App');
                    Swal.fire({
                        icon: 'success',
                        title: 'App Installed!',
                        text: 'Krishan POS has been added to your Home Screen / Applications.',
                        timer: 2000,
                        showConfirmButton: false
                    });
                }
                window.pwaInstallPrompt = null;
                return;
            } catch (err) {
                console.warn('Install prompt error:', err);
            }
        }

        // Informative Visual Modal with Sinhala & English guides for Android & iPhone
        Swal.fire({
            title: `
                <div class="flex flex-col items-center gap-2">
                    <div class="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-600 text-white flex items-center justify-center text-2xl shadow-lg shadow-emerald-500/30">
                        <i class="fa-solid fa-mobile-screen-button"></i>
                    </div>
                    <div class="text-xl font-black text-slate-900 dark:text-white">Install Krishan POS App</div>
                    <div class="text-xs text-slate-500 font-medium">Phone එකට හෝ PC එකට App එකක් ලෙස Install කරගන්න</div>
                </div>
            `,
            html: `
                <div class="text-left space-y-3.5 my-2">
                    <div class="p-3.5 rounded-2xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs">
                        <div class="font-bold text-emerald-800 dark:text-emerald-300 flex items-center gap-2 mb-1">
                            <i class="fa-brands fa-android text-base"></i> Android Phone (Google Chrome):
                        </div>
                        <ol class="list-decimal pl-5 space-y-1 text-slate-700 dark:text-slate-300">
                            <li>Chrome browser එකේ ඉහළ දකුණු කෙලවරේ ඇති <b>තිත් 3 (⋮)</b> ඔබන්න.</li>
                            <li>එහි ඇති <b>"Install app"</b> හෝ <b>"Add to Home screen"</b> (මුල් තිරයට එක් කරන්න) තෝරන්න.</li>
                            <li>එවිට Phone එකේ Home Screen එකට Krishan POS App එක install වේ!</li>
                        </ol>
                    </div>

                    <div class="p-3.5 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-xs">
                        <div class="font-bold text-blue-800 dark:text-blue-300 flex items-center gap-2 mb-1">
                            <i class="fa-brands fa-apple text-base"></i> Apple iPhone (Safari):
                        </div>
                        <ol class="list-decimal pl-5 space-y-1 text-slate-700 dark:text-slate-300">
                            <li>Safari browser එකේ පහළ ඇති <b>Share (⎋)</b> අයිකනය ඔබන්න.</li>
                            <li>පහළට Scroll කර <b>"Add to Home Screen"</b> තෝරන්න.</li>
                            <li>දැන් iPhone එකේ App එකක් ලෙස මෙය භාවිතා කළ හැක!</li>
                        </ol>
                    </div>

                    <div class="p-3.5 rounded-2xl bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800 text-xs">
                        <div class="font-bold text-violet-800 dark:text-violet-300 flex items-center gap-2 mb-1">
                            <i class="fa-brands fa-windows text-base"></i> Windows PC:
                        </div>
                        <div class="text-slate-700 dark:text-slate-300 leading-relaxed">
                            Desktop එකේ ඇති <b>"Krishan POS"</b> Icon එක Double-click කිරීමෙන් standalone Desktop App එකක් ලෙස විවෘත වේ. (නැතහොත් Edge/Chrome URL bar එකේ ඇති <b>⊞ Install</b> ඔබන්න).
                        </div>
                    </div>
                </div>
            `,
            confirmButtonText: 'හරි (Understood)',
            confirmButtonColor: '#10b981',
            customClass: {
                popup: 'rounded-3xl'
            }
        });
    },

    configureServerUrlModal: async () => {
        const currentUrl = localStorage.getItem('krishan_pos_custom_server_url') || '';
        const { value: url } = await Swal.fire({
            title: '<i class="fa-solid fa-server text-violet-600 mb-2"></i><br>Cloud Backend Server URL',
            html: `
                <div class="text-left text-xs text-slate-500 mb-3 leading-relaxed">
                    Enter your live backend server URL (e.g. Render, Railway, Cloudflare Tunnel, or Local Network IP). Leave blank to use default.
                </div>
                <input id="swal-server-url" class="swal2-input !mt-0 !w-full text-sm font-mono" placeholder="https://my-pos.onrender.com or http://192.168.8.185:3000" value="${currentUrl}">
                <div class="text-left text-[11px] text-slate-400 mt-2 space-y-1">
                    <div>💡 <strong>Render Free URL:</strong> <code>https://your-app.onrender.com</code></div>
                    <div>💡 <strong>Local Wi-Fi IP:</strong> <code>http://192.168.8.185:3000</code></div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: 'Save & Test Connection',
            confirmButtonColor: '#7c3aed',
            preConfirm: () => {
                const val = document.getElementById('swal-server-url').value.trim();
                return val;
            }
        });

        if (url !== undefined) {
            if (url) {
                localStorage.setItem('krishan_pos_custom_server_url', url.replace(/\/+$/, ''));
            } else {
                localStorage.removeItem('krishan_pos_custom_server_url');
            }

            Swal.fire({
                title: 'Connecting...',
                text: 'Testing connection to server',
                allowOutsideClick: false,
                didOpen: () => {
                    Swal.showLoading();
                }
            });

            try {
                if (app.realtime.socket) {
                    app.realtime.socket.disconnect();
                }
                app.realtime.init();
                await app.syncWithBackend(true);
                Swal.fire({
                    icon: 'success',
                    title: 'Connected Successfully!',
                    text: 'Live sync connected to ' + (url || 'default server'),
                    timer: 2000,
                    showConfirmButton: false
                });
            } catch (e) {
                Swal.fire({
                    icon: 'warning',
                    title: 'Saved in Local Mode',
                    text: 'Server URL saved. ' + e.message,
                    timer: 2500,
                    showConfirmButton: false
                });
            }
        }
    },

    ensureInitialData: async () => {
        try {
            const count = await db.items.count();
            if (count === 0) {
                // Try fetching items from backend first
                try {
                    const res = await fetch(app.getApiUrl('/api/items'), {
                        headers: app.getAuthHeaders(),
                        credentials: 'include'
                    });
                    if (res.ok) {
                        const serverItems = await res.json();
                        if (Array.isArray(serverItems) && serverItems.length > 0) {
                            await db.items.bulkPut(serverItems);
                            console.log('📦 [Dexie] Seeded catalog from backend API:', serverItems.length, 'items');
                        }
                    }
                } catch (e) {
                    // Backend unavailable or offline
                }

                // If still empty, seed default starter inventory fallback
                const currentItemCount = await db.items.count();
                if (currentItemCount === 0) {
                    const starterItems = [
                        { id: 1, name: "Photocopy (A4)", category: "Service", type: "service", price: 10, cost: 2, barcode: "SERV001", stock: 0, minStock: 0 },
                        { id: 2, name: "Passport Photo", category: "Studio", type: "service", price: 350, cost: 50, barcode: "SERV002", stock: 0, minStock: 0 },
                        { id: 3, name: "Tempered Glass", category: "Accessories", type: "product", price: 500, cost: 150, barcode: "ACC001", stock: 25, minStock: 5 },
                        { id: 4, name: "CR Books", category: "Stationery", type: "product", price: 250, cost: 180, barcode: "STAT001", stock: 50, minStock: 10 }
                    ];
                    await db.items.bulkPut(starterItems);
                    console.log('📦 [Dexie] Seeded default starter inventory');
                }
            }

            // Also check and seed repairs from backend if empty
            const repairCount = await db.repairs.count();
            if (repairCount === 0) {
                try {
                    const resRep = await fetch(app.getApiUrl('/api/repairs'), {
                        headers: app.getAuthHeaders(),
                        credentials: 'include'
                    });
                    if (resRep.ok) {
                        const serverRepairs = await resRep.json();
                        if (Array.isArray(serverRepairs) && serverRepairs.length > 0) {
                            await db.repairs.bulkPut(serverRepairs);
                            console.log('🔧 [Dexie] Seeded repairs from backend API:', serverRepairs.length, 'repairs');
                        }
                    }
                } catch (e) {
                    // Backend unavailable or offline
                }
            }
        } catch (err) {
            console.warn('ensureInitialData error:', err);
        }
    },

    init: async () => {
        try {
            app.updateDateTime();
            setInterval(app.updateDateTime, 1000);
            app.initTheme();

            // 0. Ensure catalog has starter/server data immediately
            await app.ensureInitialData();

            // 1. Initialize Realtime Engine
            app.realtime.init();
            app.fetchWhatsAppStatus();

            // 2. Verify authentication
            const isAuth = await app.checkAuth();
            if (!isAuth) {
                app.showLoginOverlay();
                return;
            }

            // 3. Sync with SQLite backend database
            try {
                await app.syncWithBackend(true);
            } catch (syncErr) {
                console.warn('Backend sync skipped/failed:', syncErr);
            }

            // 4. Ensure again that items exist if sync returned empty
            await app.ensureInitialData();

            app.updateShopProfileHeader();
            app.navigate('dashboard');
        } catch (e) {
            console.error('App init error:', e);
            try {
                app.navigate('dashboard');
            } catch (err) {}
        }

        // Global Error Handler
        window.addEventListener('unhandledrejection', (event) => {
            console.error('Unhandled promise rejection:', event.reason);
        });
    },

    toggleSidebar: (forceState) => {
        const sidebar = document.getElementById('main-sidebar');
        const backdrop = document.getElementById('sidebar-backdrop');
        if (!sidebar) return;
        
        const isHidden = sidebar.classList.contains('-translate-x-full');
        const shouldShow = forceState !== undefined ? forceState : isHidden;

        if (shouldShow) {
            sidebar.classList.remove('-translate-x-full');
            if (backdrop) backdrop.classList.remove('hidden');
        } else {
            sidebar.classList.add('-translate-x-full');
            if (backdrop) backdrop.classList.add('hidden');
        }
    },

    showLoginOverlay: () => {
        let overlay = document.getElementById('pos-login-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'pos-login-overlay';
            overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/90 backdrop-blur-md';
            overlay.innerHTML = `
                <div class="w-full max-w-md bg-white dark:bg-slate-800 rounded-3xl p-8 sm:p-10 shadow-2xl border border-slate-200 dark:border-slate-700">
                    <div class="text-center mb-6">
                        <div class="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-tr from-violet-600 to-indigo-600 text-white flex items-center justify-center text-2xl shadow-lg shadow-violet-500/30 mb-3">
                            <i class="fa-solid fa-cash-register"></i>
                        </div>
                        <h2 class="text-2xl font-black text-slate-900 dark:text-white">Krishan POS</h2>
                        <p class="text-xs text-violet-600 dark:text-violet-400 font-semibold mt-0.5">Communication & Studio</p>
                        <p class="text-xs text-slate-400 mt-1">Sign in to access the Point of Sale System</p>
                    </div>

                    <form id="overlay-login-form" class="space-y-4" onsubmit="app.handleOverlayLogin(event)">
                        <div>
                            <label class="block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                                <i class="fa-solid fa-user text-violet-600 mr-1"></i> Username
                            </label>
                            <input type="text" id="overlay-username" required autocomplete="username"
                                class="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl text-slate-800 dark:text-white text-sm font-medium focus:ring-2 focus:ring-violet-500 outline-none transition-all"
                                placeholder="Enter username (e.g. admin)">
                        </div>

                        <div>
                            <label class="block text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider mb-1.5">
                                <i class="fa-solid fa-lock text-violet-600 mr-1"></i> Password
                            </label>
                            <input type="password" id="overlay-password" required autocomplete="current-password"
                                class="w-full px-4 py-3 bg-slate-50 dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-xl text-slate-800 dark:text-white text-sm font-medium focus:ring-2 focus:ring-violet-500 outline-none transition-all"
                                placeholder="••••••••">
                        </div>

                        <div id="overlay-error-banner" class="hidden p-3 rounded-xl bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-300 text-xs font-semibold flex items-center gap-2">
                            <i class="fa-solid fa-circle-exclamation"></i>
                            <span id="overlay-error-text">Invalid credentials</span>
                        </div>

                        <button type="submit" id="overlay-login-btn"
                            class="w-full py-3.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-bold rounded-xl shadow-lg shadow-violet-500/25 transition-all active:scale-[0.98] flex items-center justify-center gap-2 text-sm">
                            <span id="overlay-btn-text">Sign In to POS</span>
                            <i class="fa-solid fa-arrow-right"></i>
                        </button>
                    </form>

                    <div class="mt-5 pt-4 border-t border-slate-100 dark:border-slate-700 text-center">
                        <button type="button" onclick="app.fillOverlayAdmin()"
                            class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 hover:bg-violet-100 transition-colors border border-violet-100 dark:border-violet-800">
                            ✨ Quick Login: admin / admin123
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        }
        overlay.classList.remove('hidden');
        setTimeout(() => {
            const userInp = document.getElementById('overlay-username');
            if (userInp) userInp.focus();
        }, 100);
    },

    fillOverlayAdmin: () => {
        const u = document.getElementById('overlay-username');
        const p = document.getElementById('overlay-password');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const form = document.getElementById('overlay-login-form');
        if (form) form.dispatchEvent(new Event('submit'));
    },

    handleOverlayLogin: async (e) => {
        if (e) e.preventDefault();
        const u = document.getElementById('overlay-username').value.trim();
        const p = document.getElementById('overlay-password').value.trim();
        const btn = document.getElementById('overlay-login-btn');
        const btnText = document.getElementById('overlay-btn-text');
        const errBanner = document.getElementById('overlay-error-banner');
        const errText = document.getElementById('overlay-error-text');

        if (!u || !p) return;

        errBanner.classList.add('hidden');
        btn.disabled = true;
        btnText.textContent = 'Signing in...';

        let user = null;
        try {
            // 1. Try backend authentication
            try {
                const res = await fetch(app.getApiUrl('/api/auth/login'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ username: u, password: p })
                });
                const data = await res.json().catch(() => ({}));
                if (res.ok && data.success) {
                    user = data.user;
                    if (data.token) {
                        localStorage.setItem('pos_token', data.token);
                    }
                }
            } catch (err) {
                // Backend offline
            }

            // 2. Fallback offline authentication
            if (!user) {
                if (u.toLowerCase() === 'admin' && p === 'admin123') {
                    user = { id: 1, username: 'admin', role: 'admin', name: 'Administrator' };
                } else if (u.toLowerCase() === 'cashier' && p === 'cashier123') {
                    user = { id: 2, username: 'cashier', role: 'cashier', name: 'Cashier' };
                } else {
                    const localUsers = JSON.parse(localStorage.getItem('pos_registered_users') || '[]');
                    const found = localUsers.find(x => x.username.toLowerCase() === u.toLowerCase() && x.password === p);
                    if (found) {
                        user = { id: found.id, username: found.username, role: found.role || 'cashier', name: found.name };
                    }
                }
            }

            if (!user) {
                throw new Error('Invalid username or password.');
            }

            app.currentUser = user;
            localStorage.setItem('pos_current_user', JSON.stringify(user));
            app.updateUserHeader();

            const overlay = document.getElementById('pos-login-overlay');
            if (overlay) overlay.classList.add('hidden');

            await app.syncWithBackend();
            app.updateShopProfileHeader();
            app.navigate('dashboard');

            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'success',
                title: `Logged in as ${user.name || user.username}`,
                timer: 1500,
                showConfirmButton: false
            });

        } catch (err) {
            errText.textContent = err.message || 'Login failed';
            errBanner.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btnText.textContent = 'Sign In to POS';
        }
    },

    checkAuth: async () => {
        try {
            const res = await fetch(app.getApiUrl('/api/auth/me'), {
                method: 'GET',
                headers: app.getAuthHeaders(),
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                if (data && data.authenticated && data.user) {
                    app.currentUser = data.user;
                    localStorage.setItem('pos_current_user', JSON.stringify(data.user));
                    app.updateUserHeader();
                    return true;
                }
            }
        } catch (e) {
            // Offline / static mode
        }

        const saved = localStorage.getItem('pos_current_user');
        if (saved) {
            try {
                app.currentUser = JSON.parse(saved);
                app.updateUserHeader();
                return true;
            } catch (err) {}
        }
        return false;
    },

    updateUserHeader: () => {
        if (!app.currentUser) return;
        const nameEl = document.getElementById('user-display-name');
        const roleEl = document.getElementById('user-display-role');
        const avatarEl = document.getElementById('user-avatar-initials');
        const usersNav = document.getElementById('sidebar-users-item');

        if (nameEl) nameEl.textContent = app.currentUser.name || app.currentUser.username;
        if (roleEl) roleEl.textContent = app.currentUser.role || 'cashier';
        if (avatarEl) {
            const initial = (app.currentUser.name || app.currentUser.username || 'U').charAt(0).toUpperCase();
            avatarEl.textContent = initial;
        }

        if (usersNav) {
            if (app.currentUser.role === 'admin') {
                usersNav.classList.remove('hidden');
            } else {
                usersNav.classList.add('hidden');
            }
        }
    },

    logout: async () => {
        const result = await Swal.fire({
            title: 'Log out?',
            text: 'Are you sure you want to log out of Krishan POS?',
            icon: 'question',
            showCancelButton: true,
            confirmButtonText: 'Yes, Logout',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#ef4444'
        });

        if (result.isConfirmed) {
            try {
                await fetch(app.getApiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
            } catch (e) {}
            localStorage.removeItem('pos_current_user');
            app.currentUser = null;
            app.showLoginOverlay();
        }
    },



    initTheme: () => {
        const isDark = localStorage.getItem('krishan_pos_theme') === 'dark';
        if (isDark) {
            document.documentElement.classList.add('dark');
            const icon = document.getElementById('theme-icon');
            if (icon) {
                icon.classList.remove('fa-moon');
                icon.classList.add('fa-sun');
            }
        } else {
            document.documentElement.classList.remove('dark');
            const icon = document.getElementById('theme-icon');
            if (icon) {
                icon.classList.remove('fa-sun');
                icon.classList.add('fa-moon');
            }
        }
    },

    toggleDarkMode: () => {
        const html = document.documentElement;
        const icon = document.getElementById('theme-icon');
        if (html.classList.contains('dark')) {
            html.classList.remove('dark');
            localStorage.setItem('krishan_pos_theme', 'light');
            if (icon) {
                icon.classList.remove('fa-sun');
                icon.classList.add('fa-moon');
            }
        } else {
            html.classList.add('dark');
            localStorage.setItem('krishan_pos_theme', 'dark');
            if (icon) {
                icon.classList.remove('fa-moon');
                icon.classList.add('fa-sun');
            }
        }
    },

    getShopProfile: () => ({
        shopName: localStorage.getItem('krishan_pos_shop_name') || 'Krishan Communication & Studio',
        ownerName: localStorage.getItem('krishan_pos_owner_name') || 'Owner',
        phone: localStorage.getItem('krishan_pos_phone') || '',
        address: localStorage.getItem('krishan_pos_address') || ''
    }),

    saveShopProfile: (profile) => {
        localStorage.setItem('krishan_pos_shop_name', profile.shopName || 'Krishan Communication & Studio');
        localStorage.setItem('krishan_pos_owner_name', profile.ownerName || 'Owner');
        localStorage.setItem('krishan_pos_phone', profile.phone || '');
        localStorage.setItem('krishan_pos_address', profile.address || '');

        app.apiCall('/api/settings', 'POST', { key: 'shop_name', value: profile.shopName || '' }, 'set_setting');
        app.apiCall('/api/settings', 'POST', { key: 'owner_name', value: profile.ownerName || '' }, 'set_setting');
        app.apiCall('/api/settings', 'POST', { key: 'phone', value: profile.phone || '' }, 'set_setting');
        app.apiCall('/api/settings', 'POST', { key: 'address', value: profile.address || '' }, 'set_setting');
    },

    updateShopProfileHeader: () => {
        const profile = app.getShopProfile();
        const shopLabel = document.getElementById('shop-profile-name');
        if (shopLabel) {
            shopLabel.textContent = profile.shopName;
        }
    },

    editShopProfile: async () => {
        const currentProfile = app.getShopProfile();
        const { value: profileData } = await Swal.fire({
            title: '<i class="fa-solid fa-store text-violet-600 mb-2"></i><br>Business Profile Details',
            html: `
                <div class="text-left text-sm text-slate-500 mb-3">Add or edit your shop details (shown on receipts & header).</div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-left">
                    <div class="md:col-span-2">
                        <label class="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Shop Name</label>
                        <input id="setup-shop-name" class="swal2-input !mt-0 !w-full" placeholder="Krishan Communication & Studio" value="${currentProfile.shopName || ''}">
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Owner Name</label>
                        <input id="setup-owner-name" class="swal2-input !mt-0 !w-full" placeholder="Owner Name" value="${currentProfile.ownerName || ''}">
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Phone Number</label>
                        <input id="setup-phone" class="swal2-input !mt-0 !w-full" placeholder="0771234567" value="${currentProfile.phone || ''}">
                    </div>
                    <div class="md:col-span-2">
                        <label class="block text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Address</label>
                        <textarea id="setup-address" class="swal2-textarea !mt-0 !w-full" rows="2" placeholder="Shop address">${currentProfile.address || ''}</textarea>
                    </div>
                </div>
            `,
            focusConfirm: false,
            showCancelButton: true,
            confirmButtonText: 'Save Details',
            confirmButtonColor: '#7c3aed',
            preConfirm: () => {
                const shopName = document.getElementById('setup-shop-name').value.trim();
                const ownerName = document.getElementById('setup-owner-name').value.trim();
                const phone = document.getElementById('setup-phone').value.trim();
                const address = document.getElementById('setup-address').value.trim();

                if (!shopName) {
                    Swal.showValidationMessage('Please enter shop name');
                    return false;
                }

                return { shopName, ownerName, phone, address };
            }
        });

        if (profileData) {
            app.saveShopProfile(profileData);
            app.updateShopProfileHeader();
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'success',
                title: 'Shop profile saved',
                showConfirmButton: false,
                timer: 2000
            });
        }
    },

    // ──────────────────────────────────────────────
    // AUTO MESSAGE & SMS GATEWAY CONFIGURATION
    // ──────────────────────────────────────────────
    // WHATSAPP 1-SHOT DISPATCH & GATEWAY ENGINE
    // ──────────────────────────────────────────────
    updateWhatsAppStatus: (statusData) => {
        if (!statusData) return;
        const prevConnected = app.whatsapp.connected;
        app.whatsapp.connected = Boolean(statusData.connected);
        app.whatsapp.status = statusData.status || (statusData.connected ? 'connected' : 'disconnected');
        app.whatsapp.qr = statusData.qr || null;
        app.whatsapp.user = statusData.user || null;

        app.renderWhatsAppStatusUI();

        // If modal is open, refresh dynamically
        if (app.whatsapp.modalOpen) {
            app.renderWhatsAppModalContent();
            if (!prevConnected && app.whatsapp.connected) {
                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'success',
                    title: `🎉 WhatsApp Connected (+${app.whatsapp.user?.phone || 'Shop'})! 1-Shot Active`,
                    timer: 4000,
                    showConfirmButton: false
                });
            }
        }
    },

    renderWhatsAppStatusUI: () => {
        const dot = document.getElementById('whatsapp-header-dot');
        const label = document.getElementById('whatsapp-header-label');
        const btn = document.getElementById('whatsapp-header-btn');
        const sidebarBadge = document.getElementById('sidebar-whatsapp-status-badge');

        if (app.whatsapp.connected) {
            if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50';
            if (label) {
                label.textContent = 'WA Live';
                label.className = 'hidden sm:inline font-bold text-emerald-700 dark:text-emerald-300';
            }
            if (btn) {
                btn.title = `WhatsApp Connected: +${app.whatsapp.user?.phone || 'Shop'} (1-Shot Active)`;
                btn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-700 dark:text-emerald-300 border border-emerald-400 dark:border-emerald-600 text-xs font-bold transition-all shadow-sm active:scale-95 cursor-pointer';
            }
            if (sidebarBadge) {
                sidebarBadge.className = 'ml-auto text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold';
                sidebarBadge.textContent = 'Live';
            }
        } else if (app.whatsapp.status === 'waiting_qr') {
            if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse';
            if (label) {
                label.textContent = 'Scan QR';
                label.className = 'hidden sm:inline font-bold text-amber-600 dark:text-amber-400';
            }
            if (btn) {
                btn.title = 'Scan WhatsApp QR code to link POS';
                btn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-400 dark:border-amber-600 text-xs font-bold transition-all shadow-sm active:scale-95 cursor-pointer';
            }
            if (sidebarBadge) {
                sidebarBadge.className = 'ml-auto text-[10px] px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-bold';
                sidebarBadge.textContent = 'Scan QR';
            }
        } else if (app.whatsapp.status === 'connecting') {
            if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-blue-500 animate-ping';
            if (label) {
                label.textContent = 'Connecting...';
                label.className = 'hidden sm:inline font-bold text-blue-600 dark:text-blue-400';
            }
            if (sidebarBadge) {
                sidebarBadge.className = 'ml-auto text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-bold';
                sidebarBadge.textContent = 'Connecting';
            }
        } else {
            if (dot) dot.className = 'inline-block w-2 h-2 rounded-full bg-slate-400';
            if (label) {
                label.textContent = 'WhatsApp';
                label.className = 'hidden sm:inline text-slate-500 dark:text-slate-400';
            }
            if (btn) {
                btn.title = 'WhatsApp Disconnected. Click to connect.';
                btn.className = 'flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-bold transition-all shadow-sm active:scale-95 cursor-pointer';
            }
            if (sidebarBadge) {
                sidebarBadge.className = 'ml-auto text-[10px] px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 font-bold';
                sidebarBadge.textContent = 'Offline';
            }
        }
    },

    fetchWhatsAppStatus: async () => {
        try {
            const res = await fetch(app.getApiUrl('/api/whatsapp/status'));
            if (res.ok) {
                const data = await res.json();
                app.updateWhatsAppStatus(data);
            }
        } catch (e) {
            console.warn('Could not fetch WhatsApp status:', e.message);
        }
    },

    sendDirectWhatsApp: async ({ phone, message }) => {
        try {
            const res = await fetch(app.getApiUrl('/api/whatsapp/send'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone, message })
            });
            const data = await res.json().catch(() => ({}));
            return data;
        } catch (err) {
            console.warn('Direct WhatsApp API failed:', err);
            return { success: false, error: err.message };
        }
    },

    getWhatsAppModalHTML: () => {
        const isConnected = app.whatsapp.connected;
        const phone = app.whatsapp.user?.phone || '';
        const name = app.whatsapp.user?.name || '';

        if (isConnected) {
            return `
                <div class="space-y-4 text-xs">
                    <!-- Status Header -->
                    <div class="p-4 rounded-2xl bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-emerald-500/5 border border-emerald-500/40 flex items-center gap-3.5 shadow-sm">
                        <div class="w-12 h-12 rounded-2xl bg-emerald-500 text-white flex items-center justify-center text-2xl flex-shrink-0 shadow-lg shadow-emerald-500/30">
                            <i class="fa-brands fa-whatsapp"></i>
                        </div>
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="relative flex h-2.5 w-2.5">
                                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                                </span>
                                <span class="font-black text-sm text-emerald-900 dark:text-emerald-200">WhatsApp Active (1-Shot Enabled)</span>
                            </div>
                            <div class="text-[12px] text-slate-700 dark:text-slate-200 font-bold mt-0.5">
                                +${phone} ${name ? `<span class="text-slate-400 font-normal">(${name})</span>` : ''}
                            </div>
                            <p class="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                                ✓ බිල්පත් සහ රෙපයාර් සටහන් එක ක්ලික් එකෙන් Customer ට ස්වයංක්‍රීයව යයි.
                            </p>
                        </div>
                    </div>

                    <!-- Direct Test Sender Tool -->
                    <div class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 space-y-2.5">
                        <div class="font-bold text-slate-700 dark:text-slate-200 flex items-center justify-between">
                            <span class="flex items-center gap-1.5"><i class="fa-solid fa-paper-plane text-emerald-600"></i> Test 1-Shot WhatsApp Message</span>
                            <span class="text-[10px] text-slate-400 font-normal">පණිවිඩය ටෙස්ට් කරන්න</span>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <div class="sm:col-span-1">
                                <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Phone Number (අංකය)</label>
                                <input id="wa-test-phone" type="tel" class="swal2-input !m-0 !w-full !text-xs font-mono font-bold" placeholder="07x xxxxxxx" value="${phone || ''}">
                            </div>
                            <div class="sm:col-span-2">
                                <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Message (පණිවිඩය)</label>
                                <input id="wa-test-msg" type="text" class="swal2-input !m-0 !w-full !text-xs" value="⚡ Hello from Krishan POS! Direct WhatsApp 1-shot sending is active!">
                            </div>
                        </div>
                        <button id="wa-btn-send-test" type="button" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold flex items-center justify-center gap-2 transition active:scale-95 text-xs shadow-md shadow-emerald-600/20 cursor-pointer">
                            <i class="fa-solid fa-bolt"></i> Send Test Message (1-Shot)
                        </button>
                    </div>

                    <!-- Actions -->
                    <div class="flex items-center justify-between pt-1">
                        <button id="wa-btn-restart" type="button" class="text-xs text-slate-600 dark:text-slate-300 hover:text-slate-900 flex items-center gap-1.5 py-1.5 px-3 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 transition cursor-pointer">
                            <i class="fa-solid fa-arrows-rotate"></i> Reconnect Session
                        </button>
                        <button id="wa-btn-logout" type="button" class="text-xs text-red-600 hover:text-red-700 dark:text-red-400 flex items-center gap-1.5 py-1.5 px-3 rounded-xl border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/30 transition cursor-pointer">
                            <i class="fa-solid fa-right-from-bracket"></i> Unlink / Scan New Number
                        </button>
                    </div>
                </div>
            `;
        }

        // Waiting QR or Disconnected state
        return `
            <div class="space-y-4 text-xs">
                <div class="p-4 rounded-2xl bg-gradient-to-b from-emerald-50/60 to-slate-50 dark:from-slate-800 dark:to-slate-800/80 border border-emerald-200 dark:border-slate-700 text-center space-y-3 shadow-sm">
                    <div>
                        <h3 class="font-black text-sm text-slate-800 dark:text-slate-100 flex items-center justify-center gap-2">
                            <i class="fa-brands fa-whatsapp text-emerald-500 text-xl"></i> Link Shop WhatsApp to POS
                        </h3>
                        <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            ස්වයංක්‍රීයව එක් ක්ලික් එකෙන් බිල්පත් සහ රෙපයාර් ස්ලිප් යැවීම සඳහා WhatsApp සම්බන්ධ කරන්න
                        </p>
                    </div>

                    <div class="relative inline-block mx-auto">
                        ${app.whatsapp.qr ? `
                            <img id="wa-qr-image" src="${app.whatsapp.qr}" class="w-64 h-64 mx-auto rounded-2xl border-4 border-emerald-500/20 shadow-xl bg-white p-2 object-contain transition-all" alt="WhatsApp QR Code">
                        ` : `
                            <div class="w-64 h-64 mx-auto rounded-2xl border-2 border-dashed border-emerald-300 dark:border-slate-600 flex flex-col items-center justify-center gap-3 text-slate-400 bg-white/70 dark:bg-slate-900/70">
                                <i class="fa-solid fa-circle-notch fa-spin text-3xl text-emerald-500"></i>
                                <span class="text-xs font-semibold text-slate-600 dark:text-slate-300">Generating WhatsApp QR...</span>
                                <span class="text-[10px] text-slate-400">ක්‍රියාවලිය සකස් වෙමින් පවතී</span>
                            </div>
                        `}
                    </div>

                    <!-- Steps in Sinhala & English -->
                    <div class="p-3 rounded-xl bg-white dark:bg-slate-900/80 border border-slate-200 dark:border-slate-700 text-left text-[11px] space-y-2 text-slate-600 dark:text-slate-300">
                        <div class="flex items-center gap-2">
                            <span class="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 font-bold flex items-center justify-center text-[10px] flex-shrink-0">1</span>
                            <span>ඔබගේ දුරකථනයේ <strong>WhatsApp</strong> (හෝ WhatsApp Business) විවෘත කරන්න.</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 font-bold flex items-center justify-center text-[10px] flex-shrink-0">2</span>
                            <span><strong>Settings (හෝ ⋮ මෙනුව)</strong> > <strong>Linked Devices</strong> (සම්බන්ධිත උපාංග) වෙත යන්න.</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <span class="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 font-bold flex items-center justify-center text-[10px] flex-shrink-0">3</span>
                            <span><strong>Link a Device</strong> ඔබා මෙම QR Code එක Scan කරන්න.</span>
                        </div>
                    </div>

                    <button id="wa-btn-restart-qr" type="button" class="w-full py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-xl font-bold flex items-center justify-center gap-2 text-xs transition cursor-pointer">
                        <i class="fa-solid fa-arrows-rotate"></i> Refresh QR Code (නැවත උත්සාහ කරන්න)
                    </button>
                </div>
            </div>
        `;
    },

    attachWhatsAppModalEvents: () => {
        // Send Test Message
        const btnSendTest = document.getElementById('wa-btn-send-test');
        if (btnSendTest) {
            btnSendTest.addEventListener('click', async () => {
                const phoneInput = document.getElementById('wa-test-phone');
                const msgInput = document.getElementById('wa-test-msg');
                const phone = (phoneInput?.value || '').trim();
                const msg = (msgInput?.value || '').trim();

                if (!phone) {
                    Swal.showValidationMessage('කරුණාකර දුරකථන අංකයක් ඇතුළත් කරන්න');
                    return;
                }
                if (!msg) {
                    Swal.showValidationMessage('කරුණාකර පණිවිඩයක් ඇතුළත් කරන්න');
                    return;
                }

                btnSendTest.disabled = true;
                const originalHtml = btnSendTest.innerHTML;
                btnSendTest.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i> Sending 1-Shot Message...';

                const res = await app.sendDirectWhatsApp({ phone, message: msg });
                btnSendTest.disabled = false;
                btnSendTest.innerHTML = originalHtml;

                if (res.success) {
                    Swal.fire({
                        toast: true,
                        position: 'top-end',
                        icon: 'success',
                        title: `✅ Test message delivered to +${res.phone || phone}! (1-Shot)`,
                        timer: 3500,
                        showConfirmButton: false
                    });
                } else {
                    Swal.fire({
                        icon: 'error',
                        title: 'Delivery Failed',
                        text: res.message || res.error || 'Failed to send WhatsApp message.',
                        confirmButtonColor: '#10b981'
                    });
                }
            });
        }

        // Restart / Reconnect Session
        const btnRestart = document.getElementById('wa-btn-restart') || document.getElementById('wa-btn-restart-qr');
        if (btnRestart) {
            btnRestart.addEventListener('click', async () => {
                btnRestart.disabled = true;
                btnRestart.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1.5"></i> Reconnecting...';
                try {
                    await fetch(app.getApiUrl('/api/whatsapp/restart'), { method: 'POST' });
                    app.whatsapp.status = 'connecting';
                    app.renderWhatsAppModalContent();
                } catch (e) {
                    console.error('Restart failed:', e);
                }
            });
        }

        // Logout / Unlink
        const btnLogout = document.getElementById('wa-btn-logout');
        if (btnLogout) {
            btnLogout.addEventListener('click', async () => {
                const conf = await Swal.fire({
                    title: 'Unlink WhatsApp?',
                    text: 'ඔබට මෙම WhatsApp ගිණුම ඉවත් කර අලුත් අංකයක් Scan කිරීමට අවශ්‍යද?',
                    icon: 'warning',
                    showCancelButton: true,
                    confirmButtonText: 'Yes, Unlink (ඉවත් කරන්න)',
                    cancelButtonText: 'Cancel',
                    confirmButtonColor: '#ef4444'
                });
                if (conf.isConfirmed) {
                    Swal.showLoading();
                    await fetch(app.getApiUrl('/api/whatsapp/logout'), { method: 'POST' });
                    app.whatsapp.connected = false;
                    app.whatsapp.status = 'disconnected';
                    app.whatsapp.user = null;
                    app.whatsapp.qr = null;
                    app.renderWhatsAppStatusUI();
                    app.openWhatsAppManagerModal();
                }
            });
        }
    },

    renderWhatsAppModalContent: () => {
        const container = document.getElementById('wa-modal-dynamic-content');
        if (!container) return;
        container.innerHTML = app.getWhatsAppModalHTML();
        app.attachWhatsAppModalEvents();
    },

    openWhatsAppManagerModal: async () => {
        app.whatsapp.modalOpen = true;
        app.fetchWhatsAppStatus();

        await Swal.fire({
            title: '<div class="flex items-center justify-center gap-2 text-lg font-black"><i class="fa-brands fa-whatsapp text-emerald-500 text-2xl"></i> WhatsApp 1-Shot Messenger</div>',
            html: `<div id="wa-modal-dynamic-content">${app.getWhatsAppModalHTML()}</div>`,
            showConfirmButton: false,
            showCloseButton: true,
            width: '32rem',
            didOpen: () => {
                app.attachWhatsAppModalEvents();
            },
            didClose: () => {
                app.whatsapp.modalOpen = false;
            }
        });
    },

    getMessageSettings: () => ({
        autoMsgOnSave: localStorage.getItem('krishan_pos_auto_msg') !== 'false',
        channel: localStorage.getItem('krishan_pos_msg_channel') || 'whatsapp', // 'whatsapp' | 'dialog' | 'notify'
        provider: localStorage.getItem('krishan_pos_sms_provider') || 'dialog',
        apiKey: localStorage.getItem('krishan_pos_sms_key') || '',
        password: localStorage.getItem('krishan_pos_sms_pass') || '',
        senderId: localStorage.getItem('krishan_pos_sms_sender') || 'KRISHAN',
        apiUrl: localStorage.getItem('krishan_pos_sms_url') || ''
    }),

    saveMessageSettings: (settings) => {
        localStorage.setItem('krishan_pos_auto_msg', settings.autoMsgOnSave ? 'true' : 'false');
        localStorage.setItem('krishan_pos_msg_channel', settings.channel || 'whatsapp');
        localStorage.setItem('krishan_pos_sms_provider', settings.provider || 'dialog');
        localStorage.setItem('krishan_pos_sms_key', settings.apiKey || '');
        localStorage.setItem('krishan_pos_sms_pass', settings.password || '');
        localStorage.setItem('krishan_pos_sms_sender', settings.senderId || 'KRISHAN');
        localStorage.setItem('krishan_pos_sms_url', settings.apiUrl || '');
    },

    openMessageSettingsModal: async () => {
        const cur = app.getMessageSettings();
        const isWaConnected = app.whatsapp.connected;
        const { value: res } = await Swal.fire({
            title: '<div class="flex items-center justify-center gap-2 text-lg font-black"><i class="fa-brands fa-whatsapp text-emerald-500 text-2xl"></i> Auto Message & SMS Gateway Settings</div>',
            html: `
                <div class="text-left text-xs space-y-3.5 my-2">
                    <!-- WhatsApp 1-Shot Status Banner -->
                    <div class="p-3 rounded-xl ${isWaConnected ? 'bg-emerald-50/80 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-700' : 'bg-amber-50/80 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700'} flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                            <i class="fa-brands fa-whatsapp text-lg ${isWaConnected ? 'text-emerald-600' : 'text-amber-500'}"></i>
                            <div>
                                <div class="font-bold ${isWaConnected ? 'text-emerald-900 dark:text-emerald-200' : 'text-amber-900 dark:text-amber-200'}">
                                    ${isWaConnected ? `POS WhatsApp Active (+${app.whatsapp.user?.phone || 'Shop'})` : 'POS WhatsApp Not Connected'}
                                </div>
                                <div class="text-[10px] text-slate-500">
                                    ${isWaConnected ? '1-Shot Direct Sending සක්‍රීයව පවතී' : 'Scan QR to send messages in 1-Shot'}
                                </div>
                            </div>
                        </div>
                        <button type="button" onclick="Swal.close(); app.openWhatsAppManagerModal();" class="px-2.5 py-1 rounded-lg ${isWaConnected ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-amber-600 hover:bg-amber-700'} text-white font-bold text-[11px] shadow-sm transition active:scale-95 cursor-pointer">
                            ${isWaConnected ? 'Manage' : 'Scan QR'}
                        </button>
                    </div>

                    <div class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                        <label class="flex items-center justify-between cursor-pointer">
                            <span class="font-bold text-slate-700 dark:text-slate-200">
                                ⚡ Auto-Send Message on Bill Save<br>
                                <span class="text-[11px] font-normal text-slate-500">බිල්පතක් හෝ රෙපයාර් එකක් දැමූ සැනින් ස්වයංක්‍රීයව පණිවිඩය යවන්න</span>
                            </span>
                            <input id="cfg-auto-msg" type="checkbox" class="w-5 h-5 accent-emerald-600 rounded cursor-pointer" ${cur.autoMsgOnSave ? 'checked' : ''}>
                        </label>
                    </div>

                    <div>
                        <label class="block font-bold text-slate-700 dark:text-slate-300 mb-1">Primary Notification Channel (පණිවිඩය යවන මාධ්‍යය):</label>
                        <div class="grid grid-cols-2 gap-2">
                            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-emerald-300/80 bg-emerald-50/50 dark:bg-emerald-950/30 cursor-pointer">
                                <input type="radio" name="cfg-channel" value="whatsapp" ${cur.channel === 'whatsapp' ? 'checked' : ''} onchange="document.getElementById('sms-gateway-fields').classList.add('hidden')">
                                <span class="font-bold text-emerald-800 dark:text-emerald-300 text-xs"><i class="fa-brands fa-whatsapp text-emerald-600"></i> WhatsApp (1-Shot / Web)</span>
                            </label>
                            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-blue-300/80 bg-blue-50/50 dark:bg-blue-950/30 cursor-pointer">
                                <input type="radio" name="cfg-channel" value="dialog" ${cur.channel !== 'whatsapp' ? 'checked' : ''} onchange="document.getElementById('sms-gateway-fields').classList.remove('hidden')">
                                <span class="font-bold text-blue-800 dark:text-blue-300 text-xs"><i class="fa-solid fa-tower-broadcast text-blue-600"></i> Dialog e-SMS / SMS API</span>
                            </label>
                        </div>
                    </div>

                    <div id="sms-gateway-fields" class="${cur.channel === 'whatsapp' ? 'hidden' : ''} space-y-2.5 p-3 rounded-xl bg-blue-50/40 dark:bg-slate-800 border border-blue-200 dark:border-slate-700">
                        <div class="text-[11px] font-bold text-blue-700 dark:text-blue-300 flex items-center gap-1.5 mb-1">
                            <i class="fa-solid fa-gear"></i> Dialog Enterprise e-SMS / API Configuration
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Username / API Key</label>
                                <input id="cfg-sms-key" class="swal2-input !m-0 !w-full !text-xs font-semibold" placeholder="e.g. esms_user / API Key" value="${cur.apiKey}">
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Password / API Secret</label>
                                <input id="cfg-sms-pass" type="password" class="swal2-input !m-0 !w-full !text-xs font-semibold" placeholder="Password / Token" value="${cur.password}">
                            </div>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Sender ID / Mask Name</label>
                                <input id="cfg-sms-sender" class="swal2-input !m-0 !w-full !text-xs font-semibold" placeholder="e.g. KRISHAN" value="${cur.senderId}">
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Gateway Provider</label>
                                <select id="cfg-sms-provider" class="swal2-input !m-0 !w-full !text-xs font-semibold">
                                    <option value="dialog" ${cur.provider === 'dialog' ? 'selected' : ''}>Dialog e-SMS</option>
                                    <option value="notify" ${cur.provider === 'notify' ? 'selected' : ''}>Notify.lk</option>
                                </select>
                            </div>
                        </div>
                        <p class="text-[10px] text-slate-500">Dialog e-SMS ගිණුමේ Username/Password ඇතුළත් කළ විට WhatsApp නොමැතිව කෙලින්ම Customer ගේ දුරකථනයට SMS පණිවිඩය ස්වයංක්‍රීයව යවයි.</p>
                    </div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: 'Save Settings',
            confirmButtonColor: '#10b981',
            preConfirm: () => {
                const autoMsgOnSave = document.getElementById('cfg-auto-msg').checked;
                const channel = document.querySelector('input[name="cfg-channel"]:checked')?.value || 'whatsapp';
                const apiKey = (document.getElementById('cfg-sms-key')?.value || '').trim();
                const password = (document.getElementById('cfg-sms-pass')?.value || '').trim();
                const senderId = (document.getElementById('cfg-sms-sender')?.value || '').trim();
                const provider = document.getElementById('cfg-sms-provider')?.value || 'dialog';
                return { autoMsgOnSave, channel, apiKey, password, senderId, provider };
            }
        });

        if (res) {
            app.saveMessageSettings(res);
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'success',
                title: 'Message Settings Saved',
                timer: 2000,
                showConfirmButton: false
            });
        }
    },

    updateDateTime: () => {
        const now = new Date();
        document.getElementById('current-time').textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        document.getElementById('current-date').textContent = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    },

    navigate: async (view) => {
        const content = document.getElementById('app-content');
        app.state.currentView = view;

        // Update Sidebar Active State
        document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active', 'border-r-4', 'border-violet-600', 'bg-violet-50', 'text-violet-600'));
        const activeNav = document.getElementById(`nav-${view}`);
        if (activeNav) activeNav.classList.add('active', 'border-r-4', 'border-violet-600', 'bg-violet-50', 'text-violet-600');

        content.innerHTML = '<div class="flex items-center justify-center h-full"><i class="fa-solid fa-circle-notch fa-spin text-4xl text-violet-600"></i></div>';

        try {
            switch (view) {
                case 'dashboard':
                    await app.renderDashboard();
                    break;
                case 'pos':
                    await app.renderPOS();
                    break;
                case 'products':
                    await app.renderInventory();
                    break;
                case 'repairs':
                    await app.renderRepairs();
                    break;
                case 'frames':
                    await app.renderPhotoFrames();
                    break;
                case 'sales':
                    await app.renderSalesHistory();
                    break;
                case 'reports':
                    await app.renderReports();
                    break;
                case 'expenses':
                    await app.renderExpenses();
                    break;
                case 'credits':
                    await app.renderCredits();
                    break;
                case 'utility':
                    await app.renderUtilityBills();
                    break;
                case 'suppliers':
                    await app.renderSuppliers();
                    break;
                case 'bank':
                    await app.renderBankTracker();
                    break;
                case 'users':
                    await app.renderUsers();
                    break;
                default:
                    await app.renderDashboard();
            }
        } catch (navErr) {
            console.error(`Navigation error for view ${view}:`, navErr);
            if (content) {
                content.innerHTML = `
                    <div class="p-8 text-center bg-white rounded-3xl border border-slate-200 shadow-sm max-w-lg mx-auto my-12">
                        <i class="fa-solid fa-triangle-exclamation text-4xl text-amber-500 mb-3"></i>
                        <h3 class="text-lg font-bold text-slate-800">Krishan POS</h3>
                        <p class="text-sm text-slate-500 mt-1 mb-5">Click below to open Point of Sale</p>
                        <button onclick="app.navigate('pos')" class="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-bold text-sm shadow-md">
                            Go to POS Screen
                        </button>
                    </div>
                `;
            }
        }
    },

    renderUsers: async () => {
        if (!app.currentUser || app.currentUser.role !== 'admin') {
            Swal.fire('Access Denied', 'Only administrators can manage user accounts.', 'warning');
            app.navigate('dashboard');
            return;
        }

        let users = [];
        try {
            const res = await fetch(app.getApiUrl('/api/users'), { credentials: 'include' });
            const data = await res.json();
            if (data.success) users = data.users;
        } catch (e) {
            console.error('Error loading users:', e);
        }

        const html = `
            <div class="fade-in max-w-6xl mx-auto pb-16">
                <!-- Header -->
                <div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
                    <div>
                        <h2 class="text-3xl font-black text-slate-800 dark:text-slate-100 flex items-center gap-3">
                            <i class="fa-solid fa-users-gear text-purple-600"></i> User Accounts & Roles
                        </h2>
                        <p class="text-slate-500 text-sm mt-1">Manage system administrators and cashier logins</p>
                    </div>
                    <button onclick="app.openUserModal()" class="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white px-5 py-3 rounded-2xl font-bold shadow-lg shadow-purple-200 dark:shadow-none flex items-center gap-2 transition-all transform active:scale-95">
                        <i class="fa-solid fa-user-plus"></i> Add New User
                    </button>
                </div>

                <!-- Users Grid / Table -->
                <div class="bg-white dark:bg-slate-800 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-700 overflow-hidden">
                    <div class="overflow-x-auto">
                        <table class="w-full text-left border-collapse">
                            <thead>
                                <tr class="bg-slate-50 dark:bg-slate-900/50 border-b border-slate-200 dark:border-slate-700 text-xs uppercase font-extrabold text-slate-500 tracking-wider">
                                    <th class="p-4 pl-6">User</th>
                                    <th class="p-4">Username</th>
                                    <th class="p-4">Role</th>
                                    <th class="p-4">Created Date</th>
                                    <th class="p-4 text-right pr-6">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-100 dark:divide-slate-700/50 text-sm">
                                ${users.map(u => `
                                    <tr class="hover:bg-slate-50/50 dark:hover:bg-slate-700/20 transition-colors">
                                        <td class="p-4 pl-6 font-bold text-slate-800 dark:text-slate-200 flex items-center gap-3">
                                            <div class="w-10 h-10 rounded-full ${u.role === 'admin' ? 'bg-purple-600' : 'bg-blue-600'} text-white flex items-center justify-center font-bold text-sm">
                                                ${(u.name || u.username).charAt(0).toUpperCase()}
                                            </div>
                                            <div>
                                                <div class="font-bold text-slate-800 dark:text-slate-100">${u.name}</div>
                                                <div class="text-xs text-slate-400 font-normal">ID: #${u.id}</div>
                                            </div>
                                        </td>
                                        <td class="p-4 font-mono font-bold text-slate-700 dark:text-slate-300">
                                            @${u.username}
                                        </td>
                                        <td class="p-4">
                                            <span class="px-3 py-1 rounded-full text-xs font-bold ${
                                                u.role === 'admin'
                                                    ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
                                                    : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                                            }">
                                                <i class="fa-solid ${u.role === 'admin' ? 'fa-shield-halved' : 'fa-cash-register'} mr-1"></i>
                                                ${u.role.toUpperCase()}
                                            </span>
                                        </td>
                                        <td class="p-4 text-slate-500 text-xs">
                                            ${new Date(u.created_at || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                                        </td>
                                        <td class="p-4 text-right pr-6">
                                            <div class="inline-flex items-center gap-2">
                                                <button onclick="app.openUserModal(${u.id}, '${u.username}', '${u.name}', '${u.role}')" class="p-2 text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/30 rounded-lg transition-colors" title="Edit User">
                                                    <i class="fa-solid fa-pen-to-square"></i>
                                                </button>
                                                ${u.id !== app.currentUser.id ? `
                                                    <button onclick="app.deleteUser(${u.id}, '${u.username}')" class="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors" title="Delete User">
                                                        <i class="fa-solid fa-trash-can"></i>
                                                    </button>
                                                ` : '<span class="text-xs text-slate-400 italic px-2">You</span>'}
                                            </div>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
    },

    openUserModal: async (id = null, currentUsername = '', currentName = '', currentRole = 'cashier') => {
        const isEdit = Boolean(id);
        const { value: formValues } = await Swal.fire({
            title: `<i class="fa-solid ${isEdit ? 'fa-user-pen' : 'fa-user-plus'} text-purple-600 mb-2"></i><br>${isEdit ? 'Edit User Account' : 'Add New POS User'}`,
            html: `
                <div class="text-left space-y-3">
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Full Name</label>
                        <input id="swal-user-name" class="swal2-input !mt-0 !w-full" placeholder="e.g. Kasun Perera" value="${currentName}">
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Username (Login ID)</label>
                        <input id="swal-user-username" class="swal2-input !mt-0 !w-full" placeholder="e.g. kasun" value="${currentUsername}" ${isEdit ? 'disabled' : ''}>
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">${isEdit ? 'New Password (leave blank to keep current)' : 'Password'}</label>
                        <input id="swal-user-pass" type="password" class="swal2-input !mt-0 !w-full" placeholder="${isEdit ? '••••••••' : 'At least 4 characters'}">
                    </div>
                    <div>
                        <label class="block text-xs font-bold uppercase text-slate-500 mb-1">Role / Permissions</label>
                        <select id="swal-user-role" class="swal2-select !mt-0 !w-full">
                            <option value="cashier" ${currentRole === 'cashier' ? 'selected' : ''}>Cashier (Sales & Inventory View)</option>
                            <option value="admin" ${currentRole === 'admin' ? 'selected' : ''}>Administrator (Full Access)</option>
                        </select>
                    </div>
                </div>
            `,
            focusConfirm: false,
            showCancelButton: true,
            confirmButtonText: isEdit ? 'Save Changes' : 'Create User',
            confirmButtonColor: '#9333ea',
            preConfirm: () => {
                const name = document.getElementById('swal-user-name').value.trim();
                const username = document.getElementById('swal-user-username').value.trim();
                const password = document.getElementById('swal-user-pass').value.trim();
                const role = document.getElementById('swal-user-role').value;

                if (!name || (!isEdit && !username)) {
                    Swal.showValidationMessage('Please fill all required fields');
                    return false;
                }
                if (!isEdit && (!password || password.length < 4)) {
                    Swal.showValidationMessage('Password must be at least 4 characters');
                    return false;
                }
                return { name, username, password, role };
            }
        });

        if (formValues) {
            try {
                if (isEdit) {
                    const res = await fetch(app.getApiUrl(`/api/users/${id}`), {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify(formValues)
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.message || 'Update failed');
                    Swal.fire({ icon: 'success', title: 'User Updated', timer: 1500, showConfirmButton: false });
                } else {
                    const res = await fetch(app.getApiUrl('/api/users'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify(formValues)
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.message || 'Creation failed');
                    Swal.fire({ icon: 'success', title: 'User Created', timer: 1500, showConfirmButton: false });
                }
                app.renderUsers();
            } catch (err) {
                Swal.fire('Error', err.message, 'error');
            }
        }
    },

    deleteUser: async (id, username) => {
        const result = await Swal.fire({
            title: `Delete user @${username}?`,
            text: 'This account will no longer be able to log in.',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Yes, Delete',
            confirmButtonColor: '#ef4444',
            cancelButtonText: 'Cancel'
        });

        if (result.isConfirmed) {
            try {
                const res = await fetch(app.getApiUrl(`/api/users/${id}`), {
                    method: 'DELETE',
                    credentials: 'include'
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Delete failed');
                Swal.fire({ icon: 'success', title: 'User Deleted', timer: 1500, showConfirmButton: false });
                app.renderUsers();
            } catch (err) {
                Swal.fire('Error', err.message, 'error');
            }
        }
    },

    renderBankTracker: async () => {
        let transactions = [];
        try {
            transactions = await db.bankTransactions.reverse().toArray();
        } catch (e) {
            console.error("Database error:", e);
            // If table doesn't exist, we might need to refresh or alert
            Swal.fire('Database Update Required', 'Logging you out to refresh system tables...', 'info').then(() => {
                location.reload();
            });
            return;
        }

        const totalDeposits = transactions.filter(t => t.type === 'deposit').reduce((sum, t) => sum + t.amount, 0);
        const totalWithdrawals = transactions.filter(t => t.type === 'withdrawal').reduce((sum, t) => sum + t.amount, 0);
        const balance = totalDeposits - totalWithdrawals;

        const html = `
            <div class="fade-in max-w-5xl mx-auto">
                <div class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
                    <div>
                        <h2 class="text-3xl font-black text-slate-800">Bank Balance Tracker</h2>
                        <p class="text-slate-500">Manage your daily savings and withdrawals</p>
                    </div>
                    <div class="flex gap-3">
                        <button onclick="app.openBankTransactionModal('deposit')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-2xl font-bold shadow-lg shadow-emerald-100 flex items-center gap-2 transition-all">
                            <i class="fa-solid fa-plus-circle"></i> Deposit Money
                        </button>
                        <button onclick="app.openBankTransactionModal('withdrawal')" class="bg-red-600 hover:bg-red-700 text-white px-6 py-3 rounded-2xl font-bold shadow-lg shadow-red-100 flex items-center gap-2 transition-all">
                            <i class="fa-solid fa-minus-circle"></i> Withdraw Money
                        </button>
                    </div>
                </div>

                <!-- Balance Summary Card -->
                <div class="bg-gradient-to-br from-blue-600 to-indigo-700 p-10 rounded-[2.5rem] shadow-2xl shadow-blue-200 text-white mb-10 relative overflow-hidden">
                    <div class="absolute top-0 right-0 p-10 opacity-10">
                        <i class="fa-solid fa-building-columns text-[10rem]"></i>
                    </div>
                    <div class="relative z-10">
                        <p class="text-blue-100 font-bold text-xl mb-2 uppercase tracking-widest">Available Balance</p>
                        <h1 class="text-7xl font-black tracking-tighter mb-8">LKR ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</h1>
                        
                        <div class="grid grid-cols-2 gap-8 pt-8 border-t border-white/20">
                            <div>
                                <p class="text-blue-200 text-sm font-bold uppercase mb-1">Total Put</p>
                                <p class="text-2xl font-black text-emerald-300">+ LKR ${totalDeposits.toLocaleString()}</p>
                            </div>
                            <div>
                                <p class="text-blue-200 text-sm font-bold uppercase mb-1">Total Taken</p>
                                <p class="text-2xl font-black text-red-300">- LKR ${totalWithdrawals.toLocaleString()}</p>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Transaction History -->
                <div class="bg-white p-8 rounded-[2rem] shadow-xl border border-slate-200 overflow-hidden">
                    <div class="flex items-center justify-between mb-8">
                        <h3 class="text-xl font-black text-slate-800 flex items-center gap-2">
                            <i class="fa-solid fa-clock-rotate-left text-blue-600"></i> Transaction History
                        </h3>
                    </div>
                    
                    <div class="overflow-x-auto">
                        <table class="w-full">
                            <thead>
                                <tr class="text-left text-slate-400 text-sm uppercase font-bold border-b border-slate-100">
                                    <th class="pb-4 px-2">Date</th>
                                    <th class="pb-4 px-2">Description</th>
                                    <th class="pb-4 px-2 text-right">Amount</th>
                                    <th class="pb-4 px-2 text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-slate-50">
                                ${transactions.length === 0 ? `
                                    <tr>
                                        <td colspan="4" class="py-20 text-center">
                                            <div class="flex flex-col items-center opacity-30">
                                                <i class="fa-solid fa-receipt text-6xl mb-4"></i>
                                                <p class="text-xl font-bold">No transactions recorded yet</p>
                                                <p class="text-sm">Start by adding a deposit or withdrawal</p>
                                            </div>
                                        </td>
                                    </tr>
                                ` : transactions.map(t => `
                                    <tr class="hover:bg-slate-50/50 transition-colors group">
                                        <td class="py-5 px-2">
                                            <p class="font-bold text-slate-700">${new Date(t.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</p>
                                            <p class="text-xs text-slate-400">${new Date(t.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                                        </td>
                                        <td class="py-5 px-2">
                                            <div class="flex items-center gap-3">
                                                <div class="w-10 h-10 rounded-xl flex items-center justify-center ${t.type === 'deposit' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}">
                                                    <i class="fa-solid ${t.type === 'deposit' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down'}"></i>
                                                </div>
                                                <div>
                                                    <p class="font-bold text-slate-800 capitalize">${t.type}</p>
                                                    <p class="text-xs text-slate-500">${t.note || 'No description'}</p>
                                                </div>
                                            </div>
                                        </td>
                                        <td class="py-5 px-2 text-right">
                                            <p class="text-lg font-black ${t.type === 'deposit' ? 'text-emerald-600' : 'text-red-500'}">
                                                ${t.type === 'deposit' ? '+' : '-'} ${t.amount.toFixed(2)}
                                            </p>
                                        </td>
                                        <td class="py-5 px-2 text-right">
                                            <button onclick="app.deleteBankTransaction(${t.id})" class="text-slate-300 hover:text-red-500 transition-colors p-2 lg:opacity-0 group-hover:opacity-100">
                                                <i class="fa-solid fa-trash-can"></i>
                                            </button>
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
    },

    openBankTransactionModal: async (type) => {
        const { value: formValues } = await Swal.fire({
            title: `<i class="fa-solid ${type === 'deposit' ? 'fa-circle-plus text-emerald-600' : 'fa-circle-minus text-red-600'} mb-2"></i><br>${type === 'deposit' ? 'Add Deposit' : 'Record Withdrawal'}`,
            html: `
                <div class="text-sm text-slate-500 mb-4">Enter the amount and a brief note</div>
                <div class="relative mb-3">
                    <span class="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-slate-400">LKR</span>
                    <input id="bank-amount" class="swal2-input !m-0 !pl-14" type="number" placeholder="0.00" autofocus>
                </div>
                <input id="bank-note" class="swal2-input !m-0" type="text" placeholder="Note (optional)">
            `,
            showCancelButton: true,
            confirmButtonText: type === 'deposit' ? 'Deposit' : 'Withdraw',
            confirmButtonColor: type === 'deposit' ? '#059669' : '#dc2626',
            preConfirm: () => {
                const amount = parseFloat(document.getElementById('bank-amount').value);
                const note = document.getElementById('bank-note').value;
                if (!amount || amount <= 0) {
                    Swal.showValidationMessage('Please enter a valid amount');
                    return false;
                }
                return { amount, note };
            }
        });

        if (formValues) {
            const txRecord = {
                date: new Date().toISOString(),
                type: type,
                amount: formValues.amount,
                note: formValues.note
            };
            const newId = await db.bankTransactions.add(txRecord);
            app.apiCall('/api/bank-transactions', 'POST', { id: newId, ...txRecord }, 'create_bank_tx');
            app.renderBankTracker();
            
            Swal.fire({
                icon: 'success',
                title: 'Transaction Saved',
                showConfirmButton: false,
                timer: 1500,
                toast: true,
                position: 'top-end'
            });
        }
    },

    deleteBankTransaction: async (id) => {
        const result = await Swal.fire({
            title: 'Delete Transaction?',
            text: "This action cannot be undone!",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            confirmButtonText: 'Yes, delete it!'
        });

        if (result.isConfirmed) {
            await db.bankTransactions.delete(id);
            app.apiCall(`/api/bank-transactions/${id}`, 'DELETE', null, 'delete_bank_tx', id);
            app.renderBankTracker();
        }
    },

    renderSuppliers: async () => {
        const suppliers = await db.suppliers.toArray();
        const bills = await db.purchaseBills.toArray();

        const html = `
            <div class="fade-in max-w-6xl mx-auto">
                <div class="flex flex-col md:flex-row justify-between items-center mb-10 gap-6">
                    <div>
                        <h2 class="text-3xl font-black text-slate-800">Supplier & Purchase</h2>
                        <p class="text-slate-500">Track wholesale shops and delivery guys</p>
                    </div>
                    <button onclick="app.openAddSupplierModal()" class="bg-violet-600 hover:bg-violet-700 text-white px-6 py-3 rounded-2xl font-bold shadow-lg shadow-violet-100 flex items-center gap-2 transition-all">
                        <i class="fa-solid fa-plus"></i> Add New Supplier
                    </button>
                </div>

                <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <!-- Supplier List -->
                    <div class="lg:col-span-1 space-y-4">
                        <h3 class="font-bold text-slate-700 flex items-center gap-2 px-2">
                            <i class="fa-solid fa-address-book text-violet-600"></i> My Suppliers
                        </h3>
                        <div class="bg-white rounded-[2rem] shadow-xl border border-slate-200 overflow-hidden min-h-[500px]">
                            ${suppliers.length === 0 ? `
                                <div class="p-20 text-center opacity-30">
                                    <i class="fa-solid fa-truck-field text-5xl mb-3"></i>
                                    <p class="text-xs font-bold uppercase tracking-widest">No Suppliers Found</p>
                                </div>
                            ` : `
                                <div class="divide-y divide-slate-100 max-h-[500px] overflow-y-auto">
                                    ${suppliers.map(s => {
                                        const supplierBills = bills.filter(b => b.supplierId === s.id);
                                        const pendingTotal = supplierBills.reduce((sum, b) => sum + (b.total - (b.paidAmount || 0)), 0);
                                        return `
                                            <div onclick="app.viewSupplierBills(${s.id})" 
                                                 class="supplier-item-${s.id} p-5 hover:bg-slate-50 cursor-pointer transition-all flex items-center justify-between group">
                                                <div class="space-y-1">
                                                    <h4 class="font-black text-slate-800 text-base group-hover:text-violet-600 transition-colors">${s.name}</h4>
                                                    <p class="text-xs text-slate-400 font-medium">${s.company || 'Direct Supplier'}</p>
                                                    ${pendingTotal > 0 ? `
                                                        <span class="inline-block text-[10px] font-black uppercase tracking-wider text-red-500 bg-red-50 px-2 py-0.5 rounded-md">
                                                            LKR ${pendingTotal.toLocaleString()} Due
                                                        </span>
                                                    ` : `
                                                        <span class="inline-block text-[10px] font-black uppercase tracking-wider text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-md">
                                                            Settled
                                                        </span>
                                                    `}
                                                </div>
                                                <button onclick="event.stopPropagation(); app.deleteSupplier(${s.id})" 
                                                        class="opacity-0 group-hover:opacity-100 p-2 text-slate-300 hover:text-red-500 transition-all">
                                                    <i class="fa-solid fa-trash-can"></i>
                                                </button>
                                            </div>
                                        `;
                                    }).join('')}
                                </div>
                            `}
                        </div>
                    </div>

                    <!-- Supplier Details & Bills -->
                    <div id="supplier-bills-view" class="lg:col-span-2">
                        <div class="h-full bg-slate-50/50 rounded-[2rem] border-2 border-dashed border-slate-200 flex flex-col items-center justify-center p-12 text-center text-slate-400">
                            <i class="fa-solid fa-hand-pointer text-4xl mb-4 text-slate-300"></i>
                            <p class="font-bold">Select a supplier from the list</p>
                            <p class="text-xs">to view purchase bills and settle payments</p>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
    },

    openAddSupplierModal: async () => {
        const { value: formValues } = await Swal.fire({
            title: 'Add New Supplier',
            html: `
                <div class="text-left mb-2 text-xs font-bold text-slate-400 uppercase tracking-widest">Supplier Details</div>
                <input id="sup-name" class="swal2-input !mt-0" placeholder="Contact Name (e.g. Sunil)">
                <input id="sup-company" class="swal2-input" placeholder="Shop/Company (e.g. City Wholesale)">
                <input id="sup-contact" class="swal2-input" placeholder="Contact number">
            `,
            showCancelButton: true,
            confirmButtonText: 'Save Supplier',
            confirmButtonColor: '#7c3aed',
            preConfirm: () => {
                const name = document.getElementById('sup-name').value;
                const company = document.getElementById('sup-company').value;
                const contact = document.getElementById('sup-contact').value;
                if (!name) {
                    Swal.showValidationMessage('Name is required');
                    return false;
                }
                return { name, company, contact };
            }
        });

        if (formValues) {
            const newId = await db.suppliers.add(formValues);
            app.apiCall('/api/suppliers', 'POST', { id: newId, ...formValues }, 'create_supplier');
            app.renderSuppliers();
            Swal.fire({ icon: 'success', title: 'Supplier added', toast: true, position: 'top-end', timer: 2000, showConfirmButton: false });
        }
    },

    viewSupplierBills: async (supplierId) => {
        const supplier = await db.suppliers.get(supplierId);
        const bills = await db.purchaseBills.where('supplierId').equals(supplierId).reverse().toArray();
        const pendingTotal = bills.reduce((sum, b) => sum + (b.total - (b.paidAmount || 0)), 0);

        // Highlight active supplier
        document.querySelectorAll('[class^="supplier-item-"]').forEach(el => el.classList.remove('bg-violet-50', 'border-l-4', 'border-violet-600'));
        const activeItem = document.querySelector(`.supplier-item-${supplierId}`);
        if (activeItem) activeItem.classList.add('bg-violet-50', 'border-l-4', 'border-violet-600');

        const html = `
            <div class="fade-in flex flex-col h-full bg-white rounded-[2rem] shadow-xl border border-slate-200 p-8">
                <div class="flex justify-between items-start mb-8">
                    <div>
                        <h3 class="text-2xl font-black text-slate-800">${supplier.name}</h3>
                        <p class="text-slate-500 font-bold uppercase text-[10px] tracking-widest">${supplier.company || 'Private'} • ${supplier.contact || 'No Contact'}</p>
                    </div>
                    <button onclick="app.openAddSupplierBillModal(${supplierId})" class="bg-slate-900 text-white px-5 py-2.5 rounded-xl text-sm font-bold hover:bg-slate-800 transition-all flex items-center gap-2 shadow-lg">
                        <i class="fa-solid fa-plus-circle"></i> බිල්පතක් එක් කරන්න (Add Bill)
                    </button>
                </div>

                <div class="grid grid-cols-2 gap-6 mb-8">
                    <div class="bg-slate-50 p-5 rounded-2xl border border-slate-100">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">මුළු ඇණවුම් වටිනාකම (Total Ordered)</p>
                        <p class="text-2xl font-black text-slate-700">LKR ${bills.reduce((sum, b) => sum + b.total, 0).toLocaleString()}</p>
                    </div>
                    <div class="bg-red-50 p-5 rounded-2xl border border-red-100">
                        <p class="text-[10px] font-bold text-red-500 uppercase tracking-widest mb-1">ගෙවීමට ඇති මුදල (To be Paid)</p>
                        <p class="text-2xl font-black text-red-600">LKR ${pendingTotal.toLocaleString()}</p>
                    </div>
                </div>

                <div class="overflow-y-auto flex-1 scrollbar-hide pr-2">
                    <table class="w-full">
                        <thead class="sticky top-0 bg-white z-10">
                            <tr class="text-left text-[10px] text-slate-400 uppercase font-black tracking-widest border-b border-slate-100">
                                <th class="pb-3 px-2">Date / Info</th>
                                <th class="pb-3 px-2 text-right">බිල්පත (Bill)</th>
                                <th class="pb-3 px-2 text-right">ගෙවූ මුදල (Paid)</th>
                                <th class="pb-3 px-2 text-right">හිඟය (Balance)</th>
                                <th class="pb-3 px-2 text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-50">
                            ${bills.length === 0 ? `
                                <tr><td colspan="5" class="py-20 text-center text-slate-300 font-bold">පර්චස් අයිතම හමු නොවීය (No purchase records found)</td></tr>
                            ` : bills.map(b => {
            const balance = b.total - (b.paidAmount || 0);
            return `
                                <tr class="group hover:bg-slate-50/50 transition-colors">
                                    <td class="py-5 px-2">
                                        <p class="font-bold text-slate-700 text-sm">${new Date(b.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</p>
                                        <p class="text-[10px] text-slate-400 font-medium">${b.note || 'No Invoice #'}</p>
                                    </td>
                                    <td class="py-5 px-2 text-right font-bold text-slate-400 text-sm">LKR ${b.total.toLocaleString()}</td>
                                    <td class="py-5 px-2 text-right font-bold text-emerald-600 text-sm">LKR ${(b.paidAmount || 0).toLocaleString()}</td>
                                    <td class="py-5 px-2 text-right font-black text-slate-800 text-base">LKR ${balance.toLocaleString()}</td>
                                    <td class="py-5 px-2 text-center">
                                        <button onclick="app.markBillAsPaid(${b.id}, ${supplierId})" 
                                                class="text-[10px] font-black uppercase px-3 py-1.5 rounded-full transition-all ${balance <= 0 ? 'bg-emerald-100 text-emerald-700 shadow-sm border border-emerald-200' : 'bg-red-100 text-red-700 hover:bg-red-600 hover:text-white shadow-md border border-red-200'}">
                                            ${balance <= 0 ? 'Paid' : 'Gawanna (Pay)'}
                                        </button>
                                    </td>
                                </tr>
                            `}).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        document.getElementById('supplier-bills-view').innerHTML = html;
    },

    openAddSupplierBillModal: async (supplierId) => {
        const { value: formValues } = await Swal.fire({
            title: 'නව පර්චස් බිල්පතක් (Record New Purchase)',
            html: `
                <div class="text-left mb-4">
                    <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">මුළු මුදල (Bill Amount - LKR)</label>
                    <div class="relative mt-1">
                        <span class="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-slate-400">Rs.</span>
                        <input id="bill-total" type="number" class="swal2-input !m-0 !pl-14 !w-full" placeholder="Total Amount">
                    </div>
                </div>
                <div class="text-left mb-4">
                    <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">විස්තරය (Invoice / Note)</label>
                    <input id="bill-note" class="swal2-input !mt-1 !w-full" placeholder="e.g. Shop Bill #456">
                </div>
                <div class="text-left">
                    <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">තත්වය (Initial Status)</label>
                    <select id="bill-status" class="swal2-select !mt-1 !w-full !m-0">
                        <option value="pending">හිඟ මුදල් (Credit Bill)</option>
                        <option value="paid">ගෙවා නිම කළ (Paid Full)</option>
                    </select>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: 'සටහන් කරන්න (Record)',
            confirmButtonColor: '#0f172a',
            preConfirm: () => {
                const total = parseFloat(document.getElementById('bill-total').value);
                const note = document.getElementById('bill-note').value;
                const status = document.getElementById('bill-status').value;
                if (!total || total <= 0) {
                    Swal.showValidationMessage('මුදල ඇතුළත් කිරීම අනිවාර්යයි');
                    return false;
                }
                return { 
                    total, note, status, supplierId, 
                    date: new Date().toISOString(),
                    paidAmount: status === 'paid' ? total : 0 
                };
            }
        });

        if (formValues) {
            const newId = await db.purchaseBills.add(formValues);
            app.apiCall('/api/purchase-bills', 'POST', { id: newId, ...formValues }, 'create_bill');
            app.viewSupplierBills(supplierId);
            app.renderSuppliers();
        }
    },

    markBillAsPaid: async (billId, supplierId) => {
        const bill = await db.purchaseBills.get(billId);
        const currentPaid = bill.paidAmount || 0;
        const balance = bill.total - currentPaid;

        const { value: paidAmount } = await Swal.fire({
            title: 'මුදල් ගෙවීම (Record Payment)',
            html: `
                <div class="text-left mb-4 bg-slate-50 p-4 rounded-xl border border-slate-100 italic text-xs text-slate-500">
                    <div class="flex justify-between mb-1"><span>මුළු බිල්පත:</span> <span>LKR ${bill.total}</span></div>
                    <div class="flex justify-between mb-1"><span>කලින් ගෙවූ:</span> <span>LKR ${currentPaid}</span></div>
                    <div class="flex justify-between font-bold text-slate-700"><span>හිඟය:</span> <span>LKR ${balance}</span></div>
                </div>
                <div class="text-left">
                    <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">දැන් ගෙවන මුදල (Amount to Pay Now)</label>
                    <input id="pay-now-amount" type="number" class="swal2-input !mt-1 !w-full" value="${balance}">
                </div>
            `,
            showCancelButton: true,
            confirmButtonColor: '#10b981',
            confirmButtonText: 'මුදල් ගෙව්වා (Pay)',
            preConfirm: () => {
                const amount = parseFloat(document.getElementById('pay-now-amount').value);
                if (isNaN(amount) || amount <= 0) {
                    Swal.showValidationMessage('කරුණාකර නිවැරදි මුදලක් ඇතුළත් කරන්න');
                    return false;
                }
                return amount;
            }
        });

        if (paidAmount !== undefined) {
            const newTotalPaid = currentPaid + paidAmount;
            const newStatus = newTotalPaid >= bill.total ? 'paid' : 'pending';
            
            const updatedBill = { 
                ...bill,
                paidAmount: newTotalPaid,
                status: newStatus
            };
            await db.purchaseBills.update(billId, { 
                paidAmount: newTotalPaid,
                status: newStatus
            });
            app.apiCall(`/api/purchase-bills/${billId}`, 'PUT', updatedBill, 'update_bill', billId);
            
            app.viewSupplierBills(supplierId);
            app.renderSuppliers();
            Swal.fire({ icon: 'success', title: 'ගෙවීම සටහන් විය', timer: 1000, showConfirmButton: false });
        }
    },

    deleteSupplierBill: async (id, supplierId) => {
        if (confirm('Delete this bill record?')) {
            await db.purchaseBills.delete(id);
            app.apiCall(`/api/purchase-bills/${id}`, 'DELETE', null, 'delete_bill', id);
            app.viewSupplierBills(supplierId);
            app.renderSuppliers();
        }
    },

    deleteSupplier: async (id) => {
        if (confirm('Delete this supplier? All history will be deleted.')) {
            await db.suppliers.delete(id);
            await db.purchaseBills.where('supplierId').equals(id).delete();
            app.apiCall(`/api/suppliers/${id}`, 'DELETE', null, 'delete_supplier', id);
            app.renderSuppliers();
        }
    },

    // --- DASHBOARD ---
    renderDashboard: async () => {
        try {
            await app.ensureInitialData();
            const today = new Date().toISOString().split('T')[0];

            let salesToday = [];
            try {
                const allSales = await db.sales.toArray();
                salesToday = (allSales || []).filter(s => s && s.date && String(s.date).startsWith(today));
            } catch (e) {
                console.warn('Could not read sales for dashboard:', e);
            }

            const totalRevenue = salesToday.reduce((sum, sale) => sum + Number(sale.total || 0), 0);

            let allRepairs = [];
            try {
                allRepairs = await db.repairs.toArray();
                if (!allRepairs || allRepairs.length === 0) {
                    try {
                        const resRep = await fetch(app.getApiUrl('/api/repairs'), {
                            headers: app.getAuthHeaders(),
                            credentials: 'include'
                        });
                        if (resRep.ok) {
                            const srv = await resRep.json();
                            if (Array.isArray(srv) && srv.length > 0) {
                                await db.repairs.bulkPut(srv);
                                allRepairs = await db.repairs.toArray();
                            }
                        }
                    } catch (e) {}
                }
            } catch (e) {
                console.warn('Could not read repairs for dashboard:', e);
            }
            if (!allRepairs) allRepairs = [];
            allRepairs.sort((a, b) => Number(b.id) - Number(a.id));
            const pendingRepairs = allRepairs.filter(r => r && String(r.status || 'Pending').toLowerCase() === 'pending').length;

            let allFrames = [];
            try {
                allFrames = await db.photoFrames.toArray();
            } catch (e) {}
            if (!allFrames) allFrames = [];
            const activeFrames = allFrames.filter(f => !['delivered'].includes(String(f.status || 'Pending').toLowerCase())).length;
            const readyFrames = allFrames.filter(f => String(f.status || '').toLowerCase() === 'ready').length;

            let lowStockItems = 0;
            try {
                const allItems = await db.items.toArray();
                lowStockItems = (allItems || []).filter(i => i && i.type === 'product' && Number(i.stock || 0) <= Number(i.minStock || 5)).length;
            } catch (e) {
                console.warn('Could not read items for dashboard:', e);
            }

            const html = `
                <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-6 mb-10 fade-in">
                    <div class="bg-gradient-to-br from-violet-500 to-indigo-600 p-6 rounded-3xl shadow-xl shadow-violet-200 text-white flex flex-col justify-between min-h-[160px]">
                        <div class="flex justify-between items-start mb-4">
                            <p class="text-violet-100 font-bold text-base">Total Sales Today</p>
                            <div class="bg-white/20 p-3 rounded-xl shadow-sm">
                                <i class="fa-solid fa-coins text-2xl"></i>
                            </div>
                        </div>
                        <h2 class="text-4xl font-black tracking-tight">LKR ${totalRevenue.toFixed(2)}</h2>
                    </div>

                    <div onclick="app.navigate('repairs')" class="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col justify-between min-h-[160px] cursor-pointer hover:border-orange-400 dark:hover:border-orange-500 hover:shadow-md transition active:scale-98 group" title="Click to view all repairs">
                        <div class="flex justify-between items-start mb-4">
                            <div>
                                <p class="text-slate-500 dark:text-slate-400 font-bold text-base group-hover:text-orange-600 transition-colors">Pending Repairs</p>
                                <span class="text-xs text-orange-500 font-bold">භාරගත් රෙපයාර් &rarr;</span>
                            </div>
                            <div class="bg-orange-50 text-orange-600 group-hover:bg-orange-600 group-hover:text-white transition-all p-3 rounded-xl border border-orange-100 shadow-sm">
                                <i class="fa-solid fa-screwdriver-wrench text-2xl"></i>
                            </div>
                        </div>
                        <div class="flex items-baseline justify-between">
                            <h2 class="text-4xl font-black text-slate-800 dark:text-slate-100 tracking-tight">${pendingRepairs}</h2>
                            <span class="text-xs font-bold text-violet-600 dark:text-violet-400 group-hover:underline">View All &rarr;</span>
                        </div>
                    </div>

                    <div onclick="app.navigate('frames')" class="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col justify-between min-h-[160px] cursor-pointer hover:border-rose-400 dark:hover:border-rose-500 hover:shadow-md transition active:scale-98 group" title="Click to view photo frames">
                        <div class="flex justify-between items-start mb-4">
                            <div>
                                <p class="text-slate-500 dark:text-slate-400 font-bold text-base group-hover:text-rose-600 transition-colors">Photo Frame Orders</p>
                                <span class="text-xs text-rose-500 font-bold">ෆොටෝ ෆ්‍රේම් &rarr;</span>
                            </div>
                            <div class="bg-rose-50 text-rose-600 group-hover:bg-rose-600 group-hover:text-white transition-all p-3 rounded-xl border border-rose-100 shadow-sm">
                                <i class="fa-solid fa-image text-2xl"></i>
                            </div>
                        </div>
                        <div class="flex items-baseline justify-between">
                            <h2 class="text-4xl font-black text-slate-800 dark:text-slate-100 tracking-tight">${activeFrames}</h2>
                            <span class="text-xs font-bold text-rose-600 dark:text-rose-400 group-hover:underline">${readyFrames > 0 ? readyFrames + ' Ready' : 'View All &rarr;'}</span>
                        </div>
                    </div>

                    <div class="bg-white dark:bg-slate-800 p-6 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col justify-between min-h-[160px]">
                        <div class="flex justify-between items-start mb-4">
                            <p class="text-slate-500 font-bold text-base">Low Stock Items</p>
                            <div class="bg-red-50 text-red-600 p-3 rounded-xl border border-red-100 shadow-sm">
                                <i class="fa-solid fa-triangle-exclamation text-2xl"></i>
                            </div>
                        </div>
                        <h2 class="text-4xl font-black text-red-600 tracking-tight">${lowStockItems}</h2>
                    </div>
                </div>

                <div class="grid grid-cols-1 xl:grid-cols-2 gap-8 fade-in h-full pb-8" style="animation-delay: 0.1s">
                    <!-- Recent Sales -->
                    <div class="bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
                        <div class="flex justify-between items-center mb-6">
                            <h3 class="font-black text-xl text-slate-800"><i class="fa-solid fa-clock-rotate-left mr-2 text-violet-600"></i> Recent Sales</h3>
                            <button onclick="app.navigate('sales')" class="text-sm font-bold text-violet-600 hover:text-violet-800 transition-colors">View All &rarr;</button>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-base text-left">
                                <thead class="text-sm text-slate-500 uppercase bg-slate-50 font-extrabold tracking-wider">
                                    <tr>
                                        <th class="px-5 py-4 rounded-tl-xl border-b border-slate-100">Time</th>
                                        <th class="px-5 py-4 border-b border-slate-100">Sale ID</th>
                                        <th class="px-5 py-4 border-b border-slate-100">Total</th>
                                        <th class="px-5 py-4 rounded-tr-xl border-b border-slate-100">Method</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-slate-100">
                                    ${salesToday.length === 0 ? `<tr><td colspan="4" class="px-5 py-10 text-center text-slate-400 font-medium text-lg">No sales yet today</td></tr>` :
                    salesToday.slice(-5).reverse().map(sale => `
                                        <tr class="hover:bg-slate-50 transition-colors">
                                            <td class="px-5 py-4 font-bold text-slate-700">
                                                ${new Date(sale.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </td>
                                            <td class="px-5 py-4 text-slate-500 font-medium">#${sale.id}</td>
                                            <td class="px-5 py-4 font-black text-emerald-600 text-lg">LKR ${Number(sale.total || 0).toFixed(2)}</td>
                                            <td class="px-5 py-4">
                                                <span class="bg-slate-100 text-slate-700 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider">${sale.paymentMethod || 'cash'}</span>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div class="bg-white p-8 rounded-3xl shadow-sm border border-slate-200">
                        <h3 class="font-black text-xl mb-6 text-slate-800"><i class="fa-solid fa-bolt mr-2 text-violet-600"></i> Quick Actions</h3>
                        <div class="grid grid-cols-2 md:grid-cols-3 gap-6 h-full pb-4">
                            <button onclick="app.navigate('pos')" class="p-6 bg-violet-50 hover:bg-violet-100 rounded-2xl text-violet-700 transition flex flex-col items-center justify-center gap-3 border border-violet-100 shadow-sm hover:-translate-y-1 hover:shadow-md min-h-[140px]">
                                <i class="fa-solid fa-cash-register text-5xl mb-2"></i>
                                <span class="font-bold text-lg">New Sale</span>
                            </button>
                            <button onclick="app.openRepairModal()" class="p-6 bg-orange-50 hover:bg-orange-100 rounded-2xl text-orange-700 transition flex flex-col items-center justify-center gap-3 border border-orange-100 shadow-sm hover:-translate-y-1 hover:shadow-md min-h-[140px]">
                                <i class="fa-solid fa-tools text-5xl mb-2"></i>
                                <span class="font-bold text-lg">New Repair</span>
                            </button>
                            <button onclick="app.navigate('products')" class="p-6 bg-blue-50 hover:bg-blue-100 rounded-2xl text-blue-700 transition flex flex-col items-center justify-center gap-3 border border-blue-100 shadow-sm hover:-translate-y-1 hover:shadow-md min-h-[140px]">
                                <i class="fa-solid fa-box-open text-5xl mb-2"></i>
                                <span class="font-bold text-lg">Add Stock</span>
                            </button>
                            <button onclick="app.openExpenseModal()" class="p-6 bg-red-50 hover:bg-red-100 rounded-2xl text-red-700 transition flex flex-col items-center justify-center gap-3 border border-red-100 shadow-sm hover:-translate-y-1 hover:shadow-md min-h-[140px]">
                                 <i class="fa-solid fa-receipt text-5xl mb-2"></i>
                                <span class="font-bold text-lg">Log Expense</span>
                            </button>
                            <button onclick="app.navigate('utility')" class="p-6 bg-emerald-50 hover:bg-emerald-100 rounded-2xl text-emerald-700 transition flex flex-col items-center justify-center gap-3 border border-emerald-100 shadow-sm hover:-translate-y-1 hover:shadow-md min-h-[140px]">
                                 <i class="fa-solid fa-bolt-lightning text-5xl mb-2"></i>
                                <span class="font-bold text-lg">Utility Pay</span>
                            </button>
                            <button onclick="app.navigate('bank')" class="p-6 bg-blue-50 hover:bg-blue-100 rounded-2xl text-blue-700 transition flex flex-col items-center justify-center gap-3 border border-blue-100 shadow-sm hover:-translate-y-1 hover:shadow-md min-h-[140px]">
                                 <i class="fa-solid fa-building-columns text-5xl mb-2"></i>
                                <span class="font-bold text-lg">Bank Tracker</span>
                            </button>
                            <button onclick="app.navigate('suppliers')" class="p-6 bg-orange-50 hover:bg-orange-100 rounded-2xl text-orange-700 transition flex flex-col items-center justify-center gap-3 border border-orange-100 shadow-sm hover:-translate-y-1 hover:shadow-md min-h-[140px]">
                                 <i class="fa-solid fa-truck-field text-5xl mb-2"></i>
                                <span class="font-bold text-lg">Suppliers</span>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Active Repair Jobs Section Directly on Dashboard -->
                <div class="bg-white dark:bg-slate-800 p-6 sm:p-8 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-700 fade-in mb-8">
                    <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
                        <div>
                            <h3 class="font-black text-xl text-slate-800 dark:text-slate-100 flex items-center gap-2">
                                <i class="fa-solid fa-screwdriver-wrench text-orange-500"></i> Active &amp; Recent Repairs (භාරගත් රෙපයාර්)
                            </h3>
                            <p class="text-xs text-slate-400 mt-0.5">Mobile Phone Repairing Center • Live repair tracking &amp; service slips</p>
                        </div>
                        <div class="flex items-center gap-3 w-full sm:w-auto">
                            <button onclick="app.openRepairModal()" class="flex-1 sm:flex-initial px-4 py-2.5 bg-orange-50 hover:bg-orange-100 text-orange-700 font-bold text-xs rounded-xl border border-orange-200 transition flex items-center justify-center gap-1.5 active:scale-95 shadow-sm">
                                <i class="fa-solid fa-plus-circle"></i> New Repair (නව රෙපයාර්)
                            </button>
                            <button onclick="app.navigate('repairs')" class="text-xs sm:text-sm font-bold text-violet-600 dark:text-violet-400 hover:text-violet-800 transition-colors whitespace-nowrap">
                                View All Repairs (${allRepairs.length}) &rarr;
                            </button>
                        </div>
                    </div>

                    ${allRepairs.length === 0 ? `
                        <div class="p-8 text-center text-slate-400 dark:text-slate-500 bg-slate-50 dark:bg-slate-900/40 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
                            <i class="fa-solid fa-screwdriver-wrench text-3xl mb-2 text-slate-300 dark:text-slate-600"></i>
                            <p class="font-bold text-sm">No repair jobs registered yet (තවම රෙපයාර් ඇතුළත් කර නැත)</p>
                            <p class="text-xs mt-1">Click "New Repair" to register a device and print customer slips.</p>
                        </div>
                    ` : `
                        <div class="overflow-x-auto">
                            <table class="w-full text-sm text-left">
                                <thead class="text-xs text-slate-500 dark:text-slate-400 uppercase bg-slate-50 dark:bg-slate-900/50 font-extrabold tracking-wider">
                                    <tr>
                                        <th class="px-4 py-3 rounded-tl-xl border-b border-slate-100 dark:border-slate-700">Token #</th>
                                        <th class="px-4 py-3 border-b border-slate-100 dark:border-slate-700">Device &amp; Customer</th>
                                        <th class="px-4 py-3 border-b border-slate-100 dark:border-slate-700">Issue (දෝෂය)</th>
                                        <th class="px-4 py-3 border-b border-slate-100 dark:border-slate-700">Status</th>
                                        <th class="px-4 py-3 border-b border-slate-100 dark:border-slate-700">Cost / Adv</th>
                                        <th class="px-4 py-3 rounded-tr-xl border-b border-slate-100 dark:border-slate-700 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                                    ${allRepairs.slice(0, 5).map(job => {
                                        const custName = job.customerName || job.customer_name || 'Walk-in';
                                        const phone = job.contact || job.phone || '';
                                        const model = job.phoneModel || job.phone_model || 'Device';
                                        const issue = job.issue || 'General Service';
                                        const status = job.status || 'Pending';
                                        const tokenNo = `#REP-${String(job.id).padStart(4, '0')}`;
                                        const estCost = Number(job.estimatedCost !== undefined ? job.estimatedCost : (job.cost !== undefined ? job.cost : (job.estimated_cost || 0)));
                                        const advPay = Number(job.advancePayment !== undefined ? job.advancePayment : (job.advance_payment || 0));

                                        return `
                                            <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors">
                                                <td class="px-4 py-3 font-mono font-black text-violet-700 dark:text-violet-300">
                                                    ${tokenNo}
                                                </td>
                                                <td class="px-4 py-3">
                                                    <div class="font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                                                        <i class="fa-solid fa-mobile-screen text-violet-600 text-xs"></i> ${model}
                                                    </div>
                                                    <div class="text-xs text-slate-500 dark:text-slate-400">
                                                        ${custName} ${phone ? `• <span class="font-mono text-emerald-600">${phone}</span>` : ''}
                                                    </div>
                                                </td>
                                                <td class="px-4 py-3 text-xs text-slate-600 dark:text-slate-300 max-w-[200px] truncate" title="${issue}">
                                                    ${issue}
                                                </td>
                                                <td class="px-4 py-3">
                                                    <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${app.getStatusColor(status)}">
                                                        ${status}
                                                    </span>
                                                </td>
                                                <td class="px-4 py-3 text-xs">
                                                    <div class="font-bold text-slate-700 dark:text-slate-200">LKR ${estCost.toFixed(2)}</div>
                                                    ${advPay > 0 ? `<div class="text-[10px] text-emerald-600 font-semibold">Adv: LKR ${advPay.toFixed(2)}</div>` : ''}
                                                </td>
                                                <td class="px-4 py-3 text-right">
                                                    <div class="flex items-center justify-end gap-1.5">
                                                        <button onclick="app.sendRepairWhatsApp(${job.id})" class="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition active:scale-95 flex items-center gap-1 shadow-sm" title="Send WhatsApp Note (Customer ට යවන්න)">
                                                            <i class="fa-brands fa-whatsapp text-sm"></i> <span class="hidden sm:inline">WhatsApp</span>
                                                        </button>
                                                        <button onclick="app.printServiceSlip(${job.id})" class="px-2.5 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs transition active:scale-95 flex items-center gap-1 shadow-sm" title="Print 80mm Slip">
                                                            <i class="fa-solid fa-print"></i> Slip
                                                        </button>
                                                        <button onclick="app.updateRepairStatus(${job.id})" class="px-2 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-bold transition" title="Change Status">
                                                            <i class="fa-solid fa-arrows-rotate"></i>
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        `;
                                    }).join('')}
                                </tbody>
                            </table>
                        </div>
                    `}
                </div>
            `;
            const content = document.getElementById('app-content');
            if (content) content.innerHTML = html;
        } catch (dashboardErr) {
            console.error('Error rendering dashboard:', dashboardErr);
            const content = document.getElementById('app-content');
            if (content) {
                content.innerHTML = `
                    <div class="p-8 text-center bg-white rounded-3xl border border-slate-200 shadow-sm max-w-lg mx-auto my-12">
                        <i class="fa-solid fa-chart-pie text-5xl text-violet-600 mb-4"></i>
                        <h3 class="text-xl font-black text-slate-800">Krishan POS Dashboard</h3>
                        <p class="text-sm text-slate-500 mt-2 mb-6">System ready. Click below to start a new sale.</p>
                        <button onclick="app.navigate('pos')" class="px-6 py-3 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-bold text-sm shadow-lg shadow-violet-500/25">
                            Open POS Register
                        </button>
                    </div>
                `;
            }
        }
    },

    // --- POS & SALES ---
    // Helper for category visuals
    getCategoryDetails: (category) => {
        const details = {
            'Accessories': { icon: 'fa-headphones', bg: 'bg-pink-100', text: 'text-pink-800', border: 'border-pink-500' },
            'Mobile Phones': { icon: 'fa-mobile-screen-button', bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-500' },
            'Stationery': { icon: 'fa-pen-ruler', bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-500' },
            'Service': { icon: 'fa-screwdriver-wrench', bg: 'bg-orange-100', text: 'text-orange-800', border: 'border-orange-500' },
            'Studio': { icon: 'fa-camera', bg: 'bg-purple-100', text: 'text-purple-800', border: 'border-purple-500' },
            'Chargers': { icon: 'fa-bolt', bg: 'bg-teal-100', text: 'text-teal-800', border: 'border-teal-500' },
            'Cable': { icon: 'fa-plug', bg: 'bg-cyan-100', text: 'text-cyan-800', border: 'border-cyan-500' },
            'Book': { icon: 'fa-book', bg: 'bg-indigo-100', text: 'text-indigo-800', border: 'border-indigo-500' },
            'Photoframe': { icon: 'fa-image', bg: 'bg-rose-100', text: 'text-rose-800', border: 'border-rose-500' },
            'Chargers & Cable': { icon: 'fa-charging-station', bg: 'bg-emerald-100', text: 'text-emerald-800', border: 'border-emerald-500' },
            'Button Phone': { icon: 'fa-phone', bg: 'bg-slate-200', text: 'text-slate-800', border: 'border-slate-500' }
        };
        return details[category] || { icon: 'fa-layer-group', bg: 'bg-violet-100', text: 'text-violet-800', border: 'border-violet-500' };
    },

    renderPOS: async () => {
        try {
            let items = await db.items.toArray();
            if (items.length === 0) {
                await app.ensureInitialData();
                items = await db.items.toArray();
            }
            const creditors = await db.creditors.where('type').equals('receivable').toArray();
            const categories = [...new Set(items.map(item => item.category))].sort();
            const settingsList = await db.categorySettings.toArray();
            const categoryMap = settingsList.reduce((acc, curr) => {
                acc[curr.name] = curr.image;
                return acc;
            }, {});

            const activeCategory = app.state.posCategory || 'All';
            const selectedCreditor = app.state.selectedCreditor;

            const html = `
                <div class="flex flex-col xl:flex-row gap-6 fade-in h-[calc(100vh-8rem)]">
                    <!-- Left: Categories -->
                    <div class="w-full xl:w-72 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden shrink-0">
                        <div class="p-4 bg-slate-50 border-b border-slate-100">
                            <h3 class="font-bold text-slate-700 text-sm tracking-tight uppercase">Categories</h3>
                        </div>
                        <div class="flex-1 overflow-y-auto p-3 space-y-2">
                            <button onclick="app.setPOSCategory('All')" class="w-full p-3 rounded-xl border ${activeCategory === 'All' ? 'bg-violet-600 border-violet-600 text-white font-bold' : 'bg-slate-50 border-slate-100 text-slate-600 hover:bg-slate-100'} transition-all text-left flex items-center gap-3">
                                <i class="fa-solid fa-border-all"></i> All Items
                            </button>
                            ${categories.map(cat => `
                                <button onclick="app.setPOSCategory('${cat}')" class="w-full p-3 rounded-xl border ${activeCategory === cat ? 'bg-violet-600 border-violet-600 text-white font-bold' : 'bg-slate-50 border-slate-100 text-slate-600 hover:bg-slate-100'} transition-all text-left flex items-center gap-3 truncate">
                                    <i class="fa-solid fa-tag opacity-50"></i> ${cat}
                                </button>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Center: Items & Customer Info -->
                    <div class="flex-1 flex flex-col min-w-0">
                        <!-- Customer Selection Bar (High Visibility) -->
                        <div class="mb-4 bg-yellow-50 border-2 border-yellow-200 p-3 rounded-2xl flex items-center gap-4 shadow-sm">
                            <div class="w-10 h-10 rounded-full bg-yellow-400 text-white flex items-center justify-center shrink-0">
                                <i class="fa-solid fa-user-tag text-lg"></i>
                            </div>
                            <div class="flex-1">
                                <p class="text-[10px] font-black text-yellow-700 uppercase tracking-widest leading-none mb-1">ගනුදෙනුකරු තෝරන්න (Select Customer from Naya Potha)</p>
                                <div class="flex items-center gap-2">
                                    <select onchange="app.setPOSCustomer(this.value)" class="flex-1 bg-transparent border-none p-0 focus:ring-0 text-lg font-black text-slate-800 cursor-pointer appearance-none">
                                        <option value="">අත්පිට මුදලට (Walk-in Customer - Cash Sale)</option>
                                        ${creditors.map(c => `<option value="${c.id}" ${selectedCreditor?.id === c.id ? 'selected' : ''}>${c.name} - හිඟ මුදල: LKR ${c.amount}</option>`).join('')}
                                    </select>
                                    <button onclick="app.openCustomerSearch()" class="text-yellow-700 hover:text-yellow-900 bg-yellow-200/50 hover:bg-yellow-200 p-2 rounded-lg transition-all" title="Search Customer">
                                        <i class="fa-solid fa-magnifying-glass"></i>
                                    </button>
                                    ${selectedCreditor ? `
                                        <button onclick="app.updateCreditorAmount(${selectedCreditor.id}, -1)" class="bg-emerald-600 text-white px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-emerald-700 transition-all flex items-center gap-1 shadow-sm">
                                            <i class="fa-solid fa-hand-holding-dollar"></i> Paid
                                        </button>
                                    ` : ''}
                                </div>
                            </div>
                            <button onclick="app.openCreditorModal('receivable')" class="bg-white hover:bg-yellow-100 text-yellow-700 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest border border-yellow-200 transition-all flex items-center gap-2">
                                <i class="fa-solid fa-plus"></i> New Customer
                            </button>
                        </div>

                        <!-- Top Search & Quick Amount Input (Simple & Basic) -->
                        <div class="mb-4 flex gap-3">
                            <div class="relative flex-1">
                                <i class="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i>
                                <input id="pos-search" type="text" placeholder="🔍 Search items by name, barcode or price..." class="w-full pl-11 pr-10 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-500 shadow-sm text-sm" oninput="app.filterPOSItems(this.value)" onkeydown="if(event.key==='Enter') app.handlePOSSearchEnter(this.value)">
                                <button type="button" onclick="document.getElementById('pos-search').value=''; app.filterPOSItems(''); document.getElementById('pos-search').focus();" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1" title="Clear Search">
                                    <i class="fa-solid fa-xmark text-sm"></i>
                                </button>
                            </div>
                            <!-- Quick Amount Input -->
                            <div class="relative w-44">
                                <span class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">Rs.</span>
                                <input id="quick-amount-input" type="number" placeholder="Quick Price" class="w-full pl-11 pr-4 py-3 rounded-xl border-2 border-violet-200 focus:border-violet-600 focus:outline-none focus:ring-0 font-black text-violet-700 shadow-sm bg-violet-50/30 text-sm" onkeydown="if(event.key==='Enter') app.addDirectAmount(this.value)" title="Press Enter to add custom amount">
                            </div>
                        </div>

                        <!-- Grid -->
                        <div id="pos-grid" class="flex-1 overflow-y-auto p-1">
                            <div class="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-4 pb-20">
                                ${app.generatePOSGrid(items, activeCategory)}
                            </div>
                        </div>
                    </div>

                    <!-- Right: Cart Summary -->
                    <div class="w-full xl:w-96 flex flex-col bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden shrink-0">
                        <div class="p-4 bg-slate-50 border-b border-slate-100 flex justify-between items-center">
                            <h3 class="font-bold text-slate-700 text-sm uppercase">Current Cart</h3>
                            <button onclick="app.clearCart()" class="text-[10px] text-red-500 font-bold uppercase hover:underline">Clear</button>
                        </div>
                        <div id="cart-items" class="flex-1 overflow-y-auto p-4 space-y-3">
                            <!-- Items Injected Here -->
                        </div>
                        <div id="cart-totals-area" class="p-6 bg-slate-50 border-t border-slate-100">
                            <!-- Totals Injected Here -->
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('app-content').innerHTML = html;
            app.renderPOSCart();
            setTimeout(() => document.getElementById('pos-search')?.focus(), 100);
        } catch (err) {
            console.error("POS Render Error:", err);
            document.getElementById('app-content').innerHTML = `<div class="p-10 text-center text-red-500 font-bold">Error loading POS: ${err.message}</div>`;
        }
    },

    editCategoryPhoto: async (categoryName) => {
        const { value: file } = await Swal.fire({
            title: `Select Photo for ${categoryName}`,
            input: 'file',
            inputAttributes: {
                'accept': 'image/*',
                'aria-label': 'Upload your category picture'
            },
            showCancelButton: true
        });

        if (file) {
            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64Image = e.target.result;
                try {
                    await db.categorySettings.put({ name: categoryName, image: base64Image });
                    Swal.fire({
                        icon: 'success',
                        title: 'Photo updated!',
                        showConfirmButton: false,
                        timer: 1500
                    });
                    app.renderPOS(); // Re-render to show updated photo
                } catch (error) {
                    Swal.fire('Error', 'Failed to save photo', 'error');
                }
            };
            reader.readAsDataURL(file);
        }
    },

    generatePOSGrid: (items, category = 'All') => {
        let filtered = items;
        if (category && category !== 'All') {
            filtered = items.filter(i => i.category === category);
        }

        if (filtered.length === 0) {
            return `
                <div class="col-span-full flex flex-col items-center justify-center py-12 text-slate-400">
                    <i class="fa-solid fa-box-open text-4xl mb-3 opacity-50"></i>
                    <p>No items found in this category.</p>
                </div>
            `;
        }

        return filtered.map(item => `
            <div onclick="app.addToCart(${typeof item.id === 'string' ? `'${item.id}'` : item.id})" class="bg-white rounded-2xl shadow-sm border border-slate-100 hover:shadow-xl hover:border-violet-400 cursor-pointer transition-all active:scale-95 group relative flex flex-col h-auto min-h-[240px] sm:min-h-[280px] overflow-hidden ${item.stock === 0 && item.type === 'product' ? 'opacity-50' : ''}">
                
                <!-- Large Image Section -->
                <div class="h-36 sm:h-48 w-full relative bg-slate-50 flex items-center justify-center border-b border-slate-100 flex-shrink-0 group-hover:bg-slate-100 transition-colors">
                    ${item.image ?
                `<img src="${item.image}" class="w-full h-full object-cover transform group-hover:scale-105 transition-transform duration-500">` :
                `<div class="h-full w-full ${item.type === 'service' ? 'bg-orange-50 text-orange-300 group-hover:text-orange-400' : 'bg-blue-50 text-blue-300 group-hover:text-blue-400'} flex flex-col items-center justify-center transition-colors">
                            <i class="fa-solid ${item.type === 'service' ? 'fa-bolt' : 'fa-box'} text-6xl mb-2 transform group-hover:scale-110 transition-transform duration-500"></i>
                        </div>`
            }
                    
                    ${item.type === 'product' ?
                `<span class="absolute top-3 right-3 text-[10px] sm:text-xs font-bold px-3 py-1.5 rounded-full shadow-md bg-white/90 backdrop-blur-sm border border-white/50 ${item.stock <= (item.minStock || 5) ? 'text-red-600' : 'text-slate-700'}">
                            ${item.stock} left
                         </span>`
                : ''}
                </div>

                <!-- Text & Price Section -->
                <div class="p-4 sm:p-5 flex flex-col flex-1 justify-between bg-white relative z-10 w-full">
                    <h4 class="font-extrabold text-slate-800 text-base sm:text-lg leading-tight mb-3 line-clamp-2" title="${item.name}">${item.name}</h4>
                    
                    <div class="flex justify-between items-end mt-auto pt-2 border-t border-slate-50">
                        <p class="text-violet-700 font-black text-xl sm:text-2xl">LKR ${item.price}</p>
                    </div>

                    <!-- Floating Add Button -->
                    <div class="absolute bottom-4 right-4 opacity-0 group-hover:opacity-100 transition-all duration-300 bg-violet-600 text-white w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center shadow-lg transform translate-y-4 group-hover:translate-y-0">
                        <i class="fa-solid fa-plus sm:text-lg"></i>
                    </div>
                </div>
            </div>
        `).join('');
    },

    setPOSCategory: (category) => {
        app.state.posCategory = category;

        // Update active classes on buttons
        document.querySelectorAll('.pos-category-btn').forEach(btn => {
            const bgClass = btn.getAttribute('data-bg');
            const textClass = btn.getAttribute('data-text');
            const borderClass = btn.getAttribute('data-border');

            if (btn.getAttribute('data-category') === category) {
                btn.className = `pos-category-btn w-full h-full flex flex-col items-center justify-center p-5 rounded-xl transition-all min-h-[140px] text-center ${bgClass} ${textClass} font-bold border-2 ${borderClass} shadow-md active`;
            } else {
                btn.className = `pos-category-btn w-full h-full flex flex-col items-center justify-center p-5 rounded-xl transition-all min-h-[140px] text-center ${bgClass} ${textClass} hover:opacity-80 border border-transparent shadow-sm`;
            }
        });

        // Update the grid directly instead of full render
        const searchInput = document.getElementById('pos-search');
        app.filterPOSItems(searchInput ? searchInput.value : '');
    },

    filterPOSItems: async (query = '') => {
        const allItems = await db.items.toArray();
        let filtered = allItems;
        const activeCategory = app.state.posCategory || 'All'; // Default to All

        if (activeCategory !== 'All') {
            filtered = filtered.filter(i => i.category === activeCategory);
        }

        if (query) {
            const lowerQ = query.toLowerCase();
            // Check for exact barcode match first for scanning
            const barcodeMatch = filtered.find(i => i.barcode === query);
            if (barcodeMatch) {
                app.addToCart(barcodeMatch.id);
                document.getElementById('pos-search').value = '';
                return;
            }
            filtered = filtered.filter(i => 
                i.name.toLowerCase().includes(lowerQ) || 
                (i.barcode && i.barcode.toLowerCase().includes(lowerQ)) ||
                (i.price.toString() === query || i.price.toString().startsWith(query))
            );

            // Add virtual item if query looks like a valid number and it's not and exact match for an existing item barcode/price
            const numQuery = parseFloat(query);
            if (!isNaN(numQuery) && numQuery > 0) {
                // If it's a number, we also keep the "Custom Amount" card at the top
                filtered.unshift({
                    id: 'custom-' + numQuery, // Virtual ID, parsed in addToCart
                    name: 'Custom Amount',
                    price: numQuery,
                    category: 'Service',
                    type: 'service',
                    stock: 0
                });
            }
        }

        const gridHTML = app.generatePOSGrid(filtered, null);

        const posGrid = document.getElementById('pos-grid');
        if (posGrid) {
            posGrid.innerHTML = `
                <div class="mb-4 flex items-center justify-between">
                    <h2 class="text-xl font-bold text-slate-800 flex items-center">
                        <span class="text-slate-400 mr-2 font-normal">Category:</span> ${activeCategory}
                    </h2>
                    <span class="bg-slate-100 text-slate-600 px-3 py-1 rounded-full text-sm font-medium">
                        ${query ? 'Search Results' : filtered.length + ' results'}
                    </span>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 2xl:grid-cols-4 gap-6 content-start pb-20">
                    ${gridHTML}
                </div>
            `;
        }
    },

    handlePOSSearchEnter: async (query) => {
        if (!query) return;

        // If it's a number, and we have custom amount or exact price match, we handle it
        const allItems = await db.items.toArray();
        const activeCategory = app.state.posCategory || 'All';
        let filtered = activeCategory === 'All' ? allItems : allItems.filter(i => i.category === activeCategory);

        const lowerQ = query.toLowerCase();
        
        // 1. Check exact barcode match
        const barcodeMatch = filtered.find(i => i.barcode === query);
        if (barcodeMatch) {
            app.addToCart(barcodeMatch.id);
            document.getElementById('pos-search').value = '';
            app.filterPOSItems('');
            return;
        }

        // 2. Check if it's a pure number - if so, add as custom amount
        const numQuery = parseFloat(query);
        const nameMatches = filtered.filter(i => i.name.toLowerCase().includes(lowerQ));
        
        if (!isNaN(numQuery) && numQuery > 0 && nameMatches.length === 0) {
            // It's a number and no name matches, so add as custom amount
            app.addDirectAmount(query);
            document.getElementById('pos-search').value = '';
            app.filterPOSItems('');
            return;
        }

        // 3. If there is exactly one match in the filtered list, add it
        const priceMatches = filtered.filter(i => i.price.toString() === query);
        const results = [...nameMatches, ...priceMatches];
        // Remove duplicates if any
        const uniqueResults = [...new Map(results.map(item => [item.id, item])).values()];

        if (uniqueResults.length === 1) {
            app.addToCart(uniqueResults[0].id);
            document.getElementById('pos-search').value = '';
            app.filterPOSItems('');
        }
    },

    addDirectAmount: (amountStr) => {
        const amount = parseFloat(amountStr);
        if (isNaN(amount) || amount <= 0) return;

        const tempItem = {
            id: 'custom-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
            name: 'Service',
            price: amount,
            type: 'service',
            qty: 1
        };
        app.state.cart.push(tempItem);

        // Reset input and re-render
        const input = document.getElementById('quick-amount-input');
        if (input) {
            input.value = '';
            input.focus();
        }
        app.renderPOSCart();
    },

    openCustomItemModal: async () => {
        const { value: price } = await Swal.fire({
            title: 'මුදල ඇතුළත් කරන්න (Enter Amount)',
            input: 'number',
            inputPlaceholder: '0.00',
            showCancelButton: true,
            confirmButtonText: 'එකතු කරන්න (Add)',
            confirmButtonColor: '#7c3aed',
            inputValidator: (value) => {
                if (!value || isNaN(value) || parseFloat(value) <= 0) {
                    return 'කරුණාකර නිවැරදි මිලක් ඇතුළත් කරන්න';
                }
            }
        });

        if (price) {
            const numericPrice = parseFloat(price);
            const tempItem = {
                id: 'custom-' + Date.now(),
                name: 'Service', // Default name as requested
                price: numericPrice,
                type: 'service',
                qty: 1
            };
            app.state.cart.push(tempItem);
            app.renderPOSCart();
        }
    },

    editCartItemPrice: async (index) => {
        const item = app.state.cart[index];
        const { value: newPrice } = await Swal.fire({
            title: 'Edit Price',
            input: 'number',
            inputLabel: `Current: LKR ${item.price}`,
            inputValue: item.price,
            showCancelButton: true,
            inputValidator: (value) => {
                if (!value || value < 0) {
                    return 'Please enter a valid price!';
                }
            }
        });

        if (newPrice !== null) {
            item.price = parseFloat(newPrice);
            app.renderPOSCart();
        }
    },

    addToCart: async (id) => {
        let item;
        if (typeof id === 'string' && id.startsWith('custom-')) {
            const price = parseFloat(id.split('-')[1]);
            item = {
                id: 'custom-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
                name: 'Custom Amount',
                price: price,
                type: 'service',
                stock: 0
            };
        } else {
            const numericId = Number(id);
            item = await db.items.get(numericId);
        }

        if (!item) return;

        // Check stock for products
        if (item.type === 'product' && item.stock <= 0) {
            Swal.fire({ icon: 'error', title: 'Out of Stock', text: 'This item is currently out of stock.', timer: 1500, showConfirmButton: false });
            return;
        }

        const existing = app.state.cart.find(i => i.id === item.id);
        if (existing) {
            // Check if adding one more exceeds stock (only for products)
            if (item.type === 'product' && existing.qty + 1 > item.stock) {
                Swal.fire({ icon: 'warning', title: 'Insufficient Stock', text: `Only ${item.stock} items available.`, timer: 1500, showConfirmButton: false });
                return;
            }
            existing.qty++;
        } else {
            app.state.cart.push({ ...item, qty: 1 });
        }
        app.renderPOSCart();
    },

    renderPOSCart: () => {
        const cartContainer = document.getElementById('cart-items');
        if (cartContainer) {
            cartContainer.innerHTML = app.state.cart.length === 0 ?
                `<div class="h-full flex flex-col items-center justify-center text-slate-400">
                    <i class="fa-solid fa-basket-shopping text-5xl mb-4 text-slate-200"></i>
                    <p class="font-medium">Cart is empty</p>
                </div>` :
                app.state.cart.map((item, index) => `
                    <div class="flex flex-col bg-slate-50 p-3 rounded-xl border border-slate-100 group hover:border-violet-200 transition-colors">
                        <div class="flex justify-between items-start mb-2">
                            <p class="font-bold text-slate-800 text-sm line-clamp-2 leading-snug">${item.name}</p>
                            <button onclick="app.removeFromCart(${index})" class="text-slate-300 hover:text-red-500 ml-2 transition-colors"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                        <div class="flex justify-between items-end">
                            <div class="text-xs text-slate-500">
                                ${item.price.toFixed(2)} x ${item.qty}
                            </div>
                            <div class="flex items-center gap-3">
                                <div class="flex items-center bg-white rounded-lg border border-slate-200 shadow-sm h-7">
                                    <button onclick="app.updateCartQty(${index}, -1)" class="w-7 h-full flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded-l-lg transition-colors">-</button>
                                    <span class="text-xs font-bold w-6 text-center select-none">${item.qty}</span>
                                    <button onclick="app.updateCartQty(${index}, 1)" class="w-7 h-full flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded-r-lg transition-colors">+</button>
                                </div>
                                <span class="font-bold text-xs text-violet-700 w-16 text-right">${(item.price * item.qty).toFixed(2)}</span>
                            </div>
                        </div>
                    </div>
                `).join('');

            const totalsArea = document.getElementById('cart-totals-area');
            const cartTotal = app.calculateTotal();
            const discount = app.state.discount || 0;
            const netCartAmount = cartTotal - discount;
            const creditor = app.state.selectedCreditor;

            if (totalsArea) {
                totalsArea.innerHTML = `
                    <div class="space-y-2 mb-4">
                        <div class="flex justify-between text-xs text-slate-500 font-bold uppercase tracking-wider">
                            <span>Cart Subtotal</span>
                            <span>LKR ${cartTotal.toFixed(2)}</span>
                        </div>
                        <div class="flex justify-between text-xs text-slate-500 font-bold uppercase tracking-wider">
                            <span>Discount</span>
                            <button class="text-blue-600 hover:underline" onclick="app.applyDiscount()">
                                ${discount > 0 ? '- LKR ' + discount.toFixed(2) : 'Add Discount'}
                            </button>
                        </div>
                        ${creditor ? `
                            <div class="flex justify-between text-xs text-slate-500 font-bold uppercase tracking-wider bg-red-50 p-2 rounded-lg border border-red-100 mt-2">
                                <span class="text-red-600">Old Debt (${creditor.name})</span>
                                <span class="text-red-700 font-black">LKR ${creditor.amount.toFixed(2)}</span>
                            </div>
                        ` : ''}
                    </div>
                    
                    <div class="flex justify-between items-center mb-6 pt-4 border-t border-slate-200">
                        <div>
                            <span class="block text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none mb-1">Total Outstanding</span>
                            <span class="text-2xl font-black text-violet-700">LKR ${(netCartAmount + (creditor ? creditor.amount : 0)).toFixed(2)}</span>
                        </div>
                    </div>
                    
                    <button onclick="app.processCheckout()" class="w-full bg-slate-900 hover:bg-slate-800 text-white py-4 rounded-xl font-bold text-lg shadow-xl shadow-slate-200 transition-all transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed" ${app.state.cart.length === 0 ? 'disabled' : ''}>
                        ${creditor ? 'Update & Checkout' : 'Charge LKR ' + netCartAmount.toFixed(2)}
                    </button>
                `;
            }
        }
    },

    updateCartQty: (index, change) => {
        const item = app.state.cart[index];
        const newQty = item.qty + change;

        if (newQty <= 0) {
            app.removeFromCart(index);
            return;
        }

        // Check stock limit for products
        if (item.type === 'product' && newQty > item.stock) {
            Swal.fire({ icon: 'warning', title: 'Max Stock Reached', timer: 1000, showConfirmButton: false });
            return;
        }

        item.qty = newQty;
        app.renderPOSCart();
    },

    removeFromCart: (index) => {
        app.state.cart.splice(index, 1);
        app.renderPOSCart();
    },

    clearCart: () => {
        app.state.cart = [];
        app.state.discount = 0;
        app.renderPOSCart();
    },

    calculateTotal: () => {
        return app.state.cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    },

    applyDiscount: async () => {
        const { value: discount } = await Swal.fire({
            title: 'Enter Discount Amount',
            input: 'number',
            inputLabel: 'Amount in LKR',
            inputValue: app.state.discount || 0,
            showCancelButton: true
        });

        if (discount !== null) {
            app.state.discount = parseFloat(discount);
            app.renderPOSCart();
        }
    },

    setPOSCustomer: async (id) => {
        const prevSearch = document.getElementById('pos-search')?.value || '';
        if (!id) {
            app.state.selectedCreditor = null;
        } else {
            app.state.selectedCreditor = await db.creditors.get(Number(id));
        }
        await app.renderPOS(); 
        if (prevSearch) {
            const newSearch = document.getElementById('pos-search');
            if (newSearch) {
                newSearch.value = prevSearch;
                app.filterPOSItems(prevSearch);
            }
        }
    },

    openCustomerSearch: async () => {
        const creditors = await db.creditors.where('type').equals('receivable').toArray();
        
        const { value: selectedId } = await Swal.fire({
            title: 'ගනුදෙනුකරු සොයන්න (Search Customer)',
            html: `
                <div class="text-left">
                    <input id="swal-cust-search" class="swal2-input !mt-0 !w-full" placeholder="නම හෝ ණය මුදල සොයන්න..." oninput="app.filterSwalCustomers(this.value)">
                    <div id="swal-cust-list" class="mt-4 max-h-[300px] overflow-y-auto divide-y divide-slate-100 border rounded-xl">
                        <div onclick="Swal.clickConfirm(); app.swalSelectedId = ''" class="p-4 hover:bg-slate-50 cursor-pointer flex justify-between items-center transition-colors">
                            <span class="font-bold text-slate-700">අත්පිට මුදල (Cash Sale)</span>
                            <span class="text-xs bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full font-bold">Standard</span>
                        </div>
                        ${creditors.map(c => `
                            <div onclick="Swal.clickConfirm(); app.swalSelectedId = '${c.id}'" class="cust-item p-4 hover:bg-slate-50 cursor-pointer flex justify-between items-center transition-colors" data-name="${c.name.toLowerCase()}" data-amount="${c.amount}">
                                <div>
                                    <p class="font-bold text-slate-800">${c.name}</p>
                                    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Customer / Debtor</p>
                                </div>
                                <div class="text-right">
                                    <p class="font-black text-red-600">LKR ${c.amount}</p>
                                    <p class="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Outstanding</p>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `,
            showConfirmButton: false,
            showCancelButton: true,
            cancelButtonText: 'Cancel',
            didOpen: () => {
                document.getElementById('swal-cust-search').focus();
            },
            preConfirm: () => {
                return app.swalSelectedId;
            }
        });

        if (selectedId !== undefined) {
            app.setPOSCustomer(selectedId);
        }
    },

    filterSwalCustomers: (query) => {
        const lowerQ = query.toLowerCase();
        document.querySelectorAll('.cust-item').forEach(el => {
            const name = el.getAttribute('data-name');
            const amount = el.getAttribute('data-amount');
            if (name.includes(lowerQ) || amount.includes(lowerQ)) {
                el.style.display = 'flex';
            } else {
                el.style.display = 'none';
            }
        });
    },

    processCheckout: async () => {
        if (app.state.cart.length === 0) return;

        const subTotal = app.calculateTotal();
        const discount = app.state.discount || 0;
        const cartTotal = subTotal - discount;
        const creditor = app.state.selectedCreditor;
        const currentDebt = creditor ? creditor.amount : 0;
        const totalOutstanding = cartTotal + currentDebt;

        let amountPaid = 0;
        let paymentMethod = 'cash';

        if (creditor) {
            const { value: paidVal } = await Swal.fire({
                title: 'ගෙවීම් සටහන් කිරීම (Payment Record)',
                html: `
                    <div class="space-y-4 text-left">
                        <div class="bg-slate-50 p-4 rounded-xl border border-slate-100 space-y-2">
                            <div class="flex justify-between text-sm">
                                <span class="text-slate-500 font-bold uppercase tracking-widest text-[10px]">නව බිල්පත (New Bill)</span>
                                <span class="font-black text-slate-700">LKR ${cartTotal.toFixed(2)}</span>
                            </div>
                            <div class="flex justify-between text-sm">
                                <span class="text-slate-500 font-bold uppercase tracking-widest text-[10px]">පැරණි ණය (Previous Debt)</span>
                                <span class="font-black text-red-600">LKR ${currentDebt.toFixed(2)}</span>
                            </div>
                            <div class="pt-2 border-t border-slate-200 flex justify-between">
                                <span class="text-slate-700 font-black uppercase tracking-widest text-xs">මුළු හිඟ මුදල (Total Due)</span>
                                <span class="font-black text-violet-700 text-lg">LKR ${totalOutstanding.toFixed(2)}</span>
                            </div>
                        </div>

                        <div class="relative">
                            <label class="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 ml-1">අද ලැබුණු මුදල (Amount Received Now)</label>
                            <div class="relative">
                                <span class="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-slate-400">LKR</span>
                                <input id="swal-paid" type="number" class="swal2-input !m-0 !pl-14 !w-full !text-2xl !font-black !text-emerald-600" value="${cartTotal.toFixed(0)}">
                            </div>
                            <div class="flex gap-2 mt-2">
                                <button type="button" onclick="document.getElementById('swal-paid').value = '0'" class="flex-1 py-2 bg-red-50 text-red-600 rounded-lg text-xs font-bold border border-red-100 uppercase tracking-widest">පරිපූර්ණ ණය (Full Credit)</button>
                                <button type="button" onclick="document.getElementById('swal-paid').value = '${cartTotal.toFixed(0)}'" class="flex-1 py-2 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-bold border border-emerald-100 uppercase tracking-widest">සියල්ල ගෙව්වා (Full Paid)</button>
                            </div>
                            <p class="text-[10px] text-slate-400 font-medium mt-3 ml-1">මුළු හිග මුදලින් අද ලැබෙන මුදල ඇතුළත් කරන්න. (Enter amount paid towards total debt.)</p>
                        </div>
                    </div>
                `,
                showCancelButton: true,
                confirmButtonText: 'වාර්තාව සුරකින්න (Record Sale)',
                confirmButtonColor: '#7c3aed',
                preConfirm: () => {
                    const val = parseFloat(document.getElementById('swal-paid').value);
                    if (isNaN(val) || val < 0) {
                        Swal.showValidationMessage('කරුණාකර නිවැරදි මුදලක් ඇතුළත් කරන්න');
                        return false;
                    }
                    return val;
                }
            });

            if (paidVal === undefined) return;
            amountPaid = paidVal;
            paymentMethod = 'credit';
        } else {
            const { value: method } = await Swal.fire({
                title: 'Select Payment Method',
                input: 'radio',
                inputOptions: { 'cash': 'Cash', 'card': 'Card', 'transfer': 'Bank Transfer' },
                inputValue: 'cash',
                showCancelButton: true
            });
            if (!method) return;
            paymentMethod = method;
            amountPaid = cartTotal;
        }

        try {
            const saleRecord = {
                date: new Date().toISOString(),
                items: JSON.parse(JSON.stringify(app.state.cart)),
                subTotal,
                discount,
                total: cartTotal,
                amountPaid,
                paymentMethod,
                creditorId: creditor ? creditor.id : null,
                customerName: creditor ? creditor.name : '',
                customerPhone: creditor ? (creditor.contact || creditor.phone || '') : ''
            };

            // 1. Save Sale to Dexie Local Store
            const saleId = await db.sales.add(saleRecord);

            // 2. Update Creditor Balance if applicable
            if (creditor) {
                const newDebt = totalOutstanding - amountPaid;
                const updatedCred = { 
                    ...creditor,
                    amount: newDebt,
                    lastUpdated: new Date().toISOString() 
                };
                await db.creditors.update(creditor.id, { 
                    amount: newDebt,
                    lastUpdated: updatedCred.lastUpdated 
                });
                app.apiCall(`/api/creditors/${creditor.id}`, 'PUT', updatedCred, 'update_creditor', creditor.id);
            }

            // 3. Update Inventory Stock
            for (const item of app.state.cart) {
                if (item.type === 'product' && item.id && !String(item.id).startsWith('custom-')) {
                    const dbItem = await db.items.get(item.id);
                    if (dbItem) {
                        await db.items.update(item.id, { stock: Math.max(0, dbItem.stock - item.qty) });
                    }
                }
            }

            // 4. Send Sale to Server with Socket Header (broadcasts to all other devices)
            app.apiCall('/api/sales', 'POST', { id: saleId, ...saleRecord }, 'create_sale');

            // 5. Success & Cleanup
            app.state.cart = [];
            app.state.discount = 0;
            app.state.selectedCreditor = null;
            app.renderPOS();

            Swal.fire({
                icon: 'success',
                title: 'Sale Finished',
                text: creditor ? `Customer Balance: LKR ${(totalOutstanding - amountPaid).toFixed(2)}` : 'Payment confirmed.',
                timer: 2000,
                showConfirmButton: false,
                toast: true,
                position: 'top-end'
            });

            // Auto dispatch sale message if customer phone exists
            const autoMsgOnSave = localStorage.getItem('krishan_pos_auto_msg') !== 'false';
            let saleDispatched = false;
            if (autoMsgOnSave && saleRecord.customerPhone) {
                app.sendSaleWhatsApp(saleId, { skipPreview: true });
                saleDispatched = true;
            }

            const printResult = await Swal.fire({
                title: 'Print Receipt / Send WhatsApp?',
                html: `
                    <div class="space-y-2 text-xs text-slate-600 dark:text-slate-300 my-2">
                        ${saleDispatched ? `<div class="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 font-bold text-xs">✓ WhatsApp receipt auto-sent to customer (${saleRecord.customerPhone})</div>` : ''}
                        <button id="swal-sale-wa" type="button" class="w-full py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold flex items-center justify-center gap-1.5 cursor-pointer shadow-sm transition active:scale-95">
                            <i class="fa-brands fa-whatsapp text-base"></i> Send WhatsApp Receipt (Customer ට යවන්න)
                        </button>
                    </div>
                `,
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: '<i class="fa-solid fa-print mr-1"></i> Yes, Print Receipt',
                cancelButtonText: 'Done (ඉවරයි)',
                confirmButtonColor: '#7c3aed',
                didOpen: () => {
                    const btn = document.getElementById('swal-sale-wa');
                    if (btn) btn.addEventListener('click', () => app.sendSaleWhatsApp(saleId, { skipPreview: false }));
                }
            });

            if (printResult.isConfirmed) {
                app.printReceipt(saleId);
            }
        } catch (error) {
            console.error(error);
            Swal.fire('Error', 'Checkout failed', 'error');
        }
    },

    // --- SCANNER STUBS (Cleaned Up) ---
    startScanner: () => {},
    toggleItemScanner: () => {},

    handleScan: async (code) => {
        // Logic similar to filterPOSItems but focused on exact match first
        const items = await db.items.toArray();
        const item = items.find(i => i.barcode === code);

        if (item) {
            app.addToCart(item.id);
            const Toast = Swal.mixin({
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000,
                timerProgressBar: true
            });
            Toast.fire({
                icon: 'success',
                title: `${item.name} added to cart!`
            });
        } else {
            Swal.fire({
                icon: 'question',
                title: 'Item Not Found',
                text: `No item found with barcode: ${code}. Would you like to add it?`,
                showCancelButton: true,
                confirmButtonText: 'Add New Item'
            }).then((result) => {
                if (result.isConfirmed) {
                    app.openItemModal(null, code); // Pass code to modal
                }
            });
        }
    },

    generateBarcode: () => {
        const input = document.getElementById('swal-barcode');
        if (!input) return;

        // Generate a random EAN-13 like or Code128 format
        // Simple P + Timestamp + Random
        const code = 'ITM' + Date.now().toString().slice(-8) + Math.floor(Math.random() * 100);
        input.value = code;

        app.updateBarcodePreview(code);
    },

    updateBarcodePreview: (code) => {
        try {
            if (code) {
                JsBarcode("#barcode-svg", code, {
                    format: "CODE128",
                    lineColor: "#334155",
                    width: 2,
                    height: 40,
                    displayValue: true,
                    fontSize: 14,
                    textMargin: 0,
                    margin: 0
                });
                document.getElementById('barcode-preview-container').classList.remove('hidden');
            } else {
                document.getElementById('barcode-preview-container').classList.add('hidden');
            }
        } catch (e) {
            console.error(e);
        }
    },

    // --- INVENTORY ---
    renderInventory: async () => {
        let items = await db.items.toArray();
        if (items.length === 0) {
            await app.ensureInitialData();
            items = await db.items.toArray();
        }
        const categories = ['All', ...new Set(items.map(item => item.category))];
        const settingsList = await db.categorySettings.toArray();
        const categoryMap = settingsList.reduce((acc, curr) => {
            acc[curr.name] = curr.image;
            return acc;
        }, {});

        // Initialize active category if not set
        if (app.state.inventoryCategory === undefined) app.state.inventoryCategory = 'All';
        const activeCategory = app.state.inventoryCategory;

        const html = `
            <div class="flex flex-col xl:flex-row gap-6 fade-in min-h-max xl:h-[calc(100vh-6rem)]">
                <!-- Categories Sidebar (Left) -->
                <div class="w-full xl:w-[320px] flex flex-col bg-white rounded-2xl shadow-xl border border-slate-200 h-[300px] xl:h-full flex-shrink-0">
                    <div class="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50 rounded-t-2xl">
                        <h3 class="font-bold text-slate-700"><i class="fa-solid fa-tags mr-2"></i> Categories</h3>
                    </div>
                    <div class="flex-1 overflow-y-auto p-4 grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-2 gap-4 content-start pb-6">
                        <div class="relative group h-full">
                            <button onclick="app.setInventoryCategory('All')" class="w-full h-full flex flex-col items-center justify-center p-4 rounded-xl transition-all min-h-[120px] text-center ${activeCategory === 'All' ? 'bg-violet-100 text-violet-700 font-bold border-2 border-violet-500 shadow-md' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200 shadow-sm'}">
                                <i class="fa-solid fa-border-all text-4xl mb-3"></i>
                                <span class="text-sm font-extrabold leading-tight line-clamp-2 break-all">All Items</span>
                            </button>
                        </div>
                        ${categories.filter(c => c !== 'All').map(cat => {
            const details = app.getCategoryDetails(cat);
            const isActive = activeCategory === cat;
            const catImage = categoryMap[cat] || null;
            return `<div class="relative group h-full">
                                        <button onclick="app.setInventoryCategory('${cat}')" class="w-full h-full flex flex-col items-center justify-center p-4 rounded-xl transition-all min-h-[120px] text-center ${isActive ? 'bg-violet-100 text-violet-700 font-bold border-2 border-violet-500 shadow-md' : 'bg-white text-slate-600 hover:bg-slate-50 border border-slate-200 shadow-sm'}" title="${cat}">
                                            ${catImage ?
                    `<img src="${catImage}" class="w-16 h-16 object-cover rounded-xl mb-3 shadow-md border border-slate-100">` :
                    `<i class="fa-solid ${details.icon} text-4xl mb-3 ${isActive ? 'text-violet-600' : ''}"></i>`
                }
                                            <span class="text-sm font-extrabold leading-tight line-clamp-2 break-all">${cat}</span>
                                        </button>
                                    </div>`;
        }).join('')}
                    </div>
                </div>

                <!-- Main Area -->
                <div class="flex-1 flex flex-col min-h-[600px] xl:min-h-0 xl:h-full">
                    <!-- Top Bar: Title, Search & Add -->
                    <div class="mb-4 flex flex-col lg:flex-row gap-4 items-center justify-between bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
                        <h2 class="text-xl font-bold text-slate-800 ml-2 hidden lg:block"><i class="fa-solid fa-box-open mr-2 text-violet-600"></i> Inventory</h2>
                        <div class="flex gap-3 w-full lg:w-auto flex-1 lg:max-w-xl">
                            <div class="relative flex-1">
                                <i class="fa-solid fa-magnifying-glass absolute left-4 top-1/2 transform -translate-y-1/2 text-slate-400 text-base"></i>
                                <input type="text" id="inventory-search" placeholder="🔍 Search stock items by name or code..." 
                                    class="w-full pl-11 pr-10 py-3 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-500 shadow-sm text-sm"
                                    oninput="app.filterInventoryGrid(this.value)">
                                <button type="button" onclick="document.getElementById('inventory-search').value=''; app.filterInventoryGrid(''); document.getElementById('inventory-search').focus();" class="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1" title="Clear Search">
                                    <i class="fa-solid fa-xmark text-sm"></i>
                                </button>
                            </div>
                            <button onclick="app.openItemModal()" class="bg-violet-600 hover:bg-violet-700 text-white px-5 rounded-xl font-bold shadow-md shadow-violet-200 transition-all flex items-center whitespace-nowrap h-[46px] text-sm">
                                <i class="fa-solid fa-plus mr-1.5"></i> Add Item
                            </button>
                        </div>
                    </div>

                    <!-- Content Area -->
                    <div id="inventory-grid-container" class="flex-1 overflow-y-auto pb-20 p-2">
                        ${app.generateInventoryGridHTML(items, activeCategory)}
                    </div>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
        setTimeout(() => document.getElementById('inventory-search')?.focus(), 100);
    },

    setInventoryCategory: (category) => {
        app.state.inventoryCategory = category;
        app.renderInventory();
    },

    generateInventoryGridHTML: (items, category, query = '') => {
        let filtered = items;
        if (category && category !== 'All') {
            filtered = items.filter(i => i.category === category);
        }

        if (query) {
            const lowerQ = query.toLowerCase();
            filtered = filtered.filter(i => i.name.toLowerCase().includes(lowerQ) || (i.barcode && i.barcode.toLowerCase().includes(lowerQ)));
        }

        if (filtered.length === 0) {
            return `
                <div class="col-span-full flex flex-col items-center justify-center py-20 text-slate-400 bg-white rounded-3xl border border-slate-200 shadow-sm mt-4">
                    <i class="fa-solid fa-box-open text-6xl mb-6 opacity-30"></i>
                    <p class="text-xl font-bold">No inventory items found.</p>
                </div>
            `;
        }

        const gridBlocks = filtered.map(item => `
            <div class="bg-white p-5 rounded-2xl shadow-sm border border-slate-100 hover:shadow-xl hover:border-violet-300 transition-all group flex flex-col justify-between h-auto min-h-[220px]">
                <div>
                    <div class="flex justify-between items-start mb-4">
                        <div class="flex gap-2 items-center">
                            ${item.image ? `<img src="${item.image}" class="h-8 w-8 object-cover rounded shadow-sm border border-slate-100">` : ''}
                            <span class="px-3 py-1.5 rounded-md text-[10px] font-extrabold tracking-wider uppercase ${item.type === 'product' ? 'bg-blue-50 text-blue-600' : 'bg-orange-50 text-orange-600'}">
                                ${item.type}
                            </span>
                        </div>
                        ${item.type === 'product' ?
                `<span class="text-xs font-bold px-3 py-1.5 rounded-full shadow-sm ${item.stock <= (item.minStock || 5) ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-700'}">
                                ${item.stock} in stock
                             </span>`
                : ''}
                    </div>
                    <h4 class="font-bold text-slate-800 text-lg leading-tight mb-2 line-clamp-2" title="${item.name}">${item.name}</h4>
                    <p class="text-xs text-slate-400 mb-4 tracking-wide font-mono bg-slate-50 inline-block px-2 py-1 rounded border border-slate-100">${item.barcode || 'No barcode'}</p>
                </div>
                
                <div class="mt-auto">
                    <div class="flex justify-between items-end mb-4 pt-4 border-t border-slate-100">
                        <div>
                            <p class="text-[10px] text-slate-400 uppercase font-black tracking-wider mb-1">Selling Price</p>
                            <p class="text-violet-700 font-black text-xl">LKR ${item.price.toFixed(2)}</p>
                        </div>
                        ${item.cost ? `
                        <div class="text-right">
                            <p class="text-[10px] text-slate-400 uppercase font-black tracking-wider mb-1">Cost</p>
                            <p class="text-slate-500 font-bold text-sm">LKR ${item.cost.toFixed(2)}</p>
                        </div>` : ''}
                    </div>
                    
                    <div class="flex gap-2">
                        ${item.type === 'product' ? `
                        <button onclick="app.quickAddStock(${item.id})" class="flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-600 py-2.5 rounded-xl text-sm font-bold transition-colors">
                            <i class="fa-solid fa-plus-minus mr-1"></i> Stock
                        </button>` : ''}
                        <button onclick="app.openItemModal(${item.id})" class="flex-1 bg-violet-50 hover:bg-violet-100 text-violet-600 py-2.5 rounded-xl text-sm font-bold transition-colors">
                            <i class="fa-solid fa-pen mr-1"></i> Edit
                        </button>
                        <button onclick="app.deleteItem(${item.id})" class="w-12 bg-red-50 hover:bg-red-100 text-red-600 py-2.5 rounded-xl transition-colors flex items-center justify-center shrink-0 shadow-sm border border-red-100">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        return `
            <div class="mb-4 flex items-center justify-between">
                <h2 class="text-xl font-bold text-slate-800 flex items-center">
                    <span class="text-slate-400 mr-2 font-normal">Showing:</span> ${category}
                </h2>
                <span class="bg-slate-200 text-slate-700 px-3 py-1 rounded-full text-sm font-bold shadow-inner">
                    ${filtered.length} items
                </span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-6 content-start">
                ${gridBlocks}
            </div>
        `;
    },

    filterInventoryGrid: async (query) => {
        const items = await db.items.toArray();
        const html = app.generateInventoryGridHTML(items, app.state.inventoryCategory, query);
        const container = document.getElementById('inventory-grid-container');
        if (container) {
            container.innerHTML = html;
        }
    },

    quickAddStock: async (id) => {
        const item = await db.items.get(id);
        const { value: addAmount } = await Swal.fire({
            title: `Add Stock`,
            html: `<div class="mb-2"><strong>${item.name}</strong></div><div class="text-sm text-slate-500 mb-4">Current Stock: <span class="font-bold text-slate-800">${item.stock}</span></div>`,
            input: 'number',
            inputPlaceholder: 'Enter amount to add (e.g. 10)',
            showCancelButton: true,
            confirmButtonText: '<i class="fa-solid fa-plus mr-2"></i> Add Stock',
            confirmButtonColor: '#10b981',
            inputValidator: (value) => {
                const amount = parseInt(value);
                if (isNaN(amount) || amount <= 0) {
                    return 'Please enter a valid number greater than 0';
                }
            }
        });

        if (addAmount) {
            const amount = parseInt(addAmount);
            await db.items.update(id, { stock: item.stock + amount });
            app.apiCall(`/api/items/${id}/adjust-stock`, 'POST', { delta: amount }, 'adjust_stock', id);

            const Toast = Swal.mixin({
                toast: true,
                position: 'top-end',
                showConfirmButton: false,
                timer: 3000,
                timerProgressBar: true
            });
            Toast.fire({
                icon: 'success',
                title: `Added ${amount} items. New stock is ${item.stock + amount}.`
            });

            // Re-render inventory view
            if (app.state.currentView === 'products') {
                app.renderInventory();
            }
        }
    },

    openItemModal: async (id = null, prefillBarcode = '') => {
        // Default to last added category for new items, or 'General' if not set
        const defaultCategory = app.state.lastAddedCategory || 'General';
        let item = { name: '', barcode: prefillBarcode, category: defaultCategory, type: 'product', price: 0, cost: 0, stock: 0, minStock: 5 };

        if (id) {
            item = await db.items.get(id);
        }

        // Get existing categories from DB and merge with defaults
        const allItems = await db.items.toArray();
        const existingCategories = new Set(allItems.map(i => i.category));
        const defaultCategories = [
            'Accessories', 'Mobile Phones', 'Stationery', 'Service', 'Studio',
            'Chargers', 'Cable', 'Book', 'Photoframe', 'Chargers & Cable', 'Button Phone'
        ];
        defaultCategories.forEach(c => existingCategories.add(c));
        const sortedCategories = Array.from(existingCategories).sort();
        const categoryOptions = sortedCategories.map(c => `<option value="${c}">`).join('');

        const { value: formValues } = await Swal.fire({
            title: id ? 'Edit Item' : 'Add New Item',
            html: `
                <div class="space-y-4 text-left">
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">Item Name</label>
                        <input id="swal-name" class="swal2-input m-0 w-full text-sm" placeholder="Item Name" value="${item.name}">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">Item Photo (Optional)</label>
                        <div class="flex items-center gap-3">
                            ${item.image ? `<img src="${item.image}" class="h-10 w-10 object-cover rounded shadow-sm border border-slate-200" alt="Item preview">` : ''}
                            <input id="swal-image" type="file" accept="image/*" class="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100">
                        </div>
                    </div>
                    
                    <div class="bg-slate-50 p-3 rounded-lg border border-slate-100">
                        <label class="block text-xs font-bold text-slate-500 mb-1">Item Code / Barcode (Optional)</label>
                        <div class="flex gap-2">
                            <input id="swal-barcode" class="swal2-input m-0 flex-1 text-sm h-10" placeholder="Enter barcode or item code" value="${item.barcode || ''}" oninput="app.updateBarcodePreview(this.value)">
                            <button type="button" onclick="app.generateBarcode()" class="bg-violet-100 hover:bg-violet-200 text-violet-700 px-3 h-10 rounded-lg flex items-center justify-center gap-1.5 text-xs font-bold transition-colors" title="Generate Code">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Auto
                            </button>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-4">
                        <div>
                             <label class="block text-xs font-bold text-slate-500 mb-1">Category</label>
                             <input id="swal-category" class="swal2-input m-0 w-full text-sm" list="categories" value="${item.category}" placeholder="Select/Type">

                             <datalist id="categories">
                                ${categoryOptions}
                             </datalist>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-bold text-slate-500 mb-1">Type</label>
                            <select id="swal-type" class="swal2-input m-0 w-full" onchange="document.getElementById('stock-field').style.display = this.value === 'product' ? 'block' : 'none'">
                                <option value="product" ${item.type === 'product' ? 'selected' : ''}>Physical Product</option>
                                <option value="service" ${item.type === 'service' ? 'selected' : ''}>Service</option>
                            </select>
                        </div>
                        <div id="stock-field" style="${item.type === 'product' ? '' : 'display:none'}">
                             <label class="block text-xs font-bold text-slate-500 mb-1">Current Stock</label>
                             <input type="number" id="swal-stock" class="swal2-input m-0 w-full" value="${item.stock}">
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-bold text-slate-500 mb-1">Selling Price (LKR)</label>
                            <input type="number" id="swal-price" class="swal2-input m-0 w-full" value="${item.price}">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-slate-500 mb-1">Cost Price (LKR)</label>
                            <input type="number" id="swal-cost" class="swal2-input m-0 w-full" value="${item.cost}">
                        </div>
                    </div>
                </div>
            `,
            customClass: {
                popup: 'rounded-2xl',
                confirmButton: 'bg-violet-600 px-6 py-2 rounded-lg',
                cancelButton: 'bg-slate-200 text-slate-600 px-6 py-2 rounded-lg'
            },
            didOpen: () => {
                // Initialize barcode preview if value exists
                const barcodeInput = document.getElementById('swal-barcode');
                if (barcodeInput && barcodeInput.value) {
                    app.updateBarcodePreview(barcodeInput.value);
                }
            },
            preConfirm: async () => {
                const name = document.getElementById('swal-name').value;
                const barcode = document.getElementById('swal-barcode').value;
                const category = document.getElementById('swal-category').value;
                const type = document.getElementById('swal-type').value;
                const stock = parseInt(document.getElementById('swal-stock').value) || 0;
                const price = parseFloat(document.getElementById('swal-price').value);
                const cost = parseFloat(document.getElementById('swal-cost').value) || 0;

                const fileInput = document.getElementById('swal-image');
                let imageBase64 = item.image || null;
                if (fileInput && fileInput.files.length > 0) {
                    const file = fileInput.files[0];
                    imageBase64 = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onload = (e) => resolve(e.target.result);
                        reader.readAsDataURL(file);
                    });
                }

                if (!name || isNaN(price) || !category) {
                    Swal.showValidationMessage('Please fill required fields (Name, Price, Category)');
                    return false;
                }
                return { name, barcode, category, type, price, cost, stock, minStock: 5, image: imageBase64 };
            }
        });

        if (formValues) {
            // Update last added category for next time
            app.state.lastAddedCategory = formValues.category;

            if (id) {
                await db.items.update(id, formValues);
                app.apiCall(`/api/items/${id}`, 'PUT', formValues, 'update_item', id);
            } else {
                const newId = await db.items.add(formValues);
                app.apiCall('/api/items', 'POST', { id: newId, ...formValues }, 'create_item');
            }
            app.renderInventory();
            Swal.fire({ icon: 'success', title: 'Saved', timer: 1000, showConfirmButton: false });
        }
    },

    deleteItem: async (id) => {
        const result = await Swal.fire({
            title: 'Are you sure?',
            text: "You won't be able to revert this!",
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#d33',
            confirmButtonText: 'Yes, delete it!'
        });

        if (result.isConfirmed) {
            await db.items.delete(id);
            app.apiCall(`/api/items/${id}`, 'DELETE', null, 'delete_item', id);
            app.renderInventory();
            Swal.fire('Deleted!', 'Item has been deleted.', 'success');
        }
    },

    // --- REPAIRS & JOB CARDS ---
    repairFilterStatus: 'All',
    repairSearchQuery: '',

    renderRepairs: async () => {
        let repairs = await db.repairs.toArray();
        if (!repairs || repairs.length === 0) {
            try {
                const resRep = await fetch(app.getApiUrl('/api/repairs'), {
                    headers: app.getAuthHeaders(),
                    credentials: 'include'
                });
                if (resRep.ok) {
                    const srv = await resRep.json();
                    if (Array.isArray(srv) && srv.length > 0) {
                        await db.repairs.bulkPut(srv);
                        repairs = await db.repairs.toArray();
                    }
                }
            } catch (e) {}
        }
        if (!repairs) repairs = [];
        // Sort descending by ID (newest first)
        repairs.sort((a, b) => Number(b.id) - Number(a.id));

        const totalCount = repairs.length;
        const pendingCount = repairs.filter(r => (r.status || 'Pending').toLowerCase() === 'pending').length;
        const inProgressCount = repairs.filter(r => (r.status || '').toLowerCase() === 'in progress').length;
        const completedCount = repairs.filter(r => ['completed', 'delivered'].includes((r.status || '').toLowerCase())).length;

        // Apply filters
        const activeFilter = app.repairFilterStatus || 'All';
        const searchQuery = (app.repairSearchQuery || '').trim().toLowerCase();

        let filteredRepairs = repairs;
        if (activeFilter !== 'All') {
            filteredRepairs = filteredRepairs.filter(r => (r.status || 'Pending').toLowerCase() === activeFilter.toLowerCase());
        }
        if (searchQuery) {
            filteredRepairs = filteredRepairs.filter(r => {
                const jobToken = `rep-${r.id}`.toLowerCase();
                const name = (r.customerName || r.customer_name || '').toLowerCase();
                const phone = (r.contact || r.phone || '').toLowerCase();
                const model = (r.phoneModel || r.phone_model || '').toLowerCase();
                const issue = (r.issue || '').toLowerCase();
                return jobToken.includes(searchQuery) || name.includes(searchQuery) || phone.includes(searchQuery) || model.includes(searchQuery) || issue.includes(searchQuery);
            });
        }

        const html = `
            <div class="bg-white dark:bg-slate-900 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-800 p-4 sm:p-6 fade-in flex flex-col space-y-6 mb-8">
                <!-- Top Header & Action -->
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                    <div>
                        <h2 class="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                            <i class="fa-solid fa-screwdriver-wrench text-violet-600"></i> Repair Jobs & Customer Tokens
                        </h2>
                        <p class="text-xs text-slate-400 mt-0.5">Mobile Phone & Electronics Repairing Center • Print Customer Job Slips</p>
                    </div>
                    <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                        <button onclick="app.printServiceSlip(null, { isBlank: true })" class="flex-1 sm:flex-initial bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3.5 py-2.5 rounded-xl font-bold transition flex items-center justify-center gap-1.5 text-xs active:scale-95" title="Print Blank Service Slips to write by hand (හිස් Service Slips Print කරන්න)">
                            <i class="fa-solid fa-file-invoice text-emerald-600 dark:text-emerald-400"></i> Blank Slip (හිස් Slip)
                        </button>
                        <button onclick="app.openRepairModal()" class="flex-1 sm:flex-initial bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white px-5 py-2.5 rounded-xl font-bold shadow-lg shadow-violet-500/25 transition-all flex items-center justify-center gap-2 text-sm active:scale-95">
                            <i class="fa-solid fa-plus-circle"></i> New Repair Job (නව රෙපයාර් එකක්)
                        </button>
                    </div>
                </div>

                <!-- Metrics Overview Cards -->
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div class="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60">
                        <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Total Jobs</div>
                        <div class="text-2xl font-black text-slate-800 dark:text-white mt-1">${totalCount}</div>
                    </div>
                    <div class="p-3.5 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200/60 dark:border-amber-800/50">
                        <div class="text-[11px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Pending (භාරගත්)</div>
                        <div class="text-2xl font-black text-amber-700 dark:text-amber-300 mt-1">${pendingCount}</div>
                    </div>
                    <div class="p-3.5 bg-blue-50 dark:bg-blue-950/30 rounded-xl border border-blue-200/60 dark:border-blue-800/50">
                        <div class="text-[11px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider">In Progress</div>
                        <div class="text-2xl font-black text-blue-700 dark:text-blue-300 mt-1">${inProgressCount}</div>
                    </div>
                    <div class="p-3.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200/60 dark:border-emerald-800/50">
                        <div class="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Completed / Ready</div>
                        <div class="text-2xl font-black text-emerald-700 dark:text-emerald-300 mt-1">${completedCount}</div>
                    </div>
                </div>

                <!-- Search and Status Filter Bar -->
                <div class="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
                    <div class="relative flex-1">
                        <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
                        <input id="repair-search-input" type="text" value="${app.repairSearchQuery || ''}"
                            oninput="app.setRepairSearch(this.value)"
                            placeholder="Search by Job # (e.g. REP-0001), Customer, Phone, or Device Model..."
                            class="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs sm:text-sm font-medium text-slate-800 dark:text-slate-100 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-500">
                    </div>
                    <div class="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
                        ${['All', 'Pending', 'In Progress', 'Completed', 'Delivered'].map(st => `
                            <button onclick="app.setRepairFilter('${st}')"
                                class="px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${activeFilter === st ? 'bg-violet-600 text-white shadow-sm' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200'}">
                                ${st}
                            </button>
                        `).join('')}
                    </div>
                </div>

                <!-- Repairs List Cards -->
                <div class="flex-1 overflow-y-auto">
                    ${filteredRepairs.length === 0 ? `
                        <div class="p-12 text-center text-slate-400 dark:text-slate-500">
                            <i class="fa-solid fa-inbox text-4xl mb-3 text-slate-300 dark:text-slate-600"></i>
                            <p class="font-bold">No repair jobs found</p>
                            <p class="text-xs mt-1">Click "New Repair Job" to register a device and print a customer receipt.</p>
                        </div>
                    ` : `
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
                            ${filteredRepairs.map(job => {
                                const customerName = job.customerName || job.customer_name || 'Walk-in';
                                const phoneModel = job.phoneModel || job.phone_model || 'Device';
                                const contact = job.contact || job.phone || '';
                                const issue = job.issue || 'General Service / Checkup';
                                const status = job.status || 'Pending';
                                const estCost = Number(job.estimatedCost !== undefined ? job.estimatedCost : (job.cost !== undefined ? job.cost : (job.estimated_cost || 0)));
                                const advPay = Number(job.advancePayment !== undefined ? job.advancePayment : (job.advance_payment || 0));
                                const balance = Math.max(0, estCost - advPay);
                                const tokenNo = `#REP-${String(job.id).padStart(4, '0')}`;

                                return `
                                <div class="border border-slate-200/80 dark:border-slate-700/80 rounded-2xl p-4 hover:shadow-lg transition-all bg-white dark:bg-slate-800/90 relative flex flex-col justify-between space-y-3">
                                    <!-- Top Badges -->
                                    <div class="flex justify-between items-start">
                                        <div class="flex items-center gap-2">
                                            <span class="font-mono text-xs font-black px-2.5 py-1 rounded-lg bg-violet-50 dark:bg-violet-950/60 border border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300">
                                                ${tokenNo}
                                            </span>
                                            <span class="text-[10px] font-bold px-2 py-0.5 rounded-full ${app.getStatusColor(status)}">
                                                ${status}
                                            </span>
                                        </div>
                                        <span class="text-[10px] font-semibold text-slate-400">
                                            ${new Date(job.createdAt || Date.now()).toLocaleDateString()}
                                        </span>
                                    </div>

                                    <!-- Device & Customer -->
                                    <div>
                                        <h3 class="font-black text-slate-800 dark:text-white text-base leading-snug flex items-center gap-1.5">
                                            <i class="fa-solid fa-mobile-screen text-violet-600 text-sm"></i> ${phoneModel}
                                        </h3>
                                        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400 mt-1">
                                            <span class="font-semibold"><i class="fa-solid fa-user mr-1 text-slate-400"></i>${customerName}</span>
                                            ${contact ? `
                                                <a href="tel:${contact}" class="font-bold text-violet-600 dark:text-violet-400 hover:underline">
                                                    <i class="fa-solid fa-phone mr-1 text-emerald-500"></i>${contact}
                                                </a>
                                            ` : '<span class="text-slate-400 italic">No phone</span>'}
                                        </div>
                                    </div>

                                    <!-- Issue / Problem Box -->
                                    <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-700 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                                        <span class="font-bold text-slate-400 uppercase text-[10px] block mb-0.5">දෝෂය / Issue:</span>
                                        ${issue}
                                    </div>

                                    <!-- Cost Breakdown -->
                                    <div class="p-2.5 rounded-xl bg-violet-50/50 dark:bg-violet-950/30 border border-violet-100 dark:border-violet-900/40 text-xs space-y-1">
                                        <div class="flex justify-between items-center text-slate-500 dark:text-slate-400">
                                            <span>Est. Cost (ඇස්තමේන්තුව):</span>
                                            <span class="font-bold text-slate-700 dark:text-slate-200">LKR ${estCost.toFixed(2)}</span>
                                        </div>
                                        <div class="flex justify-between items-center text-slate-500 dark:text-slate-400">
                                            <span>Advance (අත්තිකාරම්):</span>
                                            <span class="font-bold text-emerald-600 dark:text-emerald-400">LKR ${advPay.toFixed(2)}</span>
                                        </div>
                                        <div class="flex justify-between items-center pt-1 border-t border-violet-200/60 dark:border-violet-800/60 font-black text-violet-900 dark:text-violet-200 text-sm">
                                            <span>Balance (ඉතිරි මුදල):</span>
                                            <span class="text-violet-700 dark:text-violet-300">LKR ${balance.toFixed(2)}</span>
                                        </div>
                                    </div>

                                    <!-- Action Buttons -->
                                    <div class="pt-2 border-t border-slate-100 dark:border-slate-700/60 flex items-center justify-between gap-1.5">
                                        <!-- Print Customer Service Slip Button (Matching Photo) -->
                                        <button onclick="app.printServiceSlip(${job.id})"
                                            class="flex-1 py-2 px-2.5 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition active:scale-95"
                                            title="Print Customer Service Slip (Service Slip එක Print කරන්න)">
                                            <i class="fa-solid fa-receipt"></i>
                                            <span>Slip</span>
                                        </button>

                                        <!-- Send WhatsApp Note Button -->
                                        <button onclick="app.sendRepairWhatsApp(${job.id})"
                                            class="py-2 px-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition active:scale-95"
                                            title="Send WhatsApp Note (Customer ට WhatsApp Note එකක් යවන්න)">
                                            <i class="fa-brands fa-whatsapp text-sm"></i>
                                            <span>WhatsApp</span>
                                        </button>

                                        <!-- Print 80mm Thermal Receipt Button -->
                                        <button onclick="app.printThermalReceipt(${job.id})"
                                            class="py-2 px-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold text-xs flex items-center justify-center gap-1 transition"
                                            title="Print 80mm Thermal Receipt (Thermal බිල්පත)">
                                            <i class="fa-solid fa-print"></i>
                                        </button>

                                        <button onclick="app.updateRepairStatus(${job.id})"
                                            class="py-2 px-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-bold transition flex items-center gap-1"
                                            title="Change Job Status">
                                            <i class="fa-solid fa-arrows-rotate"></i>
                                        </button>

                                        <button onclick="app.openRepairModal(${job.id})"
                                            class="py-2 px-2 rounded-xl bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-slate-700 dark:text-slate-200 text-xs font-bold transition"
                                            title="Edit Job Details">
                                            <i class="fa-solid fa-pen"></i>
                                        </button>

                                        <button onclick="app.deleteRepair(${job.id})"
                                            class="py-2 px-2 rounded-xl bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 text-rose-600 text-xs font-bold transition"
                                            title="Delete Job">
                                            <i class="fa-solid fa-trash"></i>
                                        </button>
                                    </div>
                                </div>
                                `;
                            }).join('')}
                        </div>
                    `}
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
    },

    setRepairFilter: (status) => {
        app.repairFilterStatus = status;
        app.renderRepairs();
    },

    setRepairSearch: (query) => {
        app.repairSearchQuery = query;
        app.renderRepairs();
    },

    getStatusColor: (status) => {
        switch ((status || '').toLowerCase()) {
            case 'pending': return 'bg-amber-100 text-amber-800 dark:bg-amber-950/70 dark:text-amber-300 border border-amber-300/60';
            case 'in progress': return 'bg-blue-100 text-blue-800 dark:bg-blue-950/70 dark:text-blue-300 border border-blue-300/60';
            case 'completed': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/70 dark:text-emerald-300 border border-emerald-300/60';
            case 'delivered': return 'bg-slate-200 text-slate-800 dark:bg-slate-800 dark:text-slate-300 border border-slate-300/60';
            default: return 'bg-slate-100 text-slate-700';
        }
    },

    openRepairModal: async (id = null) => {
        let job = { customerName: '', contact: '', phoneModel: '', issue: '', estimatedCost: 0, advancePayment: 0, status: 'Pending' };
        if (id) {
            job = await db.repairs.get(id);
        }

        const estCostVal = job.estimatedCost !== undefined ? job.estimatedCost : (job.cost || 0);
        const advPayVal = job.advancePayment || 0;

        const { value: formValues } = await Swal.fire({
            title: `<div class="flex items-center justify-center gap-2 text-xl font-black text-slate-800 dark:text-white"><i class="fa-solid fa-screwdriver-wrench text-violet-600"></i> ${id ? 'Edit Repair Job' : 'New Repair Job (නව රෙපයාර් එකක්)'}</div>`,
            html: `
                <div class="space-y-3 text-left text-xs my-2">
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label class="block font-bold text-slate-600 dark:text-slate-400 mb-1">Customer Name (නම) *</label>
                            <input id="rep-name" class="swal2-input !m-0 !w-full !text-xs font-semibold" placeholder="e.g. Kamal Perera" value="${job.customerName || ''}">
                        </div>
                        <div>
                            <label class="block font-bold text-emerald-700 dark:text-emerald-400 mb-1">
                                <i class="fa-brands fa-whatsapp text-emerald-600 mr-1"></i> Customer WhatsApp Number (ඉල්ලාගන්නා අංකය) *
                            </label>
                            <input id="rep-contact" type="tel" class="swal2-input !m-0 !w-full !text-xs font-bold border-emerald-300 dark:border-emerald-700" placeholder="07x xxxxxxx (Customer ගේ WhatsApp අංකය)" value="${job.contact || ''}">
                        </div>
                    </div>

                    <div>
                        <label class="block font-bold text-slate-600 dark:text-slate-400 mb-1">Device Model (දුරකථන / භාණ්ඩ මාදිලිය) *</label>
                        <input id="rep-model" class="swal2-input !m-0 !w-full !text-xs font-semibold" placeholder="e.g. Samsung Galaxy A12 / Redmi Note 10" value="${job.phoneModel || ''}">
                    </div>

                    <div>
                        <label class="block font-bold text-slate-600 dark:text-slate-400 mb-1">Issue / Fault Description (දෝෂය පිළිබඳ විස්තරය) *</label>
                        <textarea id="rep-issue" class="swal2-textarea !m-0 !w-full !text-xs font-semibold !h-20" placeholder="e.g. Display broken / Touch not working / Charging port damage">${job.issue || ''}</textarea>
                    </div>

                    <div class="grid grid-cols-2 gap-3 p-3 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
                        <div>
                            <label class="block font-bold text-slate-700 dark:text-slate-300 mb-1">Estimated Cost (ඇස්තමේන්තු ගාස්තුව)</label>
                            <div class="relative">
                                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold">LKR</span>
                                <input id="rep-cost" type="number" step="0.01" class="swal2-input !m-0 !w-full !pl-12 !text-xs font-bold" placeholder="0.00" value="${estCostVal}">
                            </div>
                        </div>
                        <div>
                            <label class="block font-bold text-slate-700 dark:text-slate-300 mb-1">Advance Paid (අත්තිකාරම් මුදල)</label>
                            <div class="relative">
                                <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-bold">LKR</span>
                                <input id="rep-advance" type="number" step="0.01" class="swal2-input !m-0 !w-full !pl-12 !text-xs font-bold" placeholder="0.00" value="${advPayVal}">
                            </div>
                        </div>
                    </div>

                    <!-- Auto Message & SMS Toggle -->
                    <div class="flex items-center justify-between p-2.5 bg-emerald-50/90 dark:bg-emerald-950/40 rounded-xl border border-emerald-200 dark:border-emerald-800">
                        <div class="flex items-center gap-2">
                            <i class="fa-brands fa-whatsapp text-emerald-600 text-lg"></i>
                            <div>
                                <div class="font-bold text-slate-800 dark:text-slate-100 text-xs">Auto Message (බිල්පත දැමූ විගස Auto Note එක යවන්න)</div>
                                <div class="text-[10px] text-slate-500 dark:text-slate-400">Save කළ සැනින් WhatsApp / SMS ස්වයංක්‍රීයව Customer ට යවයි</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <button type="button" onclick="app.openMessageSettingsModal()" class="text-[10px] text-emerald-700 dark:text-emerald-300 underline font-bold px-1 py-0.5 hover:text-emerald-800" title="SMS & WhatsApp Settings">⚙️ Config</button>
                            <input type="checkbox" id="rep-auto-msg" class="w-4 h-4 accent-emerald-600 cursor-pointer" ${localStorage.getItem('krishan_pos_auto_msg') !== 'false' ? 'checked' : ''}>
                        </div>
                    </div>

                    ${id ? `
                    <div>
                        <label class="block font-bold text-slate-600 dark:text-slate-400 mb-1">Repair Status (තත්ත්වය)</label>
                        <select id="rep-status" class="swal2-input !m-0 !w-full !text-xs font-bold cursor-pointer">
                            <option value="Pending" ${job.status === 'Pending' ? 'selected' : ''}>Pending (භාරගත් - තවම ආරම්භ කර නැත)</option>
                            <option value="In Progress" ${job.status === 'In Progress' ? 'selected' : ''}>In Progress (සාදමින් පවතී)</option>
                            <option value="Completed" ${job.status === 'Completed' ? 'selected' : ''}>Completed (සාදා නිම කළ - ලබාගැනීමට සූදානම්)</option>
                            <option value="Delivered" ${job.status === 'Delivered' ? 'selected' : ''}>Delivered (ගනුදෙනුකරුට භාර දුන්)</option>
                        </select>
                    </div>
                    ` : ''}
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: id ? '<i class="fa-solid fa-save mr-1"></i> Update Job' : '<i class="fa-solid fa-plus-circle mr-1"></i> Register & Save',
            confirmButtonColor: '#7c3aed',
            preConfirm: () => {
                const customerName = document.getElementById('rep-name').value.trim();
                const contact = document.getElementById('rep-contact').value.trim();
                const phoneModel = document.getElementById('rep-model').value.trim();
                const issue = document.getElementById('rep-issue').value.trim();
                const estimatedCost = parseFloat(document.getElementById('rep-cost').value) || 0;
                const advancePayment = parseFloat(document.getElementById('rep-advance').value) || 0;
                const autoMsg = document.getElementById('rep-auto-msg') ? document.getElementById('rep-auto-msg').checked : true;
                localStorage.setItem('krishan_pos_auto_msg', autoMsg ? 'true' : 'false');

                if (!customerName || !phoneModel || !issue) {
                    Swal.showValidationMessage('Customer Name, Device Model, සහ Issue විස්තරය අනිවාර්යයි!');
                    return false;
                }

                // If Auto-Message is ON, ensure customer phone number is provided
                const cleanPhone = contact.replace(/[^0-9]/g, '');
                if (autoMsg && cleanPhone.length < 9) {
                    Swal.showValidationMessage('කරුණාකර Customer ගෙන් ඉල්ලාගත් WhatsApp අංකය (07x xxxxxxx) ඇතුළත් කරන්න!');
                    return false;
                }

                const data = {
                    customerName,
                    contact,
                    phoneModel,
                    issue,
                    estimatedCost,
                    cost: estimatedCost,
                    advancePayment,
                    autoMsg
                };

                if (id) {
                    data.status = document.getElementById('rep-status').value;
                } else {
                    data.status = 'Pending';
                    data.createdAt = new Date().toISOString();
                }

                return data;
            }
        });

        if (formValues) {
            let targetId = id;
            if (id) {
                await db.repairs.update(id, formValues);
                app.apiCall(`/api/repairs/${id}`, 'PUT', formValues, 'update_repair', id);
                Swal.fire({ icon: 'success', title: 'Job Updated', timer: 1200, showConfirmButton: false });
                if (app.state.currentView === 'dashboard') {
                    await app.renderDashboard();
                } else {
                    await app.renderRepairs();
                }
            } else {
                targetId = await db.repairs.add(formValues);
                app.apiCall('/api/repairs', 'POST', { id: targetId, ...formValues }, 'create_repair');
                // Immediately navigate to repairs screen so user sees their new repair registered right away!
                await app.navigate('repairs');
            }

            // AUTO SEND ON BILL SAVE: If autoMsg is on and phone number is provided, dispatch message immediately!
            let autoDispatched = false;
            if (formValues.autoMsg !== false && (formValues.contact || '').trim()) {
                try {
                    await app.sendRepairWhatsApp(targetId, 'auto', { skipPreview: true });
                    autoDispatched = true;
                } catch (err) {
                    console.warn('Auto message trigger error:', err);
                }
            }

            // Ask to print customer bill / job card slip or re-send note
            const printAsk = await Swal.fire({
                title: id ? 'Repair Job Updated!' : (autoDispatched ? 'Repair Job Saved & Note Sent!' : 'Repair Job Registered!'),
                html: `
                    <div class="text-center space-y-3 text-sm my-1">
                        <div class="font-mono text-2xl font-black text-violet-700 dark:text-violet-400">
                            #REP-${String(targetId).padStart(4, '0')}
                        </div>
                        ${autoDispatched ? `
                            <div class="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 font-bold text-xs flex items-center justify-center gap-2 shadow-sm">
                                <i class="fa-solid fa-circle-check text-emerald-600 text-base"></i> Auto Message WhatsApp / SMS යවන ලදී (+${formValues.contact})
                            </div>
                        ` : `
                            <p class="text-xs text-slate-500">Service Slip Print කරන්න හෝ WhatsApp Note එක යවන්න:</p>
                        `}
                        <button id="swal-btn-wa" type="button" class="w-full py-2 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition active:scale-95 cursor-pointer">
                            <i class="fa-brands fa-whatsapp text-base"></i> ${autoDispatched ? 'Re-send WhatsApp Note (නැවත යවන්න)' : 'Send WhatsApp Note (Customer ට යවන්න)'}
                        </button>
                    </div>
                `,
                icon: 'success',
                showCancelButton: true,
                showDenyButton: true,
                confirmButtonText: '<i class="fa-solid fa-receipt mr-1.5"></i> Service Slip Print',
                denyButtonText: '<i class="fa-solid fa-print mr-1.5"></i> Thermal Receipt',
                cancelButtonText: 'Done (ඉවරයි)',
                confirmButtonColor: '#13385e',
                denyButtonColor: '#7c3aed',
                didOpen: () => {
                    const waBtn = document.getElementById('swal-btn-wa');
                    if (waBtn) {
                        waBtn.addEventListener('click', () => {
                            app.sendRepairWhatsApp(targetId, 'auto', { skipPreview: false });
                        });
                    }
                }
            });

            if (printAsk.isConfirmed) {
                app.printServiceSlip(targetId);
            } else if (printAsk.isDenied) {
                app.printThermalReceipt(targetId);
            }
        }
    },

    updateRepairStatus: async (id) => {
        const repair = await db.repairs.get(id);
        if (!repair) return;

        const { value: status } = await Swal.fire({
            title: `<div class="flex items-center justify-center gap-2 text-lg font-black"><i class="fa-solid fa-arrows-rotate text-blue-600"></i> Update Job Status</div>`,
            input: 'select',
            inputOptions: {
                'Pending': 'Pending (භාරගත්)',
                'In Progress': 'In Progress (සාදමින් පවතී)',
                'Completed': 'Completed (සාදා නිම කළ)',
                'Delivered': 'Delivered (භාර දුන්)'
            },
            inputValue: repair.status || 'Pending',
            showCancelButton: true,
            confirmButtonText: 'Update Status',
            confirmButtonColor: '#7c3aed'
        });

        if (status) {
            await db.repairs.update(id, { status });
            const updated = await db.repairs.get(id);
            app.apiCall(`/api/repairs/${id}`, 'PUT', updated, 'update_repair', id);
            if (app.state.currentView === 'dashboard') {
                await app.renderDashboard();
            } else {
                await app.renderRepairs();
            }

            // Prompt delivery print & WhatsApp if status changed
            if (status === 'Delivered' || status === 'Completed' || status === 'In Progress') {
                const printAsk = await Swal.fire({
                    title: `Status: ${status}`,
                    html: `
                        <div class="text-center space-y-3 text-xs my-2">
                            <p class="text-slate-600 dark:text-slate-300">Customer ට Status Update එක WhatsApp මගින් යවන්න හෝ Receipt එක Print කරන්න:</p>
                            <button id="swal-btn-status-wa" type="button" class="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition active:scale-95 cursor-pointer">
                                <i class="fa-brands fa-whatsapp text-base"></i> Send WhatsApp Update (Status පණිවිඩය යවන්න)
                            </button>
                        </div>
                    `,
                    icon: 'info',
                    showCancelButton: true,
                    confirmButtonText: '<i class="fa-solid fa-print mr-1"></i> Print Receipt',
                    cancelButtonText: 'Done (අවශ්‍ය නැත)',
                    confirmButtonColor: '#7c3aed',
                    didOpen: () => {
                        const waBtn = document.getElementById('swal-btn-status-wa');
                        if (waBtn) {
                            waBtn.addEventListener('click', () => {
                                app.sendRepairWhatsApp(id, status.toLowerCase());
                            });
                        }
                    }
                });
                if (printAsk.isConfirmed) {
                    app.printRepairReceipt(id);
                }
            }
        }
    },

    deleteRepair: async (id) => {
        const repair = await db.repairs.get(id);
        const token = `#REP-${String(id).padStart(4, '0')}`;
        if (await Swal.fire({
            title: `Delete ${token}?`,
            text: `Are you sure you want to delete repair job for ${repair?.phoneModel || 'device'}?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#e11d48',
            confirmButtonText: 'Yes, Delete'
        }).then(r => r.isConfirmed)) {
            await db.repairs.delete(id);
            app.apiCall(`/api/repairs/${id}`, 'DELETE', null, 'delete_repair', id);
            if (app.state.currentView === 'dashboard') {
                await app.renderDashboard();
            } else {
                await app.renderRepairs();
            }
            Swal.fire({ icon: 'success', title: 'Job deleted', timer: 1000, showConfirmButton: false });
        }
    },

    // ──────────────────────────────────────────────
    // PHOTO FRAMES & STUDIO CUSTOM ORDERS ENGINE
    // ──────────────────────────────────────────────
    frameFilterStatus: 'All',
    frameSearchQuery: '',

    filterPhotoFrames: (status = null, query = null) => {
        if (status !== null) app.frameFilterStatus = status;
        if (query !== null) app.frameSearchQuery = query;
        app.renderPhotoFrames();
    },

    renderPhotoFrames: async () => {
        let frames = [];
        try {
            frames = await db.photoFrames.toArray();
            if (!frames || frames.length === 0) {
                const res = await fetch(app.getApiUrl('/api/frames'), {
                    headers: app.getAuthHeaders(),
                    credentials: 'include'
                });
                if (res.ok) {
                    const srv = await res.json();
                    if (Array.isArray(srv) && srv.length > 0) {
                        await db.photoFrames.bulkPut(srv);
                        frames = await db.photoFrames.toArray();
                    }
                }
            }
        } catch (e) {
            console.warn('Error fetching frames:', e);
        }
        if (!frames) frames = [];
        frames.sort((a, b) => Number(b.id) - Number(a.id));

        const totalCount = frames.length;
        const pendingCount = frames.filter(f => (f.status || 'Pending').toLowerCase() === 'pending').length;
        const inProgressCount = frames.filter(f => ['designing', 'printing', 'framing', 'in progress'].includes((f.status || '').toLowerCase())).length;
        const readyCount = frames.filter(f => (f.status || '').toLowerCase() === 'ready').length;
        const deliveredCount = frames.filter(f => (f.status || '').toLowerCase() === 'delivered').length;

        // Apply filters
        const activeFilter = app.frameFilterStatus || 'All';
        const searchQuery = (app.frameSearchQuery || '').trim().toLowerCase();

        let filtered = frames;
        if (activeFilter !== 'All') {
            if (activeFilter === 'Active') {
                filtered = filtered.filter(f => !['delivered'].includes((f.status || '').toLowerCase()));
            } else {
                filtered = filtered.filter(f => (f.status || 'Pending').toLowerCase() === activeFilter.toLowerCase());
            }
        }
        if (searchQuery) {
            filtered = filtered.filter(f => {
                const token = `frm-${f.id}`.toLowerCase();
                const name = (f.customerName || '').toLowerCase();
                const phone = (f.contact || '').toLowerCase();
                const size = (f.size || '').toLowerCase();
                const type = (f.frameType || '').toLowerCase();
                const mould = (f.mouldingColor || '').toLowerCase();
                const notes = (f.notes || '').toLowerCase();
                return token.includes(searchQuery) || name.includes(searchQuery) || phone.includes(searchQuery) || size.includes(searchQuery) || type.includes(searchQuery) || mould.includes(searchQuery) || notes.includes(searchQuery);
            });
        }

        const html = `
            <div class="bg-white dark:bg-slate-900 rounded-3xl shadow-sm border border-slate-200 dark:border-slate-800 p-4 sm:p-6 fade-in flex flex-col space-y-6 mb-8">
                <!-- Top Header & Action -->
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                    <div>
                        <h2 class="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                            <i class="fa-solid fa-image text-rose-500"></i> Photo Frames &amp; Studio Orders
                        </h2>
                        <p class="text-xs text-slate-400 mt-0.5">Custom Photo Frames • Glass, Matte, Canvas Texture &amp; Box Framing • Workshop Orders</p>
                    </div>
                    <div class="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                        <button onclick="app.printFrameSlip(null, { isBlank: true })" class="flex-1 sm:flex-initial bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3.5 py-2.5 rounded-xl font-bold transition flex items-center justify-center gap-1.5 text-xs active:scale-95 cursor-pointer" title="Print Blank Frame Slips">
                            <i class="fa-solid fa-file-invoice text-rose-500"></i> Blank Slip (හිස් Slip)
                        </button>
                        <button onclick="app.openPhotoFrameModal()" class="flex-1 sm:flex-initial bg-gradient-to-r from-rose-500 to-pink-600 hover:from-rose-600 hover:to-pink-700 text-white px-5 py-2.5 rounded-xl font-bold shadow-lg shadow-rose-500/25 transition-all flex items-center justify-center gap-2 text-sm active:scale-95 cursor-pointer">
                            <i class="fa-solid fa-plus-circle"></i> New Frame Order (නව ෆ්‍රේම් එකක්)
                        </button>
                    </div>
                </div>

                <!-- Metrics Overview Cards -->
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div class="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200/60 dark:border-slate-700/60">
                        <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Total Orders (මුළු)</div>
                        <div class="text-2xl font-black text-slate-800 dark:text-white mt-1">${totalCount}</div>
                    </div>
                    <div class="p-3.5 bg-amber-50 dark:bg-amber-950/30 rounded-xl border border-amber-200/60 dark:border-amber-800/50">
                        <div class="text-[11px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wider">Pending (භාරගත්)</div>
                        <div class="text-2xl font-black text-amber-700 dark:text-amber-300 mt-1">${pendingCount}</div>
                    </div>
                    <div class="p-3.5 bg-blue-50 dark:bg-blue-950/30 rounded-xl border border-blue-200/60 dark:border-blue-800/50">
                        <div class="text-[11px] font-bold text-blue-600 dark:text-blue-400 uppercase tracking-wider">In Framing (සැකසෙමින්)</div>
                        <div class="text-2xl font-black text-blue-700 dark:text-blue-300 mt-1">${inProgressCount}</div>
                    </div>
                    <div class="p-3.5 bg-emerald-50 dark:bg-emerald-950/30 rounded-xl border border-emerald-200/60 dark:border-emerald-800/50">
                        <div class="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">Ready for Pickup (සූදානම්)</div>
                        <div class="text-2xl font-black text-emerald-700 dark:text-emerald-300 mt-1">${readyCount}</div>
                    </div>
                </div>

                <!-- Filters & Search Bar -->
                <div class="flex flex-col md:flex-row justify-between items-stretch md:items-center gap-3 pt-2">
                    <!-- Status Filter Tabs -->
                    <div class="flex flex-wrap gap-1.5 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-2xl border border-slate-200/60 dark:border-slate-700/60 text-xs">
                        ${['All', 'Active', 'Pending', 'Framing', 'Ready', 'Delivered'].map(st => `
                            <button onclick="app.filterPhotoFrames('${st}')" class="px-3 py-1.5 rounded-xl font-bold transition-all cursor-pointer ${activeFilter.toLowerCase() === st.toLowerCase() ? 'bg-white dark:bg-slate-700 text-rose-600 dark:text-rose-400 shadow-sm' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}">
                                ${st === 'All' ? 'All Orders' : (st === 'Ready' ? 'Ready (සූදානම්)' : st)}
                            </button>
                        `).join('')}
                    </div>

                    <!-- Search Input -->
                    <div class="relative w-full md:w-80">
                        <i class="fa-solid fa-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i>
                        <input id="frame-search-input" type="text" placeholder="Search by Order#, Name, Size, Phone..." value="${app.frameSearchQuery || ''}" oninput="app.filterPhotoFrames(null, this.value)" class="w-full pl-9 pr-3.5 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500">
                    </div>
                </div>

                <!-- Orders Grid / Cards -->
                ${filtered.length === 0 ? `
                    <div class="py-16 text-center space-y-3">
                        <div class="w-16 h-16 rounded-full bg-rose-50 dark:bg-rose-950/40 text-rose-500 flex items-center justify-center text-3xl mx-auto">
                            <i class="fa-solid fa-image"></i>
                        </div>
                        <h3 class="font-bold text-slate-700 dark:text-slate-200 text-base">No photo frame orders found</h3>
                        <p class="text-xs text-slate-400">නව ෆොටෝ ෆ්‍රේම් ඇණවුමක් භාරගැනීමට "New Frame Order" ඔබන්න.</p>
                        <button onclick="app.openPhotoFrameModal()" class="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl font-bold text-xs shadow-md transition cursor-pointer">
                            + Register Frame Order
                        </button>
                    </div>
                ` : `
                    <div class="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                        ${filtered.map(f => {
                            const token = `#FRM-${String(f.id).padStart(4, '0')}`;
                            const total = Number(f.totalCost || 0);
                            const adv = Number(f.advancePayment || 0);
                            const bal = Math.max(0, total - adv);
                            const st = (f.status || 'Pending').toLowerCase();

                            let stBadge = 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
                            if (st === 'ready') stBadge = 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
                            else if (st === 'delivered') stBadge = 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
                            else if (['framing', 'designing', 'printing', 'in progress'].includes(st)) stBadge = 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';

                            return `
                                <div class="p-4 rounded-2xl bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/80 shadow-sm hover:shadow-md hover:border-rose-300 dark:hover:border-rose-700/60 transition-all flex flex-col justify-between space-y-3">
                                    <!-- Card Header -->
                                    <div class="flex items-start justify-between gap-2">
                                        <div>
                                            <div class="flex items-center gap-2">
                                                <span class="font-mono font-black text-rose-600 dark:text-rose-400 text-sm tracking-tight">${token}</span>
                                                <span class="px-2 py-0.5 rounded-full text-[10px] font-black uppercase ${stBadge}">${f.status || 'Pending'}</span>
                                            </div>
                                            <h4 class="font-bold text-slate-800 dark:text-slate-100 text-base mt-1 flex items-center gap-1.5">
                                                <span>${f.customerName || 'Customer'}</span>
                                            </h4>
                                            ${f.contact ? `
                                                <a href="https://wa.me/94${String(f.contact).replace(/[^0-9]/g, '').replace(/^0/, '')}" target="_blank" class="text-xs font-mono font-bold text-emerald-600 hover:text-emerald-700 flex items-center gap-1 mt-0.5" title="WhatsApp Customer">
                                                    <i class="fa-brands fa-whatsapp text-sm"></i> +${f.contact}
                                                </a>
                                            ` : ''}
                                        </div>

                                        <!-- Big Frame Size Badge -->
                                        <div class="text-right">
                                            <div class="px-3 py-1 rounded-xl bg-gradient-to-r from-rose-50 to-pink-50 dark:from-rose-950/40 dark:to-pink-950/40 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 font-black text-xs shadow-sm">
                                                <i class="fa-solid fa-crop-simple mr-1 text-[10px]"></i> ${f.size || '12x18 inch'}
                                            </div>
                                            ${f.dueDate ? `
                                                <div class="text-[10px] font-bold text-slate-400 mt-1" title="Target Delivery Date">
                                                    Due: ${new Date(f.dueDate).toLocaleDateString('en-GB')}
                                                </div>
                                            ` : ''}
                                        </div>
                                    </div>

                                    <!-- Frame Details Box -->
                                    <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-100 dark:border-slate-800 text-xs space-y-1">
                                        <div class="flex justify-between items-center text-slate-600 dark:text-slate-300">
                                            <span class="text-slate-400 text-[11px]">Type / Style:</span>
                                            <span class="font-bold">${f.frameType || 'Normal Glass'} (${f.mouldingColor || 'Gold'})</span>
                                        </div>
                                        <div class="flex justify-between items-center text-slate-600 dark:text-slate-300">
                                            <span class="text-slate-400 text-[11px]">Service:</span>
                                            <span class="font-semibold">${f.serviceType || 'Print & Frame'}</span>
                                        </div>
                                        ${f.notes ? `
                                            <div class="pt-1 border-t border-slate-200/50 dark:border-slate-800 text-[11px] text-slate-500 italic">
                                                "${f.notes}"
                                            </div>
                                        ` : ''}
                                    </div>

                                    <!-- Financials row -->
                                    <div class="flex items-center justify-between p-2 rounded-xl bg-slate-50/80 dark:bg-slate-900/40 border border-slate-200/50 dark:border-slate-700/50 text-xs font-mono">
                                        <div>
                                            <div class="text-[10px] text-slate-400 uppercase font-bold">Total Cost</div>
                                            <div class="font-black text-slate-800 dark:text-slate-200">LKR ${total.toFixed(2)}</div>
                                        </div>
                                        <div>
                                            <div class="text-[10px] text-emerald-600 uppercase font-bold">Advance</div>
                                            <div class="font-bold text-emerald-600">LKR ${adv.toFixed(2)}</div>
                                        </div>
                                        <div class="text-right">
                                            <div class="text-[10px] ${bal > 0 ? 'text-red-500' : 'text-emerald-600'} uppercase font-bold">Balance</div>
                                            <div class="font-black ${bal > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600'}">${bal > 0 ? `LKR ${bal.toFixed(2)}` : 'PAID ✓'}</div>
                                        </div>
                                    </div>

                                    <!-- Status Changer & Action Buttons -->
                                    <div class="space-y-2 pt-1 border-t border-slate-100 dark:border-slate-800">
                                        <!-- Quick Status Dropdown -->
                                        <div class="flex items-center gap-1.5">
                                            <span class="text-[10px] font-bold text-slate-400 uppercase">Status:</span>
                                            <select onchange="app.updatePhotoFrameStatus(${f.id}, this.value)" class="flex-1 py-1 px-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-xs font-bold border border-slate-200 dark:border-slate-600 focus:outline-none">
                                                <option value="Pending" ${st === 'pending' ? 'selected' : ''}>🟡 Pending (භාරගත්)</option>
                                                <option value="Designing" ${st === 'designing' ? 'selected' : ''}>🔵 Designing (ඩිසයින්)</option>
                                                <option value="Framing" ${st === 'framing' ? 'selected' : ''}>🟣 Framing (ෆ්‍රේම් සැකසීම)</option>
                                                <option value="Ready" ${st === 'ready' ? 'selected' : ''}>🟢 Ready for Pickup (සූදානම්)</option>
                                                <option value="Delivered" ${st === 'delivered' ? 'selected' : ''}>⚪ Delivered (භාර දුන්)</option>
                                            </select>
                                        </div>

                                        <!-- Buttons toolbar -->
                                        <div class="grid grid-cols-4 gap-1.5 pt-1">
                                            <button onclick="app.sendFrameWhatsApp(${f.id})" class="col-span-2 py-2 px-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-sm transition active:scale-95 cursor-pointer" title="Send WhatsApp Note (1-Shot)">
                                                <i class="fa-brands fa-whatsapp text-sm"></i> WhatsApp
                                            </button>
                                            <button onclick="app.printFrameSlip(${f.id})" class="py-2 px-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 font-bold text-xs flex items-center justify-center gap-1 transition active:scale-95 cursor-pointer" title="Print Slip">
                                                <i class="fa-solid fa-print"></i> Slip
                                            </button>
                                            <div class="flex gap-1">
                                                <button onclick="app.openPhotoFrameModal(${f.id})" class="flex-1 py-2 rounded-xl bg-violet-50 hover:bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 font-bold text-xs flex items-center justify-center transition active:scale-95 cursor-pointer" title="Edit Order">
                                                    <i class="fa-solid fa-pen"></i>
                                                </button>
                                                <button onclick="app.deletePhotoFrame(${f.id})" class="w-8 py-2 rounded-xl bg-red-50 hover:bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400 font-bold text-xs flex items-center justify-center transition active:scale-95 cursor-pointer" title="Delete">
                                                    <i class="fa-solid fa-trash"></i>
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `}
            </div>
        `;

        document.getElementById('app-content').innerHTML = html;
    },

    openPhotoFrameModal: async (frameId = null) => {
        let frame = null;
        if (frameId) {
            frame = await db.photoFrames.get(Number(frameId));
        }

        const isEdit = Boolean(frame);
        const title = isEdit ? `Edit Photo Frame #${String(frame.id).padStart(4, '0')}` : 'New Photo Frame Order (නව ෆ්‍රේම් ඇණවුමක්)';
        const defaultDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const standardSizes = [
            '4x6 inch (4R)', '5x7 inch (5R)', '6x8 inch (6R)',
            '8x10 inch (8R)', '8x12 inch (S8R)', '10x12 inch (10R)',
            '10x15 inch', '12x15 inch', '12x18 inch (12R)',
            '16x20 inch', '16x24 inch', '20x24 inch', '20x30 inch', '24x36 inch'
        ];

        const { value: formValues } = await Swal.fire({
            title: `<div class="flex items-center justify-center gap-2 text-lg font-black"><i class="fa-solid fa-image text-rose-500 text-xl"></i> ${title}</div>`,
            html: `
                <div class="text-left space-y-3 text-xs my-2">
                    <!-- Customer Details -->
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                            <label class="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-0.5">Customer Name (ගනුදෙනුකරුගේ නම) *</label>
                            <input id="frm-name" class="swal2-input !m-0 !w-full !text-xs font-bold" placeholder="e.g. Kasun Perera" value="${frame?.customerName || ''}">
                        </div>
                        <div>
                            <label class="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-0.5">WhatsApp Number (දුරකථන අංකය) *</label>
                            <input id="frm-contact" type="tel" class="swal2-input !m-0 !w-full !text-xs font-bold" placeholder="07x xxxxxxx" value="${frame?.contact || ''}">
                        </div>
                    </div>

                    <!-- Frame Size & Quick Chips -->
                    <div>
                        <div class="flex justify-between items-center mb-1">
                            <label class="text-[11px] font-bold text-slate-700 dark:text-slate-300">Frame Size (ෆ්‍රේම් ප්‍රමාණය) *</label>
                            <span class="text-[10px] text-slate-400">Quick click below or type custom</span>
                        </div>
                        <input id="frm-size" class="swal2-input !m-0 !w-full !text-xs font-bold font-mono text-rose-600 dark:text-rose-400" placeholder="e.g. 12x18 inch (12R)" value="${frame?.size || '12x18 inch (12R)'}">
                        
                        <!-- Quick Size Pill Buttons -->
                        <div class="flex flex-wrap gap-1 mt-1.5">
                            ${standardSizes.map(sz => `
                                <button type="button" onclick="document.getElementById('frm-size').value = '${sz}'" class="px-2 py-0.5 rounded-lg bg-slate-100 hover:bg-rose-50 dark:bg-slate-800 dark:hover:bg-rose-950/40 text-slate-600 dark:text-slate-300 hover:text-rose-600 text-[10px] font-bold border border-slate-200 dark:border-slate-700 transition cursor-pointer">
                                    ${sz.split(' ')[0]}
                                </button>
                            `).join('')}
                        </div>
                    </div>

                    <!-- Frame Style & Border Moulding -->
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                            <label class="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-0.5">Frame Surface / Type (වර්ගය)</label>
                            <select id="frm-type" class="swal2-input !m-0 !w-full !text-xs font-semibold">
                                <option value="Normal Glass Frame" ${(!frame || frame.frameType === 'Normal Glass Frame') ? 'selected' : ''}>Normal Glass (සාමාන්‍ය වීදුරු)</option>
                                <option value="Matte / Non-Glare Glass" ${frame?.frameType === 'Matte / Non-Glare Glass' ? 'selected' : ''}>Matte / Non-Glare Glass (නොදිලිසෙන)</option>
                                <option value="Canvas Texture Finish" ${frame?.frameType === 'Canvas Texture Finish' ? 'selected' : ''}>Canvas Texture (කැන්වස් ලැමිනේට්)</option>
                                <option value="Box / Floating Depth Frame" ${frame?.frameType === 'Box / Floating Depth Frame' ? 'selected' : ''}>Box Frame (ගැඹුරු බොක්ස් ෆ්‍රේම්)</option>
                                <option value="Laminated Photo (No Glass)" ${frame?.frameType === 'Laminated Photo (No Glass)' ? 'selected' : ''}>Laminated (වීදුරු රහිත)</option>
                                <option value="Certificate / Diploma Frame" ${frame?.frameType === 'Certificate / Diploma Frame' ? 'selected' : ''}>Certificate Frame (සහතික පත්‍ර)</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-0.5">Border Moulding / Color (දාරය)</label>
                            <select id="frm-moulding" class="swal2-input !m-0 !w-full !text-xs font-semibold">
                                <option value="Gold Border" ${(!frame || frame.mouldingColor === 'Gold Border') ? 'selected' : ''}>Gold Border (රන්වන් දාරය)</option>
                                <option value="Classic Black" ${frame?.mouldingColor === 'Classic Black' ? 'selected' : ''}>Classic Black (කළු)</option>
                                <option value="Teak / Wood Grain" ${frame?.mouldingColor === 'Teak / Wood Grain' ? 'selected' : ''}>Teak / Wood Grain (තේක්ක ලී රටා)</option>
                                <option value="Silver Border" ${frame?.mouldingColor === 'Silver Border' ? 'selected' : ''}>Silver Border (රිදී)</option>
                                <option value="White Border" ${frame?.mouldingColor === 'White Border' ? 'selected' : ''}>White Border (සුදු)</option>
                                <option value="Dark Mahogany" ${frame?.mouldingColor === 'Dark Mahogany' ? 'selected' : ''}>Dark Mahogany / Brown (දුඹුරු)</option>
                                <option value="Thin Modern Edge" ${frame?.mouldingColor === 'Thin Modern Edge' ? 'selected' : ''}>Thin Modern Edge (සිහින් දාර)</option>
                            </select>
                        </div>
                    </div>

                    <!-- Service Type & Target Date -->
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                            <label class="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-0.5">Service Type (සේවාව)</label>
                            <select id="frm-service" class="swal2-input !m-0 !w-full !text-xs font-semibold">
                                <option value="Photo Print & Frame" ${(!frame || frame.serviceType === 'Photo Print & Frame') ? 'selected' : ''}>Photo Print &amp; Frame (ප්‍රින්ට් + ෆ්‍රේම්)</option>
                                <option value="Frame Only" ${frame?.serviceType === 'Frame Only' ? 'selected' : ''}>Frame Only (පාරිභෝගිකයාගේ ෆොටෝ)</option>
                                <option value="Old Photo Restoration & Frame" ${frame?.serviceType === 'Old Photo Restoration & Frame' ? 'selected' : ''}>Restoration &amp; Frame (පරණ ෆොටෝ)</option>
                                <option value="Studio Shoot & Frame" ${frame?.serviceType === 'Studio Shoot & Frame' ? 'selected' : ''}>Studio Shoot &amp; Frame (ස්ටුඩියෝ)</option>
                                <option value="Collage / Digital Art & Frame" ${frame?.serviceType === 'Collage / Digital Art & Frame' ? 'selected' : ''}>Collage / Art &amp; Frame</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-0.5">Target Delivery Date (ලබාදිය යුතු දිනය)</label>
                            <input id="frm-due-date" type="date" class="swal2-input !m-0 !w-full !text-xs font-bold" value="${frame?.dueDate || defaultDate}">
                        </div>
                    </div>

                    <!-- Financials (Price, Advance, Balance) -->
                    <div class="grid grid-cols-2 gap-2 p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                        <div>
                            <label class="block text-[10px] font-bold text-slate-500 mb-0.5">Total Price (මුළු මුදල LKR) *</label>
                            <input id="frm-total" type="number" step="10" class="swal2-input !m-0 !w-full !text-xs font-bold font-mono" placeholder="3500" value="${frame?.totalCost || ''}">
                        </div>
                        <div>
                            <label class="block text-[10px] font-bold text-emerald-600 mb-0.5">Advance Paid (අත්තිකාරම් LKR)</label>
                            <input id="frm-advance" type="number" step="10" class="swal2-input !m-0 !w-full !text-xs font-bold font-mono text-emerald-600" placeholder="1000" value="${frame?.advancePayment || 0}">
                        </div>
                    </div>

                    <!-- Notes / Custom Text -->
                    <div>
                        <label class="block text-[11px] font-bold text-slate-700 dark:text-slate-300 mb-0.5">Special Instructions / Custom Notes (විශේෂ සටහන්)</label>
                        <input id="frm-notes" class="swal2-input !m-0 !w-full !text-xs" placeholder="e.g. Add text 'Happy Birthday Senuka', Anti-glare glass" value="${frame?.notes || ''}">
                    </div>

                    <!-- Auto WhatsApp Checkbox -->
                    <div class="p-2.5 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <i class="fa-brands fa-whatsapp text-emerald-600 text-lg"></i>
                            <div>
                                <div class="font-bold text-emerald-900 dark:text-emerald-200 text-xs">Auto WhatsApp 1-Shot Notification</div>
                                <div class="text-[10px] text-slate-500">Save කළ සැනින් Frame Order Slip එක Customer ගේ WhatsApp වෙත යවයි</div>
                            </div>
                        </div>
                        <input id="frm-auto-wa" type="checkbox" class="w-5 h-5 accent-emerald-600 rounded cursor-pointer" checked>
                    </div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: isEdit ? 'Update Order' : 'Save & Register Order',
            confirmButtonColor: '#e11d48',
            preConfirm: () => {
                const customerName = (document.getElementById('frm-name')?.value || '').trim();
                const contact = (document.getElementById('frm-contact')?.value || '').trim();
                const size = (document.getElementById('frm-size')?.value || '').trim();
                const frameType = document.getElementById('frm-type')?.value;
                const mouldingColor = document.getElementById('frm-moulding')?.value;
                const serviceType = document.getElementById('frm-service')?.value;
                const dueDate = document.getElementById('frm-due-date')?.value;
                const totalCost = Number(document.getElementById('frm-total')?.value || 0);
                const advancePayment = Number(document.getElementById('frm-advance')?.value || 0);
                const notes = (document.getElementById('frm-notes')?.value || '').trim();
                const autoWa = document.getElementById('frm-auto-wa')?.checked;

                if (!customerName) {
                    Swal.showValidationMessage('කරුණාකර ගනුදෙනුකරුගේ නම ඇතුළත් කරන්න');
                    return false;
                }
                if (!size) {
                    Swal.showValidationMessage('කරුණාකර Frame Size එක තෝරන්න හෝ ඇතුළත් කරන්න');
                    return false;
                }
                if (totalCost <= 0) {
                    Swal.showValidationMessage('කරුණාකර වලංගු මුළු මුදලක් ඇතුළත් කරන්න');
                    return false;
                }

                return { customerName, contact, size, frameType, mouldingColor, serviceType, dueDate, totalCost, advancePayment, notes, autoWa };
            }
        });

        if (!formValues) return;

        let targetId = frameId;
        const nowIso = new Date().toISOString();

        if (isEdit) {
            const updated = {
                ...formValues,
                status: frame.status || 'Pending'
            };
            await db.photoFrames.update(frame.id, updated);
            app.apiCall(`/api/frames/${frame.id}`, 'PUT', updated, 'update_frame', frame.id);
        } else {
            const newObj = {
                ...formValues,
                status: 'Pending',
                createdAt: nowIso
            };
            const insertedId = await db.photoFrames.add(newObj);
            targetId = insertedId;
            app.apiCall('/api/frames', 'POST', { id: insertedId, ...newObj }, 'create_frame', insertedId);
        }

        if (app.state.currentView === 'frames') {
            await app.renderPhotoFrames();
        } else if (app.state.currentView === 'dashboard') {
            await app.renderDashboard();
        }

        // AUTO WHATSAPP DISPATCH IN 1-SHOT!
        let autoDispatched = false;
        if (formValues.autoWa && formValues.contact) {
            try {
                await app.sendFrameWhatsApp(targetId, 'auto', { skipPreview: true });
                autoDispatched = true;
            } catch (waErr) {
                console.warn('Auto frame WhatsApp error:', waErr);
            }
        }

        // Post-save Confirmation Prompt with Slip / Tag print options
        const postAsk = await Swal.fire({
            title: isEdit ? 'Frame Order Updated!' : (autoDispatched ? 'Order Saved & WhatsApp Sent!' : 'Frame Order Registered!'),
            html: `
                <div class="text-center space-y-3 text-xs my-1">
                    <div class="font-mono text-2xl font-black text-rose-600 dark:text-rose-400">
                        #FRM-${String(targetId).padStart(4, '0')}
                    </div>
                    ${autoDispatched ? `
                        <div class="p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 font-bold text-xs flex items-center justify-center gap-2 shadow-sm">
                            <i class="fa-solid fa-circle-check text-emerald-600 text-base"></i> WhatsApp Frame Slip auto-sent to +${formValues.contact} (1-Shot)
                        </div>
                    ` : ''}
                    <button id="swal-post-wa" type="button" class="w-full py-2.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-sm transition active:scale-95 cursor-pointer">
                        <i class="fa-brands fa-whatsapp text-base"></i> ${autoDispatched ? 'Re-send WhatsApp Note' : 'Send WhatsApp Note (1-Shot)'}
                    </button>
                </div>
            `,
            icon: 'success',
            showCancelButton: true,
            showDenyButton: true,
            confirmButtonText: '<i class="fa-solid fa-receipt mr-1"></i> Customer Slip Print',
            denyButtonText: '<i class="fa-solid fa-tag mr-1"></i> Workshop Tag Print',
            cancelButtonText: 'Done (ඉවරයි)',
            confirmButtonColor: '#e11d48',
            denyButtonColor: '#7c3aed',
            didOpen: () => {
                const btn = document.getElementById('swal-post-wa');
                if (btn) btn.addEventListener('click', () => app.sendFrameWhatsApp(targetId, 'auto', { skipPreview: false }));
            }
        });

        if (postAsk.isConfirmed) {
            app.printFrameSlip(targetId, { workshopTag: false });
        } else if (postAsk.isDenied) {
            app.printFrameSlip(targetId, { workshopTag: true });
        }
    },

    updatePhotoFrameStatus: async (id, status) => {
        const frame = await db.photoFrames.get(Number(id));
        if (!frame) return;

        await db.photoFrames.update(Number(id), { status });
        app.apiCall(`/api/frames/${id}`, 'PUT', { status }, 'update_frame', id);

        if (app.state.currentView === 'frames') {
            await app.renderPhotoFrames();
        } else if (app.state.currentView === 'dashboard') {
            await app.renderDashboard();
        }

        // If status changed to Ready or Delivered, offer WhatsApp notification
        if (status === 'Ready' || status === 'Delivered') {
            const isReady = status === 'Ready';
            const ask = await Swal.fire({
                title: isReady ? '🎉 Frame Ready for Pickup!' : '🤝 Frame Handed Over!',
                text: isReady 
                    ? `Customer (${frame.customerName}) ට Frame එක සාදා නිමකර ඇති බව WhatsApp පණිවිඩයක් මගින් දන්වන්නද?` 
                    : `Customer (${frame.customerName}) ට Thank You WhatsApp පණිවිඩයක් යවන්නද?`,
                icon: 'question',
                showCancelButton: true,
                confirmButtonText: `<i class="fa-brands fa-whatsapp text-lg mr-1.5"></i> Send WhatsApp (1-Shot)`,
                cancelButtonText: 'Done (අවශ්‍ය නැත)',
                confirmButtonColor: '#10b981'
            });

            if (ask.isConfirmed) {
                app.sendFrameWhatsApp(id, status.toLowerCase());
            }
        }
    },

    deletePhotoFrame: async (id) => {
        const frame = await db.photoFrames.get(Number(id));
        const token = `#FRM-${String(id).padStart(4, '0')}`;
        const conf = await Swal.fire({
            title: `Delete ${token}?`,
            text: `Are you sure you want to delete photo frame order for ${frame?.customerName || 'customer'}?`,
            icon: 'warning',
            showCancelButton: true,
            confirmButtonColor: '#e11d48',
            confirmButtonText: 'Yes, Delete'
        });

        if (conf.isConfirmed) {
            await db.photoFrames.delete(Number(id));
            app.apiCall(`/api/frames/${id}`, 'DELETE', null, 'delete_frame', id);
            if (app.state.currentView === 'frames') {
                await app.renderPhotoFrames();
            } else if (app.state.currentView === 'dashboard') {
                await app.renderDashboard();
            }
            Swal.fire({ icon: 'success', title: 'Order deleted', timer: 1000, showConfirmButton: false });
        }
    },

    sendFrameWhatsApp: async (frameId, customType = 'auto', options = {}) => {
        let frame = await db.photoFrames.get(Number(frameId));
        if (!frame) return;

        const shopDetails = {
            name: localStorage.getItem('krishan_pos_shop_name') || "Krishan Communication & Studio",
            address: localStorage.getItem('krishan_pos_shop_address') || "Hatharamanhandiya, Mapalassa, Sooriyawewa",
            phone: localStorage.getItem('krishan_pos_shop_phone') || "076 928 18 80 / 071 759 7335"
        };

        let phone = (frame.contact || '').trim();
        let cleanDigits = phone.replace(/[^0-9]/g, '');

        if (cleanDigits.length < 9) {
            const { value: enteredPhone } = await Swal.fire({
                title: '<div class="flex items-center justify-center gap-2 text-lg font-bold"><i class="fa-brands fa-whatsapp text-emerald-500 text-2xl"></i> Customer WhatsApp Number</div>',
                text: `Customer (${frame.customerName || 'Customer'}) ගේ WhatsApp දුරකථන අංකය ඇතුළත් කරන්න:`,
                input: 'tel',
                inputValue: phone || '',
                inputPlaceholder: '07x xxxxxxx',
                showCancelButton: true,
                confirmButtonText: 'Next / ඉදිරියට',
                confirmButtonColor: '#10b981',
                inputValidator: (val) => {
                    const digits = (val || '').replace(/[^0-9]/g, '');
                    if (digits.length < 9) return 'කරුණාකර නිවැරදි දුරකථන අංකයක් ඇතුළත් කරන්න (9 or 10 digits)';
                }
            });
            if (!enteredPhone) return;
            phone = enteredPhone.trim();
            cleanDigits = phone.replace(/[^0-9]/g, '');
            await db.photoFrames.update(frame.id, { contact: phone });
            frame.contact = phone;
        }

        let intlPhone = cleanDigits;
        if (intlPhone.startsWith('0')) intlPhone = '94' + intlPhone.substring(1);
        else if (intlPhone.length === 9) intlPhone = '94' + intlPhone;

        const tokenNo = `#FRM-${String(frame.id).padStart(4, '0')}`;
        const customerName = frame.customerName || 'Customer';
        const size = frame.size || '12x18 inch';
        const frameType = frame.frameType || 'Normal Glass';
        const moulding = frame.mouldingColor || 'Gold Border';
        const service = frame.serviceType || 'Print & Frame';
        const total = Number(frame.totalCost || 0);
        const adv = Number(frame.advancePayment || 0);
        const balance = Math.max(0, total - adv);
        const dueDate = frame.dueDate ? new Date(frame.dueDate).toLocaleDateString('en-GB') : 'Ready Soon';
        const dateStr = new Date(frame.createdAt || Date.now()).toLocaleDateString('en-GB');

        let msg = '';
        const stLower = (customType !== 'auto' ? customType : (frame.status || 'Pending')).toLowerCase();

        if (stLower.includes('complete') || stLower.includes('ready')) {
            msg = `📸 *${shopDetails.name.toUpperCase()}*\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🎉 *PHOTO FRAME READY / සාදා නිමකර ඇත!*\n\n` +
                  `🎫 *Order Token:* ${tokenNo}\n` +
                  `👤 *Customer:* ${customerName}\n` +
                  `🖼️ *Frame Size:* ${size}\n` +
                  `✨ *Style / Border:* ${frameType} (${moulding})\n` +
                  `✅ *Status:* Ready for Pickup (ලබාගැනීමට සූදානම්)\n` +
                  (balance > 0 ? `💰 *Balance to pay:* LKR ${balance.toFixed(2)}\n` : `✅ *Payment:* Fully Paid (සම්පූර්ණයෙන් ගෙවා ඇත)\n`) +
                  `📅 *Date:* ${dateStr}\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `📍 *ස්ථානය:* ${shopDetails.address}\n` +
                  `📞 *විමසීම්:* ${shopDetails.phone}\n\n` +
                  `*ඔබ ඇණවුම් කළ Photo Frame එක සාදා නිම කර ඇති බැවින් අප ආයතනය වෙත පැමිණ ලබාගත හැක.*\n\n` +
                  `✨ *Thank you for choosing ${shopDetails.name}!*`;
        } else if (stLower.includes('deliver')) {
            msg = `📸 *${shopDetails.name.toUpperCase()}*\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🤝 *PHOTO FRAME DELIVERED / භාර දෙන ලදී*\n\n` +
                  `🎫 *Order Token:* ${tokenNo}\n` +
                  `👤 *Customer:* ${customerName}\n` +
                  `🖼️ *Frame:* ${size} (${frameType})\n` +
                  `✅ *Status:* Delivered (ගනුදෙනුකරුට භාර දුන්)\n` +
                  `📅 *Date:* ${dateStr}\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `📍 *ස්ථානය:* ${shopDetails.address}\n` +
                  `📞 *විමසීම්:* ${shopDetails.phone}\n\n` +
                  `*අපගේ Studio & Framing සේවාව ලබාගැනීම ගැන ස්තූතියි! නැවත පැමිණෙන්න.*\n` +
                  `✨ *Thank You! ${shopDetails.name}*`;
        } else {
            msg = `📸 *${shopDetails.name.toUpperCase()}*\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🎨 *PHOTO FRAME ORDER NOTE / ඇණවුම් සටහන*\n\n` +
                  `🎫 *Order Token:* ${tokenNo}\n` +
                  `👤 *Customer:* ${customerName}\n` +
                  `🖼️ *Frame Size:* ${size}\n` +
                  `🎨 *Frame Style:* ${frameType}\n` +
                  `✨ *Border Moulding:* ${moulding}\n` +
                  `🛠️ *Service:* ${service}\n` +
                  (total > 0 ? `💵 *Total Price:* LKR ${total.toFixed(2)}\n` : ``) +
                  (adv > 0 ? `🟢 *Advance Paid:* LKR ${adv.toFixed(2)}\n` : ``) +
                  (balance > 0 && adv > 0 ? `🔴 *Balance to Pay:* LKR ${balance.toFixed(2)}\n` : ``) +
                  (frame.dueDate ? `📅 *Target Delivery Date:* ${dueDate}\n` : ``) +
                  `📅 *Order Date:* ${dateStr}\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `📍 *ස්ථානය:* ${shopDetails.address}\n` +
                  `📞 *විමසීම් / WhatsApp:* ${shopDetails.phone}\n\n` +
                  `⚠️ *සැලකිය යුතුයි:* ඔබගේ Photo Frame එක ලබා ගැනීමට පැමිණෙන විට මෙම WhatsApp පණිවිඩය හෝ Order Token අංකය (${tokenNo}) ඉදිරිපත් කරන්න.\n\n` +
                  `✨ *Thank you for trusting ${shopDetails.name}!*`;
        }

        // 1-Shot Direct Dispatch
        if (options.skipPreview) {
            const sendRes = await app.sendDirectWhatsApp({ phone: intlPhone, message: msg });
            if (sendRes.success) {
                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'success',
                    title: `⚡ Frame note sent to +${intlPhone} (1-Shot)`,
                    showConfirmButton: false,
                    timer: 3000
                });
                return;
            }
            window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, '_blank');
            return;
        }

        const isConnected = app.whatsapp?.connected;
        const confirmSend = await Swal.fire({
            title: '<div class="flex items-center justify-center gap-2"><i class="fa-brands fa-whatsapp text-emerald-500 text-2xl"></i> Frame WhatsApp Preview</div>',
            html: `
                <div class="text-left space-y-2 text-xs">
                    <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex justify-between items-center">
                        <span class="text-slate-500 font-semibold">Recipient:</span>
                        <span class="font-mono font-bold text-emerald-600 text-sm">+${intlPhone}</span>
                    </div>
                    <div class="p-2 rounded-lg ${isConnected ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'} font-semibold text-[11px] flex items-center gap-1.5">
                        <i class="fa-solid ${isConnected ? 'fa-bolt text-emerald-500' : 'fa-triangle-exclamation text-amber-500'}"></i>
                        <span>${isConnected ? 'POS WhatsApp Linked: Message will send directly in 1-Shot!' : 'POS WhatsApp not linked: Will open in WhatsApp Web.'}</span>
                    </div>
                    <div class="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-slate-700 dark:text-slate-200 font-mono text-[11px] whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
${msg}
                    </div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: isConnected ? '<i class="fa-solid fa-bolt mr-1"></i> Send Now (1-Shot)' : '<i class="fa-brands fa-whatsapp mr-1"></i> Open WhatsApp Web',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#10b981',
            cancelButtonColor: '#64748b'
        });

        if (confirmSend.isConfirmed) {
            if (isConnected) {
                Swal.showLoading();
                const sendRes = await app.sendDirectWhatsApp({ phone: intlPhone, message: msg });
                if (sendRes.success) {
                    Swal.fire({
                        icon: 'success',
                        title: 'Sent Successfully!',
                        text: `Frame note delivered directly to +${intlPhone} via POS WhatsApp.`,
                        timer: 2000,
                        showConfirmButton: false
                    });
                } else {
                    window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, '_blank');
                }
            } else {
                window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, '_blank');
            }
        }
    },

    printFrameSlip: async (frameId = null, options = {}) => {
        let frame = null;
        if (frameId) {
            frame = await db.photoFrames.get(Number(frameId));
        }

        const isBlank = !frame || Boolean(options && options.isBlank);
        const isWorkshopTag = Boolean(options && options.workshopTag);

        const shopDetails = {
            name: localStorage.getItem('krishan_pos_shop_name') || "Krishan Communication & Studio",
            sub: "Photo Studio & Custom Framing Center",
            address: localStorage.getItem('krishan_pos_shop_address') || "Hatharamanhandiya, Mapalassa, Sooriyawewa",
            phone: localStorage.getItem('krishan_pos_shop_phone') || "076 928 18 80 / 071 759 7335"
        };

        const tokenNo = (!isBlank && frame) ? `#FRM-${String(frame.id).padStart(4, '0')}` : 'FRM-______';
        const barcodeVal = (!isBlank && frame) ? `FRM-${String(frame.id).padStart(4, '0')}` : '';
        const dateObj = (!isBlank && frame) ? new Date(frame.createdAt || Date.now()) : new Date();
        const formattedDate = (!isBlank && frame) ? dateObj.toLocaleDateString('en-GB') : '____ / ____ / 202__';
        const formattedTime = (!isBlank && frame) ? dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '____ : ____';
        const dueDate = (!isBlank && frame && frame.dueDate) ? new Date(frame.dueDate).toLocaleDateString('en-GB') : '____ / ____ / 202__';

        const totalCost = (!isBlank && frame) ? Number(frame.totalCost || 0) : 0;
        const advPay = (!isBlank && frame) ? Number(frame.advancePayment || 0) : 0;
        const balance = Math.max(0, totalCost - advPay);

        const printWindow = window.open('', '_blank', 'width=460,height=850');
        if (!printWindow) {
            Swal.fire('Popup Blocked', 'Please allow popups in your browser to print slips.', 'warning');
            return;
        }

        const receiptHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>80mm Frame Slip ${tokenNo}</title>
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                        font-size: 13.5px;
                        font-weight: 900 !important;
                        line-height: 1.25;
                        margin: 0 auto;
                        padding: 8px 8px 24px 8px;
                        width: 78mm;
                        max-width: 80mm;
                        color: #000000 !important;
                        background: #ffffff;
                        -webkit-print-color-adjust: exact;
                        print-color-adjust: exact;
                    }
                    @page { margin: 0; size: 80mm auto; }
                    @media print {
                        body { margin: 0 auto; padding: 4px 6px 16px 6px; width: 78mm; }
                        .no-print { display: none !important; }
                    }
                    .store-hdr { text-align: center; margin-bottom: 6px; }
                    .store-name { font-size: 16px; font-weight: 900; letter-spacing: 0.5px; }
                    .store-sub { font-size: 11px; font-weight: 800; margin-top: 1px; }
                    .store-addr { font-size: 10px; font-weight: 700; margin-top: 2px; }
                    .store-tel { font-size: 11px; font-weight: 900; margin-top: 2px; }
                    .slip-no-wrap {
                        border: 2.5px solid #000;
                        border-radius: 6px;
                        padding: 6px 4px;
                        text-align: center;
                        margin: 6px 0;
                        background: #fff;
                    }
                    .slip-no-lbl { font-size: 10px; font-weight: 900; letter-spacing: 1px; }
                    .slip-no-giant { font-size: 26px; font-weight: 900; font-family: monospace; letter-spacing: 1px; }
                    .size-giant-box {
                        border: 2px solid #000;
                        border-radius: 6px;
                        padding: 6px;
                        text-align: center;
                        margin: 6px 0;
                        background: #f4f4f4;
                    }
                    .size-giant-lbl { font-size: 10.5px; font-weight: 900; }
                    .size-giant-val { font-size: 20px; font-weight: 900; color: #000; }
                    .line-dashed { border-top: 1.5px dashed #000; margin: 6px 0; }
                    .line-thick { border-top: 2px solid #000; margin: 6px 0; }
                    .info-row { display: flex; justify-content: space-between; font-size: 12px; margin: 3px 0; }
                    .info-lbl { font-weight: 800; color: #333; }
                    .info-val { font-weight: 900; text-align: right; }
                    .footer-note { text-align: center; margin-top: 8px; font-size: 10px; font-weight: 800; }
                    .barcode-wrap { text-align: center; margin: 6px 0; }
                </style>
                <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
            </head>
            <body>
                <div class="store-hdr">
                    <div class="store-name">${shopDetails.name}</div>
                    <div class="store-sub">${shopDetails.sub}</div>
                    <div class="store-addr">${shopDetails.address}</div>
                    <div class="store-tel">Tel: ${shopDetails.phone}</div>
                </div>

                <div class="slip-no-wrap">
                    <div class="slip-no-lbl">${isWorkshopTag ? 'WORKSHOP FRAME BACK TAG' : 'PHOTO FRAME ORDER SLIP (අංකය)'}</div>
                    <div class="slip-no-giant">${tokenNo}</div>
                </div>

                <!-- HUGE FRAME SIZE BOX -->
                <div class="size-giant-box">
                    <div class="size-giant-lbl">FRAME SIZE (ප්‍රමාණය)</div>
                    <div class="size-giant-val">${(!isBlank && frame) ? (frame.size || '12x18 inch') : '____ x ____ inch'}</div>
                </div>

                <div class="info-row">
                    <span class="info-lbl">DATE / TIME:</span>
                    <span class="info-val">${formattedDate} ${formattedTime}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">CUSTOMER (නම):</span>
                    <span class="info-val">${(!isBlank && frame) ? (frame.customerName || 'Customer') : '___________________'}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">CONTACT (දුරකථන):</span>
                    <span class="info-val">${(!isBlank && frame) ? (frame.contact || '-') : '07x - _________'}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">FRAME TYPE (වර්ගය):</span>
                    <span class="info-val">${(!isBlank && frame) ? (frame.frameType || 'Normal Glass') : '___________________'}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">BORDER / MOULDING:</span>
                    <span class="info-val">${(!isBlank && frame) ? (frame.mouldingColor || 'Gold') : '___________________'}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">SERVICE (සේවාව):</span>
                    <span class="info-val">${(!isBlank && frame) ? (frame.serviceType || 'Print & Frame') : '___________________'}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">TARGET DELIVERY (දිනය):</span>
                    <span class="info-val" style="font-size: 13px; font-weight: 900;">${dueDate}</span>
                </div>

                ${(!isBlank && frame && frame.notes) ? `
                    <div class="line-dashed"></div>
                    <div style="font-size: 11px; font-weight: 800; margin: 3px 0;">
                        NOTES: ${frame.notes}
                    </div>
                ` : ''}

                <div class="line-thick"></div>

                <!-- FINANCIALS -->
                <div class="info-row" style="font-size: 13px;">
                    <span class="info-lbl">TOTAL PRICE (මුළු මුදල):</span>
                    <span class="info-val">LKR ${totalCost.toFixed(2)}</span>
                </div>
                <div class="info-row" style="font-size: 13px; color: #047857;">
                    <span class="info-lbl">ADVANCE PAID (අත්තිකාරම්):</span>
                    <span class="info-val">LKR ${advPay.toFixed(2)}</span>
                </div>
                <div class="info-row" style="font-size: 15px; font-weight: 900; ${balance > 0 ? 'color: #b91c1c;' : 'color: #047857;'}">
                    <span>BALANCE TO PAY (ඉතිරිය):</span>
                    <span>${balance > 0 ? `LKR ${balance.toFixed(2)}` : 'PAID IN FULL'}</span>
                </div>

                <div class="line-dashed"></div>

                <div class="footer-note">
                    <div style="font-weight: 900;">WhatsApp / විමසීම්: ${shopDetails.phone}</div>
                    <div style="margin-top: 2px;">* භාණ්ඩය ලබා ගැනීමට මෙම බිල්පත හෝ WhatsApp පණිවිඩය ඉදිරිපත් කරන්න *</div>
                    <div style="font-size: 9px; color: #555; margin-top: 2px;">Please present this slip when collecting your photo frame</div>
                    <div style="font-weight: 900; margin-top: 4px;">Thank You! ${shopDetails.name}</div>
                </div>

                ${(!isBlank && barcodeVal) ? `
                    <div class="barcode-wrap">
                        <svg id="barcode-elem"></svg>
                    </div>
                ` : ''}

                <script>
                    window.onload = function() {
                        try {
                            if (typeof JsBarcode !== 'undefined' && '${barcodeVal}') {
                                JsBarcode('#barcode-elem', '${barcodeVal}', {
                                    format: 'CODE128',
                                    width: 1.8,
                                    height: 38,
                                    displayValue: true,
                                    fontSize: 11,
                                    font: 'monospace',
                                    fontOptions: 'bold',
                                    margin: 4
                                });
                            }
                        } catch(e) {}
                        setTimeout(function() { window.print(); }, 200);
                    };
                </script>
            </body>
            </html>
        `;

        printWindow.document.open();
        printWindow.document.write(receiptHTML);
        printWindow.document.close();
    },

    // ──────────────────────────────────────────────
    // WHATSAPP CUSTOMER NOTIFICATION ENGINE
    // ──────────────────────────────────────────────
    sendRepairWhatsApp: async (repairId, customType = 'auto', options = {}) => {
        let job = await db.repairs.get(Number(repairId));
        if (!job) {
            if (!options.silent) Swal.fire('Error', 'Repair job not found', 'error');
            return;
        }

        const shopDetails = {
            name: localStorage.getItem('krishan_pos_shop_name') || "Krishan Communication & Studio",
            address: localStorage.getItem('krishan_pos_shop_address') || "Hatharamanhandiya, Mapalassa, Sooriyawewa",
            phone: localStorage.getItem('krishan_pos_shop_phone') || "076 928 18 80 / 071 759 7335"
        };

        let phone = (job.contact || job.phone || '').trim();

        // If phone is missing or incomplete, ask user to enter customer's WhatsApp number
        let cleanDigits = phone.replace(/[^0-9]/g, '');
        if (cleanDigits.length < 9) {
            const { value: enteredPhone } = await Swal.fire({
                title: '<div class="flex items-center justify-center gap-2 text-lg font-bold"><i class="fa-brands fa-whatsapp text-emerald-500 text-2xl"></i> Customer WhatsApp Number</div>',
                text: `Customer (${job.customerName || 'Customer'}) ගෙන් ඉල්ලාගත් WhatsApp දුරකථන අංකය ඇතුළත් කරන්න:`,
                input: 'tel',
                inputValue: phone || '',
                inputPlaceholder: '07x xxxxxxx (Customer ගේ WhatsApp අංකය)',
                showCancelButton: true,
                confirmButtonText: 'Next / ඉදිරියට',
                confirmButtonColor: '#10b981',
                inputValidator: (val) => {
                    const digits = (val || '').replace(/[^0-9]/g, '');
                    if (digits.length < 9) return 'කරුණාකර Customer ගේ නිවැරදි දුරකථන අංකයක් ඇතුළත් කරන්න (9 or 10 digits)';
                }
            });
            if (!enteredPhone) return;
            phone = enteredPhone.trim();
            cleanDigits = phone.replace(/[^0-9]/g, '');
            // Update in DB so it's saved for this job
            await db.repairs.update(job.id, { contact: phone });
            job.contact = phone;
            if (app.state.currentView === 'dashboard') {
                app.renderDashboard();
            } else {
                app.renderRepairs();
            }
        }

        // Format to international 94xxxxxxxxx
        let intlPhone = cleanDigits;
        if (intlPhone.startsWith('0')) {
            intlPhone = '94' + intlPhone.substring(1);
        } else if (intlPhone.length === 9) {
            intlPhone = '94' + intlPhone;
        }

        const tokenNo = `#REP-${String(job.id).padStart(4, '0')}`;
        const customerName = job.customerName || job.customer_name || 'Customer';
        const deviceModel = job.phoneModel || job.phone_model || 'Device';
        const issue = job.issue || 'General Service';
        const status = job.status || 'Pending';
        const dateStr = new Date(job.createdAt || Date.now()).toLocaleDateString('en-GB');

        const estCost = Number(job.estimatedCost !== undefined ? job.estimatedCost : (job.cost !== undefined ? job.cost : (job.estimated_cost || 0)));
        const advPay = Number(job.advancePayment !== undefined ? job.advancePayment : (job.advance_payment || 0));
        const balance = Math.max(0, estCost - advPay);

        // Determine message text based on status or customType
        let msg = '';
        const stLower = (customType !== 'auto' ? customType : status).toLowerCase();

        if (stLower.includes('complete') || stLower.includes('ready')) {
            // READY FOR PICKUP MESSAGE
            msg = `📱 *${shopDetails.name.toUpperCase()}*\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🎉 *REPAIR COMPLETED / සාදා නිමකර ඇත!*\n\n` +
                  `🎫 *Job No (අංකය):* ${tokenNo}\n` +
                  `👤 *Customer (නම):* ${customerName}\n` +
                  `📱 *Device (උපකරණය):* ${deviceModel}\n` +
                  `🛠️ *Fault / Issue:* ${issue}\n` +
                  `✅ *Status (තත්ත්වය):* Ready for Pickup (ලබාගැනීමට සූදානම්)\n` +
                  (balance > 0 ? `💰 *Balance to pay:* LKR ${balance.toFixed(2)}\n` : ``) +
                  `📅 *Date:* ${dateStr}\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `📍 *ස්ථානය:* ${shopDetails.address}\n` +
                  `📞 *විමසීම්:* ${shopDetails.phone}\n\n` +
                  `*ඔබගේ දුරකථනය සාදා නිම කර ඇති බැවින් අප ආයතනය වෙත පැමිණ ලබාගත හැක.*\n\n` +
                  `✨ *Thank you for choosing ${shopDetails.name}!*`;
        } else if (stLower.includes('deliver')) {
            // DELIVERED / HANDED OVER MESSAGE
            msg = `📱 *${shopDetails.name.toUpperCase()}*\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🤝 *DEVICE HANDED OVER / භාණ්ඩය භාර දෙන ලදී*\n\n` +
                  `🎫 *Job No (අංකය):* ${tokenNo}\n` +
                  `👤 *Customer (නම):* ${customerName}\n` +
                  `📱 *Device (උපකරණය):* ${deviceModel}\n` +
                  `✅ *Status (තත්ත්වය):* Delivered (ගනුදෙනුකරුට භාර දුන්)\n` +
                  `📅 *Date:* ${dateStr}\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `📍 *ස්ථානය:* ${shopDetails.address}\n` +
                  `📞 *විමසීම්:* ${shopDetails.phone}\n\n` +
                  `*අපගේ සේවාව ලබාගැනීම ගැන ස්තූතියි! නැවත පැමිණෙන්න.*\n` +
                  `✨ *Thank You! ${shopDetails.name}*`;
        } else {
            // INTAKE / SERVICE NOTE (DEFAULT)
            msg = `📱 *${shopDetails.name.toUpperCase()}*\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `🔧 *REPAIR SERVICE NOTE / රෙපයාර් සටහන*\n\n` +
                  `🎫 *Job Token No (අංකය):* ${tokenNo}\n` +
                  `👤 *Customer (නම):* ${customerName}\n` +
                  `📱 *Device (උපකරණය):* ${deviceModel}\n` +
                  `🛠️ *Fault / Issue (දෝෂය):* ${issue}\n` +
                  `⚡ *Status (තත්ත්වය):* ${status} (භාරගන්නා ලදී)\n` +
                  (estCost > 0 ? `💵 *Est. Cost:* LKR ${estCost.toFixed(2)}\n` : ``) +
                  (advPay > 0 ? `🟢 *Advance Paid:* LKR ${advPay.toFixed(2)}\n` : ``) +
                  (balance > 0 && advPay > 0 ? `🔴 *Balance:* LKR ${balance.toFixed(2)}\n` : ``) +
                  `📅 *Date:* ${dateStr}\n\n` +
                  `━━━━━━━━━━━━━━━━━━━━━\n` +
                  `📍 *ස්ථානය:* ${shopDetails.address}\n` +
                  `📞 *විමසීම් / WhatsApp:* ${shopDetails.phone}\n\n` +
                  `⚠️ *සැලකිය යුතුයි:* භාණ්ඩය නැවත ලබා ගැනීමට පැමිණෙන විට මෙම WhatsApp පණිවිඩය හෝ Job අංකය (${tokenNo}) ඉදිරිපත් කරන්න.\n\n` +
                  `✨ *Thank you for trusting ${shopDetails.name}!*`;
        }

        // 1-SHOT DIRECT DISPATCH: Send directly via POS WhatsApp server
        const sendDirect = async () => {
            try {
                const resp = await fetch(app.getApiUrl('/api/whatsapp/send'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: intlPhone, message: msg })
                });
                const resData = await resp.json().catch(() => ({}));
                return resData;
            } catch (err) {
                console.warn('Direct WhatsApp call failed:', err);
                return { success: false, error: err.message };
            }
        };

        // AUTO-DISPATCH (ZERO-CLICK / 1-SHOT MODE)
        if (options.skipPreview) {
            const gw = app.getMessageSettings();
            if ((gw.channel === 'dialog' || gw.channel === 'notify') && gw.apiKey) {
                try {
                    const resp = await fetch(app.getApiUrl('/api/sms/send'), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            to: intlPhone,
                            message: msg,
                            gatewayConfig: gw
                        })
                    });
                    const resData = await resp.json().catch(() => ({}));
                    if (resData.success) {
                        Swal.fire({
                            toast: true,
                            position: 'top-end',
                            icon: 'success',
                            title: `✉️ Auto SMS sent to +${intlPhone}`,
                            showConfirmButton: false,
                            timer: 2500
                        });
                        return;
                    }
                } catch (smsErr) {
                    console.warn('SMS gateway failed, falling back to WhatsApp auto-launch:', smsErr);
                }
            }

            // Primary: Attempt 1-Shot Native WhatsApp
            const directResult = await sendDirect();
            if (directResult.success) {
                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'success',
                    title: `⚡ WhatsApp note sent to +${intlPhone} (1-Shot)`,
                    showConfirmButton: false,
                    timer: 3000
                });
                return;
            }

            // Fallback to wa.me if server WhatsApp is not linked
            const waUrl = `https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
            window.open(waUrl, '_blank');
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'info',
                title: `📱 Opened WhatsApp Web for +${intlPhone}`,
                showConfirmButton: false,
                timer: 2500
            });
            return;
        }

        // MANUAL CLICK: Show quick preview and 1-Shot / Web buttons
        const isConnected = app.whatsapp?.connected;
        const confirmSend = await Swal.fire({
            title: '<div class="flex items-center justify-center gap-2"><i class="fa-brands fa-whatsapp text-emerald-500 text-2xl"></i> WhatsApp Message Preview</div>',
            html: `
                <div class="text-left space-y-2 text-xs">
                    <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex justify-between items-center">
                        <span class="text-slate-500 font-semibold">To Number:</span>
                        <span class="font-mono font-bold text-emerald-600 text-sm">+${intlPhone}</span>
                    </div>
                    <div class="p-2 rounded-lg ${isConnected ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'} font-semibold text-[11px] flex items-center gap-1.5">
                        <i class="fa-solid ${isConnected ? 'fa-bolt text-emerald-500' : 'fa-triangle-exclamation text-amber-500'}"></i>
                        <span>${isConnected ? 'POS WhatsApp Linked: Message will send directly in 1-Shot!' : 'POS WhatsApp not linked: Will open in WhatsApp Web.'}</span>
                    </div>
                    <div class="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-slate-700 dark:text-slate-200 font-mono text-[11px] whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
${msg}
                    </div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: isConnected 
                ? '<i class="fa-solid fa-bolt mr-1"></i> Send Now (1-Shot)' 
                : '<i class="fa-brands fa-whatsapp mr-1"></i> Open WhatsApp Web',
            cancelButtonText: 'Cancel (අවලංගු කරන්න)',
            confirmButtonColor: '#10b981',
            cancelButtonColor: '#64748b'
        });

        if (confirmSend.isConfirmed) {
            if (isConnected) {
                Swal.showLoading();
                const directRes = await sendDirect();
                if (directRes.success) {
                    Swal.fire({
                        icon: 'success',
                        title: 'Sent Successfully!',
                        text: `Repair note delivered directly to +${intlPhone} via POS WhatsApp.`,
                        timer: 2000,
                        showConfirmButton: false
                    });
                } else {
                    window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, '_blank');
                }
            } else {
                const waUrl = `https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
                window.open(waUrl, '_blank');
            }
        }
    },

    // ──────────────────────────────────────────────
    // WHATSAPP / SMS SALE BILL RECEIPT NOTIFICATION
    // ──────────────────────────────────────────────
    sendSaleWhatsApp: async (saleId, options = {}) => {
        const sale = await db.sales.get(Number(saleId));
        if (!sale) return;

        const shopDetails = {
            name: localStorage.getItem('krishan_pos_shop_name') || "Krishan Communication & Studio",
            address: localStorage.getItem('krishan_pos_shop_address') || "Hatharamanhandiya, Mapalassa, Sooriyawewa",
            phone: localStorage.getItem('krishan_pos_shop_phone') || "076 928 18 80 / 071 759 7335"
        };

        let phone = (sale.customerPhone || '').trim();
        if (!phone) {
            if (options.skipPreview) return;
            const { value: enteredPhone } = await Swal.fire({
                title: '<div class="flex items-center justify-center gap-2"><i class="fa-brands fa-whatsapp text-emerald-500 text-xl"></i> Customer WhatsApp Number</div>',
                text: 'Customer ගේ WhatsApp දුරකථන අංකය ඇතුළත් කරන්න:',
                input: 'tel',
                inputPlaceholder: '07x xxxxxxx',
                showCancelButton: true,
                confirmButtonText: 'Next',
                confirmButtonColor: '#10b981'
            });
            if (!enteredPhone) return;
            phone = enteredPhone.trim();
        }

        let cleanDigits = phone.replace(/[^0-9]/g, '');
        if (cleanDigits.length < 9) return;

        let intlPhone = cleanDigits;
        if (intlPhone.startsWith('0')) intlPhone = '94' + intlPhone.substring(1);
        else if (intlPhone.length === 9) intlPhone = '94' + intlPhone;

        const invoiceNo = `#INV-${String(sale.id).padStart(4, '0')}`;
        const customerName = sale.customerName || 'Customer';
        const dateStr = new Date(sale.date || Date.now()).toLocaleDateString('en-GB') + ' ' + new Date(sale.date || Date.now()).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

        const itemsList = (sale.items || []).map(it => `• ${it.name} x ${it.qty} = LKR ${(it.price * it.qty).toFixed(2)}`).join('\n');
        const total = Number(sale.total || 0).toFixed(2);
        const paid = Number(sale.amountPaid || 0).toFixed(2);

        const msg = `📱 *${shopDetails.name.toUpperCase()}*\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n` +
                    `🧾 *PAYMENT RECEIPT / බිල්පත*\n\n` +
                    `🎫 *Invoice No:* ${invoiceNo}\n` +
                    `👤 *Customer:* ${customerName}\n` +
                    `📅 *Date:* ${dateStr}\n\n` +
                    `🛒 *Items Purchased:*\n${itemsList}\n\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n` +
                    `💵 *Total Amount:* LKR ${total}\n` +
                    `🟢 *Paid Amount:* LKR ${paid}\n` +
                    `━━━━━━━━━━━━━━━━━━━━━\n` +
                    `📍 *ස්ථානය:* ${shopDetails.address}\n` +
                    `📞 *විමසීම්:* ${shopDetails.phone}\n\n` +
                    `✨ *Thank you for your business!*`;

        // AUTO-DISPATCH (1-SHOT / ZERO-CLICK MODE)
        if (options.skipPreview) {
            const sendRes = await app.sendDirectWhatsApp({ phone: intlPhone, message: msg });
            if (sendRes.success) {
                Swal.fire({
                    toast: true,
                    position: 'top-end',
                    icon: 'success',
                    title: `⚡ WhatsApp receipt sent to +${intlPhone} (1-Shot)`,
                    timer: 2500,
                    showConfirmButton: false
                });
                return;
            }

            // Fallback to wa.me if server WhatsApp is not linked
            const waUrl = `https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`;
            window.open(waUrl, '_blank');
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'info',
                title: `📱 Opened WhatsApp Web for +${intlPhone}`,
                timer: 2500,
                showConfirmButton: false
            });
            return;
        }

        const isConnected = app.whatsapp?.connected;
        const confirmSend = await Swal.fire({
            title: '<div class="flex items-center justify-center gap-2"><i class="fa-brands fa-whatsapp text-emerald-500 text-xl"></i> WhatsApp Receipt</div>',
            html: `
                <div class="text-left space-y-2 text-xs">
                    <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex justify-between items-center">
                        <span class="text-slate-500 font-semibold">To Number:</span>
                        <span class="font-mono font-bold text-emerald-600 text-sm">+${intlPhone}</span>
                    </div>
                    <div class="p-2 rounded-lg ${isConnected ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300' : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'} font-semibold text-[11px] flex items-center gap-1.5">
                        <i class="fa-solid ${isConnected ? 'fa-bolt text-emerald-500' : 'fa-triangle-exclamation text-amber-500'}"></i>
                        <span>${isConnected ? 'POS WhatsApp Linked: Message will send directly in 1-Shot!' : 'POS WhatsApp not linked: Will open in WhatsApp Web.'}</span>
                    </div>
                    <div class="p-3 rounded-xl bg-emerald-50/70 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-slate-700 dark:text-slate-200 font-mono text-[11px] whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed">
${msg}
                    </div>
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: isConnected 
                ? '<i class="fa-solid fa-bolt mr-1"></i> Send Now (1-Shot)' 
                : '<i class="fa-brands fa-whatsapp mr-1"></i> Open WhatsApp Web',
            cancelButtonText: 'Cancel (අවලංගු කරන්න)',
            confirmButtonColor: '#10b981',
            cancelButtonColor: '#64748b'
        });

        if (confirmSend.isConfirmed) {
            if (isConnected) {
                Swal.showLoading();
                const sendRes = await app.sendDirectWhatsApp({ phone: intlPhone, message: msg });
                if (sendRes.success) {
                    Swal.fire({
                        icon: 'success',
                        title: 'Sent Successfully!',
                        text: `Receipt delivered directly to customer (+${intlPhone}) via POS WhatsApp.`,
                        timer: 2000,
                        showConfirmButton: false
                    });
                } else {
                    window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, '_blank');
                }
            } else {
                window.open(`https://wa.me/${intlPhone}?text=${encodeURIComponent(msg)}`, '_blank');
            }
        }
    },

    // ──────────────────────────────────────────────
    // CUSTOMER SERVICE SLIP & REPAIR PRINTING
    // ──────────────────────────────────────────────

    // Dedicated Service Slip (Basic 80mm Thermal Receipt - Big Fault & Big Slip No)
    printServiceSlip: async (repairId = null, options = {}) => {
        return app.printThermalReceipt(repairId, options);
    },

    // ──────────────────────────────────────────────
    // 80MM BASIC THERMAL SERVICE SLIP
    // ──────────────────────────────────────────────
    printThermalReceipt: async (repairId = null, options = {}) => {
        let job = null;
        if (repairId) {
            job = await db.repairs.get(Number(repairId));
        }

        const isBlank = !job || Boolean(options && options.isBlank);
        const twoUp = Boolean(options && options.twoUp);

        const shopDetails = {
            name: localStorage.getItem('krishan_pos_shop_name') || "Krishan Communication & Studio",
            sub: "Mobile Phone & Electronics Repairing Center",
            address: localStorage.getItem('krishan_pos_shop_address') || "Hatharamanhandiya, Mapalassa, Sooriyawewa",
            phone: localStorage.getItem('krishan_pos_shop_phone') || "076 928 18 80 / 071 759 7335",
            email: localStorage.getItem('krishan_pos_shop_email') || "krishanpos@gmail.com"
        };

        const tokenNo = (!isBlank && job) ? `#REP-${String(job.id).padStart(4, '0')}` : 'REP-______';
        const barcodeVal = (!isBlank && job) ? `REP-${String(job.id).padStart(4, '0')}` : '';
        const dateObj = (!isBlank && job) ? new Date(job.createdAt || Date.now()) : new Date();
        const formattedDate = (!isBlank && job) ? dateObj.toLocaleDateString('en-GB') : '____ / ____ / 202__';
        const formattedTime = (!isBlank && job) ? dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '____ : ____';

        const rawPhone = shopDetails.phone.replace(/[^0-9]/g, '');
        const displayPhone = rawPhone.length >= 10 
            ? `${rawPhone.slice(0, 3)} ${rawPhone.slice(3, 6)} ${rawPhone.slice(6, 8)} ${rawPhone.slice(8, 10)}`
            : "076 928 18 80";

        const printWindow = window.open('', '_blank', 'width=460,height=850');
        if (!printWindow) {
            Swal.fire('Popup Blocked', 'Please allow popups in your browser to print receipts.', 'warning');
            return;
        }

        const renderSingleThermalSlip = (copyTitle = '') => `
            <div class="thermal-slip">
                ${copyTitle ? `<div class="copy-tag">[ ${copyTitle} ]</div>` : ''}

                <!-- STORE HEADER -->
                <div class="store-hdr">
                    <div class="store-name">${shopDetails.name}</div>
                    <div class="store-sub">Mobile Repairing &amp; Studio</div>
                    <div class="store-addr">${shopDetails.address}</div>
                    <div class="store-tel">Tel: ${shopDetails.phone}</div>
                </div>

                <!-- HUGE SLIP / BILL NUMBER (LOKUWATAMA) -->
                <div class="slip-no-wrap">
                    <div class="slip-no-lbl">SERVICE SLIP NO (අංකය)</div>
                    <div class="slip-no-giant">${tokenNo}</div>
                </div>

                <!-- DATE & TIME -->
                <div class="meta-row">
                    <span>DATE: ${formattedDate}</span>
                    <span>TIME: ${formattedTime}</span>
                </div>

                <div class="line-dashed"></div>

                <!-- CUSTOMER & DEVICE DETAILS -->
                <div class="info-row">
                    <span class="info-lbl">CUSTOMER:</span>
                    <span class="info-val">${(!isBlank && job) ? (job.customerName || 'WALK-IN') : '................................'}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">CONTACT:</span>
                    <span class="info-val" style="font-family: monospace;">${(!isBlank && job) ? (job.contact || 'N/A') : '................................'}</span>
                </div>
                <div class="info-row">
                    <span class="info-lbl">DEVICE:</span>
                    <span class="info-val device-text">${(!isBlank && job) ? (job.phoneModel || 'N/A') : '................................'}</span>
                </div>

                <div class="line-thick"></div>

                <!-- NOTICE & WHATSAPP -->
                <div class="footer-note">
                    <div class="wa-bold">WhatsApp: ${displayPhone}</div>
                    <div class="collect-msg">* භාණ්ඩය ලබා ගැනීමට මෙම බිල්පත ඉදිරිපත් කරන්න *</div>
                    <div style="font-size: 9.5px; font-weight: 700; color: #333; margin-top: 1px;">Please present this slip when collecting device</div>
                    <div class="thank-you">Thank You! Krishan Communication</div>
                </div>

                ${(!isBlank && barcodeVal) ? `
                    <div class="barcode-wrap">
                        <svg class="repair-barcode-svg" data-barcode="${barcodeVal}"></svg>
                    </div>
                ` : ''}

                <div style="height: 12px;"></div>
            </div>
        `;

        const receiptHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>80mm Service Slip ${tokenNo}</title>
                <style>
                    * { box-sizing: border-box; margin: 0; padding: 0; }
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                        font-size: 13.5px;
                        font-weight: 900 !important;
                        line-height: 1.25;
                        margin: 0 auto;
                        padding: 8px 8px 24px 8px;
                        width: 78mm;
                        max-width: 80mm;
                        color: #000000 !important;
                        background: #ffffff;
                        -webkit-print-color-adjust: exact;
                        print-color-adjust: exact;
                    }
                    @page {
                        margin: 0;
                        size: 80mm auto;
                    }
                    @media print {
                        body {
                            margin: 0 auto;
                            padding: 4px 6px 16px 6px;
                            width: 78mm;
                        }
                        .no-print {
                            display: none !important;
                        }
                    }

                    .line-dashed {
                        border-top: 1.5px dashed #000;
                        margin: 6px 0;
                    }
                    .line-thick {
                        border-top: 2.5px solid #000;
                        margin: 6px 0;
                    }

                    /* Store Header */
                    .store-hdr {
                        text-align: center;
                        padding-bottom: 2px;
                    }
                    .store-name {
                        font-size: 17px;
                        font-weight: 900 !important;
                        text-transform: uppercase;
                        letter-spacing: -0.3px;
                        line-height: 1.15;
                    }
                    .store-sub {
                        font-size: 11px;
                        font-weight: 900 !important;
                        text-transform: uppercase;
                        margin-top: 2px;
                    }
                    .store-addr {
                        font-size: 11px;
                        font-weight: 700 !important;
                        margin-top: 1px;
                    }
                    .store-tel {
                        font-size: 12px;
                        font-weight: 900 !important;
                        margin-top: 2px;
                    }

                    /* SUPER HUGE SLIP / BILL NUMBER (LOKUWATAMA) */
                    .slip-no-wrap {
                        border: 3px solid #000;
                        background: #000;
                        color: #fff !important;
                        text-align: center;
                        padding: 6px 2px;
                        margin: 8px 0;
                        border-radius: 4px;
                    }
                    .slip-no-lbl {
                        font-size: 11px;
                        font-weight: 900 !important;
                        letter-spacing: 1.5px;
                        color: #fff !important;
                        text-transform: uppercase;
                    }
                    .slip-no-giant {
                        font-size: 40px;
                        font-weight: 900 !important;
                        letter-spacing: 2px;
                        font-family: monospace, monospace;
                        color: #fff !important;
                        line-height: 1.05;
                        margin-top: 2px;
                    }

                    /* Meta Row */
                    .meta-row {
                        display: flex;
                        justify-content: space-between;
                        font-size: 12.5px;
                        font-weight: 900 !important;
                        margin: 3px 0;
                    }

                    /* Customer & Device Rows */
                    .info-row {
                        display: flex;
                        justify-content: space-between;
                        align-items: flex-start;
                        font-size: 14px;
                        font-weight: 900 !important;
                        margin-bottom: 4px;
                    }
                    .info-lbl {
                        width: 85px;
                        font-weight: 900 !important;
                        white-space: nowrap;
                        color: #222;
                    }
                    .info-val {
                        flex: 1;
                        text-align: right;
                        font-weight: 900 !important;
                        word-break: break-word;
                    }
                    .device-text {
                        font-size: 16px;
                        font-weight: 900 !important;
                        text-transform: uppercase;
                    }

                    /* Notice & WhatsApp */
                    .footer-note {
                        text-align: center;
                        font-size: 11px;
                        font-weight: 900 !important;
                        line-height: 1.35;
                        margin-top: 6px;
                    }
                    .wa-bold {
                        font-size: 13.5px;
                        font-weight: 900 !important;
                        margin-bottom: 2px;
                    }
                    .collect-msg {
                        font-size: 10.5px;
                        font-weight: 900 !important;
                    }
                    .thank-you {
                        font-size: 11px;
                        font-weight: 900 !important;
                        margin-top: 3px;
                    }

                    /* Barcode */
                    .barcode-wrap {
                        text-align: center;
                        margin-top: 8px;
                    }
                    .barcode-wrap svg {
                        width: 100%;
                        height: 38px;
                    }

                    .copy-tag {
                        text-align: center;
                        font-size: 12px;
                        font-weight: 900;
                        letter-spacing: 1px;
                        padding: 2px 0;
                        margin-bottom: 4px;
                    }

                    .cut-mark {
                        text-align: center;
                        font-size: 11px;
                        font-weight: 900;
                        letter-spacing: 2px;
                        margin: 10px 0;
                        border-top: 2px dashed #000;
                        padding-top: 6px;
                    }
                </style>
            </head>
            <body>
                <!-- On-Screen Controls -->
                <div class="no-print" style="background: #0f172a; color: #fff; padding: 8px 12px; border-radius: 8px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                    <span style="font-weight: 900; font-size: 12px;">🧾 80mm Thermal Slip</span>
                    <div style="display: flex; gap: 6px;">
                        <button onclick="window.print()" style="background: #10b981; color: #fff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 900; font-size: 12px; cursor: pointer;">
                            🖨️ Print
                        </button>
                        <button onclick="window.location.search = '${twoUp ? '' : '?twoUp=1'}'" style="background: #334155; color: #fff; border: none; padding: 6px 10px; border-radius: 6px; font-weight: 900; font-size: 11px; cursor: pointer;">
                            ${twoUp ? '1 Copy' : '2 Copies'}
                        </button>
                    </div>
                </div>

                <!-- Thermal Content -->
                ${twoUp ? `
                    ${renderSingleThermalSlip('CUSTOMER COPY (පාරිභෝගික පිටපත)')}
                    <div class="cut-mark">✂ - - - - - - - - - - - ✂</div>
                    ${renderSingleThermalSlip('SHOP / COUNTER COPY (කවුන්ටර පිටපත)')}
                ` : `
                    ${renderSingleThermalSlip()}
                `}

                ${(!isBlank && barcodeVal) ? `
                    <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"><\/script>
                    <script>
                        window.onload = function() {
                            try {
                                if (typeof JsBarcode !== 'undefined') {
                                    document.querySelectorAll('.repair-barcode-svg').forEach(function(el) {
                                        JsBarcode(el, "${barcodeVal}", {
                                            format: "CODE128",
                                            width: 1.8,
                                            height: 38,
                                            displayValue: true,
                                            fontSize: 12,
                                            fontOptions: "bold",
                                            margin: 0
                                        });
                                    });
                                }
                            } catch(e){}
                            setTimeout(() => {
                                window.print();
                            }, 350);
                        };
                    <\/script>
                ` : `
                    <script>
                        window.onload = function() {
                            setTimeout(() => {
                                window.print();
                            }, 350);
                        };
                    <\/script>
                `}
            </body>
            </html>
        `;

        printWindow.document.open();
        printWindow.document.write(receiptHTML);
        printWindow.document.close();
    },

    // Unified helper
    printRepairReceipt: (repairId, format = 'slip') => {
        if (format === 'thermal') {
            return app.printThermalReceipt(repairId);
        }
        return app.printServiceSlip(repairId);
    },

    // --- REPORTS ---
    renderReports: async (displayDate = new Date().toISOString().split('T')[0]) => {
        // Fetch data
        const sales = await db.sales.where('date').startsWith(displayDate).toArray();
        const expenses = await db.expenses.where('date').startsWith(displayDate).toArray();

        // Calculate Metrics
        let metrics = {
            revenue: 0,
            cogs: 0, // Cost of Goods Sold
            grossProfit: 0,
            expenseTotal: 0,
            netProfit: 0
        };

        sales.forEach(sale => {
            metrics.revenue += sale.total;
            let saleCost = 0;
            if (sale.items && Array.isArray(sale.items)) {
                saleCost = sale.items.reduce((acc, item) => acc + ((item.cost || 0) * item.qty), 0);
            }
            metrics.cogs += saleCost;
        });

        expenses.forEach(exp => metrics.expenseTotal += exp.amount);

        metrics.grossProfit = metrics.revenue - metrics.cogs;
        metrics.netProfit = metrics.grossProfit - metrics.expenseTotal;

        const html = `
             <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 fade-in space-y-8 h-full flex flex-col">
                 <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                     <h2 class="text-2xl font-bold text-slate-800">Financial Reports</h2>
                     <div class="flex items-center gap-2">
                        <label class="text-sm font-medium text-slate-500">Date:</label>
                        <input type="date" value="${displayDate}" onchange="app.renderReports(this.value)" class="border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500">
                     </div>
                 </div>
                 
                 <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
                     <div class="p-4 bg-emerald-50 rounded-xl border border-emerald-100 hover:shadow-md transition-shadow">
                         <p class="text-xs text-emerald-600 font-bold uppercase tracking-wider mb-1">Total Revenue</p>
                         <h3 class="text-2xl font-bold text-emerald-800">LKR ${metrics.revenue.toFixed(2)}</h3>
                         <p class="text-[10px] text-emerald-600 mt-1">${sales.length} Sales</p>
                     </div>
                     <div class="p-4 bg-blue-50 rounded-xl border border-blue-100 hover:shadow-md transition-shadow">
                         <p class="text-xs text-blue-600 font-bold uppercase tracking-wider mb-1">Gross Profit</p>
                         <h3 class="text-2xl font-bold text-blue-800">LKR ${metrics.grossProfit.toFixed(2)}</h3>
                         <p class="text-[10px] text-blue-600 mt-1">Revenue - Cost</p>
                     </div>
                      <div class="p-4 bg-red-50 rounded-xl border border-red-100 hover:shadow-md transition-shadow">
                         <p class="text-xs text-red-600 font-bold uppercase tracking-wider mb-1">Total Expenses</p>
                         <h3 class="text-2xl font-bold text-red-800">LKR ${metrics.expenseTotal.toFixed(2)}</h3>
                         <p class="text-[10px] text-red-600 mt-1">${expenses.length} Records</p>
                     </div>
                      <div class="p-4 bg-indigo-50 rounded-xl border border-indigo-100 hover:shadow-md transition-shadow">
                         <p class="text-xs text-indigo-600 font-bold uppercase tracking-wider mb-1">Net Profit</p>
                         <h3 class="text-2xl font-bold text-indigo-800">LKR ${metrics.netProfit.toFixed(2)}</h3>
                         <p class="text-[10px] text-indigo-600 mt-1">Gross - Expenses</p>
                     </div>
                 </div>

                <div class="flex-1 overflow-y-auto grid grid-cols-1 lg:grid-cols-2 gap-6 pt-4 border-t border-slate-100">
                    <div>
                        <h3 class="text-lg font-bold text-slate-700 mb-4 flex items-center gap-2"><i class="fa-solid fa-receipt text-slate-400"></i> Expenses Log</h3>
                        <div class="overflow-x-auto rounded-lg border border-slate-200">
                             <table class="w-full text-left text-sm">
                                <thead class="bg-slate-50 text-xs uppercase font-bold text-slate-500">
                                    <tr><th class="px-4 py-3">Cat</th><th class="px-4 py-3">Desc</th><th class="px-4 py-3 text-right">Amt</th></tr>
                                </thead>
                                <tbody class="divide-y divide-slate-100 bg-white">
                                    ${expenses.length === 0 ? '<tr><td colspan="3" class="px-4 py-4 text-center text-slate-400 text-xs">No expenses for this date</td></tr>' : ''}
                                    ${expenses.map(e => `
                                        <tr>
                                            <td class="px-4 py-2"><span class="bg-slate-100 px-2 py-0.5 rounded text-[10px] uppercase font-bold text-slate-500">${e.category}</span></td>
                                            <td class="px-4 py-2 text-slate-700">${e.description}</td>
                                            <td class="px-4 py-2 text-right font-bold text-red-600">${e.amount.toFixed(2)}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
    },



    // --- CREDIT BOOK (NAYA POTHA) ---
    renderCredits: async () => {
        const creditors = await db.creditors.toArray();
        const html = `
            <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 fade-in h-full flex flex-col">
                <div class="flex justify-between items-center mb-6">
                    <div>
                        <h2 class="text-2xl font-bold text-slate-800">ණය පොත (Credit Book)</h2>
                        <p class="text-sm text-slate-500">ණයකරුවන් සහ සැපයුම්කරුවන් කළමනාකරණය</p>
                    </div>
                    <button onclick="app.openCreditorModal()" class="bg-violet-600 hover:bg-violet-700 text-white px-6 py-2 rounded-lg font-medium shadow-lg shadow-violet-200 transition-all flex items-center">
                        <i class="fa-solid fa-plus mr-2"></i> අලුත් අයෙක් එක් කරන්න (Add Person)
                    </button>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 overflow-y-auto p-1">
                    ${creditors.length === 0 ?
                `<div class="col-span-full flex flex-col items-center justify-center p-12 text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
                            <i class="fa-solid fa-book text-4xl mb-3 opacity-50"></i>
                            <p>පැහැදිලි වාර්තා නොමැත (No records found).</p>
                        </div>` : ''}
                    
                    ${creditors.map(c => `
                        <div class="bg-white border border-slate-200 rounded-xl p-5 hover:shadow-md transition-shadow relative overflow-hidden group">
                            <div class="absolute top-0 right-0 w-24 h-24 bg-gradient-to-br ${c.amount < 0 ? 'from-green-50 to-emerald-100' : 'from-red-50 to-rose-100'} rounded-bl-full -mr-8 -mt-8 opacity-50"></div>
                            
                            <div class="relative z-10">
                                <h3 class="text-xl font-bold text-slate-800 mb-0.5">${c.name}</h3>
                                <p class="text-[10px] text-violet-600 font-black uppercase tracking-widest mb-4">${c.contact || 'No Contact'}</p>
                                
                                <div class="bg-slate-50 rounded-lg p-4 mb-4 text-center border border-slate-100 shadow-inner">
                                    <p class="text-[10px] text-slate-400 font-black uppercase mb-1 tracking-tighter">වත්මන් ශේෂය (Current Balance)</p>
                                    <p class="text-2xl font-black ${c.amount < 0 ? 'text-emerald-600' : 'text-red-600'}">
                                        LKR ${Math.abs(c.amount).toFixed(2)}
                                        <span class="text-[10px] font-bold block mt-1 uppercase tracking-widest opacity-80">
                                            ${c.amount < 0 ? 'සැපයුම්කරුට ගෙවිය යුතුයි (To Pay)' : 'අපට ලැබිය යුතුයි (To Collect)'}
                                        </span>
                                    </p>
                                </div>

                                <div class="grid grid-cols-2 gap-3">
                                    <button onclick="app.updateCreditorAmount(${c.id}, -1)" class="py-2.5 px-3 bg-emerald-600 text-white hover:bg-emerald-700 rounded-xl text-xs font-black transition-all shadow-md flex flex-col items-center justify-center gap-1">
                                        <i class="fa-solid fa-hand-holding-dollar text-lg"></i>
                                        <span>මුදල් ලැබුණා (Paid)</span>
                                    </button>
                                    <button onclick="app.updateCreditorAmount(${c.id}, 1)" class="py-2.5 px-3 bg-red-600 text-white hover:bg-red-700 rounded-xl text-xs font-black transition-all shadow-md flex flex-col items-center justify-center gap-1">
                                        <i class="fa-solid fa-file-invoice text-lg"></i>
                                        <span>ණයට ගත්තා (Credit)</span>
                                    </button>
                                </div>
                                <div class="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button onclick="app.deleteCreditor(${c.id})" class="text-slate-300 hover:text-red-500 transition-colors"><i class="fa-solid fa-trash"></i></button>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
    },

    openCreditorModal: async (defaultType = 'receivable') => {
        const { value: formValues } = await Swal.fire({
            title: defaultType === 'receivable' ? 'නව ගනුදෙනුකරුවෙකු ලියාපදිංචි කිරීම' : 'නව ණය වාර්තාවක්',
            html: `
                <div class="space-y-4 text-left">
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">නම (Name)</label>
                        <input id="cred-name" class="swal2-input m-0 w-full" placeholder="e.g. Kamal Perera">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">දුරකථන අංකය (Contact Number)</label>
                        <input id="cred-contact" class="swal2-input m-0 w-full" placeholder="07x xxxxxxx">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">ආරම්භක ශේෂය (Initial Amount - LKR)</label>
                        <input id="cred-amount" type="number" class="swal2-input m-0 w-full" placeholder="0.00" value="0">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-slate-500 mb-1">වර්ගය (Record Type)</label>
                        <select id="cred-type" class="swal2-input m-0 w-full">
                            <option value="receivable" ${defaultType === 'receivable' ? 'selected' : ''}>අපට ලැබිය යුතු (Customer / Debtor)</option>
                            <option value="payable" ${defaultType === 'payable' ? 'selected' : ''}>අප ගෙවිය යුතු (Supplier / Creditor)</option>
                        </select>
                    </div>
                </div>
            `,
            focusConfirm: false,
            showCancelButton: true,
            confirmButtonText: 'වාර්තාව සුරකින්න (Save Record)',
            confirmButtonColor: '#7c3aed',
            preConfirm: () => {
                const name = document.getElementById('cred-name').value;
                const contact = document.getElementById('cred-contact').value;
                let amount = parseFloat(document.getElementById('cred-amount').value) || 0;
                const type = document.getElementById('cred-type').value;

                if (type === 'payable') amount = -Math.abs(amount);
                else amount = Math.abs(amount);

                if (!name) {
                    Swal.showValidationMessage('නම ඇතුළත් කිරීම අනිවාර්යයි');
                    return false;
                }
                return { name, contact, amount, type, lastUpdated: new Date().toISOString() };
            }
        });

        if (formValues) {
            const newId = await db.creditors.add(formValues);
            app.apiCall('/api/creditors', 'POST', { id: newId, ...formValues }, 'create_creditor');
            
            // Re-render current view
            const activeNav = document.querySelector('nav a.bg-violet-600')?.innerText?.toLowerCase() || '';
            if (activeNav.includes('pos')) {
                app.renderPOS();
            } else {
                app.renderCredits();
            }
            
            Swal.fire({ icon: 'success', title: 'Record Added', timer: 1000, showConfirmButton: false });
        }
    },

    updateCreditorAmount: async (id, multiplier) => {
        const creditor = await db.creditors.get(id);
        const isDebtor = creditor.amount >= 0; // True if they owe us (Customer)
        
        let title = '';
        if (multiplier > 0) {
            title = isDebtor ? 'ණයට ලබාදීම (Add New Debt)' : 'ණය ගැනීම වැඩි කිරීම (Increase Payable)';
        } else {
            title = isDebtor ? 'මුදල් ලැබීම / පියවීම (Record Payment)' : 'ණය පියවීම (Settle Payable)';
        }

        const { value: amount } = await Swal.fire({
            title: title,
            html: `
                <div class="text-left mb-2">
                    <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest pl-1">මුදල (Amount in LKR)</label>
                    <input id="swal-amount" type="number" class="swal2-input !mt-1 !w-full" placeholder="0.00">
                </div>
            `,
            showCancelButton: true,
            confirmButtonText: 'Record Update',
            confirmButtonColor: multiplier > 0 ? '#dc2626' : '#059669',
            preConfirm: () => {
                const val = parseFloat(document.getElementById('swal-amount').value);
                if (!val || val <= 0) {
                    Swal.showValidationMessage('Please enter a valid amount');
                    return false;
                }
                return val;
            }
        });

        if (amount) {
            const numericAmount = parseFloat(amount);
            let newAmount = creditor.amount;

            if (multiplier > 0) { // Increase debt/payable
                if (isDebtor) newAmount += numericAmount; // They owe us more
                else newAmount -= numericAmount; // we owe supplier more (more negative)
            } else { // Settle/Pay
                if (isDebtor) newAmount -= numericAmount; // They paid us (debt decreases)
                else newAmount += numericAmount; // we paid supplier (debt decreases)
            }

            const updatedObj = { amount: newAmount, lastUpdated: new Date().toISOString() };
            await db.creditors.update(id, updatedObj);
            const fullUpdated = await db.creditors.get(id);
            app.apiCall(`/api/creditors/${id}`, 'PUT', fullUpdated, 'update_creditor', id);

            app.renderCredits();
            Swal.fire({ icon: 'success', title: 'ශේෂය යාවත්කාලීන කරන ලදී (Balance Updated)', timer: 1500, showConfirmButton: false, toast: true, position: 'top-end' });
        }
    },

    deleteCreditor: async (id) => {
        if ((await Swal.fire({ title: 'Are you sure?', icon: 'warning', showCancelButton: true })).isConfirmed) {
            await db.creditors.delete(id);
            app.apiCall(`/api/creditors/${id}`, 'DELETE', null, 'delete_creditor', id);
            app.renderCredits();
        }
    },

    openExpenseModal: async () => {
        const { value: formValues } = await Swal.fire({
            title: 'Log Expense',
            html: `
                <div class="space-y-3 text-left">
                    <input id="exp-desc" class="swal2-input m-0 w-full" placeholder="Description (e.g. Electricity Bill)">
                    <input id="exp-cat" class="swal2-input m-0 w-full" list="exp-cats" placeholder="Category">
                    <datalist id="exp-cats">
                        <option value="Utilities">
                        <option value="Rent">
                        <option value="Supplies">
                        <option value="Salary">
                    </datalist>
                    <input id="exp-amount" type="number" class="swal2-input m-0 w-full" placeholder="Amount">
                </div>
            `,
            showCancelButton: true,
            preConfirm: () => {
                return {
                    description: document.getElementById('exp-desc').value,
                    category: document.getElementById('exp-cat').value,
                    amount: parseFloat(document.getElementById('exp-amount').value) || 0,
                    date: new Date().toISOString()
                }
            }
        });

        if (formValues) {
            const newId = await db.expenses.add(formValues);
            app.apiCall('/api/expenses', 'POST', { id: newId, ...formValues }, 'create_expense');
            Swal.fire({ icon: 'success', title: 'Expense Added', timer: 1000, showConfirmButton: false });
        }
    },

    deleteExpense: async (id) => {
        if ((await Swal.fire({ title: 'Delete expense?', icon: 'warning', showCancelButton: true })).isConfirmed) {
            await db.expenses.delete(id);
            app.apiCall(`/api/expenses/${id}`, 'DELETE', null, 'delete_expense', id);
            app.renderExpenses();
        }
    },

    // --- SALES HISTORY ---
    renderSalesHistory: async () => {
        const sales = await db.sales.orderBy('date').reverse().toArray();
        const html = `
             <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 fade-in">
                 <h2 class="text-2xl font-bold text-slate-800 mb-6">Sales History</h2>
                 <div class="overflow-x-auto">
                    <table class="w-full text-left text-sm">
                        <thead class="bg-slate-50 text-xs uppercase font-bold text-slate-500">
                            <tr>
                                <th class="px-6 py-4">Date</th>
                                <th class="px-6 py-4">Receipt ID</th>
                                <th class="px-6 py-4">Items</th>
                                <th class="px-6 py-4">Payment</th>
                                <th class="px-6 py-4 text-right">Total</th>
                                <th class="px-6 py-4 text-center">Action</th>
                            </tr>
                        </thead>
                         <tbody class="divide-y divide-slate-100">
                             ${sales.map(s => `
                                <tr class="hover:bg-slate-50">
                                    <td class="px-6 py-4">${new Date(s.date).toLocaleString()}</td>
                                    <td class="px-6 py-4 text-slate-400">#${s.id}</td>
                                    <td class="px-6 py-4 text-xs text-slate-600">${s.items.map(i => `${i.qty}x ${i.name}`).join(', ')}</td>
                                    <td class="px-6 py-4 badge"><span class="bg-slate-100 px-2 py-1 rounded text-xs">${s.paymentMethod}</span></td>
                                    <td class="px-6 py-4 text-right font-bold text-emerald-600">LKR ${s.total.toFixed(2)}</td>
                                    <td class="px-6 py-4 text-center">
                                        <button onclick="app.printReceipt(${s.id})" class="text-violet-600 hover:text-violet-800 transition-colors p-2" title="Print Receipt">
                                            <i class="fa-solid fa-print"></i>
                                        </button>
                                    </td>
                                </tr>
                             `).join('')}
                         </tbody>
                    </table>
                 </div>
             </div>
        `;
    document.getElementById('app-content').innerHTML = html;
},

    // --- REPORTING ACTIONS ---
    renderExpenses: async () => {
        // Just reusing reports for now or a specific expense view
        // Let's redirect to reports as they contain expenses
        app.renderReports();
    },

        // --- UTILITY BILLS ---
    renderUtilityBills: async () => {
        const html = `
            <div class="max-w-4xl mx-auto fade-in">
                <div class="bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
                    <div class="bg-gradient-to-r from-emerald-600 to-teal-600 p-8 text-white">
                        <h2 class="text-3xl font-black mb-2 flex items-center gap-3">
                            <i class="fa-solid fa-bolt-lightning"></i> Utility Bill Payment
                        </h2>
                        <p class="text-emerald-50 text-sm opacity-90">Pay Electricity (CEB), Water (NWSDB) or Telecom bills instantly.</p>
                    </div>

                    <div class="p-10">
                        <div class="mb-10">
                            <label class="block text-sm font-black text-slate-700 mb-6 uppercase tracking-widest text-center">Tap to Add a Bill</label>
                            <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
                                <button onclick="app.addUtilityRow('CEB')" class="p-8 border-2 border-slate-100 rounded-[2rem] flex flex-col items-center gap-4 hover:border-yellow-400 hover:bg-yellow-50 hover:shadow-lg transition-all font-black text-slate-700 group overflow-hidden">
                                    <img src="http://slcgdxb.com/wp-content/uploads/2021/07/CEB-Logo.jpg" class="w-24 h-24 object-contain rounded-lg group-hover:scale-125 transition-transform transform scale-110">
                                    <span class="text-xl">CEB</span>
                                </button>
                                <button onclick="app.addUtilityRow('Water')" class="p-8 border-2 border-slate-100 rounded-[2rem] flex flex-col items-center gap-4 hover:border-blue-400 hover:bg-blue-50 hover:shadow-lg transition-all font-black text-slate-700 group overflow-hidden">
                                    <img src="https://www.waterboard.lk/wp-content/uploads/2022/11/Water-Board-Logo.png" class="w-24 h-24 object-contain rounded-lg group-hover:scale-125 transition-transform transform scale-110">
                                    <span class="text-xl">Water</span>
                                </button>
                                <button onclick="app.addUtilityRow('Walawa')" class="p-8 border-2 border-slate-100 rounded-[2rem] flex flex-col items-center gap-4 hover:border-orange-400 hover:bg-orange-50 hover:shadow-lg transition-all font-black text-slate-700 group">
                                    <i class="fa-solid fa-seedling text-5xl text-orange-500 group-hover:scale-110 transition-transform"></i>
                                    <span class="text-lg text-center leading-tight">Walawa<br>CBO</span>
                                </button>
                                <button onclick="app.addUtilityRow('Other')" class="p-8 border-2 border-slate-100 rounded-[2rem] flex flex-col items-center gap-4 hover:border-slate-400 hover:bg-slate-50 hover:shadow-lg transition-all font-black text-slate-700 group">
                                    <i class="fa-solid fa-plus text-5xl text-slate-400 group-hover:scale-110 transition-transform"></i>
                                    <span class="text-lg">Other</span>
                                </button>
                            </div>
                        </div>

                        <div id="utility-rows-container" class="space-y-4">
                            <!-- Rows will be added here -->
                        </div>

                        <div id="utility-link-container" class="mt-8 hidden">
                             <label class="block text-sm font-bold text-slate-700 mb-2 uppercase tracking-wide">Official Payment Portal</label>
                             <a id="utility-official-link" href="#" target="_blank" class="flex items-center justify-between p-4 bg-blue-50 text-blue-700 rounded-2xl border border-blue-100 hover:bg-blue-100 transition-all group max-w-md">
                                <div class="flex items-center gap-3">
                                    <i class="fa-solid fa-earth-americas text-xl"></i>
                                    <span class="font-bold text-sm">Pay on Official Site</span>
                                </div>
                                <i class="fa-solid fa-arrow-up-right-from-square opacity-50 group-hover:opacity-100 transition-opacity"></i>
                             </a>
                        </div>

                        <div class="mt-10 flex justify-end gap-4 border-t border-slate-100 pt-8">
                             <button onclick="app.navigate('dashboard')" class="px-8 py-4 bg-slate-100 text-slate-600 font-bold border border-slate-200 rounded-2xl hover:bg-slate-200 transition-all">Cancel</button>
                             <button onclick="app.processUtilityPayment()" class="px-10 py-4 bg-emerald-600 text-white font-black rounded-2xl shadow-xl shadow-emerald-200 hover:bg-emerald-700 transform hover:scale-105 active:scale-95 transition-all flex items-center gap-3 text-lg">
                                <i class="fa-solid fa-print"></i> Process & Print Receipt
                             </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('app-content').innerHTML = html;
        // Start with one CEB row
        app.addUtilityRow('CEB');
    },

    addUtilityRow: (type = 'CEB') => {
        const container = document.getElementById('utility-rows-container');
        const row = document.createElement('div');
        
        const typeIcons = {
            'CEB': '<img src="http://slcgdxb.com/wp-content/uploads/2021/07/CEB-Logo.jpg" class="w-14 h-14 object-contain rounded-md transform scale-125">',
            'Water': '<img src="https://www.waterboard.lk/wp-content/uploads/2022/11/Water-Board-Logo.png" class="w-14 h-14 object-contain rounded-md transform scale-125">',
            'Walawa': '<i class="fa-solid fa-seedling text-orange-500 text-3xl"></i>',
            'Other': '<i class="fa-solid fa-plus text-slate-400 text-3xl"></i>'
        };

        row.className = 'utility-row grid grid-cols-1 md:grid-cols-12 gap-3 bg-white p-5 rounded-2xl border border-slate-200 relative shadow-sm fade-in mb-4';
        row.innerHTML = `
            <div class="md:col-span-1 flex items-center justify-center">
                ${typeIcons[type]}
                <input type="hidden" class="util-type" value="${type}">
            </div>
            <div class="md:col-span-3">
                <label class="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest">Account No.</label>
                <input type="text" class="util-acc w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 font-bold" placeholder="Acc. No">
            </div>
            <div class="md:col-span-3">
                <label class="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest">Reference No.</label>
                <input type="text" class="util-ref w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500" placeholder="Ref. No">
            </div>
            ${type === 'Other' ? `
            <div class="md:col-span-2">
                <label class="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest">Bill Name</label>
                <input type="text" class="util-other-name w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500" placeholder="Bill Name">
            </div>
            ` : ''}
            <div class="md:col-span-2">
                <label class="block text-[10px] font-bold text-slate-400 mb-1 uppercase tracking-widest">Amount</label>
                <input type="number" class="util-amount w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 font-bold text-emerald-600" placeholder="0.00" oninput="app.updateRowServiceCharge(this)">
                <span class="util-charge-label text-[10px] font-extrabold text-slate-400 block mt-1 tracking-tight">Charge: LKR 0.00</span>
            </div>
            <div class="md:col-span-1 flex items-end justify-center pb-1">
                <button onclick="this.closest('.utility-row').remove(); app.checkUtilityLinks();" class="p-2.5 text-red-300 hover:text-red-500 transition-colors">
                    <i class="fa-solid fa-xmark text-lg"></i>
                </button>
            </div>
        `;
        container.appendChild(row);
        app.checkUtilityLinks();
    },

    checkUtilityLinks: () => {
        const types = Array.from(document.querySelectorAll('.util-type')).map(i => i.value);
        const linkContainer = document.getElementById('utility-link-container');
        const linkElem = document.getElementById('utility-official-link');
        const linkText = linkElem.querySelector('span');

        if (types.includes('CEB')) {
            linkContainer.classList.remove('hidden');
            linkElem.href = 'https://payment.ceb.lk//instantpay';
            linkText.innerText = 'Pay on CEB Official Site';
        } else if (types.includes('Water')) {
            linkContainer.classList.remove('hidden');
            linkElem.href = 'https://www.waterboard.lk/web/index.php?option=com_content&view=article&id=115&Itemid=158&lang=en';
            linkText.innerText = 'Pay on Water Board Portal';
        } else {
            linkContainer.classList.add('hidden');
        }
    },

    updateRowServiceCharge: (input) => {
        const row = input.closest('.utility-row');
        const amount = parseFloat(input.value);
        const label = row.querySelector('.util-charge-label');
        if (label) {
            const charge = app.calculateUtilityServiceCharge(amount);
            label.textContent = `Charge: LKR ${charge.toFixed(2)}`;
        }
    },

    calculateUtilityServiceCharge: (amount) => {
        if (isNaN(amount) || amount <= 0) return 0;
        if (amount <= 5000) return 30;
        if (amount <= 15000) return 40;
        return 50;
    },

    processUtilityPayment: async () => {
        const rows = document.querySelectorAll('.utility-row');
        let saleItems = [];
        let totalBillAmount = 0;
        let totalServiceCharge = 0;

        for (const row of rows) {
            const type = row.querySelector('.util-type').value;
            const accNo = row.querySelector('.util-acc').value;
            const refNo = row.querySelector('.util-ref').value;
            const billAmount = parseFloat(row.querySelector('.util-amount').value);
            const otherName = row.querySelector('.util-other-name')?.value || '';
            
            if (!accNo || isNaN(billAmount) || billAmount <= 0) {
                Swal.fire({ icon: 'error', title: 'Invalid Entry', text: 'Please enter Account Number and Amount.' });
                return;
            }

            const serviceChargePerBill = app.calculateUtilityServiceCharge(billAmount);

            saleItems.push({
                name: type === 'Other' ? (otherName || 'Utility Bill') : `${type} Bill Payment`,
                qty: 1,
                price: billAmount + serviceChargePerBill,
                cost: billAmount,
                type: 'service',
                utilityType: type,
                otherName: otherName,
                accNo: accNo,
                ref: refNo, // Storing reference as well
                billAmount: billAmount,
                serviceCharge: serviceChargePerBill
            });

            totalBillAmount += billAmount;
            totalServiceCharge += serviceChargePerBill;
        }

        const totalToPay = totalBillAmount + totalServiceCharge;

        const confirm = await Swal.fire({
            title: `Confirm ${rows.length} Payment(s)?`,
            html: `<div class="text-left space-y-2 p-2 bg-slate-50 rounded-xl border border-slate-100">
                <p><strong>Total Bills:</strong> ${rows.length}</p>
                <div class="border-t border-slate-200 mt-2 pt-2 space-y-1">
                    <p class="flex justify-between text-sm"><span>Total Bill Amount:</span> <span>LKR ${totalBillAmount.toFixed(2)}</span></p>
                    <p class="flex justify-between text-sm"><span>Total Service Charge:</span> <span>LKR ${totalServiceCharge.toFixed(2)}</span></p>
                    <p class="flex justify-between text-lg font-black text-emerald-700 border-t border-slate-200 pt-2"><span>Grand Total:</span> <span>LKR ${totalToPay.toFixed(2)}</span></p>
                </div>
            </div>`,
            icon: 'info',
            showCancelButton: true,
            confirmButtonText: 'Confirm & Pay',
            confirmButtonColor: '#059669'
        });

        if (confirm.isConfirmed) {
            const saleRecord = {
                date: new Date().toISOString(),
                items: saleItems,
                subTotal: totalToPay,
                discount: 0,
                total: totalToPay,
                paymentMethod: 'Cash',
                isUtility: true
            };
            const saleId = await db.sales.add(saleRecord);
            app.apiCall('/api/sales', 'POST', { id: saleId, ...saleRecord }, 'create_sale');

            await Swal.fire({ icon: 'success', title: 'Payments Successful', timer: 1500, showConfirmButton: false });
            app.printReceipt(saleId);
            app.navigate('dashboard');
        }
    },

    filterTable: (tableId, query) => {
            const rows = document.querySelectorAll(`#${tableId} tbody tr`);
            rows.forEach(row => {
                const text = row.innerText.toLowerCase();
                row.style.display = text.includes(query.toLowerCase()) ? '' : 'none';
            });
        },

    exportData: async () => {
        try {
            const data = {
                items: await db.items.toArray(),
                sales: await db.sales.toArray(),
                repairs: await db.repairs.toArray(),
                expenses: await db.expenses.toArray(),
                creditors: await db.creditors.toArray(),
                bankTransactions: await db.bankTransactions.toArray(),
                suppliers: await db.suppliers.toArray(),
                purchaseBills: await db.purchaseBills.toArray(),
                exportedAt: new Date().toISOString()
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `krishan-pos-backup-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            Swal.fire({
                toast: true,
                position: 'top-end',
                icon: 'success',
                title: 'Database backup downloaded successfully!',
                timer: 2000,
                showConfirmButton: false
            });
        } catch (e) {
            Swal.fire('Export Error', e.message, 'error');
        }
    },

    printReceipt: async (saleId) => {
        const sale = await db.sales.get(saleId);
        if (!sale) return;

        const shopDetails = {
            name: "Krishan Communication & Studio",
            address: "Hatharamanhandiya, Mapalassa, Sooriyawewa",
            phone: "076 928 1880 / 071 759 7335",
            email: "krishanpos@gmail.com",
            logo: "krishan_pos_logo_1775302997348.png"
        };

        const typeNames = {
            'CEB': 'ලංකා විදුලිබල මණ්ඩලය',
            'Water': 'ජාතික ජලසම්පාදන හා ජලාපවහන මණ්ඩලය',
            'Walawa': 'ඒකාබද්ධ වලව මව් නදී ප්‍රජාමූල සංවිධානය',
            'Other': 'වෙනත් බිල්පත් ගෙවීම්'
        };

        const saleDisplayName = sale.isUtility ? typeNames[sale.items[0].utilityType] || sale.items[0].utilityType : shopDetails.name;

        const printWindow = window.open('', '_blank', 'width=450,height=800');
        const itemsHTML = sale.items.map(item => `
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;font-size:15px;">
                <div style="flex:1;padding-right:4px;">
                    <div style="font-weight:600;line-height:1.15;">${item.name}</div>
                    <div style="font-size:12px;font-weight:500;">${item.qty} x LKR ${item.price.toFixed(2)}</div>
                </div>
                <div style="font-weight:600;align-self:flex-end;white-space:nowrap;">LKR ${(item.qty*item.price).toFixed(2)}</div>
            </div>
        `).join('');

        const receiptHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Bill #${saleId}</title>
                <style>
                    *{box-sizing:border-box;margin:0;padding:0;}
                    body{
                        font-family:system-ui,-apple-system,sans-serif;
                        font-size:15px;
                        line-height:1.15;
                        margin:0 auto;
                        padding:2px 5px;
                        width:80mm;
                        color:#000;
                        font-weight:400;
                    }
                    .sep{border-top:1.5px dashed #000;margin:3px 0;}
                    .gtotal{
                        font-size:20px;
                        font-weight:700;
                        border-top:2px solid #000;
                        border-bottom:3px double #000;
                        padding:3px 0;
                        display:flex;
                        justify-content:space-between;
                    }
                    .ubox{border:1.5px solid #000;padding:4px 6px;margin-bottom:3px;font-size:14px;font-weight:500;}
                    @page{margin:0;}
                    @media print{body{margin:0;padding:2px 3px;width:100%;}}
                </style>
            </head>
            <body>
                <!-- HEADER -->
                <div style="text-align:center;margin-bottom:2px;">
                    <div style="font-size:18px;font-weight:700;text-transform:uppercase;line-height:1.1;">${shopDetails.name}</div>
                    <div style="font-size:11px;font-weight:500;">Tel: ${shopDetails.phone}</div>
                </div>

                <div class="sep"></div>

                <!-- TITLE + META in one block -->
                <div style="font-size:13px;font-weight:500;">
                    <div style="text-align:center;font-size:14px;font-weight:700;text-transform:uppercase;">${sale.isUtility ? saleDisplayName : 'RECEIPT / INVOICE'}</div>
                    <div style="display:flex;justify-content:space-between;">
                        <span>#${saleId}</span>
                        <span>${new Date(sale.date).toLocaleDateString()} ${new Date(sale.date).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>
                        <span>${sale.paymentMethod.toUpperCase()}</span>
                    </div>
                </div>

                <div class="sep"></div>

                <!-- UTILITY BILLS -->
                ${sale.isUtility ? sale.items.map(i => `
                <div class="ubox">
                    <div style="font-weight:700;text-decoration:underline;font-size:13px;">UTILITY PAYMENT</div>
                    <div>Type: ${i.utilityType === 'Other' ? (i.otherName||'Utility Bill') : (typeNames[i.utilityType]||i.utilityType)}</div>
                    <div>Acc: ${i.accNo}</div>
                    ${i.ref ? `<div>Ref: ${i.ref}</div>` : ''}
                    <div class="sep" style="margin:3px 0;"></div>
                    <div style="display:flex;justify-content:space-between;"><span>Bill Amt:</span><span>LKR ${i.billAmount.toFixed(2)}</span></div>
                    <div style="display:flex;justify-content:space-between;"><span>Charge:</span><span>LKR ${i.serviceCharge.toFixed(2)}</span></div>
                </div>
                `).join('') : ''}

                <!-- ITEMS -->
                <div>${itemsHTML}</div>

                <div class="sep"></div>

                <!-- TOTALS -->
                <div style="font-weight:500;">
                    ${sale.discount > 0 ? `
                    <div style="display:flex;justify-content:space-between;font-size:14px;"><span>SUBTOTAL:</span><span>LKR ${sale.subTotal.toFixed(2)}</span></div>
                    <div style="display:flex;justify-content:space-between;font-size:14px;"><span>DISCOUNT:</span><span>- LKR ${sale.discount.toFixed(2)}</span></div>
                    ` : ''}
                    <div class="gtotal"><span>TOTAL:</span><span>LKR ${sale.total.toFixed(2)}</span></div>
                </div>

                <div class="sep"></div>
                <div style="text-align:center;font-size:12px;font-weight:600;">THANK YOU!</div>

                <script>
                    window.onload = () => { 
                        window.print(); 
                    };
                </script>
            </body>
            </html>
        `;

        printWindow.document.write(receiptHTML);
        printWindow.document.close();
    },
};

// Start the app immediately or on DOM ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => app.init());
} else {
    app.init();
}
let html5QrCode;

// කැමරාව පෙන්වීමට
async function showCamera() {
    const cameraSection = document.getElementById('camera-section');
    cameraSection.classList.remove('hidden');

    if (!html5QrCode) {
        html5QrCode = new Html5Qrcode("reader");
    }

    const config = { fps: 15, qrbox: { width: 220, height: 150 } };

    html5QrCode.start({ facingMode: "environment" }, config, (decodedText) => {
        // බාර්කෝඩ් එකක් අහුවුණාම මේක වැඩ කරනවා
        Swal.fire({
            toast: true,
            position: 'top-end',
            icon: 'success',
            title: 'Scanned: ' + decodedText,
            showConfirmButton: false,
            timer: 2000
        });

        // මේ code එක POS එකේ search එකට auto දාන්න මේක පාවිච්චි කරන්න පුළුවන්
        // app.searchProduct(decodedText); 

    }).catch(err => console.error("Camera error:", err));
}

// කැමරාව නවත්වන්න
async function hideCamera() {
    if (html5QrCode) {
        await html5QrCode.stop();
    }
    document.getElementById('camera-section').classList.add('hidden');
}