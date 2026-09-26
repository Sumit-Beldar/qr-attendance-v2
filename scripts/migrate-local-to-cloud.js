/**
 * scripts/migrate-local-to-cloud.js
 *
 * Copies all rows from local ./data/app.db into Turso cloud database.
 * Preserves primary keys and foreign keys.
 * Refuses to run if target database already contains data unless --force is specified.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

async function migrate() {
  const force = process.argv.includes('--force');

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (!tursoUrl) {
    console.error('Error: TURSO_DATABASE_URL environment variable is required.');
    console.error('Usage: TURSO_DATABASE_URL=<url> TURSO_AUTH_TOKEN=<token> npm run migrate:local-to-cloud [-- --force]');
    process.exit(1);
  }

  // Find local db file
  let localDbPath = path.join(__dirname, '..', 'data', 'app.db');
  if (!fs.existsSync(localDbPath)) {
    const legacyPath = path.join(__dirname, '..', 'data', 'attendance.db');
    if (fs.existsSync(legacyPath)) {
      localDbPath = legacyPath;
    } else {
      console.error(`Error: Local database file not found at ${localDbPath}`);
      process.exit(1);
    }
  }

  console.log(`Connecting to local DB: ${localDbPath}`);
  const localClient = createClient({ url: 'file:' + path.resolve(localDbPath) });

  console.log(`Connecting to Turso cloud DB: ${tursoUrl}`);
  const cloudClient = createClient({ url: tursoUrl, authToken: tursoToken });

  try {
    // Ensure target tables exist
    const { runMigrations } = require('../src/db');
    // Run migrations using cloudClient
    const oldEnvUrl = process.env.TURSO_DATABASE_URL;
    process.env.TURSO_DATABASE_URL = tursoUrl;
    process.env.TURSO_AUTH_TOKEN = tursoToken;
    await runMigrations();

    // Check if cloud DB already has data
    const tables = ['teachers', 'batches', 'students', 'sessions', 'attendance', 'flags'];
    let targetHasData = false;

    for (const table of tables) {
      try {
        const res = await cloudClient.execute(`SELECT COUNT(*) as count FROM ${table}`);
        const count = Number(res.rows[0].count);
        if (count > 0) {
          targetHasData = true;
          break;
        }
      } catch (err) {
        // Table might not exist yet
      }
    }

    if (targetHasData && !force) {
      console.error('\n[ABORTED] Target Turso database already contains data.');
      console.error('To overwrite/merge existing data, run with --force:');
      console.error('  npm run migrate:local-to-cloud -- --force\n');
      process.exit(1);
    }

    console.log('\nStarting data migration from local to Turso...\n');

    // Order matters for FK constraints: batches -> teachers -> students -> sessions -> attendance -> flags -> settings
    const migrationPlan = [
      {
        table: 'batches',
        columns: ['id', 'name'],
      },
      {
        table: 'teachers',
        columns: ['id', 'username', 'password_hash', 'name', 'created_at'],
      },
      {
        table: 'students',
        columns: ['id', 'student_id', 'name', 'batch_id', 'password_hash', 'must_change_password', 'created_at'],
      },
      {
        table: 'sessions',
        columns: ['id', 'teacher_id', 'batch_id', 'title', 'session_secret', 'started_at', 'ended_at'],
      },
      {
        table: 'attendance',
        columns: ['id', 'session_id', 'student_id', 'marked_at', 'device_id', 'ip', 'method'],
      },
      {
        table: 'flags',
        columns: ['id', 'session_id', 'student_id', 'device_id', 'reason', 'created_at'],
      },
      {
        table: 'settings',
        columns: ['key', 'value'],
      },
    ];

    const counts = {};

    for (const plan of migrationPlan) {
      const { table, columns } = plan;

      let localRows;
      try {
        const res = await localClient.execute(`SELECT ${columns.join(', ')} FROM ${table}`);
        localRows = res.rows;
      } catch (err) {
        console.log(`Skipping table '${table}' (not present in local DB)`);
        continue;
      }

      if (localRows.length === 0) {
        counts[table] = 0;
        console.log(`Table '${table}': 0 rows`);
        continue;
      }

      const placeholders = columns.map(() => '?').join(', ');
      const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

      // Batch in chunks of 50
      const CHUNK_SIZE = 50;
      for (let i = 0; i < localRows.length; i += CHUNK_SIZE) {
        const chunk = localRows.slice(i, i + CHUNK_SIZE);
        const stmts = chunk.map((row) => ({
          sql,
          args: columns.map((col) => {
            const v = row[col];
            return typeof v === 'bigint' ? Number(v) : v;
          }),
        }));
        await cloudClient.batch(stmts, 'write');
      }

      counts[table] = localRows.length;
      console.log(`Table '${table}': successfully migrated ${localRows.length} rows`);
    }

    console.log('\nMigration complete! Summary:');
    console.table(counts);
  } finally {
    await localClient.close();
    await cloudClient.close();
  }
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrate };
