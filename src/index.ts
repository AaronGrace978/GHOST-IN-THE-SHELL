import { BodyHarness } from './body';
import { Mirror } from './mirror';
import { WillEngine } from './will';
import { PurgatorySandbox } from './purgatory';
import { SwarmSoul } from './soul';
import { CodebaseReflection, MutationProposal, QuorumDecision, SandboxExecutionResult } from './types';

export * from './types';
export * from './body';
export * from './mirror';
export * from './will';
export * from './purgatory';
export * from './soul';
export * from './core/Soul';

export interface GhostCycleResult {
  reflection: CodebaseReflection;
  proposal: MutationProposal | null;
  sandboxResult?: SandboxExecutionResult;
  decision?: QuorumDecision;
  merged?: boolean;
}

/**
 * GhostInTheShell Orchestrator
 * Unifies:
 * 1. The Body (Harness)
 * 2. Phase 1: The Mirror (Self-Reflection & AST Code Analysis)
 * 3. The Will (Mutation Engine)
 * 4. The Purgatory (Docker / Isolated Shadow Sandbox)
 * 5. The Soul (Swarm-Soul Event Log & Consensus Layer)
 */
export class GhostInTheShell {
  public readonly body: BodyHarness;
  public readonly mirror: Mirror;
  public readonly will: WillEngine;
  public readonly purgatory: PurgatorySandbox;
  public readonly soul: SwarmSoul;

  constructor(rootDir?: string) {
    this.body = new BodyHarness({ rootDir });
    this.mirror = new Mirror(this.body);
    this.will = new WillEngine(this.body, this.mirror);
    this.purgatory = new PurgatorySandbox(this.body);
    this.soul = new SwarmSoul(this.body);
  }

  /**
   * Executes an evolutionary cycle (or reflection-only pass when dryRun is enabled).
   */
  public async runEvolutionCycle(options: {
    applyMerge?: boolean;
  } = {}): Promise<GhostCycleResult> {
    await this.soul.initialize();

    const reflection = await this.mirror.reflect();
    await this.soul.appendEvent('GENOME_REFLECTED', 'mirror', {
      genomeHash: reflection.genomeHash,
      totalFiles: reflection.totalFiles,
      totalLines: reflection.totalLines,
      totalSymbols: reflection.totalSymbols,
      bottleneckCount: reflection.bottlenecks.length,
    });

    const proposal = await this.will.proposeNextMutation(reflection);
    if (!proposal) {
      return { reflection, proposal: null };
    }

    await this.soul.appendEvent('MUTATION_PROPOSED', 'will-engine', {
      proposalId: proposal.id,
      title: proposal.title,
      targetFiles: proposal.targetFiles,
    });

    const sandboxResult = await this.purgatory.evaluateProposal(proposal);
    await this.soul.appendEvent('SANDBOX_EVALUATED', 'purgatory-sandbox', {
      proposalId: proposal.id,
      executionMode: sandboxResult.executionMode,
      compiledCleanly: sandboxResult.compiledCleanly,
      fitnessScore: sandboxResult.fitnessScore,
    });

    const decision = await this.soul.deliberate(proposal, sandboxResult);

    let merged = false;
    if (options.applyMerge && decision.approved) {
      const mergeOutcome = await this.soul.mergeIfApproved(proposal, decision);
      merged = mergeOutcome.merged;
    }

    return {
      reflection,
      proposal,
      sandboxResult,
      decision,
      merged,
    };
  }
}

async function main(): Promise<void> {
  const ghost = new GhostInTheShell();
  const telemetry = ghost.body.getSystemTelemetry();
  console.log(
    `[GHOST-IN-THE-SHELL] Booting Harness on ${telemetry.platform}/${telemetry.arch} (Node ${telemetry.nodeVersion})`
  );

  const reflection = await ghost.mirror.reflect();
  console.log(ghost.mirror.formatReflectionReport(reflection));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[GHOST-IN-THE-SHELL] Fatal error:', err);
    process.exit(1);
  });
}
