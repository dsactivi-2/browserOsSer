import type { LLMProvider } from '../schemas/llm'

export interface ToolModelMapping {
  toolPattern: string
  category: 'simple' | 'standard' | 'complex' | 'vision'
  defaultProvider: LLMProvider
  defaultModel: string
  fallbacks: Array<{ provider: LLMProvider; model: string }>
}

export const DEFAULT_ROUTING_TABLE: ToolModelMapping[] = [
  // SIMPLE — fast, cheap models for basic browser actions
  {
    toolPattern: 'browser_navigate',
    category: 'simple',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbacks: [{ provider: 'openai', model: 'gpt-4o-mini' }],
  },
  {
    toolPattern: 'browser_click',
    category: 'simple',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_fill',
    category: 'simple',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_scroll_*',
    category: 'simple',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_tab_*',
    category: 'simple',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_go_back',
    category: 'simple',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_go_forward',
    category: 'simple',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    fallbacks: [],
  },

  // STANDARD — mid-tier models for extraction and content analysis
  {
    toolPattern: 'browser_extract_*',
    category: 'standard',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    fallbacks: [{ provider: 'openai', model: 'gpt-4o' }],
  },
  {
    toolPattern: 'browser_get_page_content',
    category: 'standard',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_get_console_*',
    category: 'standard',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_execute_javascript',
    category: 'standard',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    fallbacks: [],
  },
  {
    toolPattern: 'browser_get_interactive_elements',
    category: 'standard',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    fallbacks: [],
  },

  // COMPLEX — top-tier models for multi-step reasoning
  {
    toolPattern: 'browser_multi_act',
    category: 'complex',
    defaultProvider: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    fallbacks: [{ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }],
  },

  // VISION — models with vision capabilities
  {
    toolPattern: 'browser_get_screenshot',
    category: 'vision',
    defaultProvider: 'google',
    defaultModel: 'gemini-2.5-pro',
    fallbacks: [{ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' }],
  },
  {
    toolPattern: 'browser_snapshot',
    category: 'vision',
    defaultProvider: 'google',
    defaultModel: 'gemini-2.5-pro',
    fallbacks: [],
  },
]

export const ROUTER_CONFIG = {
  METRICS_AGGREGATION_INTERVAL: 100,
  SUCCESS_RATE_KEEP_THRESHOLD: 0.9,
  SUCCESS_RATE_UPGRADE_THRESHOLD: 0.7,
  DOWNGRADE_TEST_INTERVAL: 500,
  DOWNGRADE_TEST_SAMPLE_SIZE: 10,
} as const
