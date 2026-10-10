const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
require('dotenv').config();

let dbInstance = null;

// ฟังก์ชันแปลง parameter จาก ? (SQLite) เป็น $1, $2, ... (PostgreSQL)
function convertPlaceholders(sql) {
  let paramIndex = 1;
  return sql.replace(/\?/g, () => `$${paramIndex++}`);
}

async function initPostgres(pool) {
  // 1. สร้างโครงสร้างตารางสำหรับ PostgreSQL
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL,
      line_user_id VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      building_name VARCHAR(100) NOT NULL,
      floor VARCHAR(50) NOT NULL,
      room_number VARCHAR(50) NOT NULL,
      room_type VARCHAR(100) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipments (
      id SERIAL PRIMARY KEY,
      device_code VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      location_id INT REFERENCES locations(id),
      status VARCHAR(20) DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      device_id INT NOT NULL REFERENCES equipments(id),
      reporter_id INT NOT NULL REFERENCES users(id),
      description TEXT NOT NULL,
      image_url TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      action_note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS technicians (
      id SERIAL PRIMARY KEY,
      line_user_id VARCHAR(100) UNIQUE NOT NULL,
      name VARCHAR(100) DEFAULT 'ช่างซ่อม',
      is_active INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. ตรวจสอบและลงข้อมูลเริ่มต้น (Seed Data)
  const locCount = await pool.query('SELECT COUNT(*) as count FROM locations');
  if (parseInt(locCount.rows[0].count) === 0) {
    console.log('>>> กำลังเพิ่มข้อมูลห้อง SC2-307 และอุปกรณ์ทั้งหมดลง PostgreSQL...');

    // ผู้ใช้งานตัวอย่าง
    await pool.query(`
      INSERT INTO users (name, email, password, role) VALUES 
      ('นิสิตผู้แจ้ง', 'user@test.com', '123', 'user'),
      ('ช่างวิชัย', 'staff@test.com', '123', 'staff'),
      ('แอดมินระบบ', 'admin@test.com', '123', 'admin');
    `);

    // ข้อมูลสถานที่ SC2-307
    const locResult = await pool.query(
      `INSERT INTO locations (building_name, floor, room_number, room_type) 
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['SC2', '3', '307', 'ห้องปฏิบัติการคอมพิวเตอร์']
    );
    const locId = locResult.rows[0].id;

    // คอมพิวเตอร์นักศึกษา 80 เครื่อง
    for (let i = 1; i <= 80; i++) {
      const padNum = String(i).padStart(2, '0');
      await pool.query(
        `INSERT INTO equipments (device_code, name, location_id) VALUES ($1, $2, $3)`,
        [`PC-SC2-307-${padNum}`, `เครื่องคอมพิวเตอร์นักศึกษา เครื่องที่ ${i}`, locId]
      );
    }

    // คอมพิวเตอร์อาจารย์ 1 เครื่อง
    await pool.query(
      `INSERT INTO equipments (device_code, name, location_id) VALUES ($1, $2, $3)`,
      ['PC-SC2-307-TEACHER', 'เครื่องคอมพิวเตอร์ผู้สอน/อาจารย์', locId]
    );

    // เครื่องปรับอากาศ 4 เครื่อง
    for (let i = 1; i <= 4; i++) {
      await pool.query(
        `INSERT INTO equipments (device_code, name, location_id) VALUES ($1, $2, $3)`,
        [`AC-SC2-307-0${i}`, `เครื่องปรับอากาศ แอร์ตัวที่ ${i}`, locId]
      );
    }

    // เครื่องโปรเจกเตอร์ 1 ตัว
    await pool.query(
      `INSERT INTO equipments (device_code, name, location_id) VALUES ($1, $2, $3)`,
      ['PJ-SC2-307-01', 'เครื่องโปรเจกเตอร์ Epson', locId]
    );

    // ระบบเครื่องเสียง 1 ชุด
    await pool.query(
      `INSERT INTO equipments (device_code, name, location_id) VALUES ($1, $2, $3)`,
      ['AV-SC2-307-01', 'ระบบเครื่องเสียงและแอมป์ขยายเสียง', locId]
    );

    console.log('>>> เพิ่มข้อมูลอุปกรณ์ห้อง SC2-307 ลง PostgreSQL ครบถ้วนเรียบร้อย!');
  }
}

async function getDB() {
  if (dbInstance) return dbInstance;

  if (process.env.DATABASE_URL) {
    // โหมด PostgreSQL สำหรับ Production/Render
    console.log('>>> เชื่อมต่อฐานข้อมูล: PostgreSQL');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });

    await initPostgres(pool);

    // จำลอง Method ของ SQLite (get, all, run) เพื่อให้ server.js ใช้งานต่อได้ทันที
    dbInstance = {
      get: async (sql, params = []) => {
        const res = await pool.query(convertPlaceholders(sql), params);
        return res.rows[0];
      },
      all: async (sql, params = []) => {
        const res = await pool.query(convertPlaceholders(sql), params);
        return res.rows;
      },
      run: async (sql, params = []) => {
        let converted = convertPlaceholders(sql);
        if (/^\s*insert\s+/i.test(converted) && !/returning/i.test(converted)) {
          converted += ' RETURNING id';
        }
        const res = await pool.query(converted, params);
        return {
          lastID: res.rows && res.rows[0] ? res.rows[0].id : null,
          changes: res.rowCount
        };
      },
      exec: async (sql) => {
        await pool.query(sql);
      }
    };
  } else {
    // โหมด SQLite สำหรับรันแบบ Local
    console.log('>>> เชื่อมต่อฐานข้อมูล: Local SQLite');
    dbInstance = await open({
      filename: path.join(__dirname, 'repair_system.db'),
      driver: sqlite3.Database
    });
  }

  return dbInstance;
}

module.exports = { getDB };