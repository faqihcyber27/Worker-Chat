export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() })
    }

    // AUTH
    if (url.pathname === "/register") return register(request, env)
    if (url.pathname === "/login") return login(request, env)

    // FRIEND REQUEST
    if (url.pathname === "/send-request") return sendRequest(request, env)
    if (url.pathname === "/requests") return getRequests(request, env)
    if (url.pathname === "/respond-request") return respondRequest(request, env)

    // CONTACT
    if (url.pathname === "/contacts") return getContacts(request, env)

    // CHAT LIST
    if (url.pathname === "/chats") return getChats(request, env)

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
    user: { name: user.name, email: user.email }
  })
}

// ===== FRIEND REQUEST =====
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

    // insert 2 arah
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

// ===== CONTACT =====
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

// ===== CHAT LIST =====
async function getChats(request, env) {
  const email = new URL(request.url).searchParams.get("email")

  const data = await env.DB.prepare(`
    SELECT * FROM chats
    WHERE user1 = ? OR user2 = ?
    ORDER BY updated_at DESC
  `).bind(email, email).all()

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
