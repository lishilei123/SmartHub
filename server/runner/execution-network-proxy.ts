import { createServer, request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { ExecutionEnvironmentSnapshot } from '../domain/test-execution-types.js'

/** Transport boundary shared by Chromium and APIRequestContext, including redirects. */
export async function createExecutionNetworkProxy(environment: ExecutionEnvironmentSnapshot) {
  const allowed = new Set(environment.targets.map(target =>
    `${target.protocol}://${target.host.toLowerCase()}:${target.port}`))
  const violations: string[] = []
  const sockets = new Set<Socket>()
  const permits = (url: URL) => {
    const accepted = !url.username && !url.password && allowed.has(
      `${url.protocol.slice(0, -1)}://${url.hostname.toLowerCase()}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`,
    )
    if (!accepted) violations.push(`${url.protocol}//${url.host}`)
    return accepted
  }
  const track = (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    return socket
  }
  const server = createServer((incoming, outgoing) => {
    let url: URL
    try { url = new URL(incoming.url ?? '') } catch {
      violations.push('invalid-proxy-target')
      outgoing.writeHead(403).end()
      return
    }
    if (url.protocol !== 'http:') {
      violations.push('unsupported-proxy-protocol')
      outgoing.writeHead(403).end('TEST_EXECUTION_NETWORK_TARGET_REJECTED')
      return
    }
    if (!permits(url)) {
      outgoing.writeHead(403).end('TEST_EXECUTION_NETWORK_TARGET_REJECTED')
      return
    }
    const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upstream = httpRequest(url, { method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(outgoing)
    })
    upstream.on('socket', track)
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    })
    incoming.on('aborted', () => upstream.destroy())
    incoming.pipe(upstream)
  })
  server.on('connection', track)
  server.on('connect', (incoming, socket, head) => {
    let url: URL
    try { url = new URL(`https://${incoming.url ?? ''}`) } catch {
      violations.push('invalid-connect-target')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const matchingTargets = environment.targets.filter(target => target.host.toLowerCase() === url.hostname.toLowerCase()
      && target.port === Number(url.port || 443))
    if (!matchingTargets.length) {
      violations.push(`${url.protocol}//${url.host}`)
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    // Playwright uses CONNECT for plain HTTP too. Check the first client bytes
    // before opening the peer, so HTTP permission cannot authorize a TLS tunnel.
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let prefix = head
    const timeout = setTimeout(() => socket.destroy(), 5_000)
    timeout.unref()
    socket.once('close', () => clearTimeout(timeout))
    const inspect = (chunk: Buffer) => {
      prefix = Buffer.concat([prefix, chunk])
      if (prefix.length < 8) return
      socket.off('data', inspect)
      socket.pause()
      clearTimeout(timeout)
      const protocol = prefix[0] === 22 && prefix[1] === 3 ? 'https'
        : /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) /u.test(prefix.toString('ascii', 0, 8)) ? 'http' : undefined
      if (!protocol || !matchingTargets.some(target => target.protocol === protocol)) {
        violations.push('connect-protocol-rejected')
        socket.destroy()
        return
      }
      const upstream = track(connect(Number(url.port || 443), url.hostname, () => {
        upstream.write(prefix)
        socket.pipe(upstream)
        upstream.pipe(socket)
        socket.resume()
      }))
      socket.on('close', () => upstream.destroy())
    }
    socket.on('data', inspect)
    if (head.length) inspect(Buffer.alloc(0))
  })
  server.on('upgrade', (incoming, socket, head) => {
    let url: URL
    try {
      url = new URL(incoming.url ?? '')
      if (url.protocol === 'ws:') url.protocol = 'http:'
    } catch {
      violations.push('invalid-websocket-target')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    if (!permits(url) || url.protocol !== 'http:') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const headers: OutgoingHttpHeaders = { ...incoming.headers, host: url.host }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const upstream = httpRequest(url, { method: incoming.method, headers })
    upstream.on('socket', track)
    upstream.once('upgrade', (response, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders
        .reduce<string[]>((lines, value, index, all) => index % 2 ? lines : [...lines, `${value}: ${all[index + 1]}`], [])
        .join('\r\n')}\r\n\r\n`)
      if (head.length) peer.write(head)
      if (peerHead.length) socket.write(peerHead)
      socket.pipe(peer)
      peer.pipe(socket)
    })
    upstream.on('response', () => { upstream.destroy(); socket.destroy() })
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('TEST_EXECUTION_NETWORK_PROXY_UNAVAILABLE')
  return {
    server: `http://127.0.0.1:${address.port}`,
    violations,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
