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
  if (!token || token.includes('วาง_')) return;

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

// ==========================================
// 0. LINE Webhook: ลงทะเบียนช่างอัตโนมัติเมื่อกดเพิ่มเพื่อน
// ==========================================
app.post('/api/webhook/line', async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) {
      return res.status(200).send('OK');
    }

    const db = await getDB();
    const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

    for (const event of events) {
      const userId = event.source.userId;

      // เมื่อช่างกด Follow (เพิ่มเพื่อน) หรือ Unblock หรือส่งข้อความว่า "ลงทะเบียนช่าง"
      if (
        event.type === 'follow' ||
        (event.type === 'message' && event.message.type === 'text' && event.message.text.trim() === 'ลงทะเบียนช่าง')
      ) {
        try {
          await db.run(
            `INSERT OR IGNORE INTO technicians (line_user_id, name, is_active) VALUES (?, ?, 1)`,
            [userId, 'ช่างซ่อม']
          );
          // หากเคยบล็อกไว้แล้วปลดบล็อก ให้เปิดสถานะกลับมาเป็น active
          await db.run(`UPDATE technicians SET is_active = 1 WHERE line_user_id = ?`, [userId]);
          console.log(`[LINE Bot] ลงทะเบียนช่างสำเร็จ: ${userId}`);

          // ตอบกลับข้อความอัตโนมัติหาช่าง
          if (event.replyToken && token) {
            await axios.post(
              'https://api.line.me/v2/bot/message/reply',
              {
                replyToken: event.replyToken,
                messages: [
                  {
                    type: 'text',
                    text: '🛠️ ยินดีต้อนรับสู่ระบบแจ้งซ่อม!\nคุณได้ลงทะเบียนเป็นช่างผู้รับการแจ้งเตือนงานซ่อมเรียบร้อยแล้วครับ เมื่อมีผู้แจ้งซ่อมระบบจะส่งงานให้คุณอัตโนมัติ'
                  }
                ]
              },
              {
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                }
              }
            );
          }
        } catch (dbErr) {
          console.error('Error saving technician to DB:', dbErr);
        }
      }

      // เมื่อช่างบล็อกบอท (Unfollow) ให้ปิดการแจ้งเตือน
      if (event.type === 'unfollow') {
        try {
          await db.run(`UPDATE technicians SET is_active = 0 WHERE line_user_id = ?`, [userId]);
          console.log(`[LINE Bot] ปิดการแจ้งเตือนช่าง (Unfollow): ${userId}`);
        } catch (dbErr) {
          console.error('Error updating unfollow technician:', dbErr);
        }
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

// 2. สแกน QR Code เพื่อดึงข้อมูลอุปกรณ์และสถานที่ (R4)
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

// 3. ตรวจสอบการแจ้งซ่อมซ้ำ (R2)
app.get('/api/tickets/check-duplicate', async (req, res) => {
  try {
    const db = await getDB();
    const { device_id } = req.query;
    const existingTicket = await db.get(
      'SELECT * FROM tickets WHERE device_id = ? AND status IN ("pending", "in_progress")',
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

// 4. ส่งฟอร์มแจ้งซ่อมใหม่ + แจ้งเตือนเข้า LINE ช่างทุกคน (R1)
app.post('/api/tickets', async (req, res) => {
  try {
    const db = await getDB();
    const { device_id, reporter_id, description, image_url } = req.body;

    if (!device_id || !description) {
      return res.status(400).json({ message: 'ข้อมูลไม่ครบถ้วน' });
    }

    const result = await db.run(
      'INSERT INTO tickets (device_id, reporter_id, description, image_url, status) VALUES (?, ?, ?, ?, "pending")',
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

    // ดึงรายชื่อช่างทั้งหมดที่ active จากฐานข้อมูล
    const technicians = await db.all('SELECT line_user_id FROM technicians WHERE is_active = 1');

    if (technicians && technicians.length > 0) {
      // กระจายแจ้งเตือนหาช่างทุกคน
      for (const tech of technicians) {
        await sendLineMessage(tech.line_user_id, alertText);
      }
    } else {
      // Fallback: ถ้ายังไม่มีช่างลงทะเบียน ให้ส่งหา TEST_LINE_USER_ID สำรอง
      const fallbackId = process.env.TEST_LINE_USER_ID;
      if (fallbackId) {
        await sendLineMessage(fallbackId, alertText);
      }
    }

    res.status(201).json({
      message: 'ส่งรายการแจ้งซ่อมสำเร็จ',
      ticket_id: newTicketId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. ช่างอัปเดตสถานะ/ปิดงาน + แจ้งเตือนกลับหาผู้แจ้ง (R5)
app.patch('/api/tickets/:id/status', async (req, res) => {
  try {
    const db = await getDB();
    const ticketId = req.params.id;
    const { status, action_note } = req.body;

    const ticket = await db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
    if (!ticket) return res.status(404).json({ message: 'ไม่พบใบงานซ่อมนี้' });

    await db.run(
      'UPDATE tickets SET status = COALESCE(?, status), action_note = COALESCE(?, action_note) WHERE id = ?',
      [status, action_note, ticketId]
    );

    if (status === 'completed') {
      const notifyText = `✅ งานแจ้งซ่อมของคุณเสร็จสิ้นแล้ว!\n` +
        `• หมายเลขใบงาน: #${ticketId}\n` +
        `• ผลการซ่อม: ${action_note || 'ซ่อมแซมเรียบร้อย'}\n` +
        `ขอบคุณที่แจ้งปัญหาให้เราทราบครับ`;

      const targetLineId = process.env.TEST_LINE_USER_ID;
      if (targetLineId) {
        await sendLineMessage(targetLineId, notifyText);
      }
    }

    res.json({ message: 'อัปเดตสถานะใบงานเรียบร้อย' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. ดึงสถิติ Dashboard สำหรับ Admin (R3)
app.get('/api/admin/dashboard-stats', async (req, res) => {
  try {
    const db = await getDB();
    const total = await db.get('SELECT COUNT(*) as count FROM tickets');
    const pending = await db.get('SELECT COUNT(*) as count FROM tickets WHERE status = "pending"');
    const inProgress = await db.get('SELECT COUNT(*) as count FROM tickets WHERE status = "in_progress"');
    const completed = await db.get('SELECT COUNT(*) as count FROM tickets WHERE status = "completed"');

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