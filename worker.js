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
        try { s.send(JSON.stringify(payload)) } catch {}
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
      
     // ================= INIT CHATS =================
if (data.type === "init_chats") {

  const email = data.user

  const dataChats = await this.env.DB.prepare(`
    SELECT 
      chats.*,

      CASE 
        WHEN chats.user1 = ? THEN chats.user2
        ELSE chats.user1
      END as friend_email,

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
        SELECT m2.text 
        FROM messages m2 
        WHERE m2.room =
          CASE 
            WHEN chats.user1 < chats.user2 
            THEN chats.user1 || '_' || chats.user2
            ELSE chats.user2 || '_' || chats.user1
          END
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) as last_message

    FROM chats
    WHERE chats.user1 = ? OR chats.user2 = ?
    ORDER BY chats.updated_at DESC
  `)
  .bind(email, email, email, email)
  .all()

  const result = await Promise.all(
    dataChats.results.map(async (c) => {

      const user = await this.env.DB.prepare(`
        SELECT name, avatar, bio, last_seen 
        FROM users 
        WHERE email = ?
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
    })
  )

  server.send(JSON.stringify({
    type: "init_chats",
    chats: result
  }))

  return
}
      

      // ================= INIT MESSAGES =================
      if (data.type === "init_messages") {

        const messages = await this.env.DB.prepare(`
          SELECT * FROM messages
          WHERE room = ?
          ORDER BY id ASC
        `)
        .bind(server.room)
        .all()

        server.send(JSON.stringify({
          type: "init_messages",
          messages: messages.results || []
        }))

      return
    }

  // ================= READ =================
  if (data.type === "read") {

    this.broadcast({
      type: "read",
      user: data.user,
      room: data.room
    }, server.room)

    return
  }

  // ================= TYPING =================
  if (data.type === "typing") {

    this.broadcast({
      type: "typing",
      sender: data.sender,
      room: server.room
    }, server.room)

    return
  }

  // ================= ONLINE =================
  if (data.type === "online" && server.room === "global") {

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
  if (data.type === "message") {

    let [u1, u2] = data.room.split("_")
    if (u1 > u2) [u1, u2] = [u2, u1]

    // simpan message
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
    )
    .run()

    const lastMsg = data.text || "📎 File"

    // ensure chat ada
    await this.env.DB.prepare(`
      INSERT OR IGNORE INTO chats (user1,user2,last_message,updated_at)
      VALUES(?,?,?,?)
    `)
    .bind(u1, u2, lastMsg, now)
    .run()

    // update chat
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
      file_name: data.file_name || null,
      file_type: data.file_type || null,
      created_at: now
    }

    // 🔥 kirim ke room
    this.broadcast(payload, server.room)

    // 🔥 kirim ke global (update chat list realtime)
    const globalId = this.env.CHAT_ROOM.idFromName("global")
    const globalRoom = this.env.CHAT_ROOM.get(globalId)

    await globalRoom.fetch(new Request("https://internal", {
      method: "POST",
      body: JSON.stringify(payload)
    }))
    return
    }
  })

    server.addEventListener("close", async () => {
    this.sessions.delete(server)

    for (const [email, ws] of this.onlineUsers) {
      if (ws === server) this.onlineUsers.delete(email)
    }

    const payload = {
      type: "online_list",
      users: Array.from(this.onlineUsers.keys())
    }

    this.broadcast(payload)

    // 🔥 GLOBAL SYNC (INI YANG BUTUH ASYNC)
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

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors() })
    }

    const url = new URL(request.url)

    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room")
      const id = env.CHAT_ROOM.idFromName(room)
      return env.CHAT_ROOM.get(id).fetch(request)
    }

    return new Response("Not found", { status: 404 })
  }
}

// ================= HELPER =================
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  }
}
