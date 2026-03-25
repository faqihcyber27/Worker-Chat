const SECRET = "supersecret123";

// ===== SIMPLE JWT (base64) =====
function generateJWT(payload){
  return btoa(JSON.stringify(payload));
}

function verifyJWT(token){
  try{
    return JSON.parse(atob(token));
  }catch{
    return null;
  }
}

// ===== DURABLE OBJECT =====
export class ChatRoom {
  constructor(state, env){
    this.state = state;
    this.clients = new Map(); // ws -> user
  }

  async fetch(request, env){
    const url = new URL(request.url);

    // ================= AUTH =================

    // REGISTER
    if(url.pathname === "/register" && request.method === "POST"){
      const {email,password,name} = await request.json();

      try{
        await env.DB.prepare(
          "INSERT INTO users (email,password,name) VALUES (?,?,?)"
        ).bind(email,password,name).run();

        return new Response("ok");
      }catch(e){
        return new Response("User exists",{status:400});
      }
    }

    // LOGIN
    if(url.pathname === "/login" && request.method === "POST"){
      const {email,password} = await request.json();

      const user = await env.DB.prepare(
        "SELECT * FROM users WHERE email=? AND password=?"
      ).bind(email,password).first();

      if(!user){
        return new Response("Invalid",{status:401});
      }

      const token = generateJWT({
        id:user.id,
        name:user.name
      });

      return new Response(JSON.stringify({token}),{
        headers:{"Content-Type":"application/json"}
      });
    }

    // PROFILE
    if(url.pathname === "/me"){
      const token = request.headers.get("Authorization");
      const user = verifyJWT(token);

      return new Response(JSON.stringify(user),{
        headers:{"Content-Type":"application/json"}
      });
    }

    // ================= WEBSOCKET =================

    if(request.headers.get("Upgrade") === "websocket"){

      const token = url.searchParams.get("token");
      const user = verifyJWT(token);

      if(!user){
        return new Response("Unauthorized",{status:401});
      }

      const pair = new WebSocketPair();
      const [client,server] = Object.values(pair);

      this.handleSession(server,user);

      return new Response(null,{status:101,webSocket:client});
    }

    return new Response("OK");
  }

  handleSession(ws,user){
    ws.accept();
    this.clients.set(ws,user);

    ws.addEventListener("message",(e)=>{
      let data;
      try{
        data = JSON.parse(e.data);
      }catch{
        return;
      }

      // TYPING
      if(data.type === "typing"){
        this.broadcast({
          type:"typing",
          user:user.name
        },ws);
        return;
      }

      // MESSAGE / AUDIO
      if(data.type === "message" || data.type === "audio"){

        const msg = {
          ...data,
          user:user.name,
          time:new Date().toLocaleTimeString().slice(0,5)
        };

        this.broadcast(msg);
      }
    });

    ws.addEventListener("close",()=>{
      this.clients.delete(ws);
    });
  }

  broadcast(data,sender=null){
    for(const [client] of this.clients){
      if(client !== sender){
        try{
          client.send(JSON.stringify(data));
        }catch{}
      }
    }
  }
}

// ===== ENTRY =====
export default {
  fetch(request, env){
    const id = env.CHAT_ROOM.idFromName("global");
    return env.CHAT_ROOM.get(id).fetch(request, env);
  }
};
