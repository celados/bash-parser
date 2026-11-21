import { parse, walk, createSourceIndex } from 'sh-syntax'

import { parse as parseBash } from '../src/index.ts'

// Record each syntactic child and its parent field, including words in
// arithmetic expressions, parameter operands, assignments and heredocs.
// Literal fragments and quote kinds determine each word's literal value.
function syntaxRows(stmts: unknown) {
	const rows: unknown[] = []
	function visit(value: unknown, path: string) {
		if (Array.isArray(value)) {
			value.forEach((child, i) => visit(child, path + '/' + i))
			return
		}
		if (!value || typeof value !== 'object') return
		const node = value as Record<string, unknown>
		if (('offset' in node && 'column' in node) || node.type === 'Comment')
			return
		if (typeof node.type === 'string' && 'start' in node) {
			rows.push([
				path,
				node.type,
				node.start,
				node.end,
				node.op,
				typeof node.value === 'string' ? node.value : undefined,
				typeof node.dollar === 'boolean' ? node.dollar : undefined,
			])
		}
		for (const key of Object.keys(node).sort()) {
			const child = node[key]
			if (child && typeof child === 'object') visit(child, path + '/' + key)
		}
	}
	visit(stmts, '')
	return rows
}

// Every word reduced to its literal value: literal fragments verbatim, quotes
// kept, other parts by type. Both ASTs expose the same `type`/`parts` shape.
function wordRows(stmts: unknown) {
	const rows: unknown[] = []
	function render(part: any): string {
		switch (part.type) {
			case 'Lit':
				return part.value
			case 'SglQuoted':
				return (part.dollar ? "$'" : "'") + part.value + "'"
			case 'DblQuoted':
				return (
					(part.dollar ? '$"' : '"') + part.parts.map(render).join('') + '"'
				)
			default:
				return '<' + part.type + '>'
		}
	}
	function visit(value: unknown) {
		if (Array.isArray(value)) return value.forEach(visit)
		if (!value || typeof value !== 'object') return
		const node = value as Record<string, any>
		if (node.type === 'Word')
			rows.push([node.start, node.end, node.parts.map(render).join('')])
		for (const key of Object.keys(node).sort()) {
			const child = node[key]
			if (child && typeof child === 'object') visit(child)
		}
	}
	visit(stmts)
	return rows
}

export function actual(source: string) {
	let stmts
	try {
		stmts = parseBash(source)
	} catch (error) {
		if (error instanceof SyntaxError) return null
		throw error
	}
	return { words: wordRows(stmts), syntax: syntaxRows(stmts) }
}

export async function expected(source: string) {
	let file
	try {
		file = await parse(source)
	} catch (error) {
		if (error instanceof SyntaxError) return null
		throw error
	}
	const at = createSourceIndex(source)
	walk(file, (node) => {
		node.start = at(node.start)
		node.end = at(node.end)
	})
	return { words: wordRows(file.stmts), syntax: syntaxRows(file.stmts) }
}
