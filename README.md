# 🚀 Krishan Communication & Studio - Cloud POS System

මෙම POS පද්ධතිය Cloud Hosting සේවාවන් (Vercel, Render, Railway, VPS) හරහා පහසුවෙන්ම Deploy කර Online භාවිතයට ගත හැකි පරිදි සකස් කර ඇත.

---

## 🔑 පෙරනිමි පිවිසුම් තොරතුරු (Default Login Credentials)

| තනතුර (Role) | පරිශීලක නාමය (Username) | මුරපදය (Password) |
| :--- | :--- | :--- |
| **Administrator (හිමිකරු)** | `admin` | `admin123` |
| **Cashier (කැෂියර්)** | `cashier` | `cashier123` |

---

## ☁️ Cloud Hosting කරගන්නා ආකාරය (Deployment Guide)

### පියවර 1: Supabase Free Cloud Database එක සාදා ගැනීම
1. [supabase.com](https://supabase.com) වෙත ගොස් නොමිලේ ගිණුමක් (Free Account) සාදා New Project එකක් සාදන්න.
2. Supabase Dashboard එකේ වම් පස ඇති **SQL Editor** වෙත යන්න.
3. මෙම Project එකේ ඇති `supabase-schema.sql` ගොනුවේ සම්පූර්ණ Code එක Copy කර SQL Editor එකට Paste කර **Run** කරන්න.
4. **Project Settings -> API** වෙත ගොස් පහත දෑ ලබාගන්න:
   - **Project URL** (SUPABASE_URL)
   - **anon / service_role API Key** (SUPABASE_KEY)

---

### පියවර 2: Cloud Platform එකකට Deploy කිරීම

#### විකල්පය A: Vercel හරහා Deploy කිරීම (නොමිලේ - Serverless)
1. මෙම Files GitHub Repository එකකට Push / Upload කරන්න.
2. [vercel.com](https://vercel.com) වෙත ගොස් GitHub Repo එක Import කරන්න.
3. **Settings -> Environment Variables** වලට පහත අගයන් ඇතුළත් කරන්න:
   - `SUPABASE_URL` = ඔබගේ Supabase Project URL
   - `SUPABASE_KEY` = ඔබගේ Supabase anon/service_role Key
   - `JWT_SECRET` = `krishan_pos_secure_studio_jwt_secret_2026`
4. **Deploy** බටන් එක ඔබන්න. තත්පර කිහිපයකින් ඔබගේ Live URL එක ලැබෙනු ඇත.

#### විකල්පය B: Render.com / Railway හරහා Deploy කිරීම (WebSockets & Live Sync සහිතව)
1. [render.com](https://render.com) වෙත ගොස් **New -> Web Service** තෝරන්න.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. **Environment Variables** වලට `SUPABASE_URL`, `SUPABASE_KEY`, `JWT_SECRET` ඇතුළත් කර Deploy කරන්න.

---

## 📁 පිරිසිදු කරන ලද Project ගොනු ව්‍යුහය (Clean Cloud Structure)

```
├── api/
│   └── index.js              # Vercel Serverless Function Handler
├── assets/
│   ├── icons/                # PWA App & Favicon Icons
│   └── js/                   # Standalone Helper Libraries
├── data/
│   └── pos.json              # Fallback initial data seed
├── index.html                # Main Cloud POS Billing & Dashboard UI
├── login.html                # Cloud POS Authentication UI
├── catalog.html              # Customer Public Digital Catalog Menu
├── app.js                    # Frontend Application Engine & Sync Client
├── server.js                 # Express Backend API & Cloud Endpoints
├── database.js               # Supabase Cloud PostgreSQL + Fallback Data Layer
├── whatsapp-service.js       # WhatsApp Invoice Notification Service
├── supabase-schema.sql       # Supabase Cloud Database Table Definitions
├── vercel.json               # Vercel Routing & Deployment Configuration
├── manifest.json             # Progressive Web App (PWA) Manifest
├── sw.js                     # Offline & Service Worker Cache
├── package.json              # Node.js dependencies & scripts
├── .env.example              # Cloud Environment Variables Template
├── .gitignore                # Git ignore rules
└── README.md                 # Documentation
```

---

## 📱 Mobile App (PWA) ලෙස භාවිතා කිරීම
- Cloud URL එක Phone එකේ Chrome හෝ Safari Browser එකෙන් විවෘත කරන්න.
- Browser Menu එකෙන් **"Add to Home Screen"** හෝ **"Install App"** තෝරන්න.
- ඔබගේ Phone එක මත Standalone App එකක් ලෙස ක්‍රියාත්මක වේ.

---
&copy; 2026 Krishan Communication & Studio. All Rights Reserved.
