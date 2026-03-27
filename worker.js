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

        // ================= INIT REQUEST (FIX POSISI) =================
        case "init_requests": {
          const dataReq = await this.env.DB.prepare(`
            SELECT * FROM contact_requests
            WHERE to_email = ?
            ORDER BY id DESC
          `).bind(data.user).all()

          server.send(JSON.stringify({
            type:"request_list",
            data: dataReq.results || []
          }))
          break
        }

        // ================= CHATS =================
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
                SELECT name, avatar FROM users WHERE email = ?
              `).bind(friend_email).first()

              return {
                room: c.room,
                updated_at: c.created_at,
                friend_email,
                friend_name: user?.name || friend_email,
                friend_avatar: user?.avatar || null,
                last_message: c.text || "📎 File"
              }
            })
          )

          server.send(JSON.stringify({
            type:"init_chats",
            chats: result
          }))
          break
        }

        // ================= MESSAGES =================
        case "init_messages": {
          let [u1, u2] = data.room.split("_")
          if (u1 > u2) [u1, u2] = [u2, u1]
          const room = u1 + "_" + u2

          const messages = await this.env.DB.prepare(`
            SELECT * FROM messages WHERE room=? ORDER BY id ASC
          `).bind(room).all()

          server.send(JSON.stringify({
            type:"init_messages",
            messages: messages.results || []
          }))
          break
        }

        // ================= ONLINE =================
        case "online": {
          if(server.room !== "global") break

          this.onlineUsers.set(data.user, server)

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
            (room,sender,text,created_at,is_read)
            VALUES(?,?,?,?,0)
          `).bind(room,data.sender,data.text,now).run()

          const payload = {
            type:"message",
            room,
            sender:data.sender,
            text:data.text,
            created_at:now
          }

          this.broadcast(payload, server.room)

          const globalId = this.env.CHAT_ROOM.idFromName("global")
          const globalRoom = this.env.CHAT_ROOM.get(globalId)

          await globalRoom.fetch(new Request("https://internal", {
            method:"POST",
            body:JSON.stringify(payload)
          }))

          break
        }

        case "contact_update": {
          this.broadcast({ type:"contact_update" })
          break
        }
        
        // ================= PROFILE UPDATE =================
        case "profile_update": {

        // update DB
        await this.env.DB.prepare(`
          UPDATE users
          SET name=?, bio=?, avatar=?
          WHERE email=?
        `)
        .bind(data.name, data.bio, data.avatar, data.email)
        .run()

        // 🔥 broadcast ke semua user
        this.broadcast({
          type:"profile_update",
          user:{
            email:data.email,
            name:data.name,
            bio:data.bio,
            avatar:data.avatar
        }
      })

      break
    a}

      }

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

    // ================= SEND REQUEST =================
    if (url.pathname === "/send-request" && request.method === "POST") {

      const { from_email, to_email } = await request.json()
      const now = new Date().toISOString()

      const result = await env.DB.prepare(`
        INSERT INTO contact_requests (from_email,to_email,created_at)
        VALUES (?,?,?)
      `).bind(from_email, to_email, now).run()

      const globalRoom = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName("global")
      )

      await globalRoom.fetch(new Request("https://internal", {
        method:"POST",
        body: JSON.stringify({
          type:"new_request",
          data:{
            id: result.meta.last_row_id,
            from_email,
            to_email
          }
        })
      }))

      return new Response(JSON.stringify({ success:true }), { headers:cors() })
    }

    // ================= RESPOND =================
    if (url.pathname === "/respond-request" && request.method === "POST") {

      const { id, action } = await request.json()

      const req = await env.DB.prepare(`
        SELECT * FROM contact_requests WHERE id=?
      `).bind(id).first()

      if (action === "accept") {

        await env.DB.prepare(`
          INSERT INTO contacts (user_email, friend_email)
          VALUES (?,?)
        `).bind(req.from_email, req.to_email).run()

        const globalId = env.CHAT_ROOM.idFromName("global")
        const globalRoom = env.CHAT_ROOM.get(globalId)

        // 🔥 NOTIF ACCEPT
        await globalRoom.fetch(new Request("https://internal", {
            method:"POST",
            body: JSON.stringify({
            type:"request_accepted",
            to:req.from_email,
            name:req.to_email
        })
      }))

  // 🔥 PENTING BANGET (INI YANG KAMU BUTUH)
  await globalRoom.fetch(new Request("https://internal", {
    method:"POST",
    body: JSON.stringify({
      type:"contact_update"
    })
  }))
}

      await env.DB.prepare(`
        DELETE FROM contact_requests WHERE id=?
      `).bind(id).run()

      const globalRoom = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName("global")
      )

      await globalRoom.fetch(new Request("https://internal", {
        method:"POST",
        body: JSON.stringify({
          type:"request_update",
          id
        })
      }))

      return new Response(JSON.stringify({ success:true }), { headers:cors() })
    }

    // ================= DELETE CONTACT (FIXED) =================
    if (url.pathname === "/delete-contact" && request.method === "POST") {

      const { user_email, friend_email } = await request.json()

      await env.DB.prepare(`
        DELETE FROM contacts
        WHERE (user_email=? AND friend_email=?)
           OR (user_email=? AND friend_email=?)
      `).bind(user_email, friend_email, friend_email, user_email).run()

      const globalRoom = env.CHAT_ROOM.get(
        env.CHAT_ROOM.idFromName("global")
      )

      await globalRoom.fetch(new Request("https://internal", {
        method:"POST",
        body: JSON.stringify({
          type:"contact_update"
        })
      }))

      return new Response(JSON.stringify({ success:true }), { headers:cors() })
    }
    
    if (url.pathname === "/get-profile") {

    const email = url.searchParams.get("email")

    const user = await env.DB.prepare(`
      SELECT email, name, bio, avatar
      FROM users
      WHERE email=?
    `).bind(email).first()

    return new Response(JSON.stringify(user || {}), {
      headers:{ "Content-Type":"application/json", ...cors() }
    })
  }

    // ================= WS =================
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
