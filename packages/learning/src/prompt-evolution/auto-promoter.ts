import type { ABTester } from './ab-tester'
import type { PromptRegistry } from './prompt-registry'

export interface AutoPromoterConfig {
  minSampleSize: number
  significanceThreshold: number
}

export class AutoPromoter {
  private registry: PromptRegistry
  private abTester: ABTester
  private config: AutoPromoterConfig

  constructor(
    registry: PromptRegistry,
    abTester: ABTester,
    config: Partial<AutoPromoterConfig> = {},
  ) {
    this.registry = registry
    this.abTester = abTester
    this.config = {
      minSampleSize: config.minSampleSize ?? 50,
      significanceThreshold: config.significanceThreshold ?? 0.05,
    }
  }

  checkAndPromote(): Array<{
    experimentId: string
    winnerId: string
    reason: string
  }> {
    const results: Array<{
      experimentId: string
      winnerId: string
      reason: string
    }> = []
    const experiments = this.abTester.listExperiments('running')

    for (const exp of experiments) {
      const varA = this.registry.get(exp.variantAId)
      const varB = this.registry.get(exp.variantBId)
      if (!varA || !varB) continue

      if (
        varA.totalUses < this.config.minSampleSize ||
        varB.totalUses < this.config.minSampleSize
      )
        continue

      const pA = varA.successRate
      const pB = varB.successRate
      const nA = varA.totalUses
      const nB = varB.totalUses
      const pooledP = (varA.successCount + varB.successCount) / (nA + nB)
      const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / nA + 1 / nB))

      if (se === 0) continue

      const zScore = Math.abs(pA - pB) / se
      const pValue = 2 * (1 - this.normalCDF(zScore))

      if (pValue < this.config.significanceThreshold) {
        const winnerId = pA > pB ? exp.variantAId : exp.variantBId
        const winnerRate = pA > pB ? pA : pB
        const loserRate = pA > pB ? pB : pA

        this.abTester.conclude(exp.id, winnerId)
        this.registry.promote(winnerId)

        results.push({
          experimentId: exp.id,
          winnerId,
          reason: `Winner: ${(winnerRate * 100).toFixed(1)}% vs ${(loserRate * 100).toFixed(1)}% (p=${pValue.toFixed(4)})`,
        })
      }
    }

    return results
  }

  private normalCDF(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x))
    const d = 0.3989422804014327
    const p =
      d *
      Math.exp((-x * x) / 2) *
      (0.3193815 * t +
        -0.3565638 * t * t +
        1.781478 * t * t * t +
        -1.821256 * t * t * t * t +
        1.3302744 * t * t * t * t * t)
    return x > 0 ? 1 - p : p
  }
}
