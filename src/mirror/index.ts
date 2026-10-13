import * as ts from 'typescript';
import * as crypto from 'crypto';
import * as path from 'path';
import { BodyHarness } from '../body';
import {
  BottleneckReport,
  CodebaseReflection,
  FileAnalysis,
  FileEntry,
  SymbolDescriptor,
} from '../types';

export interface MirrorOptions {
  complexityWarningThreshold?: number;
  targetDirectories?: string[];
}

/**
 * Phase 1: The Mirror
 * Self-reading and AST-based code-analysis engine.
 * Allows GHOST-IN-THE-SHELL to introspect its own source code, map its dependency
 * topology, measure cyclomatic complexity, and surface actionable bottlenecks.
 */
export class Mirror {
  private readonly body: BodyHarness;
  private readonly complexityThreshold: number;
  private readonly targetDirs: string[];

  constructor(body: BodyHarness, options: MirrorOptions = {}) {
    this.body = body;
    this.complexityThreshold = options.complexityWarningThreshold ?? 6;
    this.targetDirs = options.targetDirectories ?? ['src'];
  }

  /**
   * Performs a complete self-reflection pass over the agent's TypeScript source tree.
   */
  public async reflect(): Promise<CodebaseReflection> {
    const filePathsSet = new Set<string>();
    for (const dir of this.targetDirs) {
      if (await this.body.exists(dir)) {
        const found = await this.body.listFiles(dir, ['.ts']);
        for (const f of found) {
          filePathsSet.add(f);
        }
      }
    }

    const sortedPaths = Array.from(filePathsSet).sort();
    const fileEntries: FileEntry[] = await Promise.all(
      sortedPaths.map((p) => this.body.inspectFile(p))
    );

    const fileAnalyses: FileAnalysis[] = fileEntries.map((entry) =>
      this.analyzeTypeScriptFile(entry)
    );

    const dependencyGraph = this.buildDependencyGraph(fileAnalyses);
    const bottlenecks = this.detectBottlenecks(fileAnalyses, dependencyGraph);

    const totalLines = fileAnalyses.reduce((acc, f) => acc + f.lineCount, 0);
    const totalSymbols = fileAnalyses.reduce(
      (acc, f) => acc + f.symbols.length,
      0
    );
    const totalComplexity = fileAnalyses.reduce(
      (acc, f) => acc + f.totalComplexity,
      0
    );
    const averageComplexity =
      totalSymbols > 0
        ? Math.round((totalComplexity / totalSymbols) * 100) / 100
        : 1;

    const genomeHash = this.computeGenomeHash(fileEntries);

    return {
      timestamp: new Date().toISOString(),
      rootDir: this.body.rootDir,
      genomeHash,
      totalFiles: fileAnalyses.length,
      totalLines,
      totalSymbols,
      averageComplexity,
      files: fileAnalyses,
      dependencyGraph,
      bottlenecks,
    };
  }

  /**
   * Parses and analyzes a single TypeScript file using the TypeScript Compiler AST.
   */
  public analyzeTypeScriptFile(entry: FileEntry): FileAnalysis {
    const sourceFile = ts.createSourceFile(
      entry.relativePath,
      entry.content,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS
    );

    const imports: string[] = [];
    const exports: string[] = [];
    const symbols: SymbolDescriptor[] = [];
    const diagnostics: string[] = [];

    const lines = entry.content.split(/\r?\n/);
    const todos: Array<{ line: number; text: string }> = [];
    lines.forEach((lineText, idx) => {
      const match = lineText.match(/\/\/\s*(TODO|FIXME|OPTIMIZE|HACK)\b[:\s]*(.*)/i);
      if (match) {
        todos.push({
          line: idx + 1,
          text: `${match[1].toUpperCase()}: ${match[2].trim()}`,
        });
      }
    });

    const isNodeExported = (node: ts.Node): boolean => {
      const modifiers = ts.canHaveModifiers(node)
        ? ts.getModifiers(node)
        : undefined;
      return Boolean(
        modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      );
    };

    const getLineBounds = (node: ts.Node): { line: number; endLine: number } => {
      const startPos = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile)
      );
      const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      return {
        line: startPos.line + 1,
        endLine: endPos.line + 1,
      };
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        imports.push(node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        exports.push(node.moduleSpecifier.text);
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        const exported = isNodeExported(node);
        const name = node.name.text;
        if (exported) exports.push(name);
        const bounds = getLineBounds(node);
        symbols.push({
          name,
          kind: 'function',
          exported,
          line: bounds.line,
          endLine: bounds.endLine,
          parameters: node.parameters.map((p) => p.name.getText(sourceFile)),
          returnType: node.type ? node.type.getText(sourceFile) : undefined,
          complexity: this.calculateCyclomaticComplexity(node),
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        const exported = isNodeExported(node);
        const className = node.name.text;
        if (exported) exports.push(className);
        const bounds = getLineBounds(node);

        let classComplexity = 1;
        for (const member of node.members) {
          if (
            (ts.isMethodDeclaration(member) ||
              ts.isConstructorDeclaration(member)) &&
            member.body
          ) {
            const methodName = ts.isConstructorDeclaration(member)
              ? `${className}.constructor`
              : `${className}.${member.name.getText(sourceFile)}`;
            const methodBounds = getLineBounds(member);
            const methodComplexity = this.calculateCyclomaticComplexity(member);
            classComplexity += methodComplexity - 1;
            symbols.push({
              name: methodName,
              kind: 'method',
              exported,
              line: methodBounds.line,
              endLine: methodBounds.endLine,
              parameters: member.parameters.map((p) =>
                p.name.getText(sourceFile)
              ),
              returnType: member.type
                ? member.type.getText(sourceFile)
                : undefined,
              complexity: methodComplexity,
            });
          }
        }

        symbols.push({
          name: className,
          kind: 'class',
          exported,
          line: bounds.line,
          endLine: bounds.endLine,
          complexity: classComplexity,
        });
      } else if (ts.isInterfaceDeclaration(node)) {
        const exported = isNodeExported(node);
        const name = node.name.text;
        if (exported) exports.push(name);
        const bounds = getLineBounds(node);
        symbols.push({
          name,
          kind: 'interface',
          exported,
          line: bounds.line,
          endLine: bounds.endLine,
          complexity: 1,
        });
      } else if (ts.isTypeAliasDeclaration(node)) {
        const exported = isNodeExported(node);
        const name = node.name.text;
        if (exported) exports.push(name);
        const bounds = getLineBounds(node);
        symbols.push({
          name,
          kind: 'type',
          exported,
          line: bounds.line,
          endLine: bounds.endLine,
          complexity: 1,
        });
      } else if (ts.isVariableStatement(node)) {
        const exported = isNodeExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const name = decl.name.text;
            if (exported) exports.push(name);
            const bounds = getLineBounds(decl);
            const complexity = decl.initializer
              ? this.calculateCyclomaticComplexity(decl.initializer)
              : 1;
            symbols.push({
              name,
              kind: 'variable',
              exported,
              line: bounds.line,
              endLine: bounds.endLine,
              complexity,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    const parseDiagnostics = (
      sourceFile as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }
    ).parseDiagnostics;
    if (parseDiagnostics && parseDiagnostics.length > 0) {
      for (const diag of parseDiagnostics) {
        const pos = sourceFile.getLineAndCharacterOfPosition(diag.start);
        const msg = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
        diagnostics.push(`Line ${pos.line + 1}: ${msg}`);
      }
    }

    const totalComplexity = symbols.reduce((sum, s) => sum + s.complexity, 0);
    const maxSymbolComplexity = symbols.reduce(
      (max, s) => Math.max(max, s.complexity),
      0
    );

    return {
      relativePath: entry.relativePath,
      lineCount: lines.length,
      byteSize: entry.size,
      sha256: entry.sha256,
      imports,
      exports,
      symbols,
      todos,
      totalComplexity,
      maxSymbolComplexity,
      diagnostics,
    };
  }

  /**
   * Computes McCabe cyclomatic complexity for an AST subtree.
   */
  public calculateCyclomaticComplexity(rootNode: ts.Node): number {
    let complexity = 1;

    const walk = (node: ts.Node): void => {
      switch (node.kind) {
        case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.CaseClause:
        case ts.SyntaxKind.CatchClause:
        case ts.SyntaxKind.ConditionalExpression:
          complexity += 1;
          break;
        case ts.SyntaxKind.BinaryExpression: {
          const bin = node as ts.BinaryExpression;
          if (
            bin.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
            bin.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
          ) {
            complexity += 1;
          }
          break;
        }
        default:
          break;
      }
      ts.forEachChild(node, walk);
    };

    walk(rootNode);
    return complexity;
  }

  /**
   * Builds a normalized map of relative file paths to their resolved internal dependencies.
   */
  public buildDependencyGraph(
    files: FileAnalysis[]
  ): Record<string, string[]> {
    const knownPaths = new Set(files.map((f) => f.relativePath));
    const graph: Record<string, string[]> = {};

    for (const file of files) {
      const deps: string[] = [];
      const baseDir = path.dirname(file.relativePath);

      for (const imp of file.imports) {
        if (imp.startsWith('.')) {
          const candidateBase = path.normalize(path.join(baseDir, imp));
          const candidates = [
            candidateBase,
            `${candidateBase}.ts`,
            path.join(candidateBase, 'index.ts'),
          ];
          const matched = candidates.find((c) => knownPaths.has(c));
          deps.push(matched ?? candidateBase);
        } else {
          deps.push(imp);
        }
      }
      graph[file.relativePath] = deps;
    }

    return graph;
  }

  /**
   * Identifies architectural, complexity, or maintenance bottlenecks from the reflection.
   */
  public detectBottlenecks(
    files: FileAnalysis[],
    _dependencyGraph: Record<string, string[]>
  ): BottleneckReport[] {
    const reports: BottleneckReport[] = [];

    for (const file of files) {
      for (const diag of file.diagnostics) {
        reports.push({
          id: `diag-${file.relativePath}-${reports.length + 1}`,
          severity: 'high',
          category: 'diagnostic',
          file: file.relativePath,
          description: `Syntax/AST diagnostic in ${file.relativePath}: ${diag}`,
          suggestedAction: 'Fix syntax or type error in the reported line.',
        });
      }

      for (const sym of file.symbols) {
        if (
          (sym.kind === 'function' || sym.kind === 'method') &&
          sym.complexity > this.complexityThreshold
        ) {
          reports.push({
            id: `cx-${file.relativePath}-${sym.name}`,
            severity:
              sym.complexity > this.complexityThreshold * 2 ? 'high' : 'medium',
            category: 'complexity',
            file: file.relativePath,
            line: sym.line,
            symbol: sym.name,
            description: `Symbol "${sym.name}" has cyclomatic complexity ${sym.complexity} (threshold: ${this.complexityThreshold}).`,
            suggestedAction: `Decompose "${sym.name}" into smaller helper functions to improve modularity and testability.`,
          });
        }
      }

      for (const todo of file.todos) {
        reports.push({
          id: `todo-${file.relativePath}-L${todo.line}`,
          severity: 'low',
          category: 'todo',
          file: file.relativePath,
          line: todo.line,
          description: `Unresolved marker at ${file.relativePath}:${todo.line} (${todo.text})`,
          suggestedAction: `Implement or resolve the pending item described at line ${todo.line}.`,
        });
      }

      if (file.exports.length === 0 && !file.relativePath.endsWith('index.ts')) {
        reports.push({
          id: `export-${file.relativePath}`,
          severity: 'low',
          category: 'missing-export',
          file: file.relativePath,
          description: `Module "${file.relativePath}" defines no exports.`,
          suggestedAction:
            'Export public symbols or remove dead module if unused.',
        });
      }
    }

    return reports;
  }

  /**
   * Computes a deterministic SHA-256 hash representing the exact state of the source genome.
   */
  public computeGenomeHash(entries: FileEntry[]): string {
    const hasher = crypto.createHash('sha256');
    const sorted = [...entries].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    );
    for (const entry of sorted) {
      hasher.update(`${entry.relativePath}:${entry.sha256}\n`);
    }
    return hasher.digest('hex');
  }

  /**
   * Formats a human- and LLM-readable summary of the current self-reflection.
   */
  public formatReflectionReport(reflection: CodebaseReflection): string {
    const lines: string[] = [
      '=== GHOST-IN-THE-SHELL: PHASE 1 MIRROR REFLECTION ===',
      `Timestamp          : ${reflection.timestamp}`,
      `Genome Hash        : ${reflection.genomeHash.slice(0, 16)}...`,
      `Total Source Files : ${reflection.totalFiles}`,
      `Total Lines of Code: ${reflection.totalLines}`,
      `Total AST Symbols  : ${reflection.totalSymbols}`,
      `Avg Complexity     : ${reflection.averageComplexity}`,
      '',
      '--- Module Inventory ---',
    ];

    for (const file of reflection.files) {
      lines.push(
        `  * ${file.relativePath} (${file.lineCount} LOC, ${file.symbols.length} symbols, maxComplexity=${file.maxSymbolComplexity})`
      );
    }

    lines.push('', `--- Detected Bottlenecks (${reflection.bottlenecks.length}) ---`);
    if (reflection.bottlenecks.length === 0) {
      lines.push('  No critical bottlenecks detected.');
    } else {
      for (const b of reflection.bottlenecks) {
        lines.push(
          `  [${b.severity.toUpperCase()}] (${b.category}) ${b.file}${
            b.line ? `:${b.line}` : ''
          } -> ${b.description}`
        );
      }
    }

    return lines.join('\n');
  }
}
