import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as shSyntax } from 'sh-syntax'

import { parse } from '../src/index.ts'
import corpus from './corpus.json'

// bun run bench
// Warm: median ms per corpus input, including syntax errors.
// Cold: median wall time of a fresh `bun` process that imports the parser and
// parses one command, so import and WASM instantiation both count. `baseline`
// is a process that imports nothing: the bun startup floor.
const inputs = corpus.cases.filter((row) => !row.bytes).map((row) => row.input)
const median = (samples: number[]) =>
	samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)]!

async function warm(parseInput: (source: string) => unknown) {
	const samples: number[] = []
	for (let round = 0; round < 8; round++) {
		const start = performance.now()
		for (const source of inputs) {
			try {
				await parseInput(source)
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error
			}
		}
		if (round) samples.push((performance.now() - start) / inputs.length)
	}
	return median(samples)
}

const result = {
	inputs: inputs.length,
	warmMsPerInput: {
		shSyntax: await warm(shSyntax),
		bashParser: await warm(parse),
	},
}

const dir = mkdtempSync(join(tmpdir(), 'bash-parser-bench-'))
try {
	const root = resolve(import.meta.dir, '..')
	const cold = (name: string, body: string) => {
		const file = join(dir, name + '.ts')
		writeFileSync(file, body)
		return file
	}
	const command = 'git log --oneline | head -n 5 > out.txt'
	const scripts = {
		baseline: cold('baseline', 'export {}'),
		shSyntax: cold(
			'sh-syntax',
			`import { parse } from ${JSON.stringify(import.meta.resolve('sh-syntax'))}
await parse(${JSON.stringify(command)})`,
		),
		bashParser: cold(
			'bash-parser',
			`import { parse } from ${JSON.stringify(join(root, 'src/index.ts'))}
parse(${JSON.stringify(command)})`,
		),
	}
	const samples = {
		baseline: [] as number[],
		shSyntax: [] as number[],
		bashParser: [] as number[],
	}
	const empty = join(dir, 'empty')
	mkdirSync(empty)
	for (let round = 0; round < 33; round++) {
		for (const name of ['baseline', 'shSyntax', 'bashParser'] as const) {
			const start = performance.now()
			const proc = Bun.spawnSync(['bun', scripts[name]], { cwd: empty })
			if (proc.exitCode !== 0) throw Error(name + ': ' + proc.stderr.toString())
			if (round >= 2) samples[name].push(performance.now() - start)
		}
	}
	console.log(
		JSON.stringify(
			{
				...result,
				coldMedianMs: {
					baseline: median(samples.baseline),
					shSyntax: median(samples.shSyntax),
					bashParser: median(samples.bashParser),
				},
				bun: Bun.version,
			},
			null,
			2,
		),
	)
} finally {
	rmSync(dir, { recursive: true, force: true })
}
