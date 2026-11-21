import type { Stmt } from './nodes.ts'

import { BashParser } from './parser.ts'

export * from './nodes.ts'
export { Token, tokenText } from './tokens.ts'

/**
 * Parse bash source into its statement list. Every node carries `start` and
 * `end` as JavaScript string indices into `source`. Throws `SyntaxError`
 * (message `at <index>: <reason>`) when mvdan/sh would reject the input.
 */
export function parse(source: string): Stmt[] {
	return BashParser.parse(source)
}
