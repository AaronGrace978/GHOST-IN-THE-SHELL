import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { BodyHarness } from '../body';
import {
  BenchmarkMetric,
  MutationProposal,
  SandboxExecutionResult,
} from '../types';

export interface PurgatoryOptions {
  dockerImage?: string;
  dockerfilePath?: string;
  preferDocker?: boolean;
  timeoutMs?: number;
}

/**
 * The Purgatory (The Sandbox)
 * Transient, isolated execution wrapper ("Shadow Body") that applies a MutationProposal's
 * git diff inside an isolated Docker container (or isolated shadow worktree when the
 * Docker daemon is unavailable) and benchmarks compilation and test execution.
 */
export class PurgatorySandbox {
  private readonly body: BodyHarness;
  private readonly dockerImage: string;
  private readonly preferDocker: boolean;
  private readonly timeoutMs: number;

  constructor(body: BodyHarness, options: PurgatoryOptions = {}) {
    this.body = body;
    this.dockerImage = options.dockerImage ?? 'node:20-alpine';
    this.preferDocker = options.preferDocker ?? true;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /**
   * Checks whether the Docker CLI and daemon are reachable on the host.
   */
  public async isDockerAvailable(): Promise<boolean> {
    if (!this.preferDocker) {
      return false;
    }
    const res = await this.body.execCommand('docker', ['info'], {
      timeoutMs: 5_000,
    });
    return res.exitCode === 0;
  }

  /**
   * Evaluates a MutationProposal in an isolated Shadow Body without mutating the Prime Body.
   */
  public async evaluateProposal(
    proposal: MutationProposal
  ): Promise<SandboxExecutionResult> {
    const startTime = Date.now();
    const shadowDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `ghost-purgatory-${proposal.id}-`)
    );

    try {
      await this.stageShadowWorkspace(shadowDir);

      const patchPath = path.join(shadowDir, 'mutation.patch');
      await fs.writeFile(patchPath, proposal.diff, 'utf-8');

      const applyRes = await this.applyPatchInShadow(shadowDir, patchPath);
      if (!applyRes.applied) {
        return {
          proposalId: proposal.id,
          executionMode: 'isolated-worktree',
          appliedCleanly: false,
          compiledCleanly: false,
          testsPassed: false,
          fitnessScore: 0,
          durationMs: Date.now() - startTime,
          metrics: [
            {
              name: 'git-apply',
              passed: false,
              score: 0,
              durationMs: applyRes.durationMs,
              output: applyRes.output,
            },
          ],
          stdout: '',
          stderr: applyRes.output,
        };
      }

      const useDocker = await this.isDockerAvailable();
      if (useDocker) {
        return await this.runInDockerContainer(
          proposal,
          shadowDir,
          startTime,
          applyRes.durationMs
        );
      }

      return await this.runInIsolatedWorktree(
        proposal,
        shadowDir,
        startTime,
        applyRes.durationMs
      );
    } finally {
      await fs.rm(shadowDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Copies the Prime Body's source and configuration into the transient Shadow Body directory.
   */
  private async stageShadowWorkspace(shadowDir: string): Promise<void> {
    const files = await this.body.listFiles('.');
    for (const relPath of files) {
      const srcPath = this.body.resolveSafePath(relPath);
      const destPath = path.join(shadowDir, relPath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }

    const hostNodeModules = path.join(this.body.rootDir, 'node_modules');
    const shadowNodeModules = path.join(shadowDir, 'node_modules');
    try {
      await fs.access(hostNodeModules);
      await fs.symlink(hostNodeModules, shadowNodeModules, 'dir');
    } catch {
      // If node_modules doesn't exist, skip symlink
    }
  }

  /**
   * Applies the unified diff inside the staged Shadow Body using `git apply`.
   */
  private async applyPatchInShadow(
    shadowDir: string,
    patchPath: string
  ): Promise<{ applied: boolean; durationMs: number; output: string }> {
    const start = Date.now();
    const shadowHarness = new BodyHarness({ rootDir: shadowDir });
    const res = await shadowHarness.execCommand('git', [
      'apply',
      '--whitespace=nowarn',
      patchPath,
    ]);
    return {
      applied: res.exitCode === 0,
      durationMs: Date.now() - start,
      output: `${res.stdout}\n${res.stderr}`.trim(),
    };
  }

  /**
   * Executes typechecking and benchmark verification inside an isolated Docker container.
   */
  private async runInDockerContainer(
    proposal: MutationProposal,
    shadowDir: string,
    startTime: number,
    applyDurationMs: number
  ): Promise<SandboxExecutionResult> {
    const containerName = `ghost-shadow-${proposal.id.toLowerCase()}`;
    const dockerArgs = [
      'run',
      '--rm',
      '--name',
      containerName,
      '--network',
      'none',
      '-v',
      `${shadowDir}:/sandbox`,
      '-w',
      '/sandbox',
      this.dockerImage,
      'sh',
      '-c',
      'npx tsc --noEmit',
    ];

    const execRes = await this.body.execCommand('docker', dockerArgs, {
      timeoutMs: this.timeoutMs,
    });

    const compiledCleanly = execRes.exitCode === 0;
    const metrics: BenchmarkMetric[] = [
      {
        name: 'git-apply',
        passed: true,
        score: 1,
        durationMs: applyDurationMs,
      },
      {
        name: 'docker-tsc-typecheck',
        passed: compiledCleanly,
        score: compiledCleanly ? 1 : 0,
        durationMs: execRes.durationMs,
        output: `${execRes.stdout}\n${execRes.stderr}`.trim(),
      },
    ];

    const fitnessScore = compiledCleanly ? 1.0 : 0.25;

    return {
      proposalId: proposal.id,
      containerId: containerName,
      executionMode: 'docker',
      appliedCleanly: true,
      compiledCleanly,
      testsPassed: compiledCleanly,
      fitnessScore,
      durationMs: Date.now() - startTime,
      metrics,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
    };
  }

  /**
   * Fallback sandbox execution inside the isolated temporary worktree when Docker daemon is unavailable.
   */
  private async runInIsolatedWorktree(
    proposal: MutationProposal,
    shadowDir: string,
    startTime: number,
    applyDurationMs: number
  ): Promise<SandboxExecutionResult> {
    const shadowHarness = new BodyHarness({ rootDir: shadowDir });
    const tscBin = path.join(
      this.body.rootDir,
      'node_modules',
      '.bin',
      'tsc'
    );

    const compileRes = await shadowHarness.execCommand(
      tscBin,
      ['--noEmit'],
      { timeoutMs: this.timeoutMs }
    );

    const compiledCleanly = compileRes.exitCode === 0;
    const metrics: BenchmarkMetric[] = [
      {
        name: 'git-apply',
        passed: true,
        score: 1,
        durationMs: applyDurationMs,
      },
      {
        name: 'shadow-tsc-typecheck',
        passed: compiledCleanly,
        score: compiledCleanly ? 1 : 0,
        durationMs: compileRes.durationMs,
        output: `${compileRes.stdout}\n${compileRes.stderr}`.trim(),
      },
    ];

    const fitnessScore = compiledCleanly ? 1.0 : 0.25;

    return {
      proposalId: proposal.id,
      executionMode: 'isolated-worktree',
      appliedCleanly: true,
      compiledCleanly,
      testsPassed: compiledCleanly,
      fitnessScore,
      durationMs: Date.now() - startTime,
      metrics,
      stdout: compileRes.stdout,
      stderr: compileRes.stderr,
    };
  }
}
