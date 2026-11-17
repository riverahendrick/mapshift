// `mapshift dash`: a read-only dashboard on this computer only. It listens on 127.0.0.1, on a random port,
// behind a random token in the address, answers only GET requests, and stops itself after 10 idle minutes.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { which } from '../setup/env.ts'
import { page } from './page.ts'
import type { Snapshot } from './snapshot.ts'

export type Dash = { url: string; port: number; token: string; server: Server; closed: Promise<void>; close: () => void }

export const IDLE_MS = 10 * 60_000

export function startDash(o: { port?: number; idleMs?: number; data: () => Snapshot }): Promise<Dash> {
  const token = randomBytes(18).toString('base64url')
  const base = `/${token}/`
  let last = Date.now()
  let port = 0

  const send = (res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extra,
    })
    res.end(body)
  }

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    // only this computer, by the name it was opened with (a web page cannot point another name here)
    const host = String(req.headers.host ?? '')
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden')
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Read only', { Allow: 'GET, HEAD' })
    const path = (req.url ?? '').split('?')[0]!
    if (!path.startsWith(base)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found')
    last = Date.now()
    const rest = path.slice(base.length)
    if (rest === '') {
      const nonce = randomBytes(16).toString('base64')
      return send(res, 200, 'text/html; charset=utf-8', page(nonce), {
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      })
    }
    if (rest === 'api/state') {
      try {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(o.data()))
      } catch (err) {
        return send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ error: (err as Error).message }))
      }
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'Not found')
  }

  const server = createServer(handle)
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(o.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      port = typeof addr === 'object' && addr ? addr.port : 0
      let stop: () => void = () => undefined
      const closed = new Promise<void>(done => {
        stop = () => {
          clearInterval(timer)
          server.close(() => done())
          server.closeAllConnections()
        }
      })
      const idle = o.idleMs ?? IDLE_MS
      const timer = setInterval(() => Date.now() - last > idle && stop(), Math.min(30_000, Math.max(50, idle / 4)))
      ok({ url: `http://127.0.0.1:${port}${base}`, port, token, server, closed, close: stop })
    })
  })
}

/**
 * Opens the address in the default browser with the system's own opener, started by its full path from the
 * home folder and given the address as one argument (no shell, so nothing in it is ever run as a command).
 */
export function openBrowser(url: string): boolean {
  let exe: string | null = null
  if (process.platform === 'win32') exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
  else if (process.platform === 'darwin') exe = '/usr/bin/open'
  else exe = which('xdg-open')
  if (!exe || !existsSync(exe)) return false
  try {
    const child = spawn(exe, [url], { cwd: homedir(), detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
