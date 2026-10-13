import * as crypto from 'crypto';
import { BodyHarness } from '../body';
import { Mirror } from '../mirror';
import {
  BottleneckReport,
  CodebaseReflection,
  MutationProposal,
} from '../types';

export interface MutationSynthesizer {
  synthesize(
    reflection: CodebaseReflection,
    bottleneck: BottleneckReport | undefined,
    body: BodyHarness
  ): Promise<{
    title: string;
    rationale: string;
    fileEdits: Array<{ relativePath: string; updatedContent: string }>;
  } | null>;
}

export interface WillOptions {
  synthesizer?: MutationSynthesizer;
  contextLines?: number;
}

/**
 * The Will (The Mutation Engine)
 * Analyzes codebase reflections from The Mirror, selects highest-leverage
 * bottlenecks or evolutionary goals, and generates unified git diffs as Mutation Proposals.
 */
export class WillEngine {
  private readonly body: BodyHarness;
  private readonly mirror: Mirror;
  private readonly synthesizer?: MutationSynthesizer;
  private readonly contextLines: number;

  constructor(body: BodyHarness, mirror: Mirror, options: WillOptions = {}) {
    this.body = body;
    this.mirror = mirror;
    this.synthesizer = options.synthesizer;
    this.contextLines = options.contextLines ?? 3;
  }

  /**
   * Runs one iteration of the Will's analysis-and-proposal loop:
   * 1. Reflect on the current codebase via The Mirror
   * 2. Rank bottlenecks by severity
   * 3. Synthesize a targeted code mutation and unified git diff
   */
  public async proposeNextMutation(
    existingReflection?: CodebaseReflection
  ): Promise<MutationProposal | null> {
    const reflection = existingReflection ?? (await this.mirror.reflect());
    const prioritized = this.prioritizeBottlenecks(reflection.bottlenecks);
    const targetBottleneck = prioritized[0];

    if (this.synthesizer) {
      const result = await this.synthesizer.synthesize(
        reflection,
        targetBottleneck,
        this.body
      );
      if (result && result.fileEdits.length > 0) {
        return this.createProposalFromEdits({
          parentGenomeHash: reflection.genomeHash,
          title: result.title,
          rationale: result.rationale,
          bottleneckId: targetBottleneck?.id,
          fileEdits: result.fileEdits,
        });
      }
    }

    if (!targetBottleneck) {
      return null;
    }

    return this.synthesizeHeuristicProposal(reflection, targetBottleneck);
  }

  /**
   * Ranks detected bottlenecks from highest to lowest severity.
   */
  public prioritizeBottlenecks(
    bottlenecks: BottleneckReport[]
  ): BottleneckReport[] {
    const weight: Record<BottleneckReport['severity'], number> = {
      high: 3,
      medium: 2,
      low: 1,
    };
    return [...bottlenecks].sort(
      (a, b) => weight[b.severity] - weight[a.severity]
    );
  }

  /**
   * Builds a MutationProposal with a valid unified git diff from proposed file edits.
   */
  public async createProposalFromEdits(params: {
    parentGenomeHash: string;
    title: string;
    rationale: string;
    bottleneckId?: string;
    fileEdits: Array<{ relativePath: string; updatedContent: string }>;
  }): Promise<MutationProposal> {
    const diffs: string[] = [];
    const targetFiles: string[] = [];

    for (const edit of params.fileEdits) {
      const exists = await this.body.exists(edit.relativePath);
      const originalContent = exists
        ? await this.body.readFile(edit.relativePath)
        : '';
      if (originalContent === edit.updatedContent) {
        continue;
      }
      const patch = this.createUnifiedDiff(
        edit.relativePath,
        originalContent,
        edit.updatedContent,
        this.contextLines
      );
      if (patch.trim().length > 0) {
        diffs.push(patch);
        targetFiles.push(edit.relativePath);
      }
    }

    const combinedDiff = diffs.join('\n');
    const id = `mut-${crypto
      .createHash('sha256')
      .update(`${params.parentGenomeHash}:${params.title}:${combinedDiff}`)
      .digest('hex')
      .slice(0, 12)}`;

    return {
      id,
      parentGenomeHash: params.parentGenomeHash,
      createdAt: new Date().toISOString(),
      title: params.title,
      rationale: params.rationale,
      targetFiles,
      bottleneckId: params.bottleneckId,
      diff: combinedDiff,
    };
  }

  /**
   * Built-in heuristic mutation generator for resolving detected bottlenecks
   * when no external LLM synthesizer is attached.
   */
  private async synthesizeHeuristicProposal(
    reflection: CodebaseReflection,
    bottleneck: BottleneckReport
  ): Promise<MutationProposal | null> {
    const exists = await this.body.exists(bottleneck.file);
    if (!exists) {
      return null;
    }
    const original = await this.body.readFile(bottleneck.file);
    const lines = original.split(/\r?\n/);

    if (bottleneck.category === 'todo' && bottleneck.line) {
      const idx = bottleneck.line - 1;
      if (idx >= 0 && idx < lines.length) {
        lines[idx] = lines[idx].replace(
          /\/\/\s*(TODO|FIXME|OPTIMIZE|HACK)\b[:\s]*/i,
          '// RESOLVED: '
        );
        const updatedContent = lines.join('\n');
        return this.createProposalFromEdits({
          parentGenomeHash: reflection.genomeHash,
          title: `Resolve pending annotation in ${bottleneck.file}:${bottleneck.line}`,
          rationale: bottleneck.description,
          bottleneckId: bottleneck.id,
          fileEdits: [{ relativePath: bottleneck.file, updatedContent }],
        });
      }
    }

    // For complexity or other bottlenecks, annotate the target symbol with a structured
    // telemetry/refactor marker so downstream passes or sandbox tests can evaluate it.
    const insertLine = Math.max(0, (bottleneck.line ?? 1) - 1);
    const annotation = `// [GHOST-MUTATION-TARGET] ${bottleneck.category}: ${bottleneck.suggestedAction}`;
    if (!original.includes(annotation)) {
      lines.splice(insertLine, 0, annotation);
      const updatedContent = lines.join('\n');
      return this.createProposalFromEdits({
        parentGenomeHash: reflection.genomeHash,
        title: `Annotate ${bottleneck.category} bottleneck in ${bottleneck.file}`,
        rationale: `${bottleneck.description} (${bottleneck.suggestedAction})`,
        bottleneckId: bottleneck.id,
        fileEdits: [{ relativePath: bottleneck.file, updatedContent }],
      });
    }

    return null;
  }

  /**
   * Generates a standard unified git diff (`diff --git a/... b/...`) between two strings.
   */
  public createUnifiedDiff(
    relativePath: string,
    oldText: string,
    newText: string,
    contextLines = 3
  ): string {
    if (oldText === newText) {
      return '';
    }

    const normalizedPath = relativePath.replace(/\\/g, '/');
    const oldLines = oldText.length === 0 ? [] : oldText.split(/\r?\n/);
    const newLines = newText.length === 0 ? [] : newText.split(/\r?\n/);

    // Remove trailing empty line caused by trailing newline when both files end with \n
    if (
      oldText.endsWith('\n') &&
      oldLines.length > 0 &&
      oldLines[oldLines.length - 1] === ''
    ) {
      oldLines.pop();
    }
    if (
      newText.endsWith('\n') &&
      newLines.length > 0 &&
      newLines[newLines.length - 1] === ''
    ) {
      newLines.pop();
    }

    const ops = this.computeLineDiffOps(oldLines, newLines);
    const hunks = this.buildUnifiedHunks(ops, contextLines);
    if (hunks.length === 0) {
      return '';
    }

    const header = [
      `diff --git a/${normalizedPath} b/${normalizedPath}`,
      `--- a/${normalizedPath}`,
      `+++ b/${normalizedPath}`,
    ];

    return [...header, ...hunks].join('\n') + '\n';
  }

  /**
   * Validates whether a unified diff string contains valid diff headers and hunks.
   */
  public validateUnifiedDiff(diff: string): {
    valid: boolean;
    reason?: string;
  } {
    if (!diff || diff.trim().length === 0) {
      return { valid: false, reason: 'Diff is empty' };
    }
    const hasFileHeader =
      diff.includes('--- a/') && diff.includes('+++ b/');
    const hasHunkHeader = /@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(diff);
    if (!hasFileHeader) {
      return {
        valid: false,
        reason: 'Missing unified diff file headers (--- a/... +++ b/...)',
      };
    }
    if (!hasHunkHeader) {
      return {
        valid: false,
        reason: 'Missing unified diff hunk header (@@ -l,s +l,s @@)',
      };
    }
    return { valid: true };
  }

  private computeLineDiffOps(
    oldLines: string[],
    newLines: string[]
  ): Array<{
    type: 'equal' | 'delete' | 'insert';
    line: string;
    oldLineNo?: number;
    newLineNo?: number;
  }> {
    const m = oldLines.length;
    const n = newLines.length;

    // LCS dynamic programming table for accurate line-level diffs
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      new Array<number>(n + 1).fill(0)
    );

    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (oldLines[i] === newLines[j]) {
          dp[i][j] = 1 + dp[i + 1][j + 1];
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }

    const ops: Array<{
      type: 'equal' | 'delete' | 'insert';
      line: string;
      oldLineNo?: number;
      newLineNo?: number;
    }> = [];

    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (oldLines[i] === newLines[j]) {
        ops.push({
          type: 'equal',
          line: oldLines[i],
          oldLineNo: i + 1,
          newLineNo: j + 1,
        });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({
          type: 'delete',
          line: oldLines[i],
          oldLineNo: i + 1,
        });
        i++;
      } else {
        ops.push({
          type: 'insert',
          line: newLines[j],
          newLineNo: j + 1,
        });
        j++;
      }
    }

    while (i < m) {
      ops.push({ type: 'delete', line: oldLines[i], oldLineNo: i + 1 });
      i++;
    }
    while (j < n) {
      ops.push({ type: 'insert', line: newLines[j], newLineNo: j + 1 });
      j++;
    }

    return ops;
  }

  private buildUnifiedHunks(
    ops: Array<{
      type: 'equal' | 'delete' | 'insert';
      line: string;
      oldLineNo?: number;
      newLineNo?: number;
    }>,
    contextLines: number
  ): string[] {
    const changeIndices: number[] = [];
    ops.forEach((op, idx) => {
      if (op.type !== 'equal') {
        changeIndices.push(idx);
      }
    });

    if (changeIndices.length === 0) {
      return [];
    }

    const groups: Array<{ start: number; end: number }> = [];
    for (const idx of changeIndices) {
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(ops.length - 1, idx + contextLines);
      const prev = groups[groups.length - 1];
      if (prev && start <= prev.end + 1) {
        prev.end = Math.max(prev.end, end);
      } else {
        groups.push({ start, end });
      }
    }

    const formattedHunks: string[] = [];

    for (const group of groups) {
      const slice = ops.slice(group.start, group.end + 1);
      let oldStart = 1;
      let newStart = 1;

      const firstOld = slice.find((op) => op.oldLineNo !== undefined);
      const firstNew = slice.find((op) => op.newLineNo !== undefined);
      if (firstOld?.oldLineNo !== undefined) oldStart = firstOld.oldLineNo;
      if (firstNew?.newLineNo !== undefined) newStart = firstNew.newLineNo;

      let oldCount = 0;
      let newCount = 0;
      const bodyLines: string[] = [];

      for (const op of slice) {
        if (op.type === 'equal') {
          oldCount++;
          newCount++;
          bodyLines.push(` ${op.line}`);
        } else if (op.type === 'delete') {
          oldCount++;
          bodyLines.push(`-${op.line}`);
        } else if (op.type === 'insert') {
          newCount++;
          bodyLines.push(`+${op.line}`);
        }
      }

      formattedHunks.push(
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...bodyLines
      );
    }

    return formattedHunks;
  }
}
