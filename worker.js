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

      await this.env.DB.prepare(`
        INSERT INTO messages (room, sender, text, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .bind(data.room, data.sender, data.text, new Date().toISOString())
      .run()

      for (const s of this.sessions) {
        s.send(JSON.stringify(data))
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

    if (url.pathname === "/chats") return getChats(request, env)
    if (url.pathname === "/delete-chat") return deleteChat(request, env)

    if (url.pathname === "/contacts") return getContacts(request, env)
    if (url.pathname === "/send-request") return sendRequest(request, env)
    if (url.pathname === "/requests") return getRequests(request, env)
    if (url.pathname === "/respond-request") return respondRequest(request, env)
    if (url.pathname === "/delete-contact") return deleteContact(request, env)

    if (url.pathname === "/register") return register(request, env)
    if (url.pathname === "/login") return login(request, env)

    return new Response("Not found", { status: 404 })
  }
}

// ================= CHAT LIST =================
async function getChats(request, env) {
  const email = new URL(request.url).searchParams.get("email")

  const data = await env.DB.prepare(`
    SELECT 
      m1.room,
      MAX(m1.created_at) as updated_at,

      SUBSTR(m1.room, 1, INSTR(m1.room, '_')-1) as user1,
      SUBSTR(m1.room, INSTR(m1.room, '_')+1) as user2,

      (
        SELECT text FROM messages m2 
        WHERE m2.room = m1.room 
        ORDER BY id DESC LIMIT 1
      ) as last_message

    FROM messages m1
    WHERE m1.room LIKE '%' || ? || '%'
    GROUP BY m1.room
    ORDER BY updated_at DESC
  `)
  .bind(email)
  .all()

  const results = await Promise.all(data.results.map(async (c) => {
    const friendEmail = c.user1 === email ? c.user2 : c.user1

    const user = await env.DB.prepare(`
      SELECT name FROM users WHERE email = ?
    `).bind(friendEmail).first()

    return {
      ...c,
      friend_email: friendEmail,
      friend_name: user?.name || friendEmail
    }
  }))

  return json(results)
}

// ================= DELETE CHAT =================
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

  await env.DB.prepare(`
    INSERT INTO users (name, email, password, created_at)
    VALUES (?, ?, ?, ?)
  `)
  .bind(name, email, hashed, new Date().toISOString())
  .run()

  return json({ success: true })
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
    user: { name: user.name, email: user.email }
  })
}

// ================= REQUEST =================
async function sendRequest(request, env) {
  const { from_email, to_email } = await request.json()

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
  `)
  .bind(email)
  .all()

  return json(data.results)
}

async function respondRequest(request, env) {
  const { id } = await request.json()

  const req = await env.DB.prepare(`
    SELECT * FROM contact_requests WHERE id=?
  `).bind(id).first()

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

  return json({ success: true })
}

async function deleteContact(request, env) {
  const { user_email, friend_email } = await request.json()

  await env.DB.prepare(`
    DELETE FROM contacts 
    WHERE (user_email=? AND friend_email=?)
       OR (user_email=? AND friend_email=?)
  `)
  .bind(user_email, friend_email, friend_email, user_email)
  .run()

  return json({ success: true })
}

// ================= HELPER =================
function json(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      ...cors()
    }
  })
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  }
}
