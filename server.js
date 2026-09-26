const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
require('dotenv').config();

const { dbService } = require('./database');
const { whatsappService } = require('./whatsapp-service');

const app = express();
const server = http.createServer(app);

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

// Setup Socket.io for persistent connections (Local / VPS / Render)
let io;
if (!isServerless) {
    io = new Server(server, {
        cors: {
            origin: true,
            credentials: true
        }
    });

    let connectedClients = 0;

    io.on('connection', (socket) => {
        connectedClients++;
        console.log(`⚡ [Socket.io] Client connected (ID: ${socket.id}). Total active devices: ${connectedClients}`);

        socket.emit('sync:welcome', {
            deviceCount: connectedClients,
            timestamp: new Date().toISOString(),
            serverTime: Date.now()
        });

        io.emit('sync:device_count', { count: connectedClients });

        // Send current WhatsApp connection & QR status
        socket.emit('whatsapp:status', whatsappService.getStatus());

        socket.on('disconnect', () => {
            connectedClients = Math.max(0, connectedClients - 1);
            console.log(`🔌 [Socket.io] Client disconnected (ID: ${socket.id}). Remaining: ${connectedClients}`);
            io.emit('sync:device_count', { count: connectedClients });
        });
    });

    // Initialize WhatsApp multi-device client with Socket.io real-time updates
    whatsappService.init(io);
}

function broadcastSync(type, data, excludeSocketId = null) {
    if (!io) return;
    const payload = {
        type,
        data,
        timestamp: new Date().toISOString()
    };
    if (excludeSocketId) {
        io.except(excludeSocketId).emit('sync:event', payload);
    } else {
        io.emit('sync:event', payload);
    }
}

const JWT_SECRET = process.env.JWT_SECRET || 'krishan_pos_secure_studio_jwt_secret_2026';
const SESSION_DURATION = 12 * 60 * 60 * 1000;
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Serverless / Vercel path normalization
app.use((req, res, next) => {
    if (req.url === '/api/index.js' || req.url === '/api/index' || req.url === '/api') {
        const originalUri = req.headers['x-forwarded-uri'] || req.originalUrl;
        if (originalUri && originalUri.startsWith('/api')) {
            req.url = originalUri;
        }
    }
    next();
});


app.use(express.static(__dirname));

// JWT Helpers
function createToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role, name: user.name },
        JWT_SECRET,
        { expiresIn: '12h' }
    );
}

function verifyToken(req) {
    const token = req.cookies?.pos_token || req.headers.authorization?.replace('Bearer ', '');
    if (token) {
        try {
            return jwt.verify(token, JWT_SECRET);
        } catch (err) {
            // Token expired or invalid, continue to local LAN fallback
        }
    }
    // In Local Wi-Fi Network Mode (Shop PC server):
    // Permit local Wi-Fi terminals (phones, tablets, PCs) to seamlessly sync data
    // even if mobile browsers strip HTTP cookies or haven't saved localStorage token
    if (!isServerless) {
        const reqRole = req.headers['x-user-role'];
        if (reqRole === 'admin') {
            return { id: 1, username: 'admin', role: 'admin', name: 'Administrator' };
        }
        return { id: 2, username: 'cashier', role: 'cashier', name: 'Cashier' };
    }
    return null;
}

// Middleware
function requireAuth(req, res, next) {
    const user = verifyToken(req);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Unauthorized. Please log in.' });
    }
    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    const user = verifyToken(req);
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Forbidden. Admin access required.' });
    }
    req.user = user;
    next();
}

function getSocketId(req) {
    return req.headers['x-socket-id'] || null;
}

// ──────────────────────────────────────────────
// AUTHENTICATION ROUTES
// ──────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password are required.' });
        }

        const user = await dbService.getUserByUsername(username.trim());
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: 'Invalid username or password.' });
        }

        const payload = { id: user.id, username: user.username, role: user.role, name: user.name };
        const token = createToken(payload);

        const isHttps = Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https' || isServerless);
        res.cookie('pos_token', token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: isHttps,
            maxAge: SESSION_DURATION
        });

        return res.json({
            success: true,
            message: 'Login successful',
            user: payload,
            token
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ success: false, message: 'Server error during login.' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('pos_token');
    res.json({ success: true, message: 'Logged out successfully.' });
});

app.get('/api/auth/me', (req, res) => {
    const user = verifyToken(req);
    if (!user) {
        return res.status(401).json({ authenticated: false, message: 'No active session' });
    }
    return res.json({ authenticated: true, user });
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ success: false, message: 'Password must be at least 4 characters.' });
        }

        const user = await dbService.getUserByUsername(req.user.username);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
        }

        await dbService.updateUser(user.id, { password: newPassword });
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error updating password.' });
    }
});

// ──────────────────────────────────────────────
// USER MANAGEMENT (Admin Only)
// ──────────────────────────────────────────────

app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const users = await dbService.getUsers();
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/users', requireAdmin, async (req, res) => {
    try {
        const { username, password, role, name } = req.body;
        if (!username || !password || !name) {
            return res.status(400).json({ success: false, message: 'Username, password, and name are required.' });
        }

        const existing = await dbService.getUserByUsername(username);
        if (existing) {
            return res.status(400).json({ success: false, message: 'Username already exists.' });
        }

        const newUser = await dbService.createUser({ username, password, role: role || 'cashier', name });
        res.json({ success: true, user: newUser });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const { name, role, password } = req.body;
        const updated = await dbService.updateUser(req.params.id, { name, role, password });
        if (!updated) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, user: updated });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
    try {
        const userId = Number(req.params.id);
        if (req.user.id === userId) {
            return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
        }
        await dbService.deleteUser(userId);
        res.json({ success: true, message: 'User deleted.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ──────────────────────────────────────────────
// POS DATA CRUD ENDPOINTS (WITH REALTIME SYNC)
// ──────────────────────────────────────────────

// Customer-Facing Safe Items Endpoint (Public, Cost prices stripped)
app.get('/api/customer/items', async (req, res) => {
    try {
        const items = await dbService.getItems();
        const safeItems = (items || []).map(i => ({
            id: i.id,
            name: i.name,
            barcode: i.barcode || '',
            category: i.category || 'General',
            type: i.type || 'product',
            price: Number(i.price) || 0,
            stock: Number(i.stock) || 0,
            inStock: i.type === 'service' || (Number(i.stock) > 0)
        }));
        res.json(safeItems);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Items / Inventory
app.get('/api/items', async (req, res) => {
    try {
        const items = await dbService.getItems();
        res.json(items);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/items', requireAuth, async (req, res) => {
    try {
        const item = await dbService.createItem(req.body);
        broadcastSync('ITEM_CREATED', item, getSocketId(req));
        res.json(item);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.put('/api/items/:id', requireAuth, async (req, res) => {
    try {
        const item = await dbService.updateItem(req.params.id, req.body);
        if (!item) return res.status(404).json({ message: 'Item not found' });
        broadcastSync('ITEM_UPDATED', item, getSocketId(req));
        res.json(item);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/items/:id/adjust-stock', requireAuth, async (req, res) => {
    try {
        const delta = Number(req.body.delta) || 0;
        const item = await dbService.adjustItemStock(req.params.id, delta);
        if (!item) return res.status(404).json({ message: 'Item not found' });
        broadcastSync('STOCK_CHANGED', { id: Number(req.params.id), stock: item.stock, delta, item }, getSocketId(req));
        res.json(item);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/items/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deleteItem(id);
        broadcastSync('ITEM_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Sales
app.get('/api/sales', requireAuth, async (req, res) => {
    try {
        const sales = await dbService.getSales();
        res.json(sales);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/sales', requireAuth, async (req, res) => {
    try {
        const saleData = { ...req.body, userId: req.user.id };
        const sale = await dbService.createSale(saleData);
        const allItems = await dbService.getItems();
        
        broadcastSync('SALE_CREATED', {
            sale,
            items: allItems,
            cashier: req.user.name || req.user.username
        }, getSocketId(req));
        
        res.json(sale);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/sales/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deleteSale(id);
        broadcastSync('SALE_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Repairs
app.get('/api/repairs', requireAuth, async (req, res) => {
    try {
        const repairs = await dbService.getRepairs();
        res.json(repairs);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/repairs', requireAuth, async (req, res) => {
    try {
        const repair = await dbService.createRepair(req.body);
        broadcastSync('REPAIR_CREATED', repair, getSocketId(req));
        res.json(repair);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.put('/api/repairs/:id', requireAuth, async (req, res) => {
    try {
        const repair = await dbService.updateRepair(req.params.id, req.body);
        if (!repair) return res.status(404).json({ message: 'Repair not found' });
        broadcastSync('REPAIR_UPDATED', repair, getSocketId(req));
        res.json(repair);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/repairs/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deleteRepair(id);
        broadcastSync('REPAIR_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Photo Frames (Studio Framing)
app.get('/api/frames', requireAuth, async (req, res) => {
    try {
        const frames = await dbService.getPhotoFrames();
        res.json(frames);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/frames', requireAuth, async (req, res) => {
    try {
        const frame = await dbService.createPhotoFrame(req.body);
        broadcastSync('FRAME_CREATED', frame, getSocketId(req));
        res.status(201).json(frame);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.put('/api/frames/:id', requireAuth, async (req, res) => {
    try {
        const frame = await dbService.updatePhotoFrame(req.params.id, req.body);
        if (!frame) return res.status(404).json({ message: 'Frame order not found' });
        broadcastSync('FRAME_UPDATED', frame, getSocketId(req));
        res.json(frame);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/frames/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deletePhotoFrame(id);
        broadcastSync('FRAME_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Expenses
app.get('/api/expenses', requireAuth, async (req, res) => {
    try {
        const expenses = await dbService.getExpenses();
        res.json(expenses);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
    try {
        const expense = await dbService.createExpense(req.body);
        broadcastSync('EXPENSE_CREATED', expense, getSocketId(req));
        res.json(expense);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/expenses/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deleteExpense(id);
        broadcastSync('EXPENSE_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Creditors
app.get('/api/creditors', requireAuth, async (req, res) => {
    try {
        const creditors = await dbService.getCreditors();
        res.json(creditors);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/creditors', requireAuth, async (req, res) => {
    try {
        const creditor = await dbService.createCreditor(req.body);
        broadcastSync('CREDITOR_CREATED', creditor, getSocketId(req));
        res.json(creditor);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.put('/api/creditors/:id', requireAuth, async (req, res) => {
    try {
        const creditor = await dbService.updateCreditor(req.params.id, req.body);
        if (!creditor) return res.status(404).json({ message: 'Creditor not found' });
        broadcastSync('CREDITOR_UPDATED', creditor, getSocketId(req));
        res.json(creditor);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/creditors/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deleteCreditor(id);
        broadcastSync('CREDITOR_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Bank Transactions
app.get('/api/bank-transactions', requireAuth, async (req, res) => {
    try {
        const txs = await dbService.getBankTransactions();
        res.json(txs);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/bank-transactions', requireAuth, async (req, res) => {
    try {
        const tx = await dbService.createBankTransaction(req.body);
        broadcastSync('BANK_TX_CREATED', tx, getSocketId(req));
        res.json(tx);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/bank-transactions/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deleteBankTransaction(id);
        broadcastSync('BANK_TX_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Suppliers
app.get('/api/suppliers', requireAuth, async (req, res) => {
    try {
        const suppliers = await dbService.getSuppliers();
        res.json(suppliers);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/suppliers', requireAuth, async (req, res) => {
    try {
        const supplier = await dbService.createSupplier(req.body);
        broadcastSync('SUPPLIER_CREATED', supplier, getSocketId(req));
        res.json(supplier);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/suppliers/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deleteSupplier(id);
        broadcastSync('SUPPLIER_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Purchase Bills
app.get('/api/purchase-bills', requireAuth, async (req, res) => {
    try {
        const bills = await dbService.getPurchaseBills();
        res.json(bills);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/purchase-bills', requireAuth, async (req, res) => {
    try {
        const bill = await dbService.createPurchaseBill(req.body);
        broadcastSync('BILL_CREATED', bill, getSocketId(req));
        res.json(bill);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.put('/api/purchase-bills/:id', requireAuth, async (req, res) => {
    try {
        const bill = await dbService.updatePurchaseBill(req.params.id, req.body);
        if (!bill) return res.status(404).json({ message: 'Purchase bill not found' });
        broadcastSync('BILL_UPDATED', bill, getSocketId(req));
        res.json(bill);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.delete('/api/purchase-bills/:id', requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        await dbService.deletePurchaseBill(id);
        broadcastSync('BILL_DELETED', { id }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Settings
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await dbService.getSettings();
        res.json(settings);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

app.post('/api/settings', requireAuth, async (req, res) => {
    try {
        const { key, value } = req.body;
        await dbService.setSetting(key, value);
        broadcastSync('SETTINGS_UPDATED', { key, value }, getSocketId(req));
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
});

// Full Sync & Diagnostics
app.get('/api/sync/full', requireAuth, async (req, res) => {
    try {
        const data = await dbService.exportAllData();
        res.json({ success: true, data, timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Batch Sync (Offline Queue Processor)
app.post('/api/sync/batch', requireAuth, async (req, res) => {
    try {
        const { operations } = req.body || {};
        if (!Array.isArray(operations) || operations.length === 0) {
            return res.json({ success: true, processed: 0 });
        }

        const results = [];
        for (const op of operations) {
            try {
                switch (op.type) {
                    case 'create_item':
                        results.push({ opId: op.id, result: await dbService.createItem(op.payload) });
                        break;
                    case 'update_item':
                        results.push({ opId: op.id, result: await dbService.updateItem(op.targetId, op.payload) });
                        break;
                    case 'create_sale':
                        results.push({ opId: op.id, result: await dbService.createSale({ ...op.payload, userId: req.user.id }) });
                        break;
                    case 'create_repair':
                        results.push({ opId: op.id, result: await dbService.createRepair(op.payload) });
                        break;
                    case 'update_repair':
                        results.push({ opId: op.id, result: await dbService.updateRepair(op.targetId, op.payload) });
                        break;
                    case 'create_frame':
                        results.push({ opId: op.id, result: await dbService.createPhotoFrame(op.payload) });
                        break;
                    case 'update_frame':
                        results.push({ opId: op.id, result: await dbService.updatePhotoFrame(op.targetId, op.payload) });
                        break;
                    case 'delete_frame':
                        results.push({ opId: op.id, result: await dbService.deletePhotoFrame(op.targetId) });
                        break;
                    case 'create_expense':
                        results.push({ opId: op.id, result: await dbService.createExpense(op.payload) });
                        break;
                    case 'create_creditor':
                        results.push({ opId: op.id, result: await dbService.createCreditor(op.payload) });
                        break;
                    case 'update_creditor':
                        results.push({ opId: op.id, result: await dbService.updateCreditor(op.targetId, op.payload) });
                        break;
                    case 'create_bank_tx':
                        results.push({ opId: op.id, result: await dbService.createBankTransaction(op.payload) });
                        break;
                    case 'create_bill':
                        results.push({ opId: op.id, result: await dbService.createPurchaseBill(op.payload) });
                        break;
                    default:
                        break;
                }
            } catch (err) {
                console.error(`Error processing batch operation ${op.id}:`, err);
                results.push({ opId: op.id, error: err.message });
            }
        }

        broadcastSync('BATCH_SYNC_COMPLETED', { timestamp: new Date().toISOString() }, getSocketId(req));

        res.json({ success: true, processed: results.length, results });
    } catch (e) {
        console.error('Batch sync error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Export Backup
app.get('/api/backup/export', requireAuth, async (req, res) => {
    try {
        const data = await dbService.exportAllData();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=pos_backup_${Date.now()}.json`);
        res.send(JSON.stringify(data, null, 2));
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// PWA & Service Worker Header Configuration
app.get('/sw.js', (req, res) => {
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Network & Device Info API for Multi-PC / Mobile Pairing
const os = require('os');
let QRCode;
try {
    QRCode = require('qrcode');
} catch (e) {
    console.warn('qrcode package optional:', e.message);
}

function getLocalIPAddress() {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        const ifaceList = interfaces[devName];
        for (let i = 0; i < ifaceList.length; i++) {
            const alias = ifaceList[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return 'localhost';
}

const localIP = getLocalIPAddress();

app.get('/api/network-info', (req, res) => {
    const ip = getLocalIPAddress();
    res.json({
        success: true,
        localIp: ip,
        port: PORT,
        lanUrl: `http://${ip}:${PORT}`,
        localUrl: `http://localhost:${PORT}`,
        quickCashierUrl: `http://${ip}:${PORT}/login?quick=cashier`,
        quickAdminUrl: `http://${ip}:${PORT}/login?quick=admin`,
        customerMenuUrl: `http://${ip}:${PORT}/catalog`,
        hostname: os.hostname(),
        platform: process.platform,
        cloudSync: Boolean(process.env.SUPABASE_URL),
        time: new Date().toISOString()
    });
});

// Dynamic QR Code Generator endpoint (SVG or DataURL)
app.get('/api/qr', async (req, res) => {
    try {
        const ip = getLocalIPAddress();
        const text = req.query.text || req.query.url || `http://${ip}:${PORT}/login?quick=cashier`;
        const format = req.query.format || 'svg';

        if (!QRCode) {
            return res.status(500).json({ success: false, message: 'QRCode module not loaded.' });
        }

        if (format === 'svg') {
            const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 260 });
            res.setHeader('Content-Type', 'image/svg+xml');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            return res.send(svg);
        } else {
            const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 260 });
            return res.json({ success: true, dataUrl, text });
        }
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ──────────────────────────────────────────────
// SMS GATEWAY DISPATCH ENGINE (Dialog e-SMS / Notify.lk / Custom)
// ──────────────────────────────────────────────
app.post('/api/sms/send', async (req, res) => {
    try {
        const { to, message, gatewayConfig } = req.body;
        if (!to || !message) {
            return res.status(400).json({ success: false, message: 'Missing recipient (to) or message' });
        }

        // Clean phone number (convert 07x to 947x)
        let phone = String(to).replace(/[^0-9]/g, '');
        if (phone.startsWith('0')) {
            phone = '94' + phone.substring(1);
        } else if (phone.length === 9) {
            phone = '94' + phone;
        }

        const provider = gatewayConfig?.provider || process.env.SMS_GATEWAY_PROVIDER || 'dialog';
        const apiKey = gatewayConfig?.apiKey || process.env.SMS_API_KEY || '';
        const password = gatewayConfig?.password || process.env.SMS_PASSWORD || '';
        const senderId = gatewayConfig?.senderId || process.env.SMS_SENDER_ID || 'KRISHAN';
        const apiUrl = gatewayConfig?.apiUrl || process.env.SMS_API_URL || '';

        console.log(`📡 [SMS Engine] Attempting to send SMS to +${phone} via ${provider}...`);

        if (!apiKey && !process.env.SMS_API_KEY) {
            return res.json({ 
                success: false, 
                fallbackToWhatsApp: true, 
                message: 'SMS Gateway credentials not configured. Please use WhatsApp or configure credentials in Settings.' 
            });
        }

        if (provider === 'dialog' || provider === 'esms') {
            // Dialog Enterprise e-SMS / Ideamart HTTP POST
            const endpoint = apiUrl || 'https://esms.dialog.lk/api/sms/send';
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: apiKey,
                    password: password,
                    sourceAddress: senderId,
                    message: message,
                    msisdn: [phone]
                })
            });
            const data = await response.json().catch(() => ({ status: response.status }));
            return res.json({ success: response.ok, provider: 'dialog', data });
        } else if (provider === 'notify') {
            // Notify.lk REST API
            const endpoint = apiUrl || 'https://app.notify.lk/api/v1/send';
            const postUrl = `${endpoint}?user_id=${encodeURIComponent(apiKey)}&api_key=${encodeURIComponent(password)}&sender_id=${encodeURIComponent(senderId)}&to=${phone}&message=${encodeURIComponent(message)}`;
            const response = await fetch(postUrl, { method: 'POST' });
            const data = await response.json().catch(() => ({ status: response.status }));
            return res.json({ success: response.ok, provider: 'notify', data });
        } else {
            return res.json({ success: false, fallbackToWhatsApp: true, message: `Unknown provider: ${provider}` });
        }
    } catch (err) {
        console.error('❌ [SMS Engine] Error sending SMS:', err.message);
        return res.status(500).json({ success: false, error: err.message, fallbackToWhatsApp: true });
    }
});

// ──────────────────────────────────────────────
// WHATSAPP 1-SHOT DIRECT DISPATCH API
// ──────────────────────────────────────────────
app.get('/api/whatsapp/status', (req, res) => {
    res.json({ success: true, ...whatsappService.getStatus() });
});

app.post('/api/whatsapp/send', async (req, res) => {
    try {
        const { phone, message } = req.body || {};
        if (!phone || !message) {
            return res.status(400).json({ success: false, message: 'Phone and message are required' });
        }
        const result = await whatsappService.sendMessage(phone, message);
        return res.json(result);
    } catch (err) {
        console.error('❌ [WhatsApp API] Error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/whatsapp/restart', async (req, res) => {
    try {
        const status = await whatsappService.restart();
        res.json({ success: true, ...status });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/whatsapp/logout', async (req, res) => {
    try {
        const result = await whatsappService.logout();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Front-end Page routing
app.get('/catalog', (req, res) => {
    res.sendFile(path.join(__dirname, 'catalog.html'));
});

app.get('/menu', (req, res) => {
    res.sendFile(path.join(__dirname, 'catalog.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.server = server;
app.io = io;
module.exports = app;

if (require.main === module && !process.env.VERCEL) {
    server.listen(PORT, '0.0.0.0', async () => {
        const ip = getLocalIPAddress();
        const lanUrl = `http://${ip}:${PORT}`;
        const quickCashierUrl = `http://${ip}:${PORT}/login?quick=cashier`;

        console.log(`================================================================`);
        console.log(`🚀 Krishan POS Realtime Server Running!`);
        console.log(`💻 This Computer:       http://localhost:${PORT}`);
        console.log(`📱 Other Wi-Fi Devices:  ${lanUrl}`);
        console.log(`⚡ Realtime Sync:       WebSocket Active on Port ${PORT}`);
        console.log(`🔑 Default Accounts:    admin / admin123  |  cashier / cashier123`);
        console.log(`================================================================`);

        if (QRCode) {
            try {
                const qrAscii = await QRCode.toString(quickCashierUrl, { type: 'terminal', small: true });
                console.log(`📱 Scan this QR code from any Phone connected to Shop Wi-Fi:`);
                console.log(`   (Auto-logs in as Cashier instantly!)`);
                console.log(qrAscii);
                console.log(`🔗 Direct Wi-Fi Link: ${quickCashierUrl}`);
                console.log(`================================================================\n`);
            } catch (qrErr) {
                // Ignore terminal QR render errors
            }
        }
    });
}
