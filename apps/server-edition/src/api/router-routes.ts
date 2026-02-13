/**
 * @license
 * Copyright 2025 BrowserOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { Hono } from 'hono'
import type { LLMRouter } from '../router/llm-router'

export interface RouterRoutesDeps {
  llmRouter: LLMRouter
}

export function createRouterRoutes(deps: RouterRoutesDeps) {
  const { llmRouter } = deps
  const app = new Hono()

  // GET / — Get routing table
  app.get('/', async (c) => {
    const table = llmRouter.getRoutingTable()
    return c.json({
      routes: table.map((entry) => ({
        toolPattern: entry.toolPattern,
        provider: entry.provider,
        model: entry.model,
        category: entry.category,
        isOverride: entry.isOverride ?? false,
      })),
    })
  })

  // GET /metrics — Get aggregated metrics
  app.get('/metrics', async (c) => {
    const tool = c.req.query('tool')
    const metrics = llmRouter.getMetrics(tool)
    return c.json({ metrics })
  })

  // GET /route/:toolName — Test routing for a specific tool
  app.get('/route/:toolName', async (c) => {
    const toolName = c.req.param('toolName')
    const decision = llmRouter.route(toolName)
    return c.json(decision)
  })

  // GET /config/:toolName — Get full LLMConfig for a tool
  app.get('/config/:toolName', async (c) => {
    const toolName = c.req.param('toolName')
    const config = llmRouter.buildConfigForTool(toolName)

    if (!config) {
      return c.json({ error: 'No configuration available for tool' }, 404)
    }

    return c.json(config)
  })

  return app
}
