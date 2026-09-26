# QR Attendance System (v2)

A modern, fast, and anti-proxy QR Attendance web application that works both **locally on a teacher's laptop/hotspot** and **in the cloud (100% free deployment on Render + Turso)**.

Students scan dynamic, 7-second rotating QR codes on the classroom projector/screen to instantly record attendance with device fingerprinting and optional GPS classroom geofencing.

---

## ✨ Features

- **Dual-Mode Operation**:
  - **Local LAN / Hotspot Mode**: Run completely offline on teacher laptop with dual-port HTTPS (`3443`) and local SQLite database (`data/app.db`).
  - **Cloud Production Mode**: 100% free internet deployment on **Render** (Node.js web service with managed HTTPS) and **Turso** (SQLite-compatible cloud database).
- **Anti-Proxy Protection**:
  - **7-Second Rotating QR Code**: Dynamic HMAC-SHA256 time-slotted validation.
  - **2-Step Check-in Ticket**: Instant code validation within grace window + 60s signed ticket for seamless GPS coordinate collection without race-condition expirations.
  - **Classroom Geolocation Fence (GPS Check)**: Optional Haversine boundary check (`Off`, `Flag Only`, `Strict Block`).
  - **Device Fingerprinting & Lock**: Strict single-phone-per-student binding to stop proxy check-ins for absent friends.
  - **Rate Limiting & Security Flag Logs**: Built-in 20 req/min limits and teacher flag notifications.
- **Teacher Dashboard**:
  - Live real-time attendance feed with flag indicators and single-click fraudulent check-in revocation.
  - Student batch management with CSV import / export.
  - Session management with live projector view and detailed CSV attendance exports (with timezone support).
  - One-click full database JSON backup.
- **Student Experience**:
  - Integrated fast camera scanner and 6-character short code fallback.
  - Direct QR scan support with pending check-in queue if scanned prior to login.

---

## 🚀 Quick Start (Local LAN Mode)

```bash
# 1. Install dependencies
npm install

# 2. Start server locally
npm start
```

Access the app:
- **Teacher Dashboard**: [https://localhost:3443/teacher](https://localhost:3443/teacher)
- **Student Portal**: `https://<LAN-IP>:3443` (displayed in console at startup)

---

## 🌐 Free Cloud Deployment (Internet / Real HTTPS)

Deploy this system on the internet for free with genuine HTTPS certificates and zero maintenance.

👉 **Follow the step-by-step guide in [DEPLOY.md](file:///f:/Desktop/qr-attendance-v2/DEPLOY.md).**

### Quick Cloud Stack:
- **Code**: GitHub Private Repository
- **Hosting**: Render (Free Web Service via [`render.yaml`](file:///f:/Desktop/qr-attendance-v2/render.yaml) Blueprint)
- **Database**: Turso (Free 9 GB SQLite Cloud DB)
- **Keep-Alive**: cron-job.org (Free ping to `/healthz` every 10 minutes)

---

## 📦 Available Scripts

| Command | Description |
| :--- | :--- |
| `npm start` | Starts the application in local or production mode depending on `NODE_ENV`. |
| `npm run dev` | Starts server with automatic hot-reloading using `nodemon`. |
| `npm test` | Runs the comprehensive automated test suite (8 test suites). |
| `npm run migrate:local-to-cloud` | Migrates local `data/app.db` records to Turso cloud database with schema validation. |

---

## 🔒 Security & Privacy

- **Session Security**: Stateless, tamper-proof cookie sessions with server-side `session_version` invalidation on password change or logout.
- **Setup Security**: Teacher registration locked with secret `SETUP_KEY` in production.
- **Headers & CSP**: Powered by `helmet` with strict Content Security Policy and camera Permissions Policy.
- **Health Checks**: `/healthz` (liveness probe) and `/healthz/db` (database connectivity probe).

---

## 📄 License
ISC
