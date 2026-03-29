// ================= DO CLASS =================
export class ChatRoom {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.sessions = new Set()
    this.onlineUsers = new Map()
    this.typingThrottle = {}
  }

  broadcast(payload, room = null) {
    for (const s of this.sessions) {
      if ((!room || s.room === room) && s.readyState === 1) {
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

    // 🔥 CLEAN DISCONNECT
    server.addEventListener("close", () => {

      this.sessions.delete(server)

      for (const [email, ws] of this.onlineUsers.entries()) {
        if (ws === server) {
          this.onlineUsers.delete(email)
          break
        }
      }

      this.broadcast({
        type:"online_list",
        users:Array.from(this.onlineUsers.keys())
      })

    })

    server.addEventListener("message", async (event) => {

      const data = JSON.parse(event.data)
      const now = new Date().toISOString()

      switch(data.type){

        // ================= ONLINE =================
        case "online": {

          if(server.room !== "global") break

          if(this.onlineUsers.has(data.user)){
            try { this.onlineUsers.get(data.user).close() } catch {}
          }

          this.onlineUsers.set(data.user, server)

          this.broadcast({
            type:"online_list",
            users:Array.from(this.onlineUsers.keys())
          })

          break
        }

        // ================= PROFILE =================
        case "get_profile": {

          const user = await this.env.DB.prepare(`
            SELECT email,name,bio,avatar
            FROM users WHERE email=?
          `).bind(data.email).first()

          server.send(JSON.stringify({
            type:"profile_data",
            user
          }))
          break
        }

        case "profile_update": {

          await this.env.DB.prepare(`
            UPDATE users SET name=?, bio=?, avatar=? WHERE email=?
          `).bind(data.name,data.bio,data.avatar,data.email).run()
          
          const global = this.env.CHAT_ROOM.get(
            this.env.CHAT_ROOM.idFromName("global")
          )

          await global.fetch(new Request("https://internal", {
              method:"POST",
              body: JSON.stringify({
              type:"profile_update",
              user:{
                email:data.email,
                name:data.name,
                bio:data.bio,
                avatar:data.avatar
              }
            })
          }))

          await global.fetch(new Request("https://internal", {
            method:"POST",
            body: JSON.stringify({ type:"contact_update" })
          }))
          
          await global.fetch(new Request("https://internal", {
            method:"POST",
            body: JSON.stringify({ type:"chat_update" })
          }))

          break
        }

        // ================= CONTACT =================
        case "init_contacts": {

          const contacts = await this.env.DB.prepare(`
            SELECT 
              email,
              MAX(name) as name,
              MAX(avatar) as avatar,
              MAX(bio) as bio
            FROM (
              SELECT 
                CASE 
                  WHEN c.user_email = ? THEN c.friend_email
                  ELSE c.user_email
                END as email,
                u.name,u.avatar,u.bio
              FROM contacts c
              JOIN users u 
              ON u.email = CASE 
                WHEN c.user_email = ? THEN c.friend_email
                ELSE c.user_email
              END
              WHERE c.user_email = ? OR c.friend_email = ?
            )
            GROUP BY email
          `).bind(data.user,data.user,data.user,data.user).all()

          server.send(JSON.stringify({
            type:"init_contacts",
            contacts:contacts.results || []
          }))

          break
        }

        case "contact_update":
          this.broadcast({ type:"contact_update" })
          break

        case "delete_contact": {
          const user = data.user_email.toLowerCase().trim()
          const friend = data.friend_email.toLowerCase().trim()
          await this.env.DB.prepare(`
            DELETE FROM contacts
            WHERE (user_email=? AND friend_email=?)
            OR (user_email=? AND friend_email=?)
          `).bind(
            user,
            friend,
            friend,
            user
          ).run()

          const globalId = this.env.CHAT_ROOM.idFromName("global")
          const global = this.env.CHAT_ROOM.get(globalId)

          await global.fetch(new Request("https://internal", {
              method:"POST",
              body: JSON.stringify({
                type:"contact_update"
              })
            }))

          break // ✅ lebih aman & konsisten
        }

        // ================= REQUEST =================
        case "init_requests": {

          const req = await this.env.DB.prepare(`
            SELECT * FROM contact_requests
            WHERE to_email=?
            ORDER BY id DESC
          `).bind(data.user).all()

          this.send(server, {
    type:"request_list",
    data:req.results || []
  })
          break
        }

        case "send_request": {

  const from = data.from_email.toLowerCase().trim()
  const to = data.to_email.toLowerCase().trim()

  // ❌ jangan kirim ke diri sendiri
  if(from === to) break

  // 🔥 hapus duplicate lama
  await this.env.DB.prepare(`
    DELETE FROM contact_requests
    WHERE from_email=? AND to_email=?
  `).bind(from,to).run()

  const result = await this.env.DB.prepare(`
    INSERT INTO contact_requests (from_email,to_email,created_at)
    VALUES (?,?,?)
  `).bind(from,to,new Date().toISOString()).run()

  const payload = {
    type:"new_request",
    data:{
      id: result.meta.last_row_id,
      from_email: from,
      to_email: to
    }
  }

  // 🔥 kirim hanya ke target (user tujuan)
  for(const [email, ws] of this.onlineUsers.entries()){
    if(email === to){
      this.send(ws, payload)
    }
  }

  break
}

        case "respond_request": {

  const req = await this.env.DB.prepare(`
    SELECT * FROM contact_requests WHERE id=?
  `).bind(data.id).first()

  if(!req) break

  if(data.action === "accept"){

    await this.env.DB.prepare(`
      INSERT INTO contacts (user_email,friend_email)
      VALUES (?,?)
    `).bind(req.from_email,req.to_email).run()

    // 🔥 KIRIM KE KEDUA USER (INI YANG KAMU TANYA)
    for(const [email, ws] of this.onlineUsers.entries()){

      if(email === req.from_email || email === req.to_email){

        this.send(ws,{
          type:"request_accepted",
          from:req.from_email,
          to:req.to_email
        })

        this.send(ws,{ type:"contact_update" })
        this.send(ws,{ type:"chat_update" })
      }
    }
  }

  // 🔥 DELETE REQUEST
  await this.env.DB.prepare(`
    DELETE FROM contact_requests WHERE id=?
  `).bind(data.id).run()

  // 🔥 UPDATE REQUEST LIST REALTIME
  for(const [email, ws] of this.onlineUsers.entries()){
    if(email === req.from_email || email === req.to_email){
      this.send(ws,{
        type:"request_update",
        id:data.id
      })
    }
  }

  break
}

        // ================= CHAT LIST =================
        case "init_chats": {
          const email = data.user
          const dataChats = await this.env.DB.prepare(`
            SELECT 
              m1.room,
              m1.created_at,
              m1.text
            FROM messages m1
            INNER JOIN (
            SELECT room, MAX(created_at) as max_date
            FROM messages
            GROUP BY room
            ) m2
            ON m1.room = m2.room AND m1.created_at = m2.max_date
            WHERE m1.room LIKE '%' || ? || '%'
            ORDER BY m1.created_at DESC
            `).bind(email).all()

          const result = await Promise.all(
          dataChats.results.map(async (c)=>{

          const friend = c.room.split("_").find(x=>x!==email)

          const user = await this.env.DB.prepare(`
            SELECT name,avatar FROM users WHERE email=?
          `).bind(friend).first()

          return {
            room:c.room,
            updated_at:c.created_at,
            friend_email:friend,
            friend_name:user?.name || friend,
            friend_avatar:user?.avatar || null,
            last_message:c.text || "📎 File"
          }
        })
      )

      server.send(JSON.stringify({
        type:"init_chats",
        chats:result
      }))

      break
    }

        // ================= MESSAGE =================
        case "message": {

          let [u1,u2]=data.room.split("_")
          if(u1>u2)[u1,u2]=[u2,u1]
          const room=u1+"_"+u2

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

          // 🔥 CHAT PAGE
          this.broadcast(payload, room)
          const global = this.env.CHAT_ROOM.get(
            this.env.CHAT_ROOM.idFromName("global")
          )
          
          await global.fetch(new Request("https://internal", {
              method:"POST",
              body: JSON.stringify({
                type:"chat_update",
                ...payload
              })
            }))

          break
        }

        // ================= MESSAGES =================
        case "init_messages": {

          const messages = await this.env.DB.prepare(`
            SELECT * FROM messages WHERE room=? ORDER BY id ASC
          `).bind(data.room).all()

          server.send(JSON.stringify({
            type:"init_messages",
            messages:messages.results || []
          }))

          break
        }

        // ================= READ =================
        case "read": {

          await this.env.DB.prepare(`
            UPDATE messages
            SET is_read=1
            WHERE room=? AND sender!=?
          `).bind(data.room,data.user).run()

          this.broadcast({
            type:"read_update",
            room:data.room
          }, data.room)

          break
        }

        // ================= TYPING =================
        case "typing": {

          const nowTs = Date.now()
          const last = this.typingThrottle[data.sender] || 0
          if(nowTs - last < 300) break
          this.typingThrottle[data.sender] = nowTs

          // chat page
          this.broadcast({
            type:"typing",
            room:data.room,
            sender:data.sender
          }, data.room)

          const global = this.env.CHAT_ROOM.get(
            this.env.CHAT_ROOM.idFromName("global")
          )
          
          await global.fetch(new Request("https://internal", {
              method:"POST",
              body: JSON.stringify({
              type:"typing",
                room:data.room,
                sender:data.sender
              })
            }))
          break
        }
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
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      })
    }

    const url = new URL(request.url)
    
    if (url.pathname === "/register" && request.method === "POST") {
        const { name, email, password } = await request.json()
        const cleanEmail = email.trim().toLowerCase()

        const exist = await env.DB.prepare(`
          SELECT email FROM users WHERE email=?
        `).bind(cleanEmail).first()

        if (exist) {
          return json({ error: "Email sudah terdaftar" })
        }

        const hash = await hashPassword(password)

        await env.DB.prepare(`
          INSERT INTO users (name,email,password)
          VALUES (?,?,?)
        `).bind(name, cleanEmail, hash).run()

        return json({
        token:"ok",
        user:{ name, email:cleanEmail }
      })
    }
    
    if (url.pathname === "/login" && request.method === "POST") {

        const { email, password } = await request.json()
        const cleanEmail = email.trim().toLowerCase()
        const user = await env.DB.prepare(`
          SELECT * FROM users WHERE email=?
        `).bind(cleanEmail).first()

        if (!user) {
          return json({ error:"Email tidak ditemukan" })
        }

        const hash = await hashPassword(password)

        if (user.password !== hash) {
          return json({ error:"Password salah" })
        }

        return json({
          token:"ok",
          user:{
          email:user.email,
          name:user.name,
          avatar:user.avatar,
          bio:user.bio
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
async function hashPassword(password){
  const enc = new TextEncoder()
  const buffer = await crypto.subtle.digest("SHA-256", enc.encode(password))

  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

function json(data){
  return new Response(JSON.stringify(data), {
    headers:{
      "Content-Type":"application/json",
      "Access-Control-Allow-Origin":"*"
    }
  })
}
