// ================= DURABLE OBJECT =================
export class ChatRoom {
  constructor(state, env) {
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

      // 🔥 FIX: NORMALIZE ROOM DULU
      let [u1, u2] = data.room.split("_")
      if (u1 > u2) [u1, u2] = [u2, u1]
      const room = `${u1}_${u2}`

      // ===== SAVE MESSAGE =====
      await this.env.DB.prepare(`
        INSERT INTO messages (room, sender, text, created_at, is_read)
        VALUES (?, ?, ?, ?, 0)
      `)
      .bind(room, data.sender, data.text, now)
      .run()

      // ===== UPSERT CHAT =====
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

      // ===== BROADCAST =====
      const payload = JSON.stringify({
        room,
        sender: data.sender,
        text: data.text
      })

      for (const s of this.sessions) {
        s.send(payload)
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

// ================= MAIN WORKER =================
export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() })
    }

    // ===== WEBSOCKET =====
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room")
      const id = env.CHAT_ROOM.idFromName(room)
      return env.CHAT_ROOM.get(id).fetch(request)
    }

    // ===== GET MESSAGE HISTORY =====
    if (url.pathname === "/messages") {
      const room = url.searchParams.get("room")

      const data = await env.DB.prepare(`
        SELECT * FROM messages
        WHERE LOWER(room) = LOWER(?)
        ORDER BY id ASC
      `)
      .bind(room)
      .all()

      return json(data.results)
    }

    // ===== MARK AS READ =====
    if (url.pathname === "/mark-read") {
      const { room, user } = await request.json()

      await env.DB.prepare(`
        UPDATE messages
        SET is_read = 1
        WHERE LOWER(room) = LOWER(?) AND sender != ?
      `)
      .bind(room, user)
      .run()

      return json({ success: true })
    }

    // ===== GET CHATS + UNREAD =====
    if (url.pathname === "/chats") {
      const email = url.searchParams.get("email")

      const data = await env.DB.prepare(`
        SELECT 
          chats.*,
          (
            SELECT COUNT(*) FROM messages 
            WHERE LOWER(room) = LOWER(chats.user1 || '_' || chats.user2)
            AND sender != ?
            AND is_read = 0
          ) as unread
        FROM chats
        WHERE user1 = ? OR user2 = ?
        ORDER BY updated_at DESC
      `)
      .bind(email, email, email)
      .all()

      return json(data.results)
    }

    // ===== CONTACTS =====
    if (url.pathname === "/contacts") {
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

    return new Response("OK")
  }
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
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  }
}
