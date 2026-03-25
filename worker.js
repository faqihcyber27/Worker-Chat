export class ChatRoom {
  constructor(state, env) {
    this.sessions = new Set()
    this.env = env
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

      // simpan ke DB
      await this.env.DB.prepare(`
        INSERT INTO messages (user, message, created_at)
        VALUES (?, ?, ?)
      `)
      .bind(data.user, data.text, new Date().toISOString())
      .run()

      // broadcast
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() })
    }

    // AUTH
    if (request.method === "POST" && url.pathname === "/register") {
      return register(request, env)
    }

    if (request.method === "POST" && url.pathname === "/login") {
      return login(request, env)
    }

    // CONTACT
    if (request.method === "POST" && url.pathname === "/add-friend") {
      return addFriend(request, env)
    }

    if (url.pathname === "/contacts") {
      return getContacts(request, env)
    }

    // CHAT HISTORY
    if (url.pathname === "/messages") {
      const data = await env.DB.prepare(`
        SELECT * FROM messages ORDER BY id ASC LIMIT 50
      `).all()

      return json(data.results)
    }

    // WEBSOCKET
    if (url.pathname === "/ws") {
      const id = env.CHAT_ROOM.idFromName("global")
      return env.CHAT_ROOM.get(id).fetch(request)
    }

    return new Response("Not found", { status: 404 })
  }
}

// ===== AUTH =====
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
    user: {
      name: user.name,
      email: user.email
    }
  })
}

// ===== CONTACT =====
async function addFriend(request, env) {
  const { user_email, friend_email } = await request.json()

  if (user_email === friend_email) {
    return json({ error: "Tidak bisa add diri sendiri" }, 400)
  }

  const friend = await env.DB.prepare(`
    SELECT * FROM users WHERE email = ?
  `).bind(friend_email).first()

  if (!friend) {
    return json({ error: "User tidak ditemukan" }, 404)
  }

  await env.DB.prepare(`
    INSERT INTO contacts (user_email, friend_email, created_at)
    VALUES (?, ?, ?)
  `)
  .bind(user_email, friend_email, new Date().toISOString())
  .run()

  return json({ success: true })
}

async function getContacts(request, env) {
  const url = new URL(request.url)
  const email = url.searchParams.get("email")

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

// ===== HELPERS =====
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
