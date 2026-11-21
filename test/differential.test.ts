import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import corpus from '../scripts/corpus.json'
import { mutations } from '../scripts/mutations.ts'
import { actual, expected } from '../scripts/oracle.ts'

const cases = corpus.cases.filter((row) => !row.bytes)

test('Bash corpus matches mvdan on acceptance, word structure, and every span', async () => {
	let accepted = 0
	for (const { input, id } of cases) {
		const reference = await expected(input)
		expect(actual(input), id + ' ' + JSON.stringify(input)).toEqual(reference)
		if (reference) accepted++
	}
	expect([cases.length, accepted]).toEqual([1389, 846])
})

test('byte-only Go inputs are preserved and their JS string decoding matches', async () => {
	const raw = corpus.cases.filter((row) => row.bytes)
	expect(raw).toHaveLength(15)
	for (const row of raw) {
		const bytes = Buffer.from(row.bytes!, 'base64')
		expect(() =>
			new TextDecoder('utf-8', { fatal: true }).decode(bytes),
		).toThrow()
		const input = bytes.toString('utf8')
		expect(actual(input), row.id).toEqual(await expected(input))
	}
})

test('Unicode, case comments and lexer boundaries retain their positions', async () => {
	for (const input of [
		'a\ud83d >file',
		'a\udc00',
		'case a in a) b\n# x\nesac',
		'case a in a) # x\nesac',
		'cmd read 😀 2>空 | head',
		'echo \x60echo "\\$(printf 猫)"\x60',
		'echo "$((1+$(f)))" \${x/\$(foo)/\$(bar)}',
		'A='.padEnd(1023, 'a') + 'é\\\r\n$(x) cat',
	]) {
		expect(actual(input), JSON.stringify(input)).toEqual(await expected(input))
	}
})

test('seeded mutations match the Bash oracle', async () => {
	const count = Number(process.env.BASH_PARSER_FUZZ_COUNT ?? 4000)
	if (!Number.isSafeInteger(count) || count < 4000)
		throw Error('BASH_PARSER_FUZZ_COUNT must be at least 4000')
	let index = 0
	for (const input of mutations(
		cases.map((c) => c.input),
		count,
	)) {
		expect(
			actual(input),
			'mutation ' + index + ' ' + JSON.stringify(input),
		).toEqual(await expected(input))
		index++
	}
}, 180_000)

test('corpus acceptance agrees with bash -n wherever bash and mvdan agree', async () => {
	const home = mkdtempSync(join(tmpdir(), 'bash-parser-bash-n-'))
	let agreements = 0,
		bashOnly = 0,
		mvdanOnly = 0
	try {
		for (const { id, input } of cases) {
			const proc = Bun.spawnSync(
				['bash', '--noprofile', '--norc', '-O', 'extglob', '-n'],
				{
					cwd: home,
					env: { HOME: home, PATH: process.env.PATH, LC_ALL: 'C' },
					stdin: Buffer.from(input),
					timeout: 5000,
				},
			)
			if (proc.signalCode || proc.exitCode === null || proc.exitCode < 0)
				throw Error(id + ': bash failed to finish')
			// Some Bash versions print syntax diagnostics but exit successfully.
			const diagnostic = proc.stderr
				.toString()
				.split('\n')
				.some((line) => line.trim() && !line.includes('warning:'))
			const bash = proc.exitCode === 0 && !diagnostic
			if (((await expected(input)) !== null) === bash) {
				expect(actual(input) !== null, id).toBe(bash)
				agreements++
			} else if (bash) bashOnly++
			else mvdanOnly++
		}
		expect(agreements).toBeGreaterThan(0)
		console.info('bash -n / mvdan corpus verdicts', {
			agreements,
			bashOnly,
			mvdanOnly,
		})
	} finally {
		rmSync(home, { recursive: true, force: true })
	}
}, 120_000)
