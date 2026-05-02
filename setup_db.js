const { Client } = require('pg');

async function setup() {
  // Connect as postgres superuser
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'vfspass',
    database: 'postgres',
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL as postgres');

    // Create user if not exists
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vfsuser') THEN
          CREATE USER vfsuser WITH PASSWORD 'vfspass';
          RAISE NOTICE 'Created user vfsuser';
        ELSE
          RAISE NOTICE 'User vfsuser already exists';
        END IF;
      END $$;
    `);
    console.log('User vfsuser: OK');

    // Create database if not exists
    const dbCheck = await client.query(`SELECT 1 FROM pg_database WHERE datname = 'vfsdb'`);
    if (dbCheck.rowCount === 0) {
      await client.query('CREATE DATABASE vfsdb OWNER vfsuser');
      console.log('Database vfsdb: Created');
    } else {
      console.log('Database vfsdb: Already exists');
    }

    console.log('\nDatabase setup complete!');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

setup();
