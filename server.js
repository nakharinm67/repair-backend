const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');
require('dotenv').config();
const { getDB } = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("ngrok-skip-browser-warning", "true");
  next();
});

// ฟังก์ชันส่งข้อความ LINE (Push Message)
async function sendLineMessage(to, messageText) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || token.includes('วาง_') || !to) return;

  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to, messages: [{ type: 'text', text: messageText }] },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );
    console.log(`>>> แจ้งเตือนเข้า LINE (${to}) สำเร็จ`);
  } catch (error) {
    console.error(`LINE Push Error (${to}):`, error.response ? error.response.data : error.message);
  }
}

// ฟังก์ชันตอบกลับข้อความทันที (Reply Message)
async function replyLineMessage(replyToken, messageText) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token || !replyToken) return;

  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/reply',
      {
        replyToken,
        messages: [{ type: 'text', text: messageText }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      }
    );
  } catch (error) {
    console.error('LINE Reply Error:', error.response ? error.response.data : error.message);
  }
}

// ==========================================
// 0. LINE Webhook: ลงทะเบียนช่าง / ผู้ใช้งาน (พร้อมรหัสผ่าน)
// ==========================================
app.post('/api/webhook/line', async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) {
      return res.status(200).send('OK');
    }

    const db = await getDB();

    for (const event of events) {
      const userId = event.source.userId;

      // 1. เมื่อผู้ใช้กด Follow (เพิ่มเพื่อน) หรือ Unblock
      if (event.type === 'follow') {
        const welcomeText = `👋 ยินดีต้อนรับสู่ระบบแจ้งซ่อมอุปกรณ์!\n\n` +
          `🛠️ สำหรับเจ้าหน้าที่ช่าง:\n` +
          `พิมพ์: ลงทะเบียนช่าง <อีเมล> <รหัสผ่าน>\n` +
          `(ตัวอย่าง: ลงทะเบียนช่าง staff@test.com 123)\n\n` +
          `👤 สำหรับผู้แจ้งซ่อม (เพื่อรับผลเมื่อซ่อมเสร็จ):\n` +
          `พิมพ์: ลงทะเบียน <อีเมล> <รหัสผ่าน>\n` +
          `(ตัวอย่าง: ลงทะเบียน user@test.com 123)`;
        await replyLineMessage(event.replyToken, welcomeText);
      }

      // 2. เมื่อได้รับข้อความในแชท
      if (event.type === 'message' && event.message.type === 'text') {
        const text = event.message.text.trim();

        // 2.1 ลงทะเบียนเจ้าหน้าที่ช่าง
        if (text.startsWith('ลงทะเบียนช่าง')) {
          const parts = text.split(/\s+/);
          const email = parts[1];
          const password = parts[2];

          if (!email || !password) {
            await replyLineMessage(
              event.replyToken,
              `⚠️ ข้อมูลไม่ครบถ้วน กรุณาพิมพ์ในรูปแบบ:\n` +
              `ลงทะเบียนช่าง <อีเมล> <รหัสผ่าน>\n` +
              `(ตัวอย่าง: ลงทะเบียนช่าง staff@test.com 123)`
            );
            continue;
          }

          const user = await db.get(
            "SELECT * FROM users WHERE email = ? AND password = ? AND role = 'staff'",
            [email.toLowerCase(), password]
          );

          if (user) {
            await db.run('UPDATE users SET line_user_id = ? WHERE id = ?', [userId, user.id]);
            await db.run(
              `INSERT INTO technicians (line_user_id, name, is_active) VALUES (?, ?, 1)
               ON CONFLICT(line_user_id) DO UPDATE SET name = ?, is_active = 1`,
              [userId, user.name, user.name]
            );

            await replyLineMessage(
              event.replyToken,
              `✅ ยืนยันตัวตนสำเร็จ!\nยินดีต้อนรับคุณ ${user.name} (เจ้าหน้าที่ช่าง)\nระบบจะส่งการแจ้งเตือนงานแจ้งซ่อมใหม่มาที่นี่โดยอัตโนมัติ 🛠️`
            );
          } else {
            await replyLineMessage(
              event.replyToken,
              '❌ อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือบัญชีนี้ไม่มีสิทธิ์เป็นเจ้าหน้าที่ช่าง'
            );
          }
        }

        // 2.2 ลงทะเบียนผู้ใช้งานทั่วไป
        else if (text.startsWith('ลงทะเบียน')) {
          const parts = text.split(/\s+/);
          const email = parts[1];
          const password = parts[2];

          if (!email || !password) {
            await replyLineMessage(
              event.replyToken,
              `⚠️ ข้อมูลไม่ครบถ้วน กรุณาพิมพ์ในรูปแบบ:\n` +
              `ลงทะเบียน <อีเมล> <รหัสผ่าน>\n` +
              `(ตัวอย่าง: ลงทะเบียน user@test.com 123)`
            );
            continue;
          }

          const user = await db.get(
            'SELECT * FROM users WHERE email = ? AND password = ?',
            [email.toLowerCase(), password]
          );

          if (user) {
            await db.run('UPDATE users SET line_user_id = ? WHERE id = ?', [userId, user.id]);
            await replyLineMessage(
              event.replyToken,
              `✅ ผูกบัญชีสำเร็จ!\nสวัสดีคุณ ${user.name} คุณจะได้รับการแจ้งเตือนผ่าน LINE เมื่อช่างปิดงานซ่อมครับ`
            );
          } else {
            await replyLineMessage(
              event.replyToken,
              '❌ อีเมลหรือรหัสผ่านไม่ถูกต้อง'
            );
          }
        }
      }

      // 3. เมื่อช่างบล็อกบอท ให้ปิดสถานะการแจ้งเตือน
      if (event.type === 'unfollow') {
        await db.run('UPDATE technicians SET is_active = 0 WHERE line_user_id = ?', [userId]);
      }
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook Error:', err);
    res.status(500).send('Error');
  }
});

// 1. เข้าสู่ระบบ (Auth)
app.post('/api/auth/login', async (req, res) => {
  try {
    const db = await getDB();
    const { email, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE email = ? AND password = ?', [email, password]);

    if (!user) return res.status(401).json({ message: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });

    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET || 'secret');
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1.1 สมัครสมาชิกสำหรับเจ้าหน้าที่ช่าง
app.post('/api/auth/register-staff', async (req, res) => {
  try {
    const db = await getDB();
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน (name, email, password)' });
    }

    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ message: 'อีเมลนี้ถูกใช้งานไปแล้ว' });
    }

    const result = await db.run(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'staff')",
      [name, email.toLowerCase(), password]
    );

    res.status(201).json({
      message: 'สร้างบัญชีเจ้าหน้าที่ช่างสำเร็จ',
      userId: result.lastID,
      user: {
        id: result.lastID,
        name,
        email: email.toLowerCase(),
        role: 'staff'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 1.2 สมัครสมาชิกสำหรับผู้ใช้งานทั่วไป
app.post('/api/auth/register', async (req, res) => {
  try {
    const db = await getDB();
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'กรุณากรอกข้อมูลให้ครบถ้วน (name, email, password)' });
    }

    const existingUser = await db.get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ message: 'อีเมลนี้ถูกใช้งานไปแล้ว' });
    }

    const result = await db.run(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'user')",
      [name, email.toLowerCase(), password]
    );

    res.status(201).json({
      message: 'สร้างบัญชีผู้ใช้งานสำเร็จ',
      userId: result.lastID,
      user: {
        id: result.lastID,
        name,
        email: email.toLowerCase(),
        role: 'user'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. สแกน QR Code รายชิ้น
app.get('/api/equipments/scan/:device_code', async (req, res) => {
  try {
    const db = await getDB();
    const query = `
      SELECT e.id as device_id, e.device_code, e.name as device_name, e.status as device_status,
             l.building_name, l.floor, l.room_number, l.room_type
      FROM equipments e
      JOIN locations l ON e.location_id = l.id
      WHERE e.device_code = ?
    `;
    const device = await db.get(query, [req.params.device_code]);
    if (!device) return res.status(404).json({ message: 'ไม่พบอุปกรณ์ที่ตรงกับรหัส QR นี้' });

    res.json(device);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// สแกน QR Code ประจำห้อง (แก้ให้ยืดหยุ่น รองรับทั้ง SC2-307, ROOM-SC2-307 หรือ 307)
app.get('/api/locations/room/:room_code', async (req, res) => {
  try {
    const db = await getDB();
    const { room_code } = req.params;

    // ดึงเฉพาะตัวเลขห้องท้ายสุด เช่น SC2-307 -> 307 หรือ ROOM-SC2-307 -> 307
    const parts = room_code.split('-');
    const extractedNumber = parts[parts.length - 1];

    // 1. ค้นหาข้อมูลห้อง (ค้นหาจาก room_number โดยตรง หรือค้นหาจาก SC2 + 307)
    let location = await db.get(
      `SELECT * FROM locations 
       WHERE room_number = ? 
          OR room_number = ? 
          OR (building_name || '-' || room_number) = ?`,
      [room_code, extractedNumber, room_code]
    );

    if (!location) {
      return res.status(404).json({ message: 'ไม่พบข้อมูลห้องนี้ในระบบ' });
    }

    // 2. ดึงรายการอุปกรณ์ทั้งหมดที่อยู่ในห้องนี้
    const equipments = await db.all(
      `SELECT id as device_id, device_code, name as device_name, status
       FROM equipments
       WHERE location_id = ?
       ORDER BY id ASC`,
      [location.id]
    );

    res.json({
      location: {
        id: location.id,
        building_name: location.building_name,
        floor: location.floor,
        room_number: location.room_number,
        room_type: location.room_type
      },
      total_devices: equipments.length,
      equipments: equipments
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. ตรวจสอบการแจ้งซ่อมซ้ำ
app.get('/api/tickets/check-duplicate', async (req, res) => {
  try {
    const db = await getDB();
    const { device_id } = req.query;
    const existingTicket = await db.get(
      "SELECT * FROM tickets WHERE device_id = ? AND status IN ('pending', 'in_progress')",
      [device_id]
    );

    if (existingTicket) {
      return res.json({
        is_duplicate: true,
        message: 'อุปกรณ์นี้มีรายการแจ้งซ่อมอยู่แล้วและกำลังดำเนินการ',
        ticket: existingTicket
      });
    }
    res.json({ is_duplicate: false, message: 'พร้อมสำหรับการแจ้งซ่อม' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. ส่งฟอร์มแจ้งซ่อมใหม่ + แจ้งเตือนเข้า LINE ช่างทุกคน
app.post('/api/tickets', async (req, res) => {
  try {
    const db = await getDB();
    const { device_id, reporter_id, description, image_url } = req.body;

    if (!device_id || !description) {
      return res.status(400).json({ message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const result = await db.run(
      "INSERT INTO tickets (device_id, reporter_id, description, image_url, status) VALUES (?, ?, ?, ?, 'pending')",
      [device_id, reporter_id || 1, description, image_url || null]
    );
    const newTicketId = result.lastID;

    // ดึงข้อมูลอุปกรณ์และสถานที่มาสร้างข้อความแจ้งเตือน
    const info = await db.get(`
      SELECT e.name as device_name, e.device_code, l.building_name, l.floor, l.room_number
      FROM equipments e
      JOIN locations l ON e.location_id = l.id
      WHERE e.id = ?
    `, [device_id]);

    const alertText = `🔧 มีงานแจ้งซ่อมใหม่! (Ticket #${newTicketId})\n` +
      `• อุปกรณ์: ${info ? info.device_name : 'ID ' + device_id} (${info ? info.device_code : ''})\n` +
      `• สถานที่: อาคาร ${info ? info.building_name : ''} ชั้น ${info ? info.floor : ''} ห้อง ${info ? info.room_number : ''}\n` +
      `• อาการเสีย: ${description}`;

    const technicians = await db.all('SELECT line_user_id FROM technicians WHERE is_active = 1');

    if (technicians && technicians.length > 0) {
      for (const tech of technicians) {
        await sendLineMessage(tech.line_user_id, alertText);
      }
    } else {
      const fallbackId = process.env.TEST_LINE_USER_ID;
      if (fallbackId) await sendLineMessage(fallbackId, alertText);
    }

    res.status(201).json({
      message: 'ส่งรายการแจ้งซ่อมสำเร็จ',
      ticket_id: newTicketId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ช่างอัปเดตสถานะ/ปิดงาน + แจ้งเตือนกลับหาผู้แจ้ง
app.patch('/api/tickets/:id/status', async (req, res) => {
  try {
    const db = await getDB();
    const ticketId = req.params.id;
    const { status, action_note } = req.body;

    const ticket = await db.get(`
      SELECT t.*, u.line_user_id as reporter_line_id, e.name as device_name
      FROM tickets t
      LEFT JOIN users u ON t.reporter_id = u.id
      LEFT JOIN equipments e ON t.device_id = e.id
      WHERE t.id = ?
    `, [ticketId]);

    if (!ticket) return res.status(404).json({ message: 'ไม่พบใบงานซ่อมนี้' });

    await db.run(
      'UPDATE tickets SET status = COALESCE(?, status), action_note = COALESCE(?, action_note) WHERE id = ?',
      [status, action_note, ticketId]
    );

    if (status === 'completed') {
      const notifyText = `✅ งานแจ้งซ่อมของคุณได้รับการแก้ไขแล้ว!\n` +
        `• ใบงาน: #${ticketId} (${ticket.device_name || 'อุปกรณ์'})\n` +
        `• ผลการซ่อม: ${action_note || 'ซ่อมแซมเรียบร้อยแล้ว'}\n` +
        `ขอบคุณที่แจ้งปัญหาเข้ามาครับ 🙏`;

      const targetUserLine = ticket.reporter_line_id || process.env.TEST_LINE_USER_ID;
      if (targetUserLine) {
        await sendLineMessage(targetUserLine, notifyText);
      }
    }

    res.json({ message: 'อัปเดตสถานะใบงานเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ==========================================
// 5.1 ดึงรายการแจ้งซ่อมทั้งหมด (สำหรับช่าง/แอดมิน)
// ==========================================
app.get('/api/tickets', async (req, res) => {
  try {
    const db = await getDB();
    const query = `
      SELECT 
        t.id,
        t.description,
        t.status,
        t.action_note,
        t.created_at,
        t.updated_at,
        e.device_code,
        e.name as device_name,
        l.building_name,
        l.floor,
        l.room_number,
        u.name as reporter_name
      FROM tickets t
      LEFT JOIN equipments e ON t.device_id = e.id
      LEFT JOIN locations l ON e.location_id = l.id
      LEFT JOIN users u ON t.reporter_id = u.id
      ORDER BY t.created_at DESC
    `;

    const tickets = await db.all(query);
    res.json(tickets);
  } catch (err) {
    console.error('Error fetching tickets:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5.2 ดึงรายการแจ้งซ่อมตาม ID ผู้ใช้ (สำหรับหน้า "ประวัติของฉัน")
// ==========================================
app.get('/api/tickets/user/:user_id', async (req, res) => {
  try {
    const db = await getDB();
    const { user_id } = req.params;
    const query = `
      SELECT 
        t.id,
        t.description,
        t.status,
        t.action_note,
        t.created_at,
        t.updated_at,
        e.device_code,
        e.name as device_name,
        l.building_name,
        l.floor,
        l.room_number
      FROM tickets t
      LEFT JOIN equipments e ON t.device_id = e.id
      LEFT JOIN locations l ON e.location_id = l.id
      WHERE t.reporter_id = ?
      ORDER BY t.created_at DESC
    `;

    const tickets = await db.all(query, [user_id]);
    res.json(tickets);
  } catch (err) {
    console.error('Error fetching user tickets:', err);
    res.status(500).json({ error: err.message });
  }
});

// 6. ดึงสถิติ Dashboard สำหรับ Admin
app.get('/api/admin/dashboard-stats', async (req, res) => {
  try {
    const db = await getDB();
    const total = await db.get('SELECT COUNT(*) as count FROM tickets');
    const pending = await db.get("SELECT COUNT(*) as count FROM tickets WHERE status = 'pending'");
    const inProgress = await db.get("SELECT COUNT(*) as count FROM tickets WHERE status = 'in_progress'");
    const completed = await db.get("SELECT COUNT(*) as count FROM tickets WHERE status = 'completed'");

    res.json({
      summary: {
        total: total.count,
        pending: pending.count,
        inProgress: inProgress.count,
        completed: completed.count
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// เริ่มต้นฐานข้อมูลแล้วเปิดเซิร์ฟเวอร์
async function startServer() {
  try {
    await getDB();
    const serverPort = process.env.PORT || 5000;
    app.listen(serverPort, '0.0.0.0', () => {
      console.log(`🚀 Server is running on port ${serverPort}`);
    });
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }
}

startServer();