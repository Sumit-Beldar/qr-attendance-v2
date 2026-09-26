# Free Internet Deployment Guide: QR Attendance System

This guide walks you through deploying the QR Attendance System to the internet completely for **free**, with real HTTPS (no SSL certificate warnings) so students and teachers can use it from any network or mobile data.

---

## 🏗️ The 100% Free Architecture

| Service | Role | Why It's Free & Reliable |
| :--- | :--- | :--- |
| **GitHub** | Code Hosting | Free private repository for version control and automated deployments. |
| **Turso** | Cloud Database (libSQL / SQLite) | 9 GB free storage, 500 databases, SQLite-compatible, never wipes data on redeploys. |
| **Render** | Web App Hosting | Free Node.js Web Service with automatic managed HTTPS (`*.onrender.com`). |
| **cron-job.org** | Keep-Awake Ping | Free automated pings to `/healthz` every 10 minutes to prevent Render free instance spin-down during class hours. |

---

## 📋 Prerequisites

Before starting, create free accounts on:
1. [GitHub](https://github.com/join)
2. [Turso](https://turso.tech)
3. [Render](https://render.com)
4. [cron-job.org](https://cron-job.org)

---

## 🚀 Step 1: Push Your Project to GitHub

1. Open your terminal in the `qr-attendance-v2` directory.
2. Initialize git and commit your code:
   ```bash
   git init
   git add .
   git commit -m "Initial commit for cloud deployment"
   ```
3. Create a new **Private** repository on GitHub (e.g. `qr-attendance-v2`).
4. Link your local repo and push:
   ```bash
   git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/qr-attendance-v2.git
   git branch -M main
   git push -u origin main
   ```

---

## 🗄️ Step 2: Create a Cloud Database on Turso

You can create your database using the **Turso Web Dashboard** or the **Turso CLI**.

### Option A: Via Turso Web Dashboard (Easiest)
1. Log in to [Turso Dashboard](https://app.turso.tech).
2. Click **Create Database**.
3. Name your database (e.g., `qr-attendance`).
4. Select the region closest to your location (e.g., `bom` for Mumbai / India).
5. Once created, copy the **Database URL** (`libsql://qr-attendance-....turso.io`).
6. Click **Create Token** (choose *No Expiration* or *Full Access*), and copy the **Auth Token**.

### Option B: Via Turso CLI
```bash
# Install CLI
npm install -g @turso/cli  # or use curl -sSfL https://get.tur.so/install.sh | bash

# Login
turso auth login

# Create database in Mumbai region (bom) or your closest region
turso db create qr-attendance --location bom

# Show database URL
turso db show qr-attendance --url

# Create authentication token
turso db tokens create qr-attendance
```

> 📌 **Save these two values:**
> - `TURSO_DATABASE_URL`: `libsql://qr-attendance-yourname.turso.io`
> - `TURSO_AUTH_TOKEN`: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

---

## 🔄 Step 3: (Optional) Migrate Local Data to Turso

If you already have existing teachers, students, or attendance records in your local `data/app.db` file and want to copy them to Turso:

1. Create a `.env` file locally containing:
   ```env
   TURSO_DATABASE_URL=libsql://qr-attendance-yourname.turso.io
   TURSO_AUTH_TOKEN=your_turso_auth_token
   ```
2. Run the migration script:
   ```bash
   npm run migrate:local-to-cloud
   ```
3. The script will automatically verify the Turso connection, run schema migrations, transfer all records cleanly in atomic batches, and verify row counts.

---

## 🌐 Step 4: Deploy to Render

### Using Render Blueprint (Recommended)
1. Log in to your [Render Dashboard](https://dashboard.render.com).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub repository (`qr-attendance-v2`).
4. Render will automatically detect [`render.yaml`](file:///f:/Desktop/qr-attendance-v2/render.yaml).
5. Fill in the required environment variables when prompted:

| Environment Variable | Description | Example / Recommended Value |
| :--- | :--- | :--- |
| `NODE_ENV` | Environment mode | `production` |
| `APP_TIMEZONE` | Timezone for CSV/Dashboard | `Asia/Kolkata` (or your IANA timezone) |
| `TURSO_DATABASE_URL` | Cloud DB URL | `libsql://qr-attendance-yourname.turso.io` |
| `TURSO_AUTH_TOKEN` | Cloud DB Auth Token | *(Your Turso Token)* |
| `SETUP_KEY` | Secret key for teacher onboarding | Any strong random password (e.g. `AdminSetup2026!Key`) |
| `PUBLIC_BASE_URL` | Your Render URL (can update after first deploy) | `https://qr-attendance-xxxx.onrender.com` |

6. Click **Apply**. Render will automatically build (`npm ci`) and deploy (`npm start`).
7. Once deployed, note down your live public URL: `https://your-service-name.onrender.com`.
8. Go to **Environment** tab in Render and ensure `PUBLIC_BASE_URL` matches your exact URL (`https://your-service-name.onrender.com`).

---

## ⏱️ Step 5: Prevent Sleep (Keep-Awake on cron-job.org)

Render's free tier spins down web services after 15 minutes of inactivity. To keep your app warm and responsive for class sessions:

1. Log in to [cron-job.org](https://cron-job.org).
2. Click **CREATE CRONJOB**.
3. **Title**: `QR Attendance Keep-Alive`
4. **URL**: `https://your-service-name.onrender.com/healthz`
5. **Execution schedule**: Every **10 minutes** (`*/10 * * * *`).
6. Click **Create**.
7. cron-job.org will ping `/healthz` continuously, keeping the instance warm at 0 cost.

> 💡 *Note: The `/healthz` endpoint is ultra-lightweight and returns in `<5ms` without making unnecessary database queries.*

---

## 🧑‍🏫 Step 6: Initial Teacher Setup

1. Open `https://your-service-name.onrender.com/teacher` in your browser.
2. If no teachers exist, you will be prompted for:
   - **Full Name**
   - **Username**
   - **Password**
   - **Setup Key**: Enter the exact `SETUP_KEY` you configured in Render's environment variables.
3. Once registered, log in to access the Teacher Dashboard.

---

## 🛡️ Anti-Proxy & Classroom Geolocation Setup

Once logged in to the Teacher Dashboard, go to **Settings**:

1. **Rotating QR Code Grace Window**:
   - Default: `2 slots` (~14 seconds). Adjust between 1–5 slots depending on student network speeds.
2. **Classroom Geolocation Fence (GPS Check)**:
   - **Mode**:
     - `Disabled (Off)`: Standard check-in (students anywhere can check in with the code).
     - `Flag Only (Recommended)`: Marks attendance as present, but adds a visual warning badge `🚩 Location Mismatch: X meters away` if the student is outside the classroom.
     - `Strict (Block)`: Rejects check-in attempts outside the classroom boundary.
   - **Set Classroom GPS**:
     - Click **"Use my phone's current GPS location"** while standing in the classroom to automatically populate Latitude and Longitude.
     - Set radius (e.g. `100` meters).
   - Click **Save Settings**.

---

## 💾 Step 7: Downloading Full Database Backups

Because cloud deployments should have regular backups:
1. Go to **Teacher Dashboard** → **Settings**.
2. Under **Database Backup & Recovery**, click **"Download JSON Backup"**.
3. This downloads a complete timestamped JSON export of all teachers, students, sessions, attendances, and security logs.

---

## ❓ Troubleshooting & FAQs

### 1. The first request takes 30-50 seconds to load
Render free instances go to sleep if inactive. Set up the cron-job.org keep-awake ping (Step 5) to keep the app active during school hours.

### 2. "Invalid Setup Key" during teacher registration
Ensure the setup key you type matches the `SETUP_KEY` variable set in the Render Dashboard Environment settings.

### 3. Student gets "Camera Access Denied"
Modern mobile browsers (Chrome/Safari/iOS) require a valid HTTPS connection for camera permissions. Since Render provides valid SSL certificates (`https://`), camera scanning will work out of the box. Ensure the student grants camera permission in their browser settings.

### 4. Student switched phones or cleared storage ("Device Registered to Another Student")
The device fingerprint rule prevents students from logging into another student's account on the same phone.
- A teacher can reset a student's device lock anytime from **Teacher Dashboard** → **Students List** → **Reset Device**.

### 5. What if I want to run the app locally without internet again?
The app automatically detects when `TURSO_DATABASE_URL` is not provided and falls back to the local SQLite database at `data/app.db`. Simply run `npm start` locally!
