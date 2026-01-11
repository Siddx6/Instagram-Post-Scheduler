import sqlite3 from "sqlite3";
import { open } from "sqlite";
import dotenv from "dotenv";
dotenv.config();

const DB_FILE = process.env.DB_FILE || "./scheduler.db";

export let db;

export async function initDB() {
  db = await open({
    filename: DB_FILE,
    driver: sqlite3.Database,
  });

  // Create users table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fb_user_id TEXT UNIQUE,
      name TEXT,
      user_token TEXT,
      user_token_expires_at TEXT
    );
  `);

  // Create ig_accounts table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS ig_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      page_id TEXT,
      page_name TEXT,
      page_access_token TEXT,
      ig_user_id TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  // Create posts table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      ig_account_id INTEGER,
      caption TEXT,
      media_url TEXT,
      scheduled_time TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      posted_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(ig_account_id) REFERENCES ig_accounts(id)
    );
  `);

  console.log("✅ Database initialized");
}
