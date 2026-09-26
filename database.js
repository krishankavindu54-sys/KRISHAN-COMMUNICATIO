const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// ──────────────────────────────────────────────
// APPWRITE CLOUD BACKEND CONFIGURATION
// ──────────────────────────────────────────────
const APPWRITE_ENDPOINT = (process.env.APPWRITE_ENDPOINT || 'https://nyc.cloud.appwrite.io/v1').trim();
const APPWRITE_PROJECT_ID = (process.env.APPWRITE_PROJECT_ID || '').trim();
const APPWRITE_API_KEY = (process.env.APPWRITE_API_KEY || '').trim();
const APPWRITE_DATABASE_ID = (process.env.APPWRITE_DATABASE_ID || 'krishan_pos').trim();

let appwriteClient = null;
let appwriteDatabases = null;
let appwriteActive = false;

if (APPWRITE_PROJECT_ID && APPWRITE_API_KEY) {
    try {
        const { Client, Databases } = require('node-appwrite');
        appwriteClient = new Client()
            .setEndpoint(APPWRITE_ENDPOINT)
            .setProject(APPWRITE_PROJECT_ID)
            .setKey(APPWRITE_API_KEY);
        appwriteDatabases = new Databases(appwriteClient);
        console.log(`☁️ [Appwrite] Initialized Appwrite Cloud Client (${APPWRITE_ENDPOINT}, Project: ${APPWRITE_PROJECT_ID})`);
    } catch (err) {
        console.warn('⚠️ [Appwrite] Could not initialize Appwrite client:', err.message);
    }
}

// ──────────────────────────────────────────────
// SUPABASE CLOUD DATABASE CONFIGURATION (Optional Secondary Cloud DB)
// ──────────────────────────────────────────────
let rawSupabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
if (rawSupabaseUrl) {
    rawSupabaseUrl = rawSupabaseUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
}
const SUPABASE_URL = rawSupabaseUrl;
const SUPABASE_KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

let supabase = null;
let cloudSyncActive = false;

const isPlaceholderSupabase = !SUPABASE_URL || SUPABASE_URL.includes('dzuycbqcltmlrktiszby');

if (!isPlaceholderSupabase && SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http')) {
    try {
        const { createClient } = require('@supabase/supabase-js');
        supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false }
        });
    } catch (err) {
        console.warn('⚠️ [Cloud DB] Could not initialize Supabase client:', err.message);
        supabase = null;
    }
}

// ──────────────────────────────────────────────
// LOCAL SQLITE / JSON FALLBACK STORAGE
// ──────────────────────────────────────────────
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

let DATA_DIR;
if (isServerless) {
    DATA_DIR = path.join('/tmp', 'data');
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const sourceDb = path.join(__dirname, 'data', 'pos.sqlite');
        const targetDb = path.join(DATA_DIR, 'pos.sqlite');
        if (fs.existsSync(sourceDb) && !fs.existsSync(targetDb)) {
            fs.copyFileSync(sourceDb, targetDb);
            console.log('📦 [Database] Cloned pre-seeded pos.sqlite to /tmp/data for Vercel');
        }
        const sourceJson = path.join(__dirname, 'data', 'pos.json');
        const targetJson = path.join(DATA_DIR, 'pos.json');
        if (fs.existsSync(sourceJson) && !fs.existsSync(targetJson)) {
            fs.copyFileSync(sourceJson, targetJson);
            console.log('📦 [Database] Cloned pre-seeded pos.json to /tmp/data for Vercel');
        }
    } catch (err) {
        DATA_DIR = '/tmp';
    }
} else {
    DATA_DIR = path.join(__dirname, 'data');
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    } catch (err) {
        DATA_DIR = '/tmp';
    }
}

const DB_PATH = path.join(DATA_DIR, 'pos.sqlite');

let db;
try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
} catch (err) {
    // Fallback if sqlite module isn't available
}

class JsonDatabase {
    constructor(filePath) {
        this.filePath = filePath.replace('.sqlite', '.json');
        this.data = {
            users: [],
            items: [],
            sales: [],
            repairs: [],
            frames: [],
            expenses: [],
            creditors: [],
            bank_transactions: [],
            suppliers: [],
            purchase_bills: [],
            settings: {}
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                this.data = JSON.parse(raw);
            } else {
                this.save();
            }
        } catch (err) {
            console.error('Error loading JSON DB:', err);
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (err) {
            console.error('Error saving JSON DB:', err);
        }
    }
}

const jsonDb = !db ? new JsonDatabase(DB_PATH) : null;

// Initialize Database Tables for Local Mode
function initDatabase() {
    if (db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'cashier',
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                barcode TEXT,
                category TEXT NOT NULL DEFAULT 'General',
                type TEXT NOT NULL DEFAULT 'product',
                price REAL NOT NULL DEFAULT 0,
                cost REAL NOT NULL DEFAULT 0,
                stock INTEGER NOT NULL DEFAULT 0,
                min_stock INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                total REAL NOT NULL,
                discount REAL DEFAULT 0,
                payment_method TEXT NOT NULL DEFAULT 'cash',
                cash_received REAL DEFAULT 0,
                change_amount REAL DEFAULT 0,
                items_json TEXT NOT NULL,
                customer_name TEXT,
                customer_phone TEXT,
                user_id INTEGER,
                is_utility INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS repairs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_name TEXT NOT NULL,
                phone_model TEXT NOT NULL,
                issue TEXT,
                estimated_cost REAL DEFAULT 0,
                advance_payment REAL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                contact TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS photo_frames (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_name TEXT NOT NULL,
                contact TEXT,
                size TEXT NOT NULL,
                frame_type TEXT DEFAULT 'Normal Glass',
                moulding_color TEXT DEFAULT 'Gold',
                service_type TEXT DEFAULT 'Print & Frame',
                total_cost REAL DEFAULT 0,
                advance_payment REAL DEFAULT 0,
                due_date TEXT,
                status TEXT NOT NULL DEFAULT 'Pending',
                notes TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                category TEXT NOT NULL,
                amount REAL NOT NULL,
                description TEXT
            );

            CREATE TABLE IF NOT EXISTS creditors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT,
                amount REAL NOT NULL DEFAULT 0,
                type TEXT NOT NULL DEFAULT 'receivable',
                last_updated TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS bank_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                type TEXT NOT NULL,
                amount REAL NOT NULL,
                note TEXT
            );

            CREATE TABLE IF NOT EXISTS suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                company TEXT,
                phone TEXT,
                email TEXT,
                address TEXT
            );

            CREATE TABLE IF NOT EXISTS purchase_bills (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                supplier_id INTEGER,
                supplier_name TEXT,
                bill_number TEXT,
                date TEXT NOT NULL,
                total_amount REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                items_json TEXT
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        // Ensure default users exist
        const existingAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
        if (!existingAdmin) {
            const adminHash = bcrypt.hashSync('admin123', 10);
            db.prepare('INSERT INTO users (username, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?)').run('admin', adminHash, 'admin', 'Administrator', new Date().toISOString());
        }
        const existingCashier = db.prepare('SELECT id FROM users WHERE username = ?').get('cashier');
        if (!existingCashier) {
            const cashierHash = bcrypt.hashSync('cashier123', 10);
            db.prepare('INSERT INTO users (username, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?)').run('cashier', cashierHash, 'cashier', 'Cashier', new Date().toISOString());
        }

        // Seed initial items if empty
        const itemCount = db.prepare('SELECT count(*) as count FROM items').get().count;
        if (itemCount === 0) {
            const stmt = db.prepare('INSERT INTO items (name, category, type, price, cost, barcode, stock, min_stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
            stmt.run('Photocopy (A4)', 'Service', 'service', 10, 2, 'SERV001', 0, 0);
            stmt.run('Passport Photo', 'Studio', 'service', 350, 50, 'SERV002', 0, 0);
            stmt.run('Tempered Glass', 'Accessories', 'product', 500, 150, 'ACC001', 25, 5);
            stmt.run('CR Books', 'Stationery', 'product', 250, 180, 'STAT001', 50, 10);
        }
    } else if (jsonDb) {
        if (jsonDb.data.users.length === 0) {
            jsonDb.data.users.push(
                { id: 1, username: 'admin', password_hash: bcrypt.hashSync('admin123', 10), role: 'admin', name: 'Administrator', created_at: new Date().toISOString() },
                { id: 2, username: 'cashier', password_hash: bcrypt.hashSync('cashier123', 10), role: 'cashier', name: 'Cashier', created_at: new Date().toISOString() }
            );
            jsonDb.save();
        }
        if (jsonDb.data.items.length === 0) {
            jsonDb.data.items.push(
                { id: 1, name: "Photocopy (A4)", category: "Service", type: "service", price: 10, cost: 2, barcode: "SERV001", stock: 0, minStock: 0 },
                { id: 2, name: "Passport Photo", category: "Studio", type: "service", price: 350, cost: 50, barcode: "SERV002", stock: 0, minStock: 0 },
                { id: 3, name: "Tempered Glass", category: "Accessories", type: "product", price: 500, cost: 150, barcode: "ACC001", stock: 25, minStock: 5 },
                { id: 4, name: "CR Books", category: "Stationery", type: "product", price: 250, cost: 180, barcode: "STAT001", stock: 50, minStock: 10 }
            );
            jsonDb.save();
        }
    }

    // Verify Cloud DB status asynchronously
    if (appwriteDatabases || supabase) {
        checkCloudConnection();
    } else {
        console.log('📦 [Database] Running in Local Storage Mode (SQLite)');
    }
}

async function checkCloudConnection() {
    if (appwriteDatabases) {
        try {
            await appwriteDatabases.get(APPWRITE_DATABASE_ID);
            console.log(`⚡ [Cloud DB] Appwrite Cloud Database (${APPWRITE_DATABASE_ID}) is ONLINE and Connected.`);
            appwriteActive = true;
            cloudSyncActive = true;
            return;
        } catch (err) {
            console.warn('ℹ️ [Appwrite] Cloud check notice:', err.message);
            appwriteActive = false;
        }
    }

    if (supabase) {
        try {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out')), 1000));
            const testQuery = supabase.from('users').select('id').limit(1);
            const { error } = await Promise.race([testQuery, timeoutPromise]);
            if (error) {
                console.warn('ℹ️ [Cloud DB] Supabase not reachable, active in Local / Serverless mode:', error.message);
            } else {
                console.log('⚡ [Cloud DB] Supabase Cloud Database is ONLINE and synced.');
                cloudSyncActive = true;
                await seedCloudIfEmpty();
                return;
            }
        } catch (err) {
            console.warn('ℹ️ [Cloud DB] Cloud connection check finished (' + err.message + '). Active in Local / Serverless mode.');
        }
    }

    if (!appwriteActive) {
        console.log('📦 [Database] Running in Local Storage Mode (SQLite / JSON Fallback)');
    }
}

async function seedCloudIfEmpty() {
    if (!supabase || !cloudSyncActive) return;
    try {
        const { data: users } = await supabase.from('users').select('id').limit(1);
        if (!users || users.length === 0) {
            const adminHash = bcrypt.hashSync('admin123', 10);
            const cashierHash = bcrypt.hashSync('cashier123', 10);
            await supabase.from('users').insert([
                { username: 'admin', password_hash: adminHash, role: 'admin', name: 'Administrator', created_at: new Date().toISOString() },
                { username: 'cashier', password_hash: cashierHash, role: 'cashier', name: 'Cashier', created_at: new Date().toISOString() }
            ]);
            console.log('⚡ [Cloud DB] Default admin and cashier accounts seeded to Supabase.');
        }
    } catch (e) {}
}

// Helper formatting functions
function formatItem(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        name: row.name,
        barcode: row.barcode || '',
        category: row.category || 'General',
        type: row.type || 'product',
        price: Number(row.price || 0),
        cost: Number(row.cost || 0),
        stock: Number(row.stock || 0),
        minStock: Number(row.min_stock !== undefined ? row.min_stock : (row.minStock || 0))
    };
}

function formatSale(row) {
    if (!row) return null;
    let items = [];
    try {
        items = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : (row.items_json || row.items || []);
    } catch(e) {}
    return {
        id: Number(row.id),
        date: row.date,
        total: Number(row.total || 0),
        discount: Number(row.discount || 0),
        paymentMethod: row.payment_method || row.paymentMethod || 'cash',
        cashReceived: Number(row.cash_received !== undefined ? row.cash_received : (row.cashReceived || 0)),
        change: Number(row.change_amount !== undefined ? row.change_amount : (row.change || 0)),
        items,
        customerName: row.customer_name || row.customerName || '',
        customerPhone: row.customer_phone || row.customerPhone || '',
        userId: row.user_id || row.userId || null,
        isUtility: Boolean(row.is_utility || row.isUtility)
    };
}

function formatRepair(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        customerName: row.customer_name || row.customerName || '',
        phoneModel: row.phone_model || row.phoneModel || '',
        issue: row.issue || '',
        estimatedCost: Number(row.estimated_cost !== undefined ? row.estimated_cost : (row.estimatedCost || 0)),
        advancePayment: Number(row.advance_payment !== undefined ? row.advance_payment : (row.advancePayment || 0)),
        status: row.status || 'pending',
        contact: row.contact || '',
        createdAt: row.created_at || row.createdAt || new Date().toISOString()
    };
}

function formatPhotoFrame(row) {
    if (!row) return null;
    return {
        id: Number(row.id),
        customerName: row.customer_name || row.customerName || 'Customer',
        contact: row.contact || '',
        size: row.size || '12x18 inch',
        frameType: row.frame_type || row.frameType || 'Normal Glass',
        mouldingColor: row.moulding_color || row.mouldingColor || 'Gold',
        serviceType: row.service_type || row.serviceType || 'Print & Frame',
        totalCost: Number(row.total_cost !== undefined ? row.total_cost : (row.totalCost !== undefined ? row.totalCost : 0)),
        advancePayment: Number(row.advance_payment !== undefined ? row.advance_payment : (row.advancePayment !== undefined ? row.advancePayment : 0)),
        dueDate: row.due_date || row.dueDate || '',
        status: row.status || 'Pending',
        notes: row.notes || '',
        createdAt: row.created_at || row.createdAt || new Date().toISOString()
    };
}

function formatPurchaseBill(row) {
    if (!row) return null;
    let items = [];
    try {
        items = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : (row.items_json || row.items || []);
    } catch(e) {}
    return {
        id: Number(row.id),
        supplierId: row.supplier_id || row.supplierId || null,
        supplierName: row.supplier_name || row.supplierName || '',
        billNumber: row.bill_number || row.billNumber || '',
        date: row.date || new Date().toISOString(),
        totalAmount: Number(row.total_amount !== undefined ? row.total_amount : (row.totalAmount || 0)),
        status: row.status || 'pending',
        items
    };
}

// ──────────────────────────────────────────────
// UNIVERSAL DATABASE SERVICE (SUPABASE + SQLITE / JSON FALLBACK)
// ──────────────────────────────────────────────
const dbService = {
    isCloudDB: () => Boolean(supabase && cloudSyncActive),

    // USERS
    getUsers: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('users').select('id, username, role, name, created_at').order('id', { ascending: true });
                if (!error && data) {
                    return data.map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name, createdAt: u.created_at }));
                }
            } catch (e) {}
        }
        if (db) {
            return db.prepare('SELECT id, username, role, name, created_at as createdAt FROM users ORDER BY id ASC').all();
        }
        return jsonDb.data.users.map(u => ({ id: u.id, username: u.username, role: u.role, name: u.name, createdAt: u.created_at }));
    },

    getUserByUsername: async (username) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('users').select('*').ilike('username', username.trim()).maybeSingle();
                if (!error && data) return data;
            } catch (e) {}
        }
        if (db) {
            return db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(username.trim());
        }
        return jsonDb.data.users.find(u => u.username.toLowerCase() === username.trim().toLowerCase()) || null;
    },

    createUser: async (user) => {
        const hash = user.password_hash || bcrypt.hashSync(user.password || 'admin123', 10);
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('users').insert([{
                    username: user.username.trim(),
                    password_hash: hash,
                    role: user.role || 'cashier',
                    name: user.name,
                    created_at: new Date().toISOString()
                }]).select('id, username, role, name, created_at').single();
                if (!error && data) return data;
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare('INSERT INTO users (username, password_hash, role, name, created_at) VALUES (?, ?, ?, ?, ?)');
            const res = stmt.run(user.username.trim(), hash, user.role || 'cashier', user.name, new Date().toISOString());
            return { id: Number(res.lastInsertRowid), username: user.username, role: user.role, name: user.name };
        }
        const newId = jsonDb.data.users.length ? Math.max(...jsonDb.data.users.map(u => u.id)) + 1 : 1;
        const newUser = { id: newId, username: user.username, password_hash: hash, role: user.role || 'cashier', name: user.name, created_at: new Date().toISOString() };
        jsonDb.data.users.push(newUser);
        jsonDb.save();
        return { id: newId, username: newUser.username, role: newUser.role, name: newUser.name };
    },

    updateUser: async (id, data) => {
        if (supabase && cloudSyncActive) {
            try {
                const updatePayload = {};
                if (data.name) updatePayload.name = data.name;
                if (data.role) updatePayload.role = data.role;
                if (data.password) updatePayload.password_hash = bcrypt.hashSync(data.password, 10);
                const { data: updated, error } = await supabase.from('users').update(updatePayload).eq('id', id).select('id, username, role, name').single();
                if (!error && updated) return updated;
            } catch (e) {}
        }
        if (db) {
            if (data.password) {
                const hash = bcrypt.hashSync(data.password, 10);
                db.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role), password_hash = ? WHERE id = ?')
                    .run(data.name || null, data.role || null, hash, id);
            } else {
                db.prepare('UPDATE users SET name = COALESCE(?, name), role = COALESCE(?, role) WHERE id = ?')
                    .run(data.name || null, data.role || null, id);
            }
            return db.prepare('SELECT id, username, role, name FROM users WHERE id = ?').get(id);
        }
        const user = jsonDb.data.users.find(u => u.id === Number(id));
        if (user) {
            if (data.name) user.name = data.name;
            if (data.role) user.role = data.role;
            if (data.password) user.password_hash = bcrypt.hashSync(data.password, 10);
            jsonDb.save();
            return { id: user.id, username: user.username, role: user.role, name: user.name };
        }
        return null;
    },

    deleteUser: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('users').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM users WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.users = jsonDb.data.users.filter(u => u.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // ITEMS / INVENTORY
    getItems: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('items').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(formatItem);
            } catch (e) {}
        }
        if (db) {
            const rows = db.prepare('SELECT * FROM items ORDER BY id DESC').all();
            return rows.map(formatItem);
        }
        return [...jsonDb.data.items].reverse().map(formatItem);
    },

    getItemById: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('items').select('*').eq('id', id).maybeSingle();
                if (!error && data) return formatItem(data);
            } catch (e) {}
        }
        if (db) {
            const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
            return formatItem(row);
        }
        const found = jsonDb.data.items.find(i => i.id === Number(id));
        return formatItem(found);
    },

    createItem: async (item) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('items').insert([{
                    name: item.name,
                    barcode: item.barcode || '',
                    category: item.category || 'General',
                    type: item.type || 'product',
                    price: Number(item.price || 0),
                    cost: Number(item.cost || 0),
                    stock: Number(item.stock || 0),
                    min_stock: Number(item.minStock || item.min_stock || 0)
                }]).select().single();
                if (!error && data) return formatItem(data);
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare(`
                INSERT INTO items (name, barcode, category, type, price, cost, stock, min_stock)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                item.name,
                item.barcode || '',
                item.category || 'General',
                item.type || 'product',
                item.price || 0,
                item.cost || 0,
                item.stock || 0,
                item.minStock || item.min_stock || 0
            );
            return dbService.getItemById(res.lastInsertRowid);
        }
        const newId = jsonDb.data.items.length ? Math.max(...jsonDb.data.items.map(i => i.id)) + 1 : 1;
        const newItem = { id: newId, ...item };
        jsonDb.data.items.push(newItem);
        jsonDb.save();
        return formatItem(newItem);
    },

    updateItem: async (id, item) => {
        if (supabase && cloudSyncActive) {
            try {
                const updatePayload = {};
                if (item.name !== undefined) updatePayload.name = item.name;
                if (item.barcode !== undefined) updatePayload.barcode = item.barcode;
                if (item.category !== undefined) updatePayload.category = item.category;
                if (item.type !== undefined) updatePayload.type = item.type;
                if (item.price !== undefined) updatePayload.price = Number(item.price);
                if (item.cost !== undefined) updatePayload.cost = Number(item.cost);
                if (item.stock !== undefined) updatePayload.stock = Number(item.stock);
                if (item.minStock !== undefined || item.min_stock !== undefined) {
                    updatePayload.min_stock = Number(item.minStock !== undefined ? item.minStock : item.min_stock);
                }
                const { data, error } = await supabase.from('items').update(updatePayload).eq('id', id).select().single();
                if (!error && data) return formatItem(data);
            } catch (e) {}
        }
        if (db) {
            db.prepare(`
                UPDATE items SET name = ?, barcode = ?, category = ?, type = ?, price = ?, cost = ?, stock = ?, min_stock = ?
                WHERE id = ?
            `).run(
                item.name,
                item.barcode || '',
                item.category || 'General',
                item.type || 'product',
                item.price || 0,
                item.cost || 0,
                item.stock || 0,
                item.minStock !== undefined ? item.minStock : (item.min_stock || 0),
                id
            );
            return dbService.getItemById(id);
        }
        const idx = jsonDb.data.items.findIndex(i => i.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.items[idx] = { ...jsonDb.data.items[idx], ...item };
            jsonDb.save();
            return formatItem(jsonDb.data.items[idx]);
        }
        return null;
    },

    adjustItemStock: async (id, delta) => {
        if (supabase && cloudSyncActive) {
            try {
                const current = await dbService.getItemById(id);
                if (current) {
                    const newStock = Math.max(0, current.stock + delta);
                    const { data, error } = await supabase.from('items').update({ stock: newStock }).eq('id', id).select().single();
                    if (!error && data) return formatItem(data);
                }
            } catch (e) {}
        }
        if (db) {
            db.prepare('UPDATE items SET stock = MAX(0, stock + ?) WHERE id = ?').run(delta, id);
            return dbService.getItemById(id);
        }
        const item = jsonDb.data.items.find(i => i.id === Number(id));
        if (item) {
            item.stock = Math.max(0, (item.stock || 0) + delta);
            jsonDb.save();
            return formatItem(item);
        }
        return null;
    },

    deleteItem: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('items').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM items WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.items = jsonDb.data.items.filter(i => i.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // SALES
    getSales: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('sales').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(formatSale);
            } catch (e) {}
        }
        if (db) {
            const rows = db.prepare('SELECT * FROM sales ORDER BY id DESC').all();
            return rows.map(formatSale);
        }
        return [...jsonDb.data.sales].reverse().map(formatSale);
    },

    createSale: async (sale) => {
        const itemsJson = sale.items || [];
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('sales').insert([{
                    date: sale.date || new Date().toISOString(),
                    total: Number(sale.total || 0),
                    discount: Number(sale.discount || 0),
                    payment_method: sale.paymentMethod || 'cash',
                    cash_received: Number(sale.cashReceived || 0),
                    change_amount: Number(sale.change || 0),
                    items_json: itemsJson,
                    customer_name: sale.customerName || '',
                    customer_phone: sale.customerPhone || '',
                    user_id: sale.userId || null,
                    is_utility: Boolean(sale.isUtility)
                }]).select().single();
                if (!error && data) {
                    if (Array.isArray(itemsJson)) {
                        for (const item of itemsJson) {
                            if (item.type === 'product' && item.id) {
                                await dbService.adjustItemStock(item.id, -(item.qty || 1));
                            }
                        }
                    }
                    return formatSale(data);
                }
            } catch (e) {}
        }

        if (db) {
            const stmt = db.prepare(`
                INSERT INTO sales (date, total, discount, payment_method, cash_received, change_amount, items_json, customer_name, customer_phone, user_id, is_utility)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                sale.date || new Date().toISOString(),
                sale.total,
                sale.discount || 0,
                sale.paymentMethod || 'cash',
                sale.cashReceived || 0,
                sale.change || 0,
                JSON.stringify(itemsJson),
                sale.customerName || '',
                sale.customerPhone || '',
                sale.userId || null,
                sale.isUtility ? 1 : 0
            );
            const saleId = Number(res.lastInsertRowid);

            // Deduct stock
            if (Array.isArray(itemsJson)) {
                for (const item of itemsJson) {
                    if (item.type === 'product' && item.id) {
                        db.prepare('UPDATE items SET stock = MAX(0, stock - ?) WHERE id = ?').run(item.qty || 1, item.id);
                    }
                }
            }
            return { id: saleId, ...sale };
        }

        const newId = jsonDb.data.sales.length ? Math.max(...jsonDb.data.sales.map(s => s.id)) + 1 : 1;
        const newSale = { id: newId, ...sale };
        jsonDb.data.sales.push(newSale);
        if (Array.isArray(itemsJson)) {
            for (const item of itemsJson) {
                if (item.type === 'product' && item.id) {
                    const found = jsonDb.data.items.find(i => i.id === item.id);
                    if (found) found.stock = Math.max(0, found.stock - (item.qty || 1));
                }
            }
        }
        jsonDb.save();
        return formatSale(newSale);
    },

    deleteSale: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('sales').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM sales WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.sales = jsonDb.data.sales.filter(s => s.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // REPAIRS
    getRepairs: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('repairs').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(formatRepair);
            } catch (e) {}
        }
        if (db) {
            const rows = db.prepare('SELECT * FROM repairs ORDER BY id DESC').all();
            return rows.map(formatRepair);
        }
        return [...jsonDb.data.repairs].reverse().map(formatRepair);
    },

    createRepair: async (repair) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('repairs').insert([{
                    customer_name: repair.customerName,
                    phone_model: repair.phoneModel,
                    issue: repair.issue || '',
                    estimated_cost: Number(repair.estimatedCost || 0),
                    advance_payment: Number(repair.advancePayment || 0),
                    status: repair.status || 'pending',
                    contact: repair.contact || '',
                    created_at: repair.createdAt || new Date().toISOString()
                }]).select().single();
                if (!error && data) return formatRepair(data);
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare(`
                INSERT INTO repairs (customer_name, phone_model, issue, estimated_cost, advance_payment, status, contact, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const estCost = repair.estimatedCost !== undefined ? Number(repair.estimatedCost) : (repair.cost !== undefined ? Number(repair.cost) : 0);
            const advPay = repair.advancePayment !== undefined ? Number(repair.advancePayment) : 0;
            const res = stmt.run(
                repair.customerName,
                repair.phoneModel,
                repair.issue || '',
                estCost,
                advPay,
                repair.status || 'pending',
                repair.contact || '',
                repair.createdAt || new Date().toISOString()
            );
            return { id: Number(res.lastInsertRowid), ...repair, estimatedCost: estCost, cost: estCost, advancePayment: advPay };
        }
        const newId = jsonDb.data.repairs.length ? Math.max(...jsonDb.data.repairs.map(r => r.id)) + 1 : 1;
        const newRepair = { id: newId, ...repair };
        jsonDb.data.repairs.push(newRepair);
        jsonDb.save();
        return formatRepair(newRepair);
    },

    updateRepair: async (id, repair) => {
        if (supabase && cloudSyncActive) {
            try {
                const updatePayload = {};
                if (repair.customerName !== undefined) updatePayload.customer_name = repair.customerName;
                if (repair.phoneModel !== undefined) updatePayload.phone_model = repair.phoneModel;
                if (repair.issue !== undefined) updatePayload.issue = repair.issue;
                if (repair.estimatedCost !== undefined) updatePayload.estimated_cost = Number(repair.estimatedCost);
                if (repair.advancePayment !== undefined) updatePayload.advance_payment = Number(repair.advancePayment);
                if (repair.status !== undefined) updatePayload.status = repair.status;
                if (repair.contact !== undefined) updatePayload.contact = repair.contact;
                const { data, error } = await supabase.from('repairs').update(updatePayload).eq('id', id).select().single();
                if (!error && data) return formatRepair(data);
            } catch (e) {}
        }
        if (db) {
            const current = db.prepare('SELECT * FROM repairs WHERE id = ?').get(id);
            if (!current) return null;
            const updated = {
                customerName: repair.customerName !== undefined ? repair.customerName : current.customer_name,
                phoneModel: repair.phoneModel !== undefined ? repair.phoneModel : current.phone_model,
                issue: repair.issue !== undefined ? repair.issue : current.issue,
                estimatedCost: repair.estimatedCost !== undefined ? Number(repair.estimatedCost) : (repair.cost !== undefined ? Number(repair.cost) : current.estimated_cost),
                advancePayment: repair.advancePayment !== undefined ? Number(repair.advancePayment) : current.advance_payment,
                status: repair.status !== undefined ? repair.status : current.status,
                contact: repair.contact !== undefined ? repair.contact : current.contact
            };
            db.prepare(`
                UPDATE repairs SET customer_name = ?, phone_model = ?, issue = ?, estimated_cost = ?, advance_payment = ?, status = ?, contact = ?
                WHERE id = ?
            `).run(updated.customerName, updated.phoneModel, updated.issue, updated.estimatedCost, updated.advancePayment, updated.status, updated.contact, id);
            return formatRepair({ id: Number(id), ...updated, customer_name: updated.customerName, phone_model: updated.phoneModel, estimated_cost: updated.estimatedCost, advance_payment: updated.advancePayment, created_at: current.created_at });
        }
        const idx = jsonDb.data.repairs.findIndex(r => r.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.repairs[idx] = { ...jsonDb.data.repairs[idx], ...repair };
            jsonDb.save();
            return formatRepair(jsonDb.data.repairs[idx]);
        }
        return null;
    },

    deleteRepair: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('repairs').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM repairs WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.repairs = jsonDb.data.repairs.filter(r => r.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // PHOTO FRAMES
    getPhotoFrames: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('photo_frames').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(formatPhotoFrame);
            } catch (e) {}
        }
        if (db) {
            const rows = db.prepare('SELECT * FROM photo_frames ORDER BY id DESC').all();
            return rows.map(formatPhotoFrame);
        }
        return [...(jsonDb.data.frames || [])].reverse().map(formatPhotoFrame);
    },

    createPhotoFrame: async (frame) => {
        const total = Number(frame.totalCost !== undefined ? frame.totalCost : (frame.total_cost || 0));
        const adv = Number(frame.advancePayment !== undefined ? frame.advancePayment : (frame.advance_payment || 0));
        const createdAt = frame.createdAt || new Date().toISOString();

        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('photo_frames').insert([{
                    customer_name: frame.customerName || 'Customer',
                    contact: frame.contact || '',
                    size: frame.size || '12x18 inch',
                    frame_type: frame.frameType || 'Normal Glass',
                    moulding_color: frame.mouldingColor || 'Gold',
                    service_type: frame.serviceType || 'Print & Frame',
                    total_cost: total,
                    advance_payment: adv,
                    due_date: frame.dueDate || '',
                    status: frame.status || 'Pending',
                    notes: frame.notes || '',
                    created_at: createdAt
                }]).select().single();
                if (!error && data) return formatPhotoFrame(data);
            } catch (e) {}
        }

        if (db) {
            const stmt = db.prepare(`
                INSERT INTO photo_frames (customer_name, contact, size, frame_type, moulding_color, service_type, total_cost, advance_payment, due_date, status, notes, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                frame.customerName || 'Customer',
                frame.contact || '',
                frame.size || '12x18 inch',
                frame.frameType || 'Normal Glass',
                frame.mouldingColor || 'Gold',
                frame.serviceType || 'Print & Frame',
                total,
                adv,
                frame.dueDate || '',
                frame.status || 'Pending',
                frame.notes || '',
                createdAt
            );
            return formatPhotoFrame({ id: Number(res.lastInsertRowid), ...frame, totalCost: total, advancePayment: adv, createdAt });
        }

        if (!jsonDb.data.frames) jsonDb.data.frames = [];
        const newId = jsonDb.data.frames.length ? Math.max(...jsonDb.data.frames.map(f => f.id)) + 1 : 1;
        const newFrame = { id: newId, ...frame, totalCost: total, advancePayment: adv, createdAt };
        jsonDb.data.frames.push(newFrame);
        jsonDb.save();
        return formatPhotoFrame(newFrame);
    },

    updatePhotoFrame: async (id, frame) => {
        if (db) {
            const current = db.prepare('SELECT * FROM photo_frames WHERE id = ?').get(id);
            if (!current) return null;
            const updated = {
                customerName: frame.customerName !== undefined ? frame.customerName : current.customer_name,
                contact: frame.contact !== undefined ? frame.contact : current.contact,
                size: frame.size !== undefined ? frame.size : current.size,
                frameType: frame.frameType !== undefined ? frame.frameType : current.frame_type,
                mouldingColor: frame.mouldingColor !== undefined ? frame.mouldingColor : current.moulding_color,
                serviceType: frame.serviceType !== undefined ? frame.serviceType : current.service_type,
                totalCost: frame.totalCost !== undefined ? Number(frame.totalCost) : current.total_cost,
                advancePayment: frame.advancePayment !== undefined ? Number(frame.advancePayment) : current.advance_payment,
                dueDate: frame.dueDate !== undefined ? frame.dueDate : current.due_date,
                status: frame.status !== undefined ? frame.status : current.status,
                notes: frame.notes !== undefined ? frame.notes : current.notes
            };
            db.prepare(`
                UPDATE photo_frames SET customer_name = ?, contact = ?, size = ?, frame_type = ?, moulding_color = ?, service_type = ?, total_cost = ?, advance_payment = ?, due_date = ?, status = ?, notes = ?
                WHERE id = ?
            `).run(
                updated.customerName, updated.contact, updated.size, updated.frameType, updated.mouldingColor, updated.serviceType,
                updated.totalCost, updated.advancePayment, updated.dueDate, updated.status, updated.notes, id
            );
            return formatPhotoFrame({ id: Number(id), ...updated, created_at: current.created_at });
        }

        if (!jsonDb.data.frames) jsonDb.data.frames = [];
        const idx = jsonDb.data.frames.findIndex(f => f.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.frames[idx] = { ...jsonDb.data.frames[idx], ...frame };
            jsonDb.save();
            return formatPhotoFrame(jsonDb.data.frames[idx]);
        }
        return null;
    },

    deletePhotoFrame: async (id) => {
        if (db) {
            db.prepare('DELETE FROM photo_frames WHERE id = ?').run(id);
            return true;
        }
        if (jsonDb.data.frames) {
            jsonDb.data.frames = jsonDb.data.frames.filter(f => f.id !== Number(id));
            jsonDb.save();
        }
        return true;
    },

    // EXPENSES
    getExpenses: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('expenses').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(e => ({ id: e.id, date: e.date, category: e.category, amount: Number(e.amount), description: e.description || '' }));
            } catch (e) {}
        }
        if (db) {
            return db.prepare('SELECT * FROM expenses ORDER BY id DESC').all();
        }
        return [...jsonDb.data.expenses].reverse();
    },

    createExpense: async (expense) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('expenses').insert([{
                    date: expense.date || new Date().toISOString(),
                    category: expense.category,
                    amount: Number(expense.amount || 0),
                    description: expense.description || ''
                }]).select().single();
                if (!error && data) return { id: data.id, date: data.date, category: data.category, amount: Number(data.amount), description: data.description };
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare('INSERT INTO expenses (date, category, amount, description) VALUES (?, ?, ?, ?)');
            const res = stmt.run(expense.date || new Date().toISOString(), expense.category, expense.amount, expense.description || '');
            return { id: Number(res.lastInsertRowid), ...expense };
        }
        const newId = jsonDb.data.expenses.length ? Math.max(...jsonDb.data.expenses.map(e => e.id)) + 1 : 1;
        const newExp = { id: newId, ...expense };
        jsonDb.data.expenses.push(newExp);
        jsonDb.save();
        return newExp;
    },

    deleteExpense: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('expenses').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.expenses = jsonDb.data.expenses.filter(e => e.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // CREDITORS
    getCreditors: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('creditors').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(c => ({ id: c.id, name: c.name, phone: c.phone || '', amount: Number(c.amount), type: c.type || 'receivable', lastUpdated: c.last_updated }));
            } catch (e) {}
        }
        if (db) {
            return db.prepare('SELECT id, name, phone, amount, type, last_updated as lastUpdated FROM creditors ORDER BY id DESC').all();
        }
        return [...jsonDb.data.creditors].reverse();
    },

    createCreditor: async (creditor) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('creditors').insert([{
                    name: creditor.name,
                    phone: creditor.phone || '',
                    amount: Number(creditor.amount || 0),
                    type: creditor.type || 'receivable',
                    last_updated: creditor.lastUpdated || new Date().toISOString()
                }]).select().single();
                if (!error && data) return { id: data.id, name: data.name, phone: data.phone, amount: Number(data.amount), type: data.type, lastUpdated: data.last_updated };
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare('INSERT INTO creditors (name, phone, amount, type, last_updated) VALUES (?, ?, ?, ?, ?)');
            const res = stmt.run(creditor.name, creditor.phone || '', creditor.amount || 0, creditor.type || 'receivable', creditor.lastUpdated || new Date().toISOString());
            return { id: Number(res.lastInsertRowid), ...creditor };
        }
        const newId = jsonDb.data.creditors.length ? Math.max(...jsonDb.data.creditors.map(c => c.id)) + 1 : 1;
        const newCred = { id: newId, ...creditor };
        jsonDb.data.creditors.push(newCred);
        jsonDb.save();
        return newCred;
    },

    updateCreditor: async (id, creditor) => {
        if (supabase && cloudSyncActive) {
            try {
                const updatePayload = { last_updated: new Date().toISOString() };
                if (creditor.name !== undefined) updatePayload.name = creditor.name;
                if (creditor.phone !== undefined) updatePayload.phone = creditor.phone;
                if (creditor.amount !== undefined) updatePayload.amount = Number(creditor.amount);
                if (creditor.type !== undefined) updatePayload.type = creditor.type;
                const { data, error } = await supabase.from('creditors').update(updatePayload).eq('id', id).select().single();
                if (!error && data) return { id: data.id, name: data.name, phone: data.phone, amount: Number(data.amount), type: data.type, lastUpdated: data.last_updated };
            } catch (e) {}
        }
        if (db) {
            db.prepare('UPDATE creditors SET name = ?, phone = ?, amount = ?, type = ?, last_updated = ? WHERE id = ?')
                .run(creditor.name, creditor.phone || '', creditor.amount, creditor.type, new Date().toISOString(), id);
            return { id: Number(id), ...creditor };
        }
        const idx = jsonDb.data.creditors.findIndex(c => c.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.creditors[idx] = { ...jsonDb.data.creditors[idx], ...creditor, lastUpdated: new Date().toISOString() };
            jsonDb.save();
            return jsonDb.data.creditors[idx];
        }
        return null;
    },

    deleteCreditor: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('creditors').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM creditors WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.creditors = jsonDb.data.creditors.filter(c => c.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // BANK TRANSACTIONS
    getBankTransactions: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('bank_transactions').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(b => ({ id: b.id, date: b.date, type: b.type, amount: Number(b.amount), note: b.note || '' }));
            } catch (e) {}
        }
        if (db) {
            return db.prepare('SELECT * FROM bank_transactions ORDER BY id DESC').all();
        }
        return [...jsonDb.data.bank_transactions].reverse();
    },

    createBankTransaction: async (tx) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('bank_transactions').insert([{
                    date: tx.date || new Date().toISOString(),
                    type: tx.type,
                    amount: Number(tx.amount || 0),
                    note: tx.note || ''
                }]).select().single();
                if (!error && data) return { id: data.id, date: data.date, type: data.type, amount: Number(data.amount), note: data.note };
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare('INSERT INTO bank_transactions (date, type, amount, note) VALUES (?, ?, ?, ?)');
            const res = stmt.run(tx.date || new Date().toISOString(), tx.type, tx.amount, tx.note || '');
            return { id: Number(res.lastInsertRowid), ...tx };
        }
        const newId = jsonDb.data.bank_transactions.length ? Math.max(...jsonDb.data.bank_transactions.map(b => b.id)) + 1 : 1;
        const newTx = { id: newId, ...tx };
        jsonDb.data.bank_transactions.push(newTx);
        jsonDb.save();
        return newTx;
    },

    deleteBankTransaction: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('bank_transactions').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM bank_transactions WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.bank_transactions = jsonDb.data.bank_transactions.filter(b => b.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // SUPPLIERS
    getSuppliers: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('suppliers').select('*').order('id', { ascending: false });
                if (!error && data) return data;
            } catch (e) {}
        }
        if (db) {
            return db.prepare('SELECT * FROM suppliers ORDER BY id DESC').all();
        }
        return [...jsonDb.data.suppliers].reverse();
    },

    createSupplier: async (supplier) => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('suppliers').insert([{
                    name: supplier.name,
                    company: supplier.company || '',
                    phone: supplier.phone || '',
                    email: supplier.email || '',
                    address: supplier.address || ''
                }]).select().single();
                if (!error && data) return data;
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare('INSERT INTO suppliers (name, company, phone, email, address) VALUES (?, ?, ?, ?, ?)');
            const res = stmt.run(supplier.name, supplier.company || '', supplier.phone || '', supplier.email || '', supplier.address || '');
            return { id: Number(res.lastInsertRowid), ...supplier };
        }
        const newId = jsonDb.data.suppliers.length ? Math.max(...jsonDb.data.suppliers.map(s => s.id)) + 1 : 1;
        const newSup = { id: newId, ...supplier };
        jsonDb.data.suppliers.push(newSup);
        jsonDb.save();
        return newSup;
    },

    deleteSupplier: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('suppliers').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM suppliers WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.suppliers = jsonDb.data.suppliers.filter(s => s.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // PURCHASE BILLS
    getPurchaseBills: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('purchase_bills').select('*').order('id', { ascending: false });
                if (!error && data) return data.map(formatPurchaseBill);
            } catch (e) {}
        }
        if (db) {
            const rows = db.prepare('SELECT * FROM purchase_bills ORDER BY id DESC').all();
            return rows.map(formatPurchaseBill);
        }
        return [...jsonDb.data.purchase_bills].reverse().map(formatPurchaseBill);
    },

    createPurchaseBill: async (bill) => {
        const itemsJson = bill.items || [];
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('purchase_bills').insert([{
                    supplier_id: bill.supplierId || null,
                    supplier_name: bill.supplierName || '',
                    bill_number: bill.billNumber || '',
                    date: bill.date || new Date().toISOString(),
                    total_amount: Number(bill.totalAmount || 0),
                    status: bill.status || 'pending',
                    items_json: itemsJson
                }]).select().single();
                if (!error && data) return formatPurchaseBill(data);
            } catch (e) {}
        }
        if (db) {
            const stmt = db.prepare(`
                INSERT INTO purchase_bills (supplier_id, supplier_name, bill_number, date, total_amount, status, items_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            const res = stmt.run(
                bill.supplierId || null,
                bill.supplierName || '',
                bill.billNumber || '',
                bill.date || new Date().toISOString(),
                bill.totalAmount || 0,
                bill.status || 'pending',
                JSON.stringify(itemsJson)
            );
            return { id: Number(res.lastInsertRowid), ...bill };
        }
        const newId = jsonDb.data.purchase_bills.length ? Math.max(...jsonDb.data.purchase_bills.map(p => p.id)) + 1 : 1;
        const newBill = { id: newId, ...bill };
        jsonDb.data.purchase_bills.push(newBill);
        jsonDb.save();
        return formatPurchaseBill(newBill);
    },

    updatePurchaseBill: async (id, bill) => {
        if (supabase && cloudSyncActive) {
            try {
                const updatePayload = {};
                if (bill.status !== undefined) updatePayload.status = bill.status;
                if (bill.totalAmount !== undefined) updatePayload.total_amount = Number(bill.totalAmount);
                const { data, error } = await supabase.from('purchase_bills').update(updatePayload).eq('id', id).select().single();
                if (!error && data) return formatPurchaseBill(data);
            } catch (e) {}
        }
        if (db) {
            db.prepare('UPDATE purchase_bills SET status = COALESCE(?, status), total_amount = COALESCE(?, total_amount) WHERE id = ?')
                .run(bill.status || null, bill.totalAmount || null, id);
            return { id: Number(id), ...bill };
        }
        const idx = jsonDb.data.purchase_bills.findIndex(p => p.id === Number(id));
        if (idx !== -1) {
            jsonDb.data.purchase_bills[idx] = { ...jsonDb.data.purchase_bills[idx], ...bill };
            jsonDb.save();
            return formatPurchaseBill(jsonDb.data.purchase_bills[idx]);
        }
        return null;
    },

    deletePurchaseBill: async (id) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('purchase_bills').delete().eq('id', id);
            } catch (e) {}
        }
        if (db) {
            db.prepare('DELETE FROM purchase_bills WHERE id = ?').run(id);
            return true;
        }
        jsonDb.data.purchase_bills = jsonDb.data.purchase_bills.filter(p => p.id !== Number(id));
        jsonDb.save();
        return true;
    },

    // SETTINGS
    getSettings: async () => {
        if (supabase && cloudSyncActive) {
            try {
                const { data, error } = await supabase.from('settings').select('*');
                if (!error && data) {
                    const obj = {};
                    for (const r of data) obj[r.key] = r.value;
                    return obj;
                }
            } catch (e) {}
        }
        if (db) {
            const rows = db.prepare('SELECT * FROM settings').all();
            const obj = {};
            for (const r of rows) obj[r.key] = r.value;
            return obj;
        }
        return jsonDb.data.settings;
    },

    setSetting: async (key, value) => {
        if (supabase && cloudSyncActive) {
            try {
                await supabase.from('settings').upsert({ key, value: String(value) });
            } catch (e) {}
        }
        if (db) {
            db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
            return true;
        }
        jsonDb.data.settings[key] = String(value);
        jsonDb.save();
        return true;
    },

    // EXPORT ALL DATA
    exportAllData: async () => {
        return {
            users: await dbService.getUsers(),
            items: await dbService.getItems(),
            repairs: await dbService.getRepairs(),
            frames: await dbService.getPhotoFrames(),
            sales: await dbService.getSales(),
            expenses: await dbService.getExpenses(),
            creditors: await dbService.getCreditors(),
            bankTransactions: await dbService.getBankTransactions(),
            suppliers: await dbService.getSuppliers(),
            purchaseBills: await dbService.getPurchaseBills(),
            settings: await dbService.getSettings(),
            exportTimestamp: new Date().toISOString()
        };
    }
};

initDatabase();

module.exports = { dbService };
