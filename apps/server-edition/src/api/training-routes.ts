import { Hono } from 'hono'
import type { AutoTrainer } from '../training/auto-trainer'

export interface TrainingRoutesDeps {
  autoTrainer: AutoTrainer
}

export function createTrainingRoutes(deps: TrainingRoutesDeps) {
  const { autoTrainer } = deps
  const app = new Hono()

  // GET /patterns — List training patterns
  app.get('/patterns', (c) => {
    const limitStr = c.req.query('limit')
    const limit = limitStr ? Number.parseInt(limitStr, 10) : 50
    const type = c.req.query('type')
    const patterns = autoTrainer.getPatterns(limit, type)
    return c.json({ count: patterns.length, patterns })
  })

  // POST /train — Trigger manual training run
  app.post('/train', (c) => {
    const stats = autoTrainer.train()
    return c.json(stats)
  })

  // GET /recommend — Get recommendation for an instruction
  app.get('/recommend', (c) => {
    const instruction = c.req.query('instruction')
    if (!instruction) {
      return c.json({ error: 'instruction query parameter required' }, 400)
    }
    const pattern = autoTrainer.getRecommendation(instruction)
    if (!pattern) {
      return c.json({ recommendation: null })
    }
    return c.json({ recommendation: pattern })
  })

  // GET /stats — Training statistics
  app.get('/stats', (c) => {
    return c.json(autoTrainer.getStats())
  })

  // DELETE /patterns/:id — Delete a pattern
  app.delete('/patterns/:id', (c) => {
    const id = c.req.param('id')
    const deleted = autoTrainer.deletePattern(id)
    if (!deleted) {
      return c.json({ error: 'Pattern not found' }, 404)
    }
    return c.json({ id, deleted: true })
  })

  return app
}
