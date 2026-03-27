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

    // INTERNAL BROADCAST
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

      switch(data.type){

        // ================= CONTACTS =================
        case "init_contacts": {

          const contacts = await this.env.DB.prepare(`
            SELECT 
              email,
              MAX(name) as name,
              MAX(avatar) as avatar,
              MAX(bio) as bio,
              MAX(last_seen) as last_seen
            FROM (
              SELECT 
                CASE 
                  WHEN c.user_email = ? THEN c.friend_email
                  ELSE c.user_email
                END as email,
                u.name,
                u.avatar,
                u.bio,
                u.last_seen
              FROM contacts c
              JOIN users u 
                ON u.email = CASE 
                  WHEN c.user_email = ? THEN c.friend_email
                  ELSE c.user_email
                END
              WHERE c.user_email = ? OR c.friend_email = ?
            )
            GROUP BY email
          `)
          .bind(data.user, data.user, data.user, data.user)
          .all()

          server.send(JSON.stringify({
            type:"init_contacts",
            contacts: contacts.results || []
          }))

          break
        }

        // ================= CHATS (FIX TOTAL) =================
        case "init_chats": {

          const email = data.user

          const dataChats = await this.env.DB.prepare(`
            SELECT 
              m1.room,
              m1.created_at,
              m1.text,
              m1.file_type
            FROM messages m1
            INNER JOIN (
              SELECT room, MAX(created_at) as max_date
              FROM messages
              GROUP BY room
            ) m2
            ON m1.room = m2.room AND m1.created_at = m2.max_date
            WHERE m1.room LIKE '%' || ? || '%'
            ORDER BY m1.created_at DESC
          `)
          .bind(email)
          .all()

          const result = await Promise.all(
            dataChats.results.map(async (c) => {

              const parts = c.room.split("_")
              const friend_email = parts.find(x => x !== email)

              const user = await this.env.DB.prepare(`
                SELECT name, avatar, bio, last_seen 
                FROM users 
                WHERE email = ?
              `)
              .bind(friend_email)
              .first()

              return {
                room: c.room,
                updated_at: c.created_at,
                friend_email,
                friend_name: user?.name || friend_email,
                friend_avatar: user?.avatar || null,
                friend_bio: user?.bio || "",
                friend_last_seen: user?.last_seen || null,
                last_message: c.text || (c.file_type ? "📎 File" : ""),
                unread: 0 // optional (bisa upgrade nanti)
              }
            })
          )

          server.send(JSON.stringify({
            type:"init_chats",
            chats: result
          }))

          break
        }

        // ================= MESSAGES (HISTORY) =================
        case "init_messages": {

          let [u1, u2] = data.room.split("_")
          if (u1 > u2) [u1, u2] = [u2, u1]

          const room = u1 + "_" + u2

          const messages = await this.env.DB.prepare(`
            SELECT * FROM messages
            WHERE room = ?
            ORDER BY id ASC
          `)
          .bind(room)
          .all()

          server.send(JSON.stringify({
            type:"init_messages",
            messages: messages.results || []
          }))

          break
        }

        // ================= READ =================
        case "read": {
          this.broadcast({
            type:"read",
            user:data.user,
            room:data.room
          }, server.room)
          break
        }

        // ================= TYPING =================
        case "typing": {
          this.broadcast({
            type:"typing",
            sender:data.sender,
            room:server.room
          }, server.room)
          break
        }

        // ================= ONLINE =================
        case "online": {

          if(server.room !== "global") break

          if(this.onlineUsers.has(data.user)){
            try{ this.onlineUsers.get(data.user).close() }catch{}
          }

          this.onlineUsers.set(data.user, server)

          await this.env.DB.prepare(`
            UPDATE users SET last_seen=? WHERE email=?
          `).bind(now, data.user).run()

          this.broadcast({
            type:"online_list",
            users:Array.from(this.onlineUsers.keys())
          })

          break
        }

        // ================= MESSAGE =================
        case "message": {

          let [u1, u2] = data.room.split("_")
          if (u1 > u2) [u1, u2] = [u2, u1]

          const room = u1 + "_" + u2

          await this.env.DB.prepare(`
            INSERT INTO messages
            (room,sender,text,file,file_name,file_type,created_at,is_read)
            VALUES(?,?,?,?,?,?,?,0)
          `)
          .bind(
            room,
            data.sender,
            data.text || null,
            data.file || null,
            data.file_name || null,
            data.file_type || null,
            now
          ).run()

          const payload = {
            type:"message",
            room,
            sender:data.sender,
            text:data.text || null,
            file:data.file || null,
            file_name:data.file_name || null,
            file_type:data.file_type || null,
            created_at:now
          }

          // ROOM
          this.broadcast(payload, server.room)

          // GLOBAL UPDATE (update chats realtime)
          const globalId = this.env.CHAT_ROOM.idFromName("global")
          const globalRoom = this.env.CHAT_ROOM.get(globalId)

          await globalRoom.fetch(new Request("https://internal", {
            method:"POST",
            body:JSON.stringify(payload)
          }))

          break
        }
        case "contact_update": {

          // broadcast ke semua user (global room)
          this.broadcast({
          type:"contact_update"
        })

        break
      }

      }

    })

    server.addEventListener("close", async () => {
      this.sessions.delete(server)

      for (const [email, ws] of this.onlineUsers) {
        if (ws === server) this.onlineUsers.delete(email)
      }

      this.broadcast({
        type:"online_list",
        users:Array.from(this.onlineUsers.keys())
      })
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
    
    // ================= SEND FRIEND REQUEST =================
if (url.pathname === "/send-request" && request.method === "POST") {

  const body = await request.json()
  const { from_email, to_email } = body

  // ❌ VALIDASI
  if (!from_email || !to_email || from_email === to_email) {
    return new Response(JSON.stringify({ error: "invalid request" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors() }
    })
  }

  // 🔍 CEK USER ADA
  const user = await env.DB.prepare(`
    SELECT email FROM users WHERE email = ?
  `).bind(to_email).first()

  if (!user) {
    return new Response(JSON.stringify({ error: "user not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...cors() }
    })
  }

  // 🔍 CEK SUDAH BERTEMAN
  const exists = await env.DB.prepare(`
    SELECT * FROM contacts
    WHERE (user_email = ? AND friend_email = ?)
       OR (user_email = ? AND friend_email = ?)
  `)
  .bind(from_email, to_email, to_email, from_email)
  .first()

  if (exists) {
    return new Response(JSON.stringify({ error: "already friends" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors() }
    })
  }

  // ✅ INSERT LANGSUNG (AUTO ACCEPT)
  await env.DB.prepare(`
    INSERT INTO contacts (user_email, friend_email)
    VALUES (?, ?)
  `).bind(from_email, to_email).run()

  // 🔥 REALTIME UPDATE CONTACTS
  const globalId = env.CHAT_ROOM.idFromName("global")
  const globalRoom = env.CHAT_ROOM.get(globalId)

  await globalRoom.fetch(new Request("https://internal", {
    method: "POST",
    body: JSON.stringify({
      type: "contact_update"
    })
  }))

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json", ...cors() }
  })
}

    // ================= DELETE CONTACT =================
if (url.pathname === "/delete-contact" && request.method === "POST") {

  const body = await request.json()
  const { user_email, friend_email } = body

  // 🔥 DELETE DUA ARAH (INI YANG PENTING)
  await env.DB.prepare(`
    DELETE FROM contacts
    WHERE (user_email = ? AND friend_email = ?)
       OR (user_email = ? AND friend_email = ?)
  `)
  .bind(user_email, friend_email, friend_email, user_email)
  .run()

  // 🔥 BROADCAST REALTIME (TIDAK PERLU FRONTEND TRIGGER LAGI)
  const globalId = env.CHAT_ROOM.idFromName("global")
  const globalRoom = env.CHAT_ROOM.get(globalId)

  await globalRoom.fetch(new Request("https://internal", {
    method: "POST",
    body: JSON.stringify({
      type: "contact_update"
    })
  }))

  return new Response(JSON.stringify({ success: true }), {
    headers: { 
      "Content-Type": "application/json",
      ...cors()
    }
  })
}

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
