'use strict';

const config = require('./config');

/**
 * Format timestamp in application timezone (default: Asia/Kolkata)
 */
function formatDateTime(timestamp, options = {}) {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp));
  if (isNaN(date.getTime())) return '';

  const defaultOptions = {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  };

  const formatter = new Intl.DateTimeFormat('en-IN', { ...defaultOptions, ...options });
  return formatter.format(date);
}

/**
 * Format ISO timestamp in application timezone for CSV exports
 */
function formatIsoWithTimezone(timestamp) {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp));
  if (isNaN(date.getTime())) return '';

  return formatDateTime(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/**
 * Format friendly time for "Already marked at 10:45 AM"
 */
function formatTimeOnly(timestamp) {
  if (!timestamp) return '';
  const date = new Date(Number(timestamp));
  if (isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-IN', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

module.exports = {
  formatDateTime,
  formatIsoWithTimezone,
  formatTimeOnly,
};
