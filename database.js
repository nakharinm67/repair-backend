const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

let dbInstance = null;

async function getDB() {
  if (dbInstance) return dbInstance;

  dbInstance = await open({
    filename: path.join(__dirname, 'repair_system.db'),
    driver: sqlite3.Database
  });

  // สร้างโครงสร้างตาราง
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      line_user_id TEXT
    );

    CREATE TABLE IF NOT EXISTS locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      building_name TEXT NOT NULL,
      floor TEXT NOT NULL,
      room_number TEXT NOT NULL,
      room_type TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      location_id INTEGER,
      status TEXT DEFAULT 'active',
      FOREIGN KEY (location_id) REFERENCES locations(id)
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      image_url TEXT,
      status TEXT DEFAULT 'pending',
      action_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES equipments(id),
      FOREIGN KEY (reporter_id) REFERENCES users(id)
    );
  `);

  // ตรวจสอบและลงข้อมูลเริ่มต้น (Seed Data)
  const locCount = await dbInstance.get('SELECT COUNT(*) as count FROM locations');
  if (locCount.count === 0) {
    console.log('>>> กำลังเพิ่มข้อมูลห้อง SC2-307 และอุปกรณ์ทั้งหมดลงฐานข้อมูล...');

    // 1. เพิ่มผู้ใช้งานตัวอย่าง
    await dbInstance.run(`
      INSERT INTO users (name, email, password, role) VALUES 
      ('นิสิตผู้แจ้ง', 'user@test.com', '123', 'user'),
      ('ช่างวิชัย', 'staff@test.com', '123', 'staff'),
      ('แอดมินระบบ', 'admin@test.com', '123', 'admin');
    `);

    // 2. ข้อมูลสถานที่: SC2-307 (ตึก SC2, ชั้น 3, ห้อง 07, ห้องปฏิบัติการคอมพิวเตอร์)
    const locResult = await dbInstance.run(`
      INSERT INTO locations (building_name, floor, room_number, room_type) 
      VALUES ('SC2', '3', '307', 'ห้องปฏิบัติการคอมพิวเตอร์');
    `);
    const locId = locResult.lastID;

    // 3. เพิ่มอุปกรณ์ห้อง SC2-307
    // - คอมพิวเตอร์นักศึกษา 80 เครื่อง (PC-SC2-307-01 ถึง PC-SC2-307-80)
    for (let i = 1; i <= 80; i++) {
      const padNum = String(i).padStart(2, '0');
      await dbInstance.run(
        `INSERT INTO equipments (device_code, name, location_id) VALUES (?, ?, ?)`,
        [`PC-SC2-307-${padNum}`, `เครื่องคอมพิวเตอร์นักศึกษา เครื่องที่ ${i}`, locId]
      );
    }

    // - คอมพิวเตอร์ของอาจารย์ 1 เครื่อง
    await dbInstance.run(
      `INSERT INTO equipments (device_code, name, location_id) VALUES (?, ?, ?)`,
      ['PC-SC2-307-TEACHER', 'เครื่องคอมพิวเตอร์ผู้สอน/อาจารย์', locId]
    );

    // - เครื่องปรับอากาศ 4 เครื่อง
    for (let i = 1; i <= 4; i++) {
      await dbInstance.run(
        `INSERT INTO equipments (device_code, name, location_id) VALUES (?, ?, ?)`,
        [`AC-SC2-307-0${i}`, `เครื่องปรับอากาศ แอร์ตัวที่ ${i}`, locId]
      );
    }

    // - เครื่องโปรเจกเตอร์ 1 ตัว
    await dbInstance.run(
      `INSERT INTO equipments (device_code, name, location_id) VALUES (?, ?, ?)`,
      ['PJ-SC2-307-01', 'เครื่องโปรเจกเตอร์ Epson', locId]
    );

    // - ระบบเครื่องเสียง 1 ชุด
    await dbInstance.run(
      `INSERT INTO equipments (device_code, name, location_id) VALUES (?, ?, ?)`,
      ['AV-SC2-307-01', 'ระบบเครื่องเสียงและแอมป์ขยายเสียง', locId]
    );

    console.log('>>> เพิ่มข้อมูลอุปกรณ์ห้อง SC2-307 ครบถ้วนเรียบร้อย!');
  }

  return dbInstance;
}

module.exports = { getDB };