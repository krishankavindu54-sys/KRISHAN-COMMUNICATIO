# 🚀 Krishan Communication & Studio - Cloud POS System

මෙම POS පද්ධතිය Appwrite Cloud Backend සහ Cloud Hosting සේවාවන් (Vercel, Render, Railway, VPS) හරහා පහසුවෙන්ම Deploy කර Online භාවිතයට ගත හැකි පරිදි සකස් කර ඇත.

---

## 🔑 පෙරනිමි පිවිසුම් තොරතුරු (Default Login Credentials)

| තනතුර (Role) | පරිශීලක නාමය (Username) | මුරපදය (Password) |
| :--- | :--- | :--- |
| **Administrator (හිමිකරු)** | `admin` | `admin123` |
| **Cashier (කැෂියර්)** | `cashier` | `cashier123` |

---

## ☁️ Appwrite Cloud Backend Setup (සකස් කර ඇති ආකාරය)

ඔබ ලබා දුන් Appwrite Cloud විස්තර පද්ධතියට සාර්ථකව සම්බන්ධ කර ඇත:
- **Appwrite Endpoint:** `https://nyc.cloud.appwrite.io/v1`
- **Project ID:** `6ab7bd4b003d096d96dd`
- **Database ID:** `krishan_pos`

> [!TIP]
> **වැදගත් (Appwrite API Key Scopes):**
> Appwrite Console -> **API Keys** වෙත ගොස් ඔබගේ API Key එකෙහි **Databases Scopes** (collections.read, collections.write, documents.read, documents.write, attributes.read, attributes.write) සඳහා අවසර (Permissions) ලබා දී ඇති බව තහවුරු කරගන්න.

---

## 🚀 Cloud Platform එකකට Deploy කරගන්නා ආකාරය (Deployment)

### විකල්පය A: Vercel හරහා Deploy කිරීම (Serverless)
1. මෙම Files GitHub Repository එකකට Push කරන්න.
2. [vercel.com](https://vercel.com) වෙත ගොස් GitHub Repo එක Import කරන්න.
3. **Settings -> Environment Variables** වලට පහත අගයන් ඇතුළත් කරන්න:
   - `APPWRITE_ENDPOINT` = `https://nyc.cloud.appwrite.io/v1`
   - `APPWRITE_PROJECT_ID` = `6ab7bd4b003d096d96dd`
   - `APPWRITE_API_KEY` = `standard_6a449900f764e8304764d9152c5a609e67f159bc0e2453e5b6e3b171f4b2142fcf398f6078f85fe5ccbab9fe23723d867f8c945549947618ef836483757677ee65ea649ac18402f36fb5e8f8636a82b44757c847c325c48f580e762df060d01e7e95756cae2b505034be3f8eae3df6b7736134d3caa1a55dc69c3fc71ceb821a`
   - `APPWRITE_DATABASE_ID` = `krishan_pos`
   - `JWT_SECRET` = `krishan_pos_secure_studio_jwt_secret_2026`
4. **Deploy** බටන් එක ඔබන්න.

### විකල්පය B: Render.com / Railway හරහා Deploy කිරීම (WebSockets & Live Sync)
1. [render.com](https://render.com) වෙත ගොස් **New Web Service** සාදන්න.
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Environment Variables වලට ඉහත Appwrite අගයන් ඇතුළත් කර Deploy කරන්න.

---

## 📁 පිරිසිදු කරන ලද Project ගොනු ව්‍යුහය (Clean Cloud Structure)

```
├── api/
│   └── index.js              # Vercel Serverless Function Handler
├── assets/
│   ├── icons/                # PWA App & Favicon Icons
│   └── js/                   # Helper Libraries
├── data/
│   └── pos.json              # Fallback initial data seed
├── index.html                # Main Cloud POS Billing & Dashboard UI
├── login.html                # Cloud POS Authentication UI
├── catalog.html              # Customer Public Digital Catalog Menu
├── app.js                    # Frontend Application Engine & Sync Client
├── server.js                 # Express Backend API & Cloud Endpoints
├── database.js               # Appwrite Cloud Database + SQLite/JSON Data Layer
├── whatsapp-service.js       # WhatsApp Invoice Notification Service
├── vercel.json               # Vercel Routing & Deployment Configuration
├── manifest.json             # Progressive Web App (PWA) Manifest
├── sw.js                     # Offline & Service Worker Cache
├── package.json              # Node.js dependencies & scripts
├── .env                      # Local Environment Variables
├── .env.example              # Cloud Environment Variables Template
├── .gitignore                # Git ignore rules
└── README.md                 # Documentation
```

---
&copy; 2026 Krishan Communication & Studio. All Rights Reserved.
