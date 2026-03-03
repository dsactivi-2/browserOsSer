import path from 'node:path'
import { AdaptiveTokenOptimizer } from '@browseros/learning/memory/adaptive-optimizer'
import { CrossSessionStore } from '@browseros/learning/memory/cross-session-store'
import { MemoryAnalyzer } from '@browseros/learning/memory/memory-analyzer'
import { MemoryStore } from '@browseros/learning/memory/memory-store'
import { PersistentSessionManager } from '@browseros/learning/memory/persistent-session'
import { TokenBudgetManager } from '@browseros/learning/memory/token-budget-manager'
import { createAdminRoutes } from './api/admin-routes'
import { createApiKeyRoutes } from './api/api-key-routes'
import { createAuditRoutes } from './api/audit-routes'
import { createConnectorRoutes } from './api/connector-routes'
import { createHealthRoutes } from './api/health-routes'
import { createLearningRoutes } from './api/learning-routes'
import { createMetricsRoutes } from './api/metrics-routes'
import { createNotificationRoutes } from './api/notification-routes'
import { createPreferencesRoutes } from './api/preferences-routes'
import { createRouterRoutes } from './api/router-routes'
import { createScannerRoutes } from './api/scanner-routes'
import { createTaskRoutes } from './api/task-routes'
import { createTemplateRoutes } from './api/template-routes'
import { createTimelineRoutes } from './api/timeline-routes'
import { createTrainingRoutes } from './api/training-routes'
import { AuditStore } from './audit/audit-store'
import { ApiKeyStore } from './auth/api-key-store'
import { ChromiumLauncher } from './browser-runtime/chromium-launcher'
import { VncProxy } from './browser-runtime/vnc-proxy'
import { XvfbManager } from './browser-runtime/xvfb-manager'
import type { ServerEditionConfig } from './config'
import { ConnectorManager } from './connectors/connector-manager'
import { RestConnector } from './connectors/rest/rest-connector'
import { WebhookConnector } from './connectors/webhook/webhook-connector'
import { DatabaseProvider } from './database'
import { createAuthMiddleware } from './middleware/auth'
import { createRequestLogger } from './middleware/request-logger'
import { NotificationManager } from './notifications/notification-manager'
import { LLMRouter } from './router/llm-router'
import { DependencyScanner } from './scanner/dependency-scanner'
import { TaskScheduler } from './task-queue/task-scheduler'
import { TaskStore } from './task-queue/task-store'
import { TaskTemplateStore } from './task-queue/task-template-store'
import { AutoTrainer } from './training/auto-trainer'

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
  private connectorManager: ConnectorManager | null = null
  private auditStore: AuditStore | null = null
  private apiKeyStore: ApiKeyStore | null = null
  private notificationManager: NotificationManager | null = null
  private taskTemplateStore: TaskTemplateStore | null = null
  private autoTrainer: AutoTrainer | null = null
  private dependencyScanner: DependencyScanner | null = null
  private startTime = Date.now()

  constructor(config: ServerEditionConfig) {
    this.config = config
  }

  async start(): Promise<void> {
    console.log(`Starting BrowserOS Server Edition (mode: ${this.config.mode})`)

    // Initialize shared database (single connection for all stores)
    DatabaseProvider.create(this.config.dbPath)
    console.log(`Database initialized at ${this.config.dbPath} (WAL mode)`)

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

    // Step 9: Initialize dashboard features
    this.initializeDashboard()

    // Step 10: Initialize health routes
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
    const extensionPath =
      this.config.extensionPath ??
      path.resolve(
        process.cwd(),
        this.config.chromium.extensionDir ?? 'apps/controller-ext/dist',
      )

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
    const db = DatabaseProvider.get()!
    this.taskStore = new TaskStore(db)
    this.taskScheduler = new TaskScheduler(
      this.taskStore,
      { serverPort: this.config.serverPort },
      { maxConcurrent: this.config.taskQueue.maxConcurrent },
    )

    // Mount task routes on the existing application
    if (this.application?.getHttpApp()) {
      const taskApp = createTaskRoutes({
        taskStore: this.taskStore,
        taskScheduler: this.taskScheduler,
      })
      this.application.getHttpApp().route('/tasks', taskApp)
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
    const db = DatabaseProvider.get()!
    this.llmRouter = new LLMRouter({
      db,
      enableSelfLearning: true,
    })

    // Mount router routes on the existing application
    if (this.application?.getHttpApp()) {
      const routerApp = createRouterRoutes({
        llmRouter: this.llmRouter,
      })
      this.application.getHttpApp().route('/router', routerApp)
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
    const db = DatabaseProvider.get()!

    this.memoryStore = new MemoryStore(db, {
      dbPath: this.config.dbPath,
      maxShortTermTokens: 190_000,
      compressionThreshold: 0.7,
      analysisInterval: 20,
      embeddingDimension: 384,
    })

    this.sessionManager = new PersistentSessionManager(db)
    this.crossSessionStore = new CrossSessionStore(db)
    this.tokenBudgetManager = new TokenBudgetManager()
    this.memoryAnalyzer = new MemoryAnalyzer()

    this.adaptiveOptimizer = new AdaptiveTokenOptimizer(
      db,
      this.memoryStore,
      this.memoryAnalyzer,
      this.tokenBudgetManager,
    )
    this.adaptiveOptimizer.start()
    console.log('Adaptive token optimizer started (auto-adjusts every 2min)')

    // Mount learning routes on the existing application
    if (this.application?.getHttpApp()) {
      const learningApp = createLearningRoutes({
        memoryStore: this.memoryStore,
        sessionManager: this.sessionManager,
        crossSessionStore: this.crossSessionStore,
        tokenBudgetManager: this.tokenBudgetManager,
        memoryAnalyzer: this.memoryAnalyzer,
        adaptiveOptimizer: this.adaptiveOptimizer,
      })
      this.application.getHttpApp().route('/learning', learningApp)
      console.log(
        `Learning API mounted at http://127.0.0.1:${this.config.serverPort}/learning`,
      )
    }

    console.log('Memory system initialized')
  }

  private applyMiddleware(): void {
    if (!this.application?.getHttpApp()) return

    // Global error handler — catch unhandled exceptions
    this.application.getHttpApp().onError((err: Error, c: any) => {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'Unhandled error',
          error: err.message,
          path: c.req.path,
          method: c.req.method,
          timestamp: new Date().toISOString(),
        }),
      )
      return c.json({ error: 'Internal server error' }, 500)
    })

    this.application.getHttpApp().use('*', createRequestLogger())
    if (this.config.auth.enabled) {
      this.application.getHttpApp().use(
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
    const db = DatabaseProvider.get()!
    this.connectorManager = new ConnectorManager(db)
    this.connectorManager.registerFactory('rest', () => new RestConnector())
    this.connectorManager.registerFactory(
      'webhook',
      () => new WebhookConnector(),
    )

    if (this.application?.getHttpApp()) {
      const connectorApp = createConnectorRoutes({
        connectorManager: this.connectorManager,
      })
      this.application.getHttpApp().route('/connectors', connectorApp)
      console.log(
        `Connector API mounted at http://127.0.0.1:${this.config.serverPort}/connectors`,
      )
    }
    console.log('Connector system initialized')
  }

  private initializeDashboard(): void {
    const db = DatabaseProvider.get()!
    const httpApp = this.application?.getHttpApp()
    if (!httpApp) return

    console.log('Initializing dashboard features...')
    const getUptime = () => Math.floor((Date.now() - this.startTime) / 1000)

    this.auditStore = new AuditStore(db)
    this.apiKeyStore = new ApiKeyStore(db)
    this.notificationManager = new NotificationManager(db)
    this.taskTemplateStore = new TaskTemplateStore(db)
    this.autoTrainer = new AutoTrainer(db)
    this.dependencyScanner = new DependencyScanner(db)

    this.auditStore.log({ action: 'system.started', actor: 'system' })
    this.autoTrainer.startAutoTraining()

    httpApp.route('/metrics', createMetricsRoutes({ db, getUptime }))
    httpApp.route('/audit', createAuditRoutes({ auditStore: this.auditStore }))
    httpApp.route(
      '/api-keys',
      createApiKeyRoutes({ apiKeyStore: this.apiKeyStore }),
    )
    httpApp.route(
      '/notifications',
      createNotificationRoutes(this.notificationManager),
    )
    httpApp.route(
      '/templates',
      createTemplateRoutes({ templateStore: this.taskTemplateStore }),
    )
    httpApp.route('/timeline', createTimelineRoutes({ db }))
    httpApp.route(
      '/training',
      createTrainingRoutes({ autoTrainer: this.autoTrainer }),
    )
    httpApp.route(
      '/scanner',
      createScannerRoutes({ dependencyScanner: this.dependencyScanner }),
    )
    httpApp.route('/preferences', createPreferencesRoutes({ db }))
    httpApp.route(
      '/admin',
      createAdminRoutes({ db, getUptime, dbPath: this.config.dbPath }),
    )

    console.log(
      'Dashboard features initialized (metrics, audit, api-keys, notifications, templates, timeline, training, scanner, preferences, admin)',
    )
  }

  private initializeHealth(): void {
    if (!this.application?.getHttpApp()) return
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
    this.application.getHttpApp().route('/health', healthApp)
    console.log(
      `Health API mounted at http://127.0.0.1:${this.config.serverPort}/health`,
    )
  }

  async stop(): Promise<void> {
    console.log('Shutting down Server Edition...')

    if (this.autoTrainer) {
      this.autoTrainer.stopAutoTraining()
      console.log('Auto-trainer stopped')
    }

    if (this.auditStore) {
      this.auditStore.log({ action: 'system.stopped', actor: 'system' })
    }

    if (this.connectorManager) {
      await this.connectorManager.shutdownAll()
      console.log('Connectors shut down')
    }

    if (this.adaptiveOptimizer) {
      this.adaptiveOptimizer.stop()
      console.log('Adaptive optimizer stopped')
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

    // Close the shared database connection last
    DatabaseProvider.close()
    console.log('Database closed')

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
