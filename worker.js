// ================= DO CLASS =================
export class ChatRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Set()
    this.onlineUsers = new Map()
  }

  // 🔥 SAFE BROADCAST
  broadcast(payload, roomName = null) {
    for (const s of this.sessions) {
      if (!roomName || s.room === roomName) {
        if (s.readyState === 1) {
          try {
            s.send(JSON.stringify(payload))
          } catch (e) {}
        }
      }
    }
  }

  async fetch(request) {

    // 🔥 INTERNAL GLOBAL BROADCAST
    if (request.method === "POST") {
      const data = await request.json()
      this.broadcast(data)
      return new Response("ok")
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    const url = new URL(request.url)
    const roomName = url.searchParams.get("room")

    server.accept()
    server.room = roomName
    this.sessions.add(server)

    server.addEventListener("message", async (event) => {
      const data = JSON.parse(event.data)
      const now = new Date().toISOString()

      // ================= READ =================
      if (data.type === "read") {
        this.broadcast({
          type: "read",
          user: data.user,
          room: data.room
        }, roomName)
        return
      }

      // ================= TYPING =================
      if (data.type === "typing") {
        const user = await this.env.DB.prepare(`
          SELECT name FROM users WHERE email = ?
        `).bind(data.sender).first()

        this.broadcast({
          type: "typing",
          sender: data.sender,
          name: user?.name || data.sender,
          room: roomName
        }, roomName)

        return
      }

      // ================= ONLINE =================
      if (data.type === "online" && roomName === "global") {

        // 🔥 prevent duplicate
        if (this.onlineUsers.has(data.user)) {
          try {
            this.onlineUsers.get(data.user).close()
          } catch(e){}
        }

        this.onlineUsers.set(data.user, server)

        await this.env.DB.prepare(`
          UPDATE users SET last_seen = ? WHERE email = ?
        `).bind(now, data.user).run()

        const payload = {
          type: "online_list",
          users: Array.from(this.onlineUsers.keys())
        }

        // local
        this.broadcast(payload)

        // global sync
        const globalId = this.env.CHAT_ROOM.idFromName("global")
        const globalRoom = this.env.CHAT_ROOM.get(globalId)

        await globalRoom.fetch(new Request("https://internal", {
          method: "POST",
          body: JSON.stringify(payload)
        }))

        return
      }

      // ================= MESSAGE =================
      let [u1, u2] = data.room.split("_")
      if (u1 > u2) [u1, u2] = [u2, u1]

      await this.env.DB.prepare(`
        INSERT INTO messages (
          room, sender, text, file, file_name, file_type, created_at, is_read
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `)
      .bind(
        data.room,
        data.sender,
        data.text || null,
        data.file || null,
        data.file_name || null,
        data.file_type || (data.file ? "image" : null),
        now
      )
      .run()

      const lastMsg =
        data.text ||
        (data.file_type?.includes("image") ? "📷 Foto" : "📎 File")

      await this.env.DB.prepare(`
        INSERT INTO chats (user1, user2, last_message, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user1, user2)
        DO UPDATE SET
          last_message = excluded.last_message,
          updated_at = excluded.updated_at
      `)
      .bind(u1, u2, lastMsg, now)
      .run()

      const payload = {
        type: "message",
        room: data.room,
        sender: data.sender,
        text: data.text || null,
        file: data.file || null,
        file_name: data.file_name || null,
        file_type: data.file_type || null,
        created_at: now
      }

      // 🔥 ROOM (chat.html)
      this.broadcast(payload, roomName)

      // 🔥 GLOBAL (chats.html)
      const globalId = this.env.CHAT_ROOM.idFromName("global")
      const globalRoom = this.env.CHAT_ROOM.get(globalId)

      await globalRoom.fetch(new Request("https://internal", {
        method: "POST",
        body: JSON.stringify(payload)
      }))

      // delivered
      this.broadcast({
        type: "delivered",
        room: data.room,
        sender: data.sender
      }, roomName)
    })

    // ================= CLOSE =================
    server.addEventListener("close", async () => {
      this.sessions.delete(server)

      // remove online
      for (const [email, ws] of this.onlineUsers) {
        if (ws === server) {
          this.onlineUsers.delete(email)
        }
      }

      const payload = {
        type: "online_list",
        users: Array.from(this.onlineUsers.keys())
      }

      // 🔥 broadcast global
      this.broadcast(payload)

      const globalId = this.env.CHAT_ROOM.idFromName("global")
      const globalRoom = this.env.CHAT_ROOM.get(globalId)

      await globalRoom.fetch(new Request("https://internal", {
        method: "POST",
        body: JSON.stringify(payload)
      }))
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

    if (url.pathname === "/respond-request")
      return respondRequest(request, env)

    if (url.pathname === "/delete-contact")
      return deleteContact(request, env)

    return new Response("Not found", { status: 404 })
  }
}

// ================= FRIEND ACCEPT =================
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

    const payload = {
      type: "friend_accept",
      from: req.from_email,
      to: req.to_email
    }

    const globalId = env.CHAT_ROOM.idFromName("global")
    const globalRoom = env.CHAT_ROOM.get(globalId)

    await globalRoom.fetch(new Request("https://internal", {
      method: "POST",
      body: JSON.stringify(payload)
    }))
  }

  return json({ success: true })
}

// ================= DELETE CONTACT =================
async function deleteContact(request, env) {
  const { user_email, friend_email } = await request.json()

  await env.DB.prepare(`
    DELETE FROM contacts 
    WHERE (user_email=? AND friend_email=?)
       OR (user_email=? AND friend_email=?)
  `)
  .bind(user_email, friend_email, friend_email, user_email)
  .run()

  const payload = {
    type: "contact_deleted",
    user: user_email,
    friend: friend_email
  }

  const globalId = env.CHAT_ROOM.idFromName("global")
  const globalRoom = env.CHAT_ROOM.get(globalId)

  await globalRoom.fetch(new Request("https://internal", {
    method: "POST",
    body: JSON.stringify(payload)
  }))

  return json({ success: true })
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
