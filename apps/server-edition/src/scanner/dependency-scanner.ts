import type { Database } from 'bun:sqlite'

export interface DependencyInfo {
  name: string
  currentVersion: string
  latestVersion: string | null
  updateType: 'major' | 'minor' | 'patch' | 'up-to-date' | 'unknown'
  riskLevel: 'low' | 'medium' | 'high'
  lastCheckedAt: string
}

export interface ScanResult {
  scannedAt: string
  totalDependencies: number
  outdated: number
  upToDate: number
  dependencies: DependencyInfo[]
}

function compareSemver(
  current: string,
  latest: string,
): 'major' | 'minor' | 'patch' | 'up-to-date' {
  const normalizeCurrent = current.replace(/^[^0-9]+/, '')
  const normalizeLatest = latest.replace(/^[^0-9]+/, '')

  const currentParts = normalizeCurrent.split('.').map((p) => parseInt(p, 10))
  const latestParts = normalizeLatest.split('.').map((p) => parseInt(p, 10))

  const currentMajor = currentParts[0] ?? 0
  const currentMinor = currentParts[1] ?? 0
  const currentPatch = currentParts[2] ?? 0

  const latestMajor = latestParts[0] ?? 0
  const latestMinor = latestParts[1] ?? 0
  const latestPatch = latestParts[2] ?? 0

  if (latestMajor > currentMajor) return 'major'
  if (latestMajor === currentMajor && latestMinor > currentMinor) return 'minor'
  if (
    latestMajor === currentMajor &&
    latestMinor === currentMinor &&
    latestPatch > currentPatch
  ) {
    return 'patch'
  }

  return 'up-to-date'
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export class DependencyScanner {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dependency_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scanned_at TEXT NOT NULL,
        package_json_path TEXT NOT NULL,
        scan_data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dependency_scans_scanned_at ON dependency_scans(scanned_at DESC);
    `)
  }

  async scan(packageJsonPath: string): Promise<ScanResult> {
    const file = Bun.file(packageJsonPath)
    const content = await file.text()
    const packageJson = JSON.parse(content) as PackageJson

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }

    const depNames = Object.keys(allDeps)
    const dependencies: DependencyInfo[] = []

    const batchSize = 10
    for (let i = 0; i < depNames.length; i += batchSize) {
      const batch = depNames.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map((name) => this.checkDependency(name, allDeps[name])),
      )
      dependencies.push(...results)
    }

    const scannedAt = new Date().toISOString()
    const outdated = dependencies.filter(
      (d) => d.updateType !== 'up-to-date',
    ).length
    const upToDate = dependencies.length - outdated

    const result: ScanResult = {
      scannedAt,
      totalDependencies: dependencies.length,
      outdated,
      upToDate,
      dependencies,
    }

    const stmt = this.db.prepare(`
      INSERT INTO dependency_scans (scanned_at, package_json_path, scan_data, created_at)
      VALUES (?, ?, ?, ?)
    `)

    stmt.run(scannedAt, packageJsonPath, JSON.stringify(result), scannedAt)

    return result
  }

  private async checkDependency(
    name: string,
    currentVersion: string,
  ): Promise<DependencyInfo> {
    const cleanVersion = currentVersion.replace(/^[~^>=<\s]+/, '')

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)

      const response = await fetch(
        `https://registry.npmjs.org/${name}/latest`,
        {
          signal: controller.signal,
        },
      )

      clearTimeout(timeout)

      if (!response.ok) {
        return {
          name,
          currentVersion: cleanVersion,
          latestVersion: null,
          updateType: 'unknown',
          riskLevel: 'low',
          lastCheckedAt: new Date().toISOString(),
        }
      }

      const data = (await response.json()) as { version?: string }
      const latestVersion = data.version

      if (!latestVersion) {
        return {
          name,
          currentVersion: cleanVersion,
          latestVersion: null,
          updateType: 'unknown',
          riskLevel: 'low',
          lastCheckedAt: new Date().toISOString(),
        }
      }

      const updateType = compareSemver(cleanVersion, latestVersion)

      let riskLevel: 'low' | 'medium' | 'high' = 'low'
      if (updateType === 'major') riskLevel = 'high'
      else if (updateType === 'minor') riskLevel = 'medium'

      return {
        name,
        currentVersion: cleanVersion,
        latestVersion,
        updateType,
        riskLevel,
        lastCheckedAt: new Date().toISOString(),
      }
    } catch {
      return {
        name,
        currentVersion: cleanVersion,
        latestVersion: null,
        updateType: 'unknown',
        riskLevel: 'low',
        lastCheckedAt: new Date().toISOString(),
      }
    }
  }

  getCachedScan(): ScanResult | null {
    const row = this.db
      .prepare(
        'SELECT scan_data FROM dependency_scans ORDER BY scanned_at DESC LIMIT 1',
      )
      .get() as any

    if (!row) return null

    try {
      return JSON.parse(row.scan_data) as ScanResult
    } catch {
      return null
    }
  }

  getOutdated(): DependencyInfo[] {
    const scan = this.getCachedScan()
    if (!scan) return []
    return scan.dependencies.filter((d) => d.updateType !== 'up-to-date')
  }
}
