import type { ExecutionPattern, PatternMatch } from './types'

export class PatternMatcher {
  toolSequenceSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 1
    if (a.length === 0 || b.length === 0) return 0

    const setA = new Set(a)
    const setB = new Set(b)
    let intersection = 0
    for (const tool of setA) {
      if (setB.has(tool)) intersection++
    }
    const union = setA.size + setB.size - intersection
    return union > 0 ? intersection / union : 0
  }

  textSimilarity(a: string, b: string): number {
    const wordsA = new Set(
      a
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    )
    const wordsB = new Set(
      b
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    )
    let overlap = 0
    for (const w of wordsA) {
      if (wordsB.has(w)) overlap++
    }
    const total = wordsA.size + wordsB.size - overlap
    return total > 0 ? overlap / total : 0
  }

  rankPatterns(
    patterns: ExecutionPattern[],
    taskDescription: string,
    toolHints?: string[],
  ): PatternMatch[] {
    return patterns
      .map((pattern) => {
        let similarity =
          this.textSimilarity(taskDescription, pattern.inputSummary) * 0.6

        if (toolHints && toolHints.length > 0) {
          similarity +=
            this.toolSequenceSimilarity(toolHints, pattern.toolSequence) * 0.4
        }

        return {
          pattern,
          similarity,
          relevance: similarity * pattern.confidence,
        }
      })
      .sort((a, b) => b.relevance - a.relevance)
  }
}
