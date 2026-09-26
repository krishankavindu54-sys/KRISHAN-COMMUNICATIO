-- ========================================================
-- KRISHAN POS - SUPABASE 100% FREE CLOUD DATABASE SCHEMA
-- ========================================================
-- Run this SQL in Supabase Dashboard -> SQL Editor -> Run
-- ========================================================

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default Admin & Cashier Accounts (Pass: admin123, cashier123)
INSERT INTO users (username, password_hash, name, role)
VALUES 
    ('admin', '$2a$10$l/McfkfF46qdC/2SXhyROOhtez.8VL/nQ6.X10WajmX3uThvm8XUK', 'Administrator', 'admin'),
    ('cashier', '$2a$10$xay82r0bbWzr3SWeTv/dWO4KdQh5F1STdKuSqWIcMrJY0VPnHXGUe', 'Cashier', 'cashier')
ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash;

-- 2. ITEMS / INVENTORY TABLE
CREATE TABLE IF NOT EXISTS items (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    barcode TEXT,
    category TEXT DEFAULT 'General',
    type TEXT DEFAULT 'product',
    price NUMERIC(12,2) NOT NULL DEFAULT 0,
    cost NUMERIC(12,2) NOT NULL DEFAULT 0,
    stock INT NOT NULL DEFAULT 0,
    min_stock INT NOT NULL DEFAULT 5,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Starter Products & Services
INSERT INTO items (name, category, type, price, cost, barcode, stock, min_stock)
VALUES
    ('Photocopy (A4)', 'Service', 'service', 10, 2, 'SERV001', 0, 0),
    ('Passport Photo', 'Studio', 'service', 350, 50, 'SERV002', 0, 0),
    ('Tempered Glass', 'Accessories', 'product', 500, 150, 'ACC001', 25, 5),
    ('CR Books', 'Stationery', 'product', 250, 180, 'STAT001', 50, 10)
ON CONFLICT DO NOTHING;

-- 3. SALES TABLE
CREATE TABLE IF NOT EXISTS sales (
    id BIGSERIAL PRIMARY KEY,
    date TIMESTAMPTZ DEFAULT NOW(),
    total NUMERIC(12,2) NOT NULL DEFAULT 0,
    discount NUMERIC(12,2) DEFAULT 0,
    payment_method TEXT DEFAULT 'cash',
    cash_received NUMERIC(12,2) DEFAULT 0,
    change_amount NUMERIC(12,2) DEFAULT 0,
    items_json JSONB DEFAULT '[]'::jsonb,
    customer_name TEXT DEFAULT '',
    customer_phone TEXT DEFAULT '',
    user_id BIGINT,
    is_utility BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. REPAIRS TABLE
CREATE TABLE IF NOT EXISTS repairs (
    id BIGSERIAL PRIMARY KEY,
    customer_name TEXT NOT NULL,
    phone_model TEXT NOT NULL,
    issue TEXT DEFAULT '',
    estimated_cost NUMERIC(12,2) DEFAULT 0,
    advance_payment NUMERIC(12,2) DEFAULT 0,
    status TEXT DEFAULT 'pending',
    contact TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. EXPENSES TABLE
CREATE TABLE IF NOT EXISTS expenses (
    id BIGSERIAL PRIMARY KEY,
    date TIMESTAMPTZ DEFAULT NOW(),
    category TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. CREDITORS TABLE
CREATE TABLE IF NOT EXISTS creditors (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    type TEXT DEFAULT 'receivable',
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- 7. BANK TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS bank_transactions (
    id BIGSERIAL PRIMARY KEY,
    date TIMESTAMPTZ DEFAULT NOW(),
    type TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    note TEXT DEFAULT ''
);

-- 8. SUPPLIERS TABLE
CREATE TABLE IF NOT EXISTS suppliers (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT ''
);

-- 9. PURCHASE BILLS TABLE
CREATE TABLE IF NOT EXISTS purchase_bills (
    id BIGSERIAL PRIMARY KEY,
    supplier_id BIGINT,
    supplier_name TEXT DEFAULT '',
    bill_number TEXT DEFAULT '',
    date TIMESTAMPTZ DEFAULT NOW(),
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    items_json JSONB DEFAULT '[]'::jsonb
);

-- 10. SETTINGS TABLE
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Enable Row Level Security (RLS) policies allowing full access via service key or anon
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE creditors ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow full access for users" ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for items" ON items FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for sales" ON sales FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for repairs" ON repairs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for expenses" ON expenses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for creditors" ON creditors FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for bank_transactions" ON bank_transactions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for suppliers" ON suppliers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for purchase_bills" ON purchase_bills FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow full access for settings" ON settings FOR ALL USING (true) WITH CHECK (true);
