'use strict';

const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const helmet = require('helmet');

const config = require('./config');
const { runMigrations, queryOne, closeDb } = require('./db');
const { getOrCreateSecret } = require('./auth');
const { getLanIpCandidates, getActiveLanIp, refreshPreferredIp } = require('./network');
const { getOrCreateCertificate } = require('./certs');

const app = express();

// Trust proxy (required for Render / cloud reverse proxy and secure cookies)
app.set('trust proxy', 1);

// Security Headers (Helmet + CSP + Permissions Policy)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  })
);

app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self)');
  next();
});

// HTTPS redirect in production behind proxy
app.use((req, res, next) => {
  if (config.isProduction && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Cookie-Session configuration (replaces SQLite store for stateless cloud deployment)
const sessionSecret = getOrCreateSecret();
const isLocalTest = config.publicBaseUrl && config.publicBaseUrl.startsWith('http://localhost');
const isSecureCookie = config.isProduction && !isLocalTest;

app.use(
  cookieSession({
    name: 'att_sess',
    keys: [sessionSecret],
    httpOnly: true,
    secure: isSecureCookie,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days default (overridden for teachers on login)
  })
);

// Device ID tracking cookie for anti-proxy enforcement
app.use((req, res, next) => {
  if (!req.cookies.device_id) {
    const deviceId = crypto.randomBytes(16).toString('hex');
    res.cookie('device_id', deviceId, {
      httpOnly: true,
      secure: isSecureCookie,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    });
    req.deviceId = deviceId;
  } else {
    req.deviceId = req.cookies.device_id;
  }
  next();
});

// Health Checks
app.get('/healthz', (req, res) => {
  res.json({ ok: true, status: 'healthy', uptime: process.uptime() });
});

app.get('/healthz/db', async (req, res) => {
  try {
    const row = await queryOne('SELECT 1 AS ok');
    if (row && Number(row.ok) === 1) {
      return res.json({ ok: true, db: true, status: 'database connected' });
    }
    res.status(500).json({ ok: false, db: false, error: 'Database response invalid' });
  } catch (err) {
    res.status(500).json({ ok: false, db: false, error: err.message });
  }
});

// Serve static assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Basic route redirect
app.get('/', (req, res) => {
  if (req.session && req.session.studentDbId) {
    return res.redirect('/student');
  }
  return res.redirect('/student/login');
});

// Help page
app.get('/help', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'help.html'));
});

// Setup mount points for API and Page routes
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/attendance', require('./routes/attendance'));

// Fallback direct check-in route (/a/:code)
app.get('/a/:code', (req, res, next) => {
  require('./routes/attendance')(req, res, next);
});

// Teacher & Student static page routes
app.get(/^\/teacher(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'teacher', 'index.html'));
});

app.get(/^\/student(\/.*)?$/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'student', 'index.html'));
});

app.get('/projector/:sessionId', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'projector.html'));
});

// 404 Handler
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Resource not found' });
  }
  res.status(404).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>Page Not Found</title>
      <link rel="stylesheet" href="/css/style.css">
    </head>
    <body>
      <div class="container-narrow" style="margin-top: 60px; text-align: center;">
        <h1>404 - Page Not Found</h1>
        <p style="margin-top: 12px; margin-bottom: 24px;">The page you are looking for does not exist.</p>
        <a href="/" class="btn btn-primary">Return Home</a>
      </div>
    </body>
    </html>
  `);
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ ok: false, error: err.message || 'Internal server error' });
  }
  res.status(500).send('Something went wrong on the server.');
});

// ─── Server Startup & Graceful Shutdown ───────────────────────────────────────

let activeServer = null;
let activeHttpRedirectServer = null;

async function startServer() {
  await runMigrations();
  await refreshPreferredIp();

  if (config.isProduction) {
    // Production Mode (Render provides TLS termination)
    activeServer = http.createServer(app);
    activeServer.listen(config.port, '0.0.0.0', () => {
      console.log('\n=============================================');
      console.log(`Production Attendance Server running on port ${config.port}`);
      if (config.publicBaseUrl) {
        console.log(`Public Base URL: ${config.publicBaseUrl}`);
        console.log(`Teacher Portal:  ${config.publicBaseUrl}/teacher`);
      }
      console.log('=============================================\n');
    });
  } else {
    // Local Mode (Self-signed HTTPS + HTTP redirect)
    const certs = await getOrCreateCertificate();

    activeServer = https.createServer(
      {
        key: certs.key,
        cert: certs.cert,
      },
      app
    );

    activeServer.listen(config.port, '0.0.0.0', () => {
      const lanIp = getActiveLanIp();
      const allCandidates = getLanIpCandidates();

      console.log('\n=============================================');
      console.log('Local Attendance server running (HTTPS)');
      console.log(`Teacher (this laptop): https://localhost:${config.port}/teacher`);
      console.log(`Students (phones):     https://${lanIp}:${config.port}`);
      console.log('=============================================');

      if (allCandidates.length > 1) {
        console.log('\nAvailable Network Interfaces:');
        allCandidates.forEach((c) => {
          console.log(` - ${c.name}: https://${c.ip}:${config.port} ${c.isVirtual ? '(Virtual)' : ''}`);
        });
        console.log('You can change the active IP in Teacher Settings if needed.\n');
      }
    });

    activeHttpRedirectServer = http.createServer((req, res) => {
      const host = (req.headers.host || '').split(':')[0] || 'localhost';
      res.writeHead(301, { Location: `https://${host}:${config.port}${req.url}` });
      res.end();
    });

    activeHttpRedirectServer.listen(config.httpPort, '0.0.0.0', () => {
      console.log(`HTTP redirect server running on port ${config.httpPort} -> https port ${config.port}`);
    });
  }
}

// Graceful Shutdown
async function handleShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  if (activeServer) {
    activeServer.close(() => console.log('HTTP/HTTPS server closed.'));
  }
  if (activeHttpRedirectServer) {
    activeHttpRedirectServer.close();
  }
  try {
    await closeDb();
    console.log('Database connection closed.');
  } catch (err) {
    console.error('Error closing database:', err);
  }
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
