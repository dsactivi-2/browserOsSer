/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AdaptiveTokenOptimizer } from '@browseros/learning/memory/adaptive-optimizer'
import type {
  CrossSessionStore,
  KnowledgeCategory,
} from '@browseros/learning/memory/cross-session-store'
import type { MemoryAnalyzer } from '@browseros/learning/memory/memory-analyzer'
import type { MemoryStore } from '@browseros/learning/memory/memory-store'
import type { PersistentSessionManager } from '@browseros/learning/memory/persistent-session'
import type { TokenBudgetManager } from '@browseros/learning/memory/token-budget-manager'
import { Hono } from 'hono'

interface MemoryEntry {
  id: string
  type: string
  content: string
  role?: string
  metadata?: unknown
  relevanceScore?: number
  isCompressed?: boolean
  compressedAt?: string
  createdAt: string
}

interface SessionEntry {
  conversationId: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

interface KnowledgeEntry {
  id: string
  category: string
  key: string
  value: string
  confidence?: number
  usageCount?: number
  lastUsedAt?: string
  createdAt: string
}

export interface LearningRoutesDeps {
  memoryStore: MemoryStore
  sessionManager: PersistentSessionManager
  crossSessionStore: CrossSessionStore
  tokenBudgetManager: TokenBudgetManager
  memoryAnalyzer: MemoryAnalyzer
  adaptiveOptimizer?: AdaptiveTokenOptimizer
}

export function createLearningRoutes(deps: LearningRoutesDeps) {
  const {
    memoryStore,
    sessionManager,
    crossSessionStore,
    tokenBudgetManager,
    memoryAnalyzer,
    adaptiveOptimizer,
  } = deps
  const app = new Hono()

  // GET /learning/memory/stats — Memory statistics
  app.get('/memory/stats', async (c) => {
    const sessionId = c.req.query('sessionId')
    const stats = memoryStore.getStats(sessionId)
    return c.json(stats)
  })

  // GET /learning/memory — Get memory entries for session
  app.get('/memory', async (c) => {
    const sessionId = c.req.query('sessionId')
    const type = c.req.query('type') as
      | 'short_term'
      | 'long_term'
      | 'cross_session'
      | undefined
    const limitStr = c.req.query('limit')
    const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined

    if (!sessionId) {
      return c.json({ error: 'sessionId query parameter required' }, 400)
    }

    const entries = memoryStore.getBySession(sessionId, type, limit)
    return c.json({
      sessionId,
      type: type ?? 'all',
      count: entries.length,
      entries: entries.map((e: MemoryEntry) => ({
        id: e.id,
        type: e.type,
        content: e.content,
        role: e.role,
        metadata: e.metadata,
        relevanceScore: e.relevanceScore,
        isCompressed: e.isCompressed,
        compressedAt: e.compressedAt,
        createdAt: e.createdAt,
      })),
    })
  })

  // GET /learning/memory/budget — Get current token budget status
  app.get('/memory/budget', async (c) => {
    const sessionId = c.req.query('sessionId')
    if (!sessionId) {
      return c.json({ error: 'sessionId query parameter required' }, 400)
    }

    const entries = memoryStore.getBySession(sessionId)
    const totalTokens = entries.reduce((sum: number, e: MemoryEntry) => {
      const tokens = tokenBudgetManager.estimateTokens(e.content)
      return sum + tokens
    }, 0)

    const status = tokenBudgetManager.getStatus(totalTokens)
    return c.json(status)
  })

  // POST /learning/memory/analyze — Trigger memory self-analysis
  app.post('/memory/analyze', async (c) => {
    const body = await c.req.json()
    const { sessionId } = body

    if (!sessionId) {
      return c.json({ error: 'sessionId field required in request body' }, 400)
    }

    const entries = memoryStore.getBySession(sessionId)
    const totalTokens = entries.reduce((sum: number, e: MemoryEntry) => {
      return sum + tokenBudgetManager.estimateTokens(e.content)
    }, 0)

    const budget = tokenBudgetManager.getAvailableBudget()
    const currentBudget = {
      maxTokens: budget,
      usedTokens: totalTokens,
      remainingTokens: budget - totalTokens,
      compressionThreshold: 0.7,
      messages: {
        total: entries.length,
        full: entries.filter((e: MemoryEntry) => !e.isCompressed).length,
        compressed: entries.filter((e: MemoryEntry) => e.isCompressed).length,
        dropped: 0,
      },
    }

    const result = memoryAnalyzer.analyze(entries, currentBudget)
    return c.json(result)
  })

  // GET /learning/sessions — List all persistent sessions
  app.get('/sessions', async (c) => {
    const limitStr = c.req.query('limit')
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 50
    const sessions = sessionManager.listSessions(limit)
    return c.json({
      count: sessions.length,
      sessions: sessions.map((s: SessionEntry) => ({
        conversationId: s.conversationId,
        messageCount: s.messageCount,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    })
  })

  // GET /learning/sessions/:conversationId — Get session details + history
  app.get('/sessions/:conversationId', async (c) => {
    const conversationId = c.req.param('conversationId')
    const session = sessionManager.getOrCreate(conversationId)
    return c.json(session)
  })

  // GET /learning/knowledge — Search cross-session knowledge
  app.get('/knowledge', async (c) => {
    const query = c.req.query('q')
    const category = c.req.query('category') as KnowledgeCategory | undefined
    const limitStr = c.req.query('limit')
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 20

    if (!query) {
      return c.json({ error: 'q query parameter required (search term)' }, 400)
    }

    const results = crossSessionStore.search(query, category, limit)
    return c.json({
      query,
      category: category ?? 'all',
      count: results.length,
      results: results.map((r: KnowledgeEntry) => ({
        id: r.id,
        category: r.category,
        key: r.key,
        value: r.value,
        confidence: r.confidence,
        usageCount: r.usageCount,
        lastUsedAt: r.lastUsedAt,
        createdAt: r.createdAt,
      })),
    })
  })

  // GET /learning/knowledge/stats — Cross-session knowledge statistics
  app.get('/knowledge/stats', async (c) => {
    const stats = crossSessionStore.getStats()
    return c.json(stats)
  })

  // POST /learning/knowledge — Store cross-session knowledge
  app.post('/knowledge', async (c) => {
    const body = await c.req.json()
    const { category, key, value, confidence } = body

    if (!category || !key || !value) {
      return c.json({ error: 'category, key, and value fields required' }, 400)
    }

    const validCategories = [
      'domain',
      'execution_pattern',
      'user_preference',
      'website_knowledge',
      'error_pattern',
    ]
    if (!validCategories.includes(category)) {
      return c.json(
        {
          error: `Invalid category. Must be one of: ${validCategories.join(', ')}`,
        },
        400,
      )
    }

    const id = crossSessionStore.store(category, key, value, confidence)
    return c.json(
      {
        id,
        category,
        key,
        stored: true,
      },
      201,
    )
  })

  // GET /learning/optimizer/status — Current adaptive parameters and efficiency
  app.get('/optimizer/status', async (c) => {
    if (!adaptiveOptimizer) {
      return c.json({ error: 'Adaptive optimizer not enabled' }, 404)
    }
    return c.json({
      parameters: adaptiveOptimizer.getCurrentParameters(),
      efficiency: adaptiveOptimizer.getEfficiencyReport(),
    })
  })

  // POST /learning/optimizer/run — Trigger manual optimization run
  app.post('/optimizer/run', async (c) => {
    if (!adaptiveOptimizer) {
      return c.json({ error: 'Adaptive optimizer not enabled' }, 404)
    }
    const body = await c.req.json().catch(() => ({}))
    const sessionId =
      body && typeof body === 'object' && 'sessionId' in body
        ? String((body as { sessionId: unknown }).sessionId)
        : undefined
    const result = adaptiveOptimizer.runOptimization(sessionId)
    if (!result) {
      return c.json({ message: 'Not enough entries for optimization' })
    }
    return c.json(result)
  })

  // GET /learning/optimizer/history — Optimization history
  app.get('/optimizer/history', async (c) => {
    if (!adaptiveOptimizer) {
      return c.json({ error: 'Adaptive optimizer not enabled' }, 404)
    }
    const limitStr = c.req.query('limit')
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 20
    return c.json({ history: adaptiveOptimizer.getHistory(limit) })
  })

  return app
}
