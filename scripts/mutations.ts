// Mulberry32 gives a reproducible mutation stream across JS runtimes.
export function* mutations(inputs: string[], count: number, seed = 0x637478) {
	function pick(limit: number) {
		let x = (seed += 0x6d2b79f5)
		x = Math.imul(x ^ (x >>> 15), x | 1)
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
		return Math.floor((((x ^ (x >>> 14)) >>> 0) / 4294967296) * limit)
	}
	const tokens = [
		' ',
		'\n',
		'\\\n',
		"'",
		'"',
		'`',
		';',
		'|',
		'&&',
		'||',
		'&',
		'(',
		')',
		'{',
		'}',
		'[',
		']',
		'#',
		'>',
		'<<',
		'$',
		'$(x)',
		'猫',
		'😀',
		'=',
		'abc',
		'\0',
	]
	for (let i = 0; i < count; i++) {
		const input = inputs[pick(inputs.length)]!
		const start = pick(input.length + 1)
		const end = start + pick(input.length - start + 1)
		const token = tokens[pick(tokens.length)]!
		switch (pick(5)) {
			case 0:
				yield input.slice(0, start) + token + input.slice(start)
				break
			case 1:
				yield input.slice(0, start) + input.slice(end)
				break
			case 2:
				yield input.slice(0, start) + token + input.slice(end)
				break
			case 3:
				yield (
					input.slice(0, start) +
					inputs[pick(inputs.length)] +
					input.slice(start)
				)
				break
			default:
				yield input.slice(0, end) + input.slice(start, end) + input.slice(end)
		}
	}
}
