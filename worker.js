// ================= DO CLASS =================
export class ChatRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Set()
    this.onlineUsers = new Map()
  }

  broadcast(payload, roomName = null) {
    for (const s of this.sessions) {
      if (!roomName || s.room === roomName) {
        if (s.readyState === 1) {
          try { s.send(JSON.stringify(payload)) } catch {}
        }
      }
    }
  }

  async fetch(request) {

    // 🔥 INTERNAL BROADCAST
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
        this.broadcast({
          type: "typing",
          sender: data.sender,
          room: roomName
        }, roomName)
        return
      }

      // ================= ONLINE =================
      if (data.type === "online" && roomName === "global") {

        if (this.onlineUsers.has(data.user)) {
          try { this.onlineUsers.get(data.user).close() } catch {}
        }

        this.onlineUsers.set(data.user, server)

        await this.env.DB.prepare(`
          UPDATE users SET last_seen=? WHERE email=?
        `).bind(now, data.user).run()

        const payload = {
          type: "online_list",
          users: Array.from(this.onlineUsers.keys())
        }

        this.broadcast(payload)

        return
      }

      // ================= MESSAGE =================
      let [u1, u2] = data.room.split("_")
      if (u1 > u2) [u1, u2] = [u2, u1]

      await this.env.DB.prepare(`
        INSERT INTO messages
        (room,sender,text,file,file_name,file_type,created_at,is_read)
        VALUES(?,?,?,?,?,?,?,0)
      `)
      .bind(
        data.room,
        data.sender,
        data.text || null,
        data.file || null,
        data.file_name || null,
        data.file_type || null,
        now
      ).run()

      const lastMsg = data.text || "📎 File"

      // 🔥 PASTIKAN ROW ADA
      await this.env.DB.prepare(`
        INSERT OR IGNORE INTO chats (user1,user2,last_message,updated_at)
        VALUES(?,?,?,?)
        `)
      .bind(u1, u2, lastMsg, now)
      .run()

      // 🔥 UPDATE PASTI
      await this.env.DB.prepare(`
        UPDATE chats
        SET last_message=?, updated_at=?
        WHERE user1=? AND user2=?
        `)
      .bind(lastMsg, now, u1, u2)
      .run()

      const payload = {
        type: "message",
        room: data.room,
        sender: data.sender,
        text: data.text || null,
        file: data.file || null,
        file_type: data.file_type || null,
        created_at: now
      }

      // 🔥 ROOM
      this.broadcast(payload, roomName)

      // 🔥 GLOBAL (PENTING)
      const globalId = this.env.CHAT_ROOM.idFromName("global")
      const globalRoom = this.env.CHAT_ROOM.get(globalId)

      await globalRoom.fetch(new Request("https://internal", {
        method: "POST",
        body: JSON.stringify(payload)
      }))
    })

    server.addEventListener("close", () => {
      this.sessions.delete(server)

      for (const [email, ws] of this.onlineUsers) {
        if (ws === server) this.onlineUsers.delete(email)
      }

      this.broadcast({
        type: "online_list",
        users: Array.from(this.onlineUsers.keys())
      })
    })

    return new Response(null, { status: 101, webSocket: client })
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

    if (url.pathname === "/messages") return getMessages(request, env)
    if (url.pathname === "/chats") return getChats(request, env)
    if (url.pathname === "/contacts") return getContacts(request, env)
    if (url.pathname === "/update-profile") return updateProfile(request, env)

    if (url.pathname === "/respond-request") return respondRequest(request, env)
    if (url.pathname === "/delete-contact") return deleteContact(request, env)

    return new Response("Not found", { status: 404 })
  }
}

// ================= API =================

async function getMessages(request, env) {
  const room = new URL(request.url).searchParams.get("room")

  const data = await env.DB.prepare(`
    SELECT * FROM messages WHERE room=? ORDER BY id ASC
  `).bind(room).all()

  return json(data.results)
}

async function getChats(request, env) {
  const email = new URL(request.url).searchParams.get("email")

  const data = await env.DB.prepare(`
    SELECT 
      chats.*,

      -- friend email
      CASE 
        WHEN chats.user1 = ? THEN chats.user2
        ELSE chats.user1
      END as friend_email,

      -- unread count
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
      ) as unread

    FROM chats
    WHERE chats.user1 = ? OR chats.user2 = ?
    ORDER BY chats.updated_at DESC
  `)
  .bind(email, email, email, email)
  .all()

  // 🔥 MAP USER DETAIL (INI YANG HILANG)
  const result = await Promise.all(data.results.map(async (c) => {

    const user = await env.DB.prepare(`
      SELECT name, avatar, bio, last_seen FROM users WHERE email = ?
    `)
    .bind(c.friend_email)
    .first()

    return {
      ...c,
      friend_name: user?.name || c.friend_email,
      friend_avatar: user?.avatar || null,
      friend_bio: user?.bio || "",
      friend_last_seen: user?.last_seen || null
    }
  }))

  return json(result)
}

async function getContacts(request, env) {
  const email = new URL(request.url).searchParams.get("email")

  const data = await env.DB.prepare(`
    SELECT users.name, users.email, users.avatar, users.bio
    FROM contacts
    JOIN users ON users.email = contacts.friend_email
    WHERE contacts.user_email = ?
  `)
  .bind(email)
  .all()

  return json(data.results)
}

async function updateProfile(request, env) {
  const { email, name, avatar, bio } = await request.json()

  await env.DB.prepare(`
    UPDATE users SET name=?,avatar=?,bio=? WHERE email=?
  `)
  .bind(name, avatar, bio, email)
  .run()

  return json({ success: true })
}

// ================= FRIEND =================
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
