import { createMiddleware } from 'hono/factory'

export function createRequestLogger() {
  return createMiddleware(async (c, next) => {
    const requestId = c.req.header('X-Request-ID') ?? crypto.randomUUID()
    const start = performance.now()

    c.header('X-Request-ID', requestId)

    await next()

    const duration = Math.round(performance.now() - start)
    const status = c.res.status

    console.log(
      JSON.stringify({
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        msg: `${c.req.method} ${c.req.path}`,
        requestId,
        method: c.req.method,
        path: c.req.path,
        status,
        durationMs: duration,
        timestamp: new Date().toISOString(),
      }),
    )
  })
}
