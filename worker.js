// ================= DO CLASS =================
export class ChatRoom {
  constructor(state, env) {
    this.state = state
    this.env = env

    this.sessions = new Set()
    this.rooms = new Map() // 🔥 room subscription
    this.onlineUsers = new Map()
    this.typingThrottle = {}
  }

  send(ws, data){
    try { ws.send(JSON.stringify(data)) } catch {}
  }

  broadcastAll(data){
    for(const s of this.sessions){
      if(s.readyState === 1) this.send(s, data)
    }
  }

  broadcastRoom(room, data){
    const clients = this.rooms.get(room) || new Set()
    for(const ws of clients){
      if(ws.readyState === 1) this.send(ws, data)
    }
  }

  async fetch(request) {

    // INTERNAL EVENT
    if (request.method === "POST") {
      const data = await request.json()
      this.broadcastAll(data)
      return new Response("ok")
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    server.accept()
    this.sessions.add(server)

    // DISCONNECT
    server.addEventListener("close", () => {
      this.sessions.delete(server)

      // remove from rooms
      for(const [room, set] of this.rooms){
        set.delete(server)
      }

      // remove online
      for (const [email, ws] of this.onlineUsers.entries()) {
        if (ws === server) {
          this.onlineUsers.delete(email)
          break
        }
      }

      this.broadcastAll({
        type:"online_list",
        users:[...this.onlineUsers.keys()]
      })
    })

    // ================= MESSAGE =================
    server.addEventListener("message", async (event) => {

      const data = JSON.parse(event.data)
      const now = new Date().toISOString()

      switch(data.type){

        // ================= ONLINE =================
        case "online": {
          this.onlineUsers.set(data.user, server)

          this.broadcastAll({
            type:"online_list",
            users:[...this.onlineUsers.keys()]
          })
          break
        }

        // ================= SUBSCRIBE =================
        case "subscribe": {
          const room = data.room

          if(!this.rooms.has(room)){
            this.rooms.set(room, new Set())
          }

          this.rooms.get(room).add(server)
          server.room = room

          break
        }

        // ================= UNSUBSCRIBE =================
        case "unsubscribe": {
          const room = data.room
          this.rooms.get(room)?.delete(server)
          break
        }

        // ================= INIT MESSAGES =================
        case "init_messages": {

  const room = data.room

  const messages = await this.env.DB.prepare(`
    SELECT * FROM messages
    WHERE room=?
    ORDER BY id ASC
  `).bind(room).all()

  this.send(server, {
    type:"init_messages",
    messages:messages.results || []
  })

  break
}
        
        case "init_chats": {

  const email = data.user.toLowerCase().trim()

  const rows = await this.env.DB.prepare(`
    SELECT room, text, created_at
    FROM messages
    ORDER BY created_at DESC
  `).all()

  const map = new Map()

  for(const m of (rows.results || [])){

    if(!m.room.includes("||")) continue // skip data lama rusak

    const [a,b] = m.room.split("||").map(x=>x.toLowerCase().trim())

    if(a !== email && b !== email) continue

    const normalizedRoom = [a,b].sort().join("||")

    if(!map.has(normalizedRoom)){
      map.set(normalizedRoom, {
        ...m,
        room: normalizedRoom
      })
    }
  }

  const result = await Promise.all(
    [...map.values()].map(async (m)=>{

      const [u1,u2] = m.room.split("||")
      const friend = u1 === email ? u2 : u1

      const user = await this.env.DB.prepare(`
        SELECT name, avatar FROM users WHERE email=?
      `).bind(friend).first()

      return {
        room: m.room,
        updated_at: m.created_at,
        friend_email: friend,
        friend_name: user?.name || friend,
        friend_avatar: user?.avatar || null,
        last_message: m.text || "📎 File"
      }
    })
  )

  // 🔥 AUTO SUBSCRIBE
  result.forEach(c => {
    if(!this.rooms.has(c.room)){
      this.rooms.set(c.room, new Set())
    }
    this.rooms.get(c.room).add(server)
  })

  this.send(server, {
    type:"init_chats",
    chats: result
  })

  break
}

        // ================= MESSAGE =================
        case "message": {

  let [u1,u2] = data.room.split("||").map(x=>x.toLowerCase().trim())

  if(u1 > u2) [u1,u2] = [u2,u1]

  const room = u1 + "||" + u2

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

  // 🔥 ke subscriber
  this.broadcastRoom(room, payload)

  // 🔥 update list
  this.broadcastAll({
    type:"chat_update",
    ...payload
  })

  break
}

        // ================= TYPING =================
        case "typing": {

          const nowTs = Date.now()
          const last = this.typingThrottle[data.sender] || 0
          if(nowTs - last < 300) break
          this.typingThrottle[data.sender] = nowTs

          this.broadcastRoom(data.room, {
            type:"typing",
            room:data.room,
            sender:data.sender
          })

          break
        }

        // ================= CONTACT =================
        case "init_contacts": {

          const contacts = await this.env.DB.prepare(`
            SELECT 
              email,
              MAX(name) as name,
              MAX(avatar) as avatar
            FROM (
              SELECT 
                CASE 
                  WHEN c.user_email = ? THEN c.friend_email
                  ELSE c.user_email
                END as email,
                u.name,u.avatar
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

          this.send(server, {
            type:"init_contacts",
            contacts:contacts.results || []
          })
          break
        }

        // ================= DELETE CONTACT =================
        case "delete_contact": {

          const user = data.user_email.toLowerCase().trim()
          const friend = data.friend_email.toLowerCase().trim()

          await this.env.DB.prepare(`
            DELETE FROM contacts
            WHERE (user_email=? AND friend_email=?)
            OR (user_email=? AND friend_email=?)
          `).bind(user,friend,friend,user).run()

          this.broadcastAll({ type:"contact_update" })

          break
        }

        // ================= PROFILE =================
        case "profile_update": {

          await this.env.DB.prepare(`
            UPDATE users SET name=?, bio=?, avatar=? WHERE email=?
          `).bind(data.name,data.bio,data.avatar,data.email).run()

          this.broadcastAll({
            type:"profile_update",
            user:data
          })

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
