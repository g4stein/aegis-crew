// Adapter: wraps @solidity-parser/parser. The only module that imports the parser at runtime.
// The parser builds a syntax tree from text; it never compiles or executes input (3.11).
import { parse, ParserError } from '@solidity-parser/parser';
import type { SourceUnit } from '@solidity-parser/parser/dist/src/ast-types';
import { err, ok, type Result } from '../logic/result';

export interface ParseFailure {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export function parseSolidity(source: string): Result<SourceUnit, ParseFailure[]> {
  try {
    return ok(parse(source, { loc: true, range: true }) as SourceUnit);
  } catch (e) {
    if (e instanceof ParserError) {
      return err(e.errors.map((x) => ({ line: x.line, column: x.column, message: x.message })));
    }
    return err([{ line: 0, column: 0, message: e instanceof Error ? e.message : String(e) }]);
  }
}
