import { AgentProtocolServer } from './protocol-server.mjs'

export async function createWebSocketAgentServer({
  engine,
  protocol = null,
  port = 8787,
  host = '127.0.0.1',
  logger = () => {},
}) {
  const { WebSocketServer } = await import('ws')
  const activeProtocol = protocol ?? new AgentProtocolServer({ engine })
  const server = new WebSocketServer({ host, port })

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

      logger({ type: 'message_received', messageType: message?.type })
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
    if (server.address()) {
      resolve()
      return
    }
    server.once('listening', resolve)
    server.once('error', reject)
  })

  return server
}
