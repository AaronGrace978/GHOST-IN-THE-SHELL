import { BodyHarness } from './body';
import { Mirror } from './mirror';

async function runMirrorVerification(): Promise<void> {
  const body = new BodyHarness({ rootDir: process.cwd() });
  const mirror = new Mirror(body, {
    targetDirectories: ['src'],
    complexityWarningThreshold: 8,
  });

  console.log('🪞 Initializing Phase 1: The Mirror — Self-Reading & AST Reflection...\n');

  const reflection = await mirror.reflect();

  console.log(mirror.formatReflectionReport(reflection));
  console.log('\n--- Detailed Project Map (Classes, Functions, Interfaces & Methods) ---');

  for (const file of reflection.files) {
    const classes = file.symbols
      .filter((s) => s.kind === 'class')
      .map((s) => `${s.name} [L${s.line}-L${s.endLine}]`);
    const functions = file.symbols
      .filter((s) => s.kind === 'function')
      .map(
        (s) =>
          `${s.name}(${(s.parameters ?? []).join(', ')}) [L${s.line}-L${s.endLine}, cx=${s.complexity}]`
      );
    const methods = file.symbols
      .filter((s) => s.kind === 'method')
      .map(
        (s) =>
          `${s.name}(${(s.parameters ?? []).join(', ')}) [L${s.line}-L${s.endLine}, cx=${s.complexity}]`
      );
    const interfacesAndTypes = file.symbols
      .filter((s) => s.kind === 'interface' || s.kind === 'type')
      .map((s) => `${s.name} (${s.kind})`);

    console.log(`\n📄 ${file.relativePath} (sha256: ${file.sha256.slice(0, 12)}...)`);
    if (classes.length > 0) {
      console.log(`   Classes    : ${classes.join(', ')}`);
    }
    if (functions.length > 0) {
      console.log(`   Functions  : ${functions.join(', ')}`);
    }
    if (methods.length > 0) {
      console.log(`   Methods    : ${methods.join(', ')}`);
    }
    if (interfacesAndTypes.length > 0) {
      console.log(`   Types/Intf : ${interfacesAndTypes.join(', ')}`);
    }
  }

  console.log('\n--- Internal & External Dependency Graph ---');
  console.log(JSON.stringify(reflection.dependencyGraph, null, 2));
}

runMirrorVerification().catch((err) => {
  console.error('Mirror verification failed:', err);
  process.exit(1);
});
