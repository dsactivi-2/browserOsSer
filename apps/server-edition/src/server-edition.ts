import { Database } from 'bun:sqlite'
import path from 'node:path'
import { AdaptiveTokenOptimizer } from '@browseros/learning/memory/adaptive-optimizer'
import { CrossSessionStore } from '@browseros/learning/memory/cross-session-store'
import { MemoryAnalyzer } from '@browseros/learning/memory/memory-analyzer'
import { MemoryStore } from '@browseros/learning/memory/memory-store'
import { PersistentSessionManager } from '@browseros/learning/memory/persistent-session'
import { TokenBudgetManager } from '@browseros/learning/memory/token-budget-manager'
import { createConnectorRoutes } from './api/connector-routes'
import { createHealthRoutes } from './api/health-routes'
import { createLearningRoutes } from './api/learning-routes'
import { createRouterRoutes } from './api/router-routes'
import { createTaskRoutes } from './api/task-routes'
import { ChromiumLauncher } from './browser-runtime/chromium-launcher'
import { VncProxy } from './browser-runtime/vnc-proxy'
import { XvfbManager } from './browser-runtime/xvfb-manager'
import type { ServerEditionConfig } from './config'
import { ConnectorManager } from './connectors/connector-manager'
import { RestConnector } from './connectors/rest/rest-connector'
import { WebhookConnector } from './connectors/webhook/webhook-connector'
import { createAuthMiddleware } from './middleware/auth'
import { createRequestLogger } from './middleware/request-logger'
import { LLMRouter } from './router/llm-router'
import { TaskScheduler } from './task-queue/task-scheduler'
import { TaskStore } from './task-queue/task-store'

export class ServerEdition {
  private config: ServerEditionConfig
  private xvfb: XvfbManager | null = null
  private chromium: ChromiumLauncher | null = null
  private vnc: VncProxy | null = null
  private application: any = null
  private taskStore: TaskStore | null = null
  private taskScheduler: TaskScheduler | null = null
  private llmRouter: LLMRouter | null = null
  private memoryStore: MemoryStore | null = null
  private sessionManager: PersistentSessionManager | null = null
  private crossSessionStore: CrossSessionStore | null = null
  private tokenBudgetManager: TokenBudgetManager | null = null
  private memoryAnalyzer: MemoryAnalyzer | null = null
  private adaptiveOptimizer: AdaptiveTokenOptimizer | null = null
  private optimizerDb: Database | null = null
  private connectorManager: ConnectorManager | null = null
  private startTime = Date.now()

  constructor(config: ServerEditionConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    console.log(`Starting BrowserOS Server Edition (mode: ${this.config.mode})`)

    if (this.config.mode === 'server') {
      await this.startXvfb()
    }

    await this.launchChromium()
    await this.startBrowserOSServer()

    // Apply middleware (before VNC and other routes)
    this.applyMiddleware()

    if (this.config.mode === 'server' && this.config.vnc.enabled) {
      await this.startVnc()
    }

    this.logStartupSummary()

    // Step 5: Initialize task queue
    await this.initializeTaskQueue()

    // Step 6: Initialize LLM router
    await this.initializeRouter()

    // Step 7: Initialize memory system
    await this.initializeMemory()

    // Step 8: Initialize connectors
    await this.initializeConnectors()

    // Step 9: Initialize health routes
    this.initializeHealth()
  }

  private async startXvfb(): Promise<void> {
    console.log(`Starting Xvfb on display ${this.config.xvfb.display}...`)
    this.xvfb = new XvfbManager({
      display: this.config.xvfb.display,
      resolution: this.config.xvfb.resolution,
    })
    await this.xvfb.start()
    console.log(`Xvfb running on display ${this.config.xvfb.display}`)
  }

  private async launchChromium(): Promise<void> {
    const extensionPath = this.config.extensionPath
      ?? path.resolve(process.cwd(), this.config.chromium.extensionDir ?? 'apps/controller-ext/dist')

    console.log(
      `Launching Chromium (CDP port: ${this.config.chromium.cdpPort})...`,
    )
    this.chromium = new ChromiumLauncher({
      executablePath: this.config.chromium.path,
      cdpPort: this.config.chromium.cdpPort,
      extensionPort: this.config.chromium.extensionPort,
      display:
        this.config.mode === 'server' ? this.config.xvfb.display : undefined,
      extensionPath,
    })
    await this.chromium.launch()
    console.log('Chromium launched and CDP available')
  }

  private async startBrowserOSServer(): Promise<void> {
    console.log(
      `Starting BrowserOS server on port ${this.config.serverPort}...`,
    )

    const { Application } = await import('@browseros/server/main')

    const serverConfig = {
      cdpPort: this.config.chromium.cdpPort,
      serverPort: this.config.serverPort,
      agentPort: this.config.serverPort,
      extensionPort: this.config.chromium.extensionPort,
      resourcesDir: process.cwd(),
      executionDir: path.dirname(this.config.dbPath),
      mcpAllowRemote: false,
    }

    this.application = new Application(serverConfig)
    await this.application.start()

    console.log(
      `BrowserOS server running on http://127.0.0.1:${this.config.serverPort}`,
    )
  }

  private async startVnc(): Promise<void> {
    console.log(`Starting VNC proxy on port ${this.config.vnc.port}...`)
    this.vnc = new VncProxy({
      enabled: true,
      port: this.config.vnc.port,
      password: this.config.vnc.password,
      display: this.config.xvfb.display,
    })
    await this.vnc.start()
    console.log(
      `VNC available at http://localhost:${this.config.vnc.port}/vnc.html`,
    )
  }

  private async initializeTaskQueue(): Promise<void> {
    console.log('Initializing task queue...')
    this.taskStore = new TaskStore(this.config.dbPath)
    this.taskScheduler = new TaskScheduler(
      this.taskStore,
      { serverPort: this.config.serverPort },
      { maxConcurrent: this.config.taskQueue.maxConcurrent },
    )

    // Mount task routes on the existing application
    if (this.application?.app) {
      const taskApp = createTaskRoutes({
        taskStore: this.taskStore,
        taskScheduler: this.taskScheduler,
      })
      this.application.app.route('/tasks', taskApp)
      console.log(
        `Task API mounted at http://127.0.0.1:${this.config.serverPort}/tasks`,
      )
    }

    // Start the scheduler
    this.taskScheduler.start()
    console.log('Task queue initialized and scheduler started')
  }

  private async initializeRouter(): Promise<void> {
    console.log('Initializing LLM router...')
    this.llmRouter = new LLMRouter({
      dbPath: this.config.dbPath,
      enableSelfLearning: true,
    })

    // Mount router routes on the existing application
    if (this.application?.app) {
      const routerApp = createRouterRoutes({
        llmRouter: this.llmRouter,
      })
      this.application.app.route('/router', routerApp)
      console.log(
        `Router API mounted at http://127.0.0.1:${this.config.serverPort}/router`,
      )
    }

    // Start self-learning optimization
    this.llmRouter.startSelfLearning()
    console.log('LLM router initialized and self-learning started')
  }

  private async initializeMemory(): Promise<void> {
    console.log('Initializing memory system...')

    this.memoryStore = new MemoryStore({
      dbPath: this.config.dbPath,
      maxShortTermTokens: 190_000,
      compressionThreshold: 0.7,
      analysisInterval: 20,
      embeddingDimension: 384,
    })

    this.sessionManager = new PersistentSessionManager(this.config.dbPath)
    this.crossSessionStore = new CrossSessionStore(this.config.dbPath)
    this.tokenBudgetManager = new TokenBudgetManager()
    this.memoryAnalyzer = new MemoryAnalyzer()

    this.optimizerDb = new Database(this.config.dbPath, { create: true })
    this.optimizerDb.exec('PRAGMA journal_mode = WAL')
    this.adaptiveOptimizer = new AdaptiveTokenOptimizer(
      this.optimizerDb,
      this.memoryStore,
      this.memoryAnalyzer,
      this.tokenBudgetManager,
    )
    this.adaptiveOptimizer.start()
    console.log('Adaptive token optimizer started (auto-adjusts every 2min)')

    // Mount learning routes on the existing application
    if (this.application?.app) {
      const learningApp = createLearningRoutes({
        memoryStore: this.memoryStore,
        sessionManager: this.sessionManager,
        crossSessionStore: this.crossSessionStore,
        tokenBudgetManager: this.tokenBudgetManager,
        memoryAnalyzer: this.memoryAnalyzer,
        adaptiveOptimizer: this.adaptiveOptimizer,
      })
      this.application.app.route('/learning', learningApp)
      console.log(
        `Learning API mounted at http://127.0.0.1:${this.config.serverPort}/learning`,
      )
    }

    console.log('Memory system initialized')
  }

  private applyMiddleware(): void {
    if (!this.application?.app) return
    this.application.app.use('*', createRequestLogger())
    if (this.config.auth.enabled) {
      this.application.app.use(
        '*',
        createAuthMiddleware({
          apiKeys: this.config.auth.apiKeys,
          excludePaths: ['/health'],
        }),
      )
      console.log('API key authentication enabled')
    }
  }

  private async initializeConnectors(): Promise<void> {
    console.log('Initializing connector system...')
    this.connectorManager = new ConnectorManager(this.config.dbPath)
    this.connectorManager.registerFactory('rest', () => new RestConnector())
    this.connectorManager.registerFactory(
      'webhook',
      () => new WebhookConnector(),
    )

    if (this.application?.app) {
      const connectorApp = createConnectorRoutes({
        connectorManager: this.connectorManager,
      })
      this.application.app.route('/connectors', connectorApp)
      console.log(
        `Connector API mounted at http://127.0.0.1:${this.config.serverPort}/connectors`,
      )
    }
    console.log('Connector system initialized')
  }

  private initializeHealth(): void {
    if (!this.application?.app) return
    const healthApp = createHealthRoutes({
      getUptime: () => Math.floor((Date.now() - this.startTime) / 1000),
      getVersion: () => '1.0.0',
      checks: [
        { name: 'chromium', check: async () => this.chromium !== null },
        { name: 'taskQueue', check: async () => this.taskStore !== null },
        { name: 'router', check: async () => this.llmRouter !== null },
        { name: 'memory', check: async () => this.memoryStore !== null },
      ],
    })
    this.application.app.route('/health', healthApp)
    console.log(
      `Health API mounted at http://127.0.0.1:${this.config.serverPort}/health`,
    )
  }

  async stop(): Promise<void> {
    console.log('Shutting down Server Edition...')

    if (this.connectorManager) {
      await this.connectorManager.shutdownAll()
      console.log('Connectors shut down')
    }

    if (this.adaptiveOptimizer) {
      this.adaptiveOptimizer.stop()
      console.log('Adaptive optimizer stopped')
    }

    if (this.optimizerDb) {
      this.optimizerDb.close()
      this.optimizerDb = null
      console.log('Optimizer database closed')
    }

    if (this.memoryStore) {
      this.memoryStore.close()
      console.log('Memory store closed')
    }

    if (this.sessionManager) {
      this.sessionManager.close()
      console.log('Session manager closed')
    }

    if (this.crossSessionStore) {
      this.crossSessionStore.close()
      console.log('Cross-session store closed')
    }

    if (this.llmRouter) {
      this.llmRouter.close()
      console.log('LLM router stopped')
    }

    if (this.taskScheduler) {
      await this.taskScheduler.stop()
      console.log('Task scheduler stopped')
    }

    if (this.taskStore) {
      this.taskStore.close()
      console.log('Task store closed')
    }

    if (this.vnc) {
      await this.vnc.stop()
      console.log('VNC stopped')
    }

    if (this.chromium) {
      await this.chromium.stop()
      console.log('Chromium stopped')
    }

    if (this.xvfb) {
      await this.xvfb.stop()
      console.log('Xvfb stopped')
    }

    console.log('Server Edition shutdown complete')
  }

  private logStartupSummary(): void {
    console.log('')
    console.log('=== BrowserOS Server Edition ===')
    console.log(`  Mode:   ${this.config.mode}`)
    console.log(`  API:    http://127.0.0.1:${this.config.serverPort}`)
    console.log(`  CDP:    ws://127.0.0.1:${this.config.chromium.cdpPort}`)

    if (this.vnc?.isRunning()) {
      console.log(`  VNC:    ${this.vnc.getUrl()}`)
    }

    if (this.config.auth.enabled) {
      console.log(`  Auth:   API Key (${this.config.auth.apiKeys.length} keys)`)
    }

    console.log('================================')
    console.log('')
  }

  getApplication() {
    return this.application
  }
}
