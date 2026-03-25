// ===== SIMPLE TOKEN =====
function generateToken(user){
  return btoa(JSON.stringify(user));
}

function verifyToken(token){
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

    // ================= REGISTER =================
    if(url.pathname === "/register" && request.method === "POST"){
      try{
        const body = await request.json();
        const {email,password,name} = body;

        if(!email || !password){
          return new Response("Missing field",{status:400});
        }

        await env.DB.prepare(
          "INSERT INTO users (email,password,name) VALUES (?,?,?)"
        ).bind(email,password,name).run();

        return new Response("ok");

      }catch(e){
        return new Response("Error: "+e.message,{status:500});
      }
    }

    // ================= LOGIN =================
    if(url.pathname === "/login" && request.method === "POST"){
      try{
        const body = await request.json();
        const {email,password} = body;

        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE email=?"
        ).bind(email).first();

        if(!user){
          return new Response("User not found",{status:404});
        }

        if(user.password !== password){
          return new Response("Wrong password",{status:401});
        }

        const token = generateToken({
          id:user.id,
          name:user.name
        });

        return new Response(JSON.stringify({token}),{
          headers:{"Content-Type":"application/json"}
        });

      }catch(e){
        return new Response("Error: "+e.message,{status:500});
      }
    }

    // ================= PROFILE =================
    if(url.pathname === "/me"){
      const token = request.headers.get("Authorization");
      const user = verifyToken(token);

      return new Response(JSON.stringify(user),{
        headers:{"Content-Type":"application/json"}
      });
    }

    // ================= WEBSOCKET =================
    if(request.headers.get("Upgrade") === "websocket"){

      const token = url.searchParams.get("token");
      const user = verifyToken(token);

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

      // typing
      if(data.type === "typing"){
        this.broadcast({
          type:"typing",
          user:user.name
        },ws);
        return;
      }

      // message
      if(data.type === "message"){
        const msg = {
          type:"message",
          msg:data.msg,
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
