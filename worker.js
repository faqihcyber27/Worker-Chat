// ================= DO CLASS =================
export class ChatRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Set()
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    server.accept()
    this.sessions.add(server)

    server.addEventListener("message", async (event) => {
  const data = JSON.parse(event.data)
  const now = new Date().toISOString()

  // ================= 🔥 TYPING =================
  if (data.type === "typing") {

  // 🔥 ambil nama user
  const user = await this.env.DB.prepare(`
    SELECT name FROM users WHERE email = ?
  `).bind(data.sender).first()

  for (const s of this.sessions) {
    s.send(JSON.stringify({
      type: "typing",
      sender: data.sender,
      name: user?.name || data.sender
    }))
  }
  return
  }

  // ================= 🔥 ONLINE =================
  if (data.type === "online") {
    for (const s of this.sessions) {
      s.send(JSON.stringify({
        type: "online",
        user: data.user
      }))
    }
    return
  }

      let [u1, u2] = data.room.split("_")
      if (u1 > u2) [u1, u2] = [u2, u1]

      await this.env.DB.prepare(`
        INSERT INTO messages (
  room,
  sender,
  text,
  file,
  file_name,
  file_type,
  created_at,
  is_read
)
VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `)
      .bind(
  data.room,
  data.sender,
  data.text || null,
  data.file || null,
  data.file_name || null,
  data.file_type || "file",
  now
)
      .run()

      await this.env.DB.prepare(`
        INSERT INTO chats (user1, user2, last_message, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user1, user2)
        DO UPDATE SET
          last_message = excluded.last_message,
          updated_at = excluded.updated_at
      `)
      .bind(u1, u2, data.text, now)
      .run()

      const payload = {
  room: data.room,
  sender: data.sender,
  text: data.text || null,
  file: data.file || null,
  file_name: data.file_name || null,
  file_type: data.file_type || null,
  created_at: now
}

for (const s of this.sessions) {
  s.send(JSON.stringify(payload))
}
    })

    server.addEventListener("close", () => {
      this.sessions.delete(server)
    })

    return new Response(null, {
      status: 101,
      webSocket: client
    })
  }
}

// ================= MAIN =================
export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() })
    }

    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room")
      const id = env.CHAT_ROOM.idFromName(room)
      return env.CHAT_ROOM.get(id).fetch(request)
    }

    if (url.pathname === "/messages") {
      const room = url.searchParams.get("room")

      const data = await env.DB.prepare(`
        SELECT * FROM messages
        WHERE room = ?
        ORDER BY id ASC
      `)
      .bind(room)
      .all()

      return json(data.results)
    }

    // 🔥 TAMBAHAN (AMAN)
    if (url.pathname === "/mark-read") return markRead(request, env)
    if (url.pathname === "/delete-chat") return deleteChat(request, env)

    if (url.pathname === "/register") return register(request, env)
    if (url.pathname === "/login") return login(request, env)

    if (url.pathname === "/send-request") return sendRequest(request, env)
    if (url.pathname === "/requests") return getRequests(request, env)
    if (url.pathname === "/respond-request") return respondRequest(request, env)

    if (url.pathname === "/contacts") return getContacts(request, env)
    if (url.pathname === "/delete-contact") return deleteContact(request, env)

    if (url.pathname === "/chats") return getChats(request, env)
    if (url.pathname === "/pin-chat") return pinChat(request, env)

    return new Response("Not found", { status: 404 })
  }
}

// ================= DELETE CHAT (NEW) =================
async function deleteChat(request, env) {
  const { user1, user2 } = await request.json()

  let [u1, u2] = [user1, user2]
  if (u1 > u2) [u1, u2] = [u2, u1]

  const room = `${u1}_${u2}`

  await env.DB.prepare(`
    DELETE FROM messages WHERE room = ?
  `)
  .bind(room)
  .run()

  await env.DB.prepare(`
    DELETE FROM chats WHERE user1 = ? AND user2 = ?
  `)
  .bind(u1, u2)
  .run()

  return json({ success: true })
}

  // Mark Read
  async function markRead(request, env) {
  const { room, user } = await request.json()

  await env.DB.prepare(`
    UPDATE messages
    SET is_read = 1
    WHERE room = ?
    AND sender != ?
  `)
  .bind(room, user)
  .run()

  return json({ success: true })
  }

async function pinChat(request, env) {
  const { user1, user2, pinned } = await request.json()

  let [u1, u2] = [user1, user2]
  if (u1 > u2) [u1, u2] = [u2, u1]

  await env.DB.prepare(`
    UPDATE chats
    SET pinned = ?
    WHERE user1 = ? AND user2 = ?
  `)
  .bind(pinned ? 1 : 0, u1, u2)
  .run()

  return json({ success: true })
}

// ================= AUTH =================
async function hash(password) {
  const data = new TextEncoder().encode(password)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

async function register(request, env) {
  const { name, email, password } = await request.json()
  const hashed = await hash(password)

  try {
    await env.DB.prepare(`
      INSERT INTO users (name, email, password, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .bind(name, email, hashed, new Date().toISOString())
    .run()

    return json({ success: true })
  } catch {
    return json({ error: "Email sudah terdaftar" }, 400)
  }
}

async function login(request, env) {
  const { email, password } = await request.json()
  const hashed = await hash(password)

  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE email = ?
  `).bind(email).first()

  if (!user || user.password !== hashed) {
    return json({ error: "Login gagal" }, 401)
  }

  return json({
    token: btoa(email),
    user: { name: user.name, email: user.email }
  })
}

// ================= FRIEND REQUEST =================
async function sendRequest(request, env) {
  const { from_email, to_email } = await request.json()

  if (from_email === to_email) {
    return json({ error: "Tidak bisa add diri sendiri" }, 400)
  }

  await env.DB.prepare(`
    INSERT INTO contact_requests (from_email, to_email, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `)
  .bind(from_email, to_email, new Date().toISOString())
  .run()

  return json({ success: true })
}

async function getRequests(request, env) {
  const email = new URL(request.url).searchParams.get("email")

  const data = await env.DB.prepare(`
    SELECT * FROM contact_requests
    WHERE to_email = ? AND status='pending'
  `).bind(email).all()

  return json(data.results)
}

async function respondRequest(request, env) {
  const { id, action } = await request.json()

  const req = await env.DB.prepare(`
    SELECT * FROM contact_requests WHERE id=?
  `).bind(id).first()

  if (!req) return json({ error: "Not found" }, 404)

  if (action === "accept") {
    await env.DB.prepare(`
      UPDATE contact_requests SET status='accepted' WHERE id=?
    `).bind(id).run()

    await env.DB.prepare(`
      INSERT INTO contacts (user_email, friend_email, created_at)
      VALUES (?, ?, ?)
    `).bind(req.from_email, req.to_email, new Date().toISOString()).run()

    await env.DB.prepare(`
      INSERT INTO contacts (user_email, friend_email, created_at)
      VALUES (?, ?, ?)
    `).bind(req.to_email, req.from_email, new Date().toISOString()).run()
  }

  if (action === "reject") {
    await env.DB.prepare(`
      UPDATE contact_requests SET status='rejected' WHERE id=?
    `).bind(id).run()
  }

  return json({ success: true })
}

// ================= CONTACT =================
async function getContacts(request, env) {
  const email = new URL(request.url).searchParams.get("email")

  const data = await env.DB.prepare(`
    SELECT users.name, users.email
    FROM contacts
    JOIN users ON users.email = contacts.friend_email
    WHERE contacts.user_email = ?
  `)
  .bind(email)
  .all()

  return json(data.results)
}

async function deleteContact(request, env) {
  const { user_email, friend_email } = await request.json()

  await env.DB.prepare(`
    DELETE FROM contacts 
    WHERE (LOWER(user_email)=LOWER(?) AND LOWER(friend_email)=LOWER(?))
       OR (LOWER(user_email)=LOWER(?) AND LOWER(friend_email)=LOWER(?))
  `)
  .bind(user_email, friend_email, friend_email, user_email)
  .run()

  return json({ success: true })
}

// ================= CHAT LIST =================
async function getChats(request, env) {
  const email = new URL(request.url).searchParams.get("email")

  let data = await env.DB.prepare(`
    SELECT 
      chats.*,

      (
        SELECT COUNT(*) 
        FROM messages 
        WHERE messages.room =
          CASE 
            WHEN chats.user1 < chats.user2 
            THEN chats.user1 || '_' || chats.user2
            ELSE chats.user2 || '_' || chats.user1
          END
        AND messages.sender != ?
        AND messages.is_read = 0
      ) as unread,
    (
  SELECT COALESCE(file_type, '') 
  FROM messages m2 
  WHERE m2.room =
    CASE 
      WHEN chats.user1 < chats.user2 
      THEN chats.user1 || '_' || chats.user2
      ELSE chats.user2 || '_' || chats.user1
    END
  ORDER BY m2.created_at DESC LIMIT 1
) as last_file_type

    FROM chats
    WHERE user1 = ? OR user2 = ?
    ORDER BY updated_at DESC
  `)
  .bind(email, email, email)
  .all()

  if (!data.results.length) {
    data = await env.DB.prepare(`
      SELECT 
        room,
        MAX(created_at) as updated_at,
        SUBSTR(room, 1, INSTR(room, '_')-1) as user1,
        SUBSTR(room, INSTR(room, '_')+1) as user2,
        (
          SELECT text FROM messages m2 
          WHERE m2.room = m1.room 
          ORDER BY id DESC LIMIT 1
        ) as last_message
      FROM messages m1
      WHERE room LIKE '%' || ? || '%'
      GROUP BY room
      ORDER BY updated_at DESC
    `)
    .bind(email)
    .all()
  }

  // 🔥 MAP KE NAMA
  const result = await Promise.all(data.results.map(async (c) => {

    const friendEmail =
      c.user1 === email ? c.user2 : c.user1

    const user = await env.DB.prepare(`
      SELECT name FROM users WHERE email = ?
    `)
    .bind(friendEmail)
    .first()

    return {
      ...c,
      friend_email: friendEmail,
      friend_name: user?.name || friendEmail
    }
  }))

  return json(result)
}

// ================= HELPER =================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(),
      "Content-Type": "application/json"
    }
  })
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  }
}
