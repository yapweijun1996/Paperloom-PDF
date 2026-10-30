import { describe, expect, it } from 'vitest';
import { PDFLexer, TokenType } from '../parser/lexer';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('malformed PDF token termination', () => {
  it.each([')', '{', '}'])('consumes unexpected delimiter %s', delimiter => {
    const lexer = new PDFLexer(bytes(delimiter));
    const token = lexer.nextToken();
    expect(token?.type).toBe(TokenType.Keyword);
    expect(lexer.position).toBe(1);
  });
});

it('finishes malformed PDF and DER parsing within a subprocess deadline', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { resolve } = await import('node:path');
  const execute = promisify(execFile);
  const result = await execute(process.execPath, [
    resolve('node_modules/vite-node/vite-node.mjs'),
    resolve('src/engine/__tests__/fixtures/parser-termination-runner.ts'),
  ], { timeout: 30000, maxBuffer: 1024 * 1024 });
  expect(result.stdout).toContain('termination checks passed');
}, 45000);
