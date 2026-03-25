export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === "POST" && url.pathname === "/register") {
      return register(request, env)
    }

    if (request.method === "POST" && url.pathname === "/login") {
      return login(request, env)
    }

    return new Response("Not found", { status: 404 })
  }
}

// 🔐 hash password
async function hash(password) {
  const data = new TextEncoder().encode(password)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(hashBuffer)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

// 📝 REGISTER
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
  } catch (e) {
    return json({ error: "Email sudah terdaftar" }, 400)
  }
}

// 🔑 LOGIN
async function login(request, env) {
  const { email, password } = await request.json()
  const hashed = await hash(password)

  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE email = ?
  `)
  .bind(email)
  .first()

  if (!user || user.password !== hashed) {
    return json({ error: "Login gagal" }, 401)
  }

  const token = btoa(email + ":" + Date.now())

  return json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email
    }
  })
}

// helper
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  })
}
