import { expect, test } from 'bun:test'

import { CallExpr, Lit, Token, parse, tokenText } from '../src/index.ts'

test('parse returns statements whose spans index the source string', () => {
	const source = 'echo "héllo" 猫 >out | wc -l'
	const [stmt] = parse(source)
	expect(stmt?.type).toBe('Stmt')
	expect(source.slice(stmt!.start, stmt!.end)).toBe(source)
})

test('call expressions expose words with literal parts and spans', () => {
	const source = 'git commit -m msg'
	const call = parse(source)[0]!.cmd as CallExpr
	expect(call.type).toBe('CallExpr')
	const words = call.args.map((w) => source.slice(w.start, w.end))
	expect(words).toEqual(['git', 'commit', '-m', 'msg'])
	expect((call.args[0]!.parts[0] as Lit).value).toBe('git')
})

test('redirect operators are tokens with source spellings', () => {
	const source = 'cat <<EOF\nx\nEOF'
	const stmt = parse(source)[0]!
	expect(stmt.redirs).toHaveLength(1)
	expect(stmt.redirs[0]!.op).toBe(Token.hdoc)
	expect(tokenText(Token.hdoc)).toBe('<<')
})

test('rejected input throws SyntaxError with a source index', () => {
	expect(() => parse('echo "unterminated')).toThrow(SyntaxError)
	expect(() => parse('if true; then')).toThrow(/^at \d+: /)
})
