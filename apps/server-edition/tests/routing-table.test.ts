import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { RoutingTable } from '../src/router/routing-table'

describe('RoutingTable', () => {
  let db: Database
  let table: RoutingTable

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('PRAGMA journal_mode = WAL')
    table = new RoutingTable(db)
  })

  describe('default route resolution', () => {
    test('resolves known exact-match tool to default provider and model', () => {
      const decision = table.resolve('browser_navigate')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-haiku-4-5-20251001')
    })

    test('resolves vision tool to google gemini by default', () => {
      const decision = table.resolve('browser_get_screenshot')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('google')
      expect(decision.model).toBe('gemini-2.5-pro')
    })

    test('resolves complex tool to opus by default', () => {
      const decision = table.resolve('browser_multi_act')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-opus-4-6')
    })

    test('resolves standard tool to sonnet by default', () => {
      const decision = table.resolve('browser_execute_javascript')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-sonnet-4-5-20250929')
    })

    test('falls back to sonnet for completely unknown tool', () => {
      const decision = table.resolve('unknown_tool_xyz')
      expect(decision.reason).toBe('fallback')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-sonnet-4-5-20250929')
    })
  })

  describe('wildcard pattern matching', () => {
    test('resolves wildcard browser_tab_* pattern for browser_tab_close', () => {
      const decision = table.resolve('browser_tab_close')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-haiku-4-5-20251001')
    })

    test('resolves wildcard browser_tab_* pattern for browser_tab_open', () => {
      const decision = table.resolve('browser_tab_open')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-haiku-4-5-20251001')
    })

    test('resolves wildcard browser_scroll_* pattern for browser_scroll_down', () => {
      const decision = table.resolve('browser_scroll_down')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-haiku-4-5-20251001')
    })

    test('resolves wildcard browser_extract_* pattern for browser_extract_text', () => {
      const decision = table.resolve('browser_extract_text')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-sonnet-4-5-20250929')
    })

    test('wildcard does not match tool with different prefix', () => {
      // browser_tab_* should not match browser_tabs_list (different stem)
      const decision = table.resolve('browser_tabs_list')
      // Either matches via wildcard prefix or falls back — confirm it is not a mismatch
      // browser_tab_* prefix is "browser_tab_", "browser_tabs_list" starts with "browser_tab" but not "browser_tab_"
      // So it should fall back
      expect(decision.reason).toBe('fallback')
    })
  })

  describe('override management', () => {
    test('setOverride makes resolve return optimized reason', () => {
      table.setOverride(
        'browser_navigate',
        'openai',
        'gpt-4o-mini',
        'cost optimization',
      )
      const decision = table.resolve('browser_navigate')
      expect(decision.reason).toBe('optimized')
      expect(decision.provider).toBe('openai')
      expect(decision.model).toBe('gpt-4o-mini')
    })

    test('setOverride persists to the database', () => {
      table.setOverride('browser_click', 'openai', 'gpt-4o', 'A/B test')

      // Recreate RoutingTable from same DB — override must be reloaded
      const table2 = new RoutingTable(db)
      const decision = table2.resolve('browser_click')
      expect(decision.reason).toBe('optimized')
      expect(decision.provider).toBe('openai')
      expect(decision.model).toBe('gpt-4o')
    })

    test('removeOverride falls back to default route', () => {
      table.setOverride('browser_navigate', 'openai', 'gpt-4o-mini')
      table.removeOverride('browser_navigate')

      const decision = table.resolve('browser_navigate')
      expect(decision.reason).toBe('default')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-haiku-4-5-20251001')
    })

    test('removeOverride deletes from the database', () => {
      table.setOverride('browser_fill', 'openai', 'gpt-4o')
      table.removeOverride('browser_fill')

      // Recreate to confirm DB row was removed
      const table2 = new RoutingTable(db)
      const decision = table2.resolve('browser_fill')
      expect(decision.reason).toBe('default')
    })

    test('setOverride can be updated with a new provider', () => {
      table.setOverride('browser_navigate', 'openai', 'gpt-4o-mini')
      table.setOverride(
        'browser_navigate',
        'google',
        'gemini-2.5-pro',
        'switch to gemini',
      )

      const decision = table.resolve('browser_navigate')
      expect(decision.provider).toBe('google')
      expect(decision.model).toBe('gemini-2.5-pro')
      expect(decision.reason).toBe('optimized')
    })

    test('override with wildcard pattern matches all sub-tools', () => {
      table.setOverride('browser_tab_*', 'openai', 'gpt-4o-mini')

      const close = table.resolve('browser_tab_close')
      expect(close.reason).toBe('optimized')
      expect(close.provider).toBe('openai')

      const open = table.resolve('browser_tab_open')
      expect(open.reason).toBe('optimized')
      expect(open.provider).toBe('openai')
    })

    test('removeOverride on non-existent pattern does not throw', () => {
      expect(() => table.removeOverride('non_existent_pattern')).not.toThrow()
    })
  })

  describe('getAll', () => {
    test('returns all default mappings without override flag', () => {
      const all = table.getAll()
      expect(all.length).toBeGreaterThan(0)
      for (const entry of all) {
        expect(entry).toHaveProperty('toolPattern')
        expect(entry).toHaveProperty('provider')
        expect(entry).toHaveProperty('model')
        expect(entry).toHaveProperty('category')
        expect(entry).toHaveProperty('isOverride')
      }
    })

    test('getAll marks overridden entries with isOverride true', () => {
      table.setOverride('browser_navigate', 'openai', 'gpt-4o-mini')
      const all = table.getAll()
      const nav = all.find((e) => e.toolPattern === 'browser_navigate')
      expect(nav).toBeDefined()
      expect(nav!.isOverride).toBe(true)
      expect(nav!.provider).toBe('openai')
      expect(nav!.model).toBe('gpt-4o-mini')
    })

    test('getAll reflects default provider when no override set', () => {
      const all = table.getAll()
      const shot = all.find((e) => e.toolPattern === 'browser_get_screenshot')
      expect(shot).toBeDefined()
      expect(shot!.isOverride).toBe(false)
      expect(shot!.provider).toBe('google')
    })
  })

  describe('fallback behaviour', () => {
    test('completely unknown tool resolves to anthropic sonnet fallback', () => {
      const decision = table.resolve('some_random_tool_that_does_not_exist')
      expect(decision.reason).toBe('fallback')
      expect(decision.provider).toBe('anthropic')
      expect(decision.model).toBe('claude-sonnet-4-5-20250929')
    })

    test('fallback is not used when exact match exists', () => {
      const decision = table.resolve('browser_click')
      expect(decision.reason).not.toBe('fallback')
    })

    test('fallback is not used when wildcard match exists', () => {
      const decision = table.resolve('browser_scroll_up')
      expect(decision.reason).not.toBe('fallback')
    })
  })
})
