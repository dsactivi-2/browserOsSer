export interface CompressedMessage {
  originalIndex: number
  originalContent: string
  originalTokens: number
  compressedContent: string
  compressedTokens: number
  preservedFacts: string[]
  compressionRatio: number
}

export interface CompressorConfig {
  maxSummaryTokens: number
  preservePatterns: RegExp[] // Patterns that should never be removed
}

export class MemoryCompressor {
  private config: CompressorConfig

  constructor(config: Partial<CompressorConfig> = {}) {
    this.config = {
      maxSummaryTokens: config.maxSummaryTokens ?? 200,
      preservePatterns: config.preservePatterns ?? [
        /https?:\/\/[^\s]+/g, // URLs
        /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Emails
        /\berror\b.*$/gim, // Error messages
        /selector[:\s]+['"`][^'"`]+['"`]/gi, // CSS selectors
        /\bclass=['"][^'"]+['"]/gi, // Class names
        /\bid=['"][^'"]+['"]/gi, // Element IDs
        /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, // IPs
        /\b\d{3,}\b/g, // Numbers >= 3 digits (IDs, ports, etc.)
      ],
    }
  }

  // Compress a single message by extracting key facts and summarizing
  compressMessage(content: string, role: string): CompressedMessage {
    const originalTokens = Math.ceil(content.length / 4)
    const preservedFacts = this.extractPreservedFacts(content)
    const compressedContent = this.buildCompressedContent(
      content,
      role,
      preservedFacts,
    )
    const compressedTokens = Math.ceil(compressedContent.length / 4)

    return {
      originalIndex: -1,
      originalContent: content,
      originalTokens,
      compressedContent,
      compressedTokens,
      preservedFacts,
      compressionRatio:
        originalTokens > 0 ? compressedTokens / originalTokens : 1,
    }
  }

  // Compress a batch of messages into a single summary
  compressBatch(messages: Array<{ content: string; role: string }>): string {
    if (messages.length === 0) return ''

    const facts: string[] = []
    const actions: string[] = []
    const results: string[] = []

    for (const msg of messages) {
      const extracted = this.extractPreservedFacts(msg.content)
      facts.push(...extracted)

      if (msg.role === 'user') {
        const firstLine = msg.content.split('\n')[0].slice(0, 150)
        actions.push(`User: ${firstLine}`)
      } else if (msg.role === 'assistant') {
        const firstLine = msg.content.split('\n')[0].slice(0, 150)
        results.push(`Agent: ${firstLine}`)
      }
    }

    const parts: string[] = [`[Summary of ${messages.length} messages]`]

    if (actions.length > 0) {
      parts.push('Actions: ' + actions.slice(-5).join(' | '))
    }
    if (results.length > 0) {
      parts.push('Results: ' + results.slice(-5).join(' | '))
    }
    if (facts.length > 0) {
      const uniqueFacts = [...new Set(facts)]
      parts.push('Key facts: ' + uniqueFacts.slice(0, 10).join(', '))
    }

    return parts.join('\n')
  }

  private extractPreservedFacts(content: string): string[] {
    const facts: string[] = []
    for (const pattern of this.config.preservePatterns) {
      const matches = content.match(new RegExp(pattern.source, pattern.flags))
      if (matches) {
        facts.push(...matches.slice(0, 5))
      }
    }
    return [...new Set(facts)]
  }

  private buildCompressedContent(
    content: string,
    role: string,
    facts: string[],
  ): string {
    // For short messages, keep as-is
    if (content.length <= 200) return content

    const lines = content.split('\n').filter((l) => l.trim())
    const firstLine = lines[0]?.slice(0, 200) ?? ''
    const lastLine =
      lines.length > 1 ? (lines[lines.length - 1]?.slice(0, 200) ?? '') : ''

    const parts = [`[${role}] ${firstLine}`]
    if (lastLine && lastLine !== firstLine) {
      parts.push(`... ${lastLine}`)
    }
    if (facts.length > 0) {
      parts.push(`[preserved: ${facts.slice(0, 5).join(', ')}]`)
    }

    return parts.join('\n')
  }
}
