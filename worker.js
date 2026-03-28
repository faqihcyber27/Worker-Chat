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
            body: JSON.stringify({
              type:"push_notification",
              title:"New Message 💬",
              body:data.text || "📎 File"
            })
          }))
         // ================= FCM PUSH =================
const accessToken = await getAccessToken(this.env)
console.log("ACCESS TOKEN:", accessToken)
const targetUser = (data.sender === u1) ? u2 : u1
const isOnline = this.onlineUsers.has(targetUser)
if(!isOnline){

  const tokens = await this.env.DB.prepare(`
    SELECT token FROM fcm_tokens WHERE email=?
  `).bind(targetUser).all()

  console.log("TOKENS:", tokens.results)

  for (const t of tokens.results) {

    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${this.env.FCM_PROJECT_ID}/messages:send`,
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: {
            token: t.token,
            notification: {
              title: data.sender,
              body: data.text || "📎 File"
            }
          }
        })
      }
    )

    const text = await res.text()
    console.log("FCM RESPONSE:", text)
  }

}
}

break


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
        
        const payload = {
          type:"profile_update",
          user:{
            email:data.email,
            name:data.name,
            bio:data.bio,
            avatar:data.avatar
          }
        }
          // 🔥 KIRIM KE GLOBAL ROOM (INI KUNCI)
  const globalId = this.env.CHAT_ROOM.idFromName("global")
  const globalRoom = this.env.CHAT_ROOM.get(globalId)

  await globalRoom.fetch(new Request("https://internal", {
    method:"POST",
    body: JSON.stringify(payload)
  }))

  // 🔥 TRIGGER REFRESH CONTACT & CHAT
  await globalRoom.fetch(new Request("https://internal", {
    method:"POST",
    body: JSON.stringify({ type:"contact_update" })
  }))

  await globalRoom.fetch(new Request("https://internal", {
    method:"POST",
    body: JSON.stringify({ type:"chat_update" })
  }))

  break
}

    case "read": {

      await this.env.DB.prepare(`
        UPDATE messages
        SET is_read=1
        WHERE room=? AND sender != ?
      `).bind(data.room, data.user).run()

      this.broadcast({
        type:"read_update",
        room:data.room
      }, server.room)

    break
  }
case "typing": {

  const payload = {
    type:"typing",
    room: data.room,
    sender: data.sender
  }

  // 🔥 broadcast ke semua (global)
  this.broadcast(payload)

  break
}

case "delete_contact": {

  await this.env.DB.prepare(`
    DELETE FROM contacts
    WHERE (user_email=? AND friend_email=?)
       OR (user_email=? AND friend_email=?)
  `).bind(
    data.user_email,
    data.friend_email,
    data.friend_email,
    data.user_email
  ).run()

  // 🔥 broadcast update ke semua user
  this.broadcast({
    type:"contact_update"
  })

  break
}

case "send_request": {

  const now = new Date().toISOString()

  const result = await this.env.DB.prepare(`
    INSERT INTO contact_requests (from_email,to_email,created_at)
    VALUES (?,?,?)
  `).bind(
    data.from_email,
    data.to_email,
    now
  ).run()

  // 🔥 kirim ke semua (biar notif muncul di home)
  this.broadcast({
    type:"new_request",
    data:{
      id: result.meta.last_row_id,
      from_email: data.from_email,
      to_email: data.to_email
    }
  })

  break
}

case "get_profile": {

  const user = await this.env.DB.prepare(`
    SELECT email,name,bio,avatar
    FROM users
    WHERE email=?
  `).bind(data.email).first()

  server.send(JSON.stringify({
    type:"profile_data",
    user
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
      return new Response(null, { headers: cors() })
    }

    const url = new URL(request.url)
    
  // ================= REGISTER =================
if (url.pathname === "/register" && request.method === "POST") {

  const { name, email, password } = await request.json()

  if (!name || !email || !password) {
    return new Response(JSON.stringify({
      error: "Semua field wajib diisi"
    }), { headers: cors() })
  }

  const cleanEmail = email.trim().toLowerCase()

  // cek user sudah ada
  const exist = await env.DB.prepare(`
    SELECT email FROM users WHERE email=?
  `).bind(cleanEmail).first()

  if (exist) {
    return new Response(JSON.stringify({
      error: "Email sudah terdaftar"
    }), { headers: cors() })
  }

  // 🔐 HASH PASSWORD
  const encoder = new TextEncoder()
  const data = encoder.encode(password)

  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  // simpan user
  await env.DB.prepare(`
    INSERT INTO users (name,email,password)
    VALUES (?,?,?)
  `).bind(name, cleanEmail, hashHex).run()

  return new Response(JSON.stringify({
    token: "ok",
    user: {
      name,
      email: cleanEmail
    }
  }), { headers: cors() })
}

  // ================= LOGIN =================
if (url.pathname === "/login" && request.method === "POST") {

  const { email, password } = await request.json()

  if (!email || !password) {
    return new Response(JSON.stringify({
      error: "Email dan password wajib"
    }), { headers: cors() })
  }

  const cleanEmail = email.trim().toLowerCase()

  // ambil user
  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE email=?
  `).bind(cleanEmail).first()

  if (!user) {
    return new Response(JSON.stringify({
      error: "Email tidak terdaftar"
    }), { headers: cors() })
  }

  // 🔐 HASH PASSWORD INPUT
  const encoder = new TextEncoder()
  const data = encoder.encode(password)

  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')

  // compare
  if (user.password !== hashHex) {
    return new Response(JSON.stringify({
      error: "Password salah"
    }), { headers: cors() })
  }

  return new Response(JSON.stringify({
    token: "ok",
    user: {
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      bio: user.bio
    }
  }), { headers: cors() })
}

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
  
  if (url.pathname === "/save-token" && request.method === "POST") {

  const { token, email } = await request.json()

  await env.DB.prepare(`
    INSERT INTO fcm_tokens (email, token)
    VALUES (?, ?)
  `).bind(email, token).run()

  return new Response("ok", { headers: cors() })
}
  
  if (url.pathname === "/sw.js") {
  return new Response(`
    importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js')
    importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js')

    firebase.initializeApp({
      apiKey: "AIzaSyCASPxiCM8V8OIzw3JaeTdGreID0EMyTMk",
      authDomain: "chat-realtime-7b092.firebaseapp.com",
      projectId: "chat-realtime-7b092",
      messagingSenderId: "424831780632",
      appId: "1:424831780632:web:6e42d806ea94392778406d"
    })

    const messaging = firebase.messaging()

    messaging.onBackgroundMessage(function(payload) {
      self.registration.showNotification(payload.notification.title, {
        body: payload.notification.body
      })
    })

    self.addEventListener("install", e => self.skipWaiting())
    self.addEventListener("activate", e => self.clients.claim())
  `, {
    headers: { "Content-Type": "application/javascript" }
  })
}
  
  if (url.pathname === "/manifest.json") {
  return new Response(JSON.stringify({
    name: "Realtime Chat",
    short_name: "Chat",
    start_url: "/",
    display: "standalone",
    background_color: "#020617",
    theme_color: "#7c3aed",
    icons: [
      {
        src: "https://ui-avatars.com/api/?name=Chat",
        sizes: "192x192",
        type: "image/png"
      }
    ]
  }), {
    headers: {
      "Content-Type": "application/json",
      ...cors()
    }
  })
}
  
  if (url.pathname === "/subscribe" && request.method === "POST") {

  const sub = await request.json()

  await env.DB.prepare(`
    INSERT INTO push_subscriptions (data)
    VALUES (?)
  `).bind(JSON.stringify(sub)).run()

  return new Response("ok", { headers: cors() })
}

// ================= DELETE CHAT =================
if (url.pathname === "/delete-chat" && request.method === "POST") {

  const { room } = await request.json()

  console.log("DELETE CHAT:", room)

  // 🔥 hapus semua message di room
  await env.DB.prepare(`
    DELETE FROM messages WHERE room = ?
  `).bind(room).run()

  // 🔥 broadcast biar device lain ikut hilang
  const globalRoom = env.CHAT_ROOM.get(
    env.CHAT_ROOM.idFromName("global")
  )

  await globalRoom.fetch(new Request("https://internal", {
    method:"POST",
    body: JSON.stringify({
      type:"chat_deleted",
      room
    })
  }))

  return new Response(JSON.stringify({ success:true }), {
    headers: cors()
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

async function getAccessToken(env) {

  const header = {
    alg: "RS256",
    typ: "JWT"
  }

  const now = Math.floor(Date.now() / 1000)

  const payload = {
    iss: env.FCM_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }

  function base64url(obj){
    return btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }

  const enc = new TextEncoder()

  const key = await crypto.subtle.importKey(
    "pkcs8",
    str2ab(env.FCM_PRIVATE_KEY),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  )

  const data = enc.encode(
    base64url(header) + "." + base64url(payload)
  )

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    data
  )

  const jwt =
    base64url(header) + "." +
    base64url(payload) + "." +
    arrayBufferToBase64Url(signature)

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type":"application/x-www-form-urlencoded"},
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  })

  const json = await res.json()
  return json.access_token
}

function str2ab(str){
  // hapus header & newline
  const cleaned = str
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\n/g, "")

  const binary = atob(cleaned)
  const buf = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buf)

  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i)
  }

  return buf
}

function arrayBufferToBase64Url(buffer){
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g,"-")
    .replace(/\//g,"_")
    .replace(/=+$/,"")
}
