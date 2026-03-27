self.addEventListener("push", event => {
  const data = event.data.json()

  self.registration.showNotification(data.title, {
    body: data.body,
    icon: "https://cdn-icons-png.flaticon.com/512/733/733585.png",
    data: data.url
  })
})

self.addEventListener("notificationclick", event => {
  event.notification.close()

  event.waitUntil(
    clients.openWindow(event.notification.data)
  )
})
