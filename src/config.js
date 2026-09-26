'use strict';

const isProduction = process.env.NODE_ENV === 'production';

// Normalize public base URL (strip trailing slash)
let publicBaseUrl = process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.trim() : '';
if (publicBaseUrl.endsWith('/')) {
  publicBaseUrl = publicBaseUrl.slice(0, -1);
}

const config = {
  isProduction,
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT ? parseInt(process.env.PORT, 10) : 3443,
  httpPort: 3000,
  publicBaseUrl,
  sessionSecret: process.env.SESSION_SECRET || '',
  tursoUrl: process.env.TURSO_DATABASE_URL || '',
  tursoToken: process.env.TURSO_AUTH_TOKEN || '',
  setupKey: process.env.SETUP_KEY || '',
  timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
};

// Validate required environment variables in production
if (isProduction) {
  const errors = [];

  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    errors.push('SESSION_SECRET environment variable is required and must be at least 32 characters in production.');
  }

  if (!config.tursoUrl) {
    errors.push('TURSO_DATABASE_URL environment variable is required in production.');
  }

  if (!config.tursoToken) {
    errors.push('TURSO_AUTH_TOKEN environment variable is required in production.');
  }

  if (!config.setupKey) {
    errors.push('SETUP_KEY environment variable is required in production to lock teacher setup.');
  }

  if (errors.length > 0) {
    console.error('\n=============================================');
    console.error('CONFIGURATION ERROR (Production Startup Aborted):');
    errors.forEach((err) => console.error(` - ${err}`));
    console.error('=============================================\n');
    throw new Error('Invalid production configuration: ' + errors.join('; '));
  }
}

module.exports = config;
