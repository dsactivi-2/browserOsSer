import { Hono } from 'hono'
import type { DependencyScanner } from '../scanner/dependency-scanner'

export interface ScannerRoutesDeps {
  dependencyScanner: DependencyScanner
}

export function createScannerRoutes(deps: ScannerRoutesDeps) {
  const { dependencyScanner } = deps
  const app = new Hono()

  app.post('/scan', async (c) => {
    try {
      const body = (await c.req.json()) as { packageJsonPath?: string }
      const packageJsonPath = body.packageJsonPath ?? './package.json'

      const result = await dependencyScanner.scan(packageJsonPath)
      return c.json(result)
    } catch (error) {
      return c.json(
        {
          error: `Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        },
        500,
      )
    }
  })

  app.get('/', (c) => {
    const result = dependencyScanner.getCachedScan()

    if (!result) {
      return c.json(
        { error: 'No scan results cached. Run POST /scan first.' },
        404,
      )
    }

    return c.json(result)
  })

  app.get('/outdated', (c) => {
    const scan = dependencyScanner.getCachedScan()

    if (!scan) {
      return c.json(
        { error: 'No scan results cached. Run POST /scan first.' },
        404,
      )
    }

    const outdated = dependencyScanner.getOutdated()

    return c.json({
      scannedAt: scan.scannedAt,
      totalOutdated: outdated.length,
      dependencies: outdated,
    })
  })

  return app
}
