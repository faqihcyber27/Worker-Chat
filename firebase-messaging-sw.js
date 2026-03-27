importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js")
importScripts("https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js")

firebase.initializeApp({
  apiKey: "AIzaSyCASPxiCM8V8OIzw3JaeTdGreID0EMyTMk",
  authDomain: "chat-realtime-7b092.firebaseapp.com",
  projectId: "chat-realtime-7b092",
  messagingSenderId: "424831780632",
  appId: "1:424831780632:web:6e42d806ea94392778406d"
})

const messaging = firebase.messaging()

// 🔥 NOTIF SAAT BACKGROUND
messaging.onBackgroundMessage(function(payload) {

  console.log("Notif masuk:", payload)

  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
    icon: "/icon.png"
  })
})
