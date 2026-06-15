import { AgentProtocolServer } from './protocol-server.mjs'

export async function createWebSocketAgentServer({
  engine,
  protocol = null,
  port = 8787,
  host = '127.0.0.1',
  logger = () => {},
  healthCheck = () => ({ ok: true }),
}) {
  const { createServer } = await import('node:http')
  const { WebSocketServer } = await import('ws')
  const activeProtocol = protocol ?? new AgentProtocolServer({ engine })
  const httpServer = createServer((request, response) => {
    if (request.url === '/health') {
      try {
        const health = healthCheck()
        response.writeHead(health?.ok === false ? 503 : 200, {
          'content-type': 'application/json',
        })
        response.end(JSON.stringify(health))
      } catch (error) {
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
      return
    }
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('Upgrade Required')
  })
  const server = new WebSocketServer({ server: httpServer })
  httpServer.clients = server.clients

  server.on('connection', socket => {
    logger({ type: 'connection_opened' })
    const client = {
      send(event) {
        socket.send(JSON.stringify(event))
      },
    }

    socket.on('message', data => {
      let message
      try {
        message = JSON.parse(String(data))
      } catch (error) {
        logger({
          type: 'message_error',
          error: error instanceof Error ? error.message : String(error),
        })
        client.send({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }

      logger({
        type: 'message_received',
        messageType: message?.type,
        sessionId: message?.sessionId,
        messageId: message?.messageId,
      })
      void activeProtocol.receive(client, message)
    })

    socket.on('close', () => {
      logger({ type: 'connection_closed' })
    })

    socket.on('error', error => {
      logger({
        type: 'connection_error',
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })

  await new Promise((resolve, reject) => {
    httpServer.listen(port, host)
    httpServer.once('listening', resolve)
    httpServer.once('error', reject)
  })

  const originalClose = httpServer.close.bind(httpServer)
  httpServer.close = callback => {
    server.close()
    return originalClose(callback)
  }
  return httpServer
}
