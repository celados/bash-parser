// Bash grammar adapted from mvdan/sh at 6f0102cc00b2. See LICENSE at the package root.
import { tokenText } from './tokens.ts'
export interface SyntaxNode {
	readonly type: string
	readonly start: number
	readonly end: number
}
type Command =
	| CallExpr
	| BinaryCmd
	| Block
	| Subshell
	| IfClause
	| WhileClause
	| ForClause
	| CaseClause
	| FuncDecl
	| TimeClause
	| CoprocClause
	| ArithmCmd
	| TestClause
	| LetClause
	| DeclClause
export type WordPart =
	| Lit
	| SglQuoted
	| DblQuoted
	| ParamExp
	| CmdSubst
	| ArithmExp
	| ProcSubst
	| ExtGlob

export class Stmt implements SyntaxNode {
	readonly type = 'Stmt'
	cmd: Command | null = null
	position = -1
	semicolon = -1
	negated = false
	background = false
	coprocess = false
	disown = false
	redirs: Array<Redirect> = []
	constructor(fields: Partial<Stmt> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.position
	}
	get end(): number {
		let end = -1
		if (this.semicolon >= 0) {
			end = this.semicolon + 1
			if (this.coprocess || this.disown) {
				end = end + 1
			}
		} else {
			end = this.position
			if (this.negated) {
				end = end + 1
			}
			if (this.cmd !== null) {
				end = this.cmd.end
			}
		}
		for (const r of this.redirs) {
			end = Math.max(end, r.end)
		}
		return end
	}
}
export class Assign implements SyntaxNode {
	readonly type = 'Assign'
	append = false
	naked = false
	name: Lit | null = null
	index: SyntaxNode | null = null
	value: Word | null = null
	array: ArrayExpr | null = null
	constructor(fields: Partial<Assign> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.name === null) {
			return this.value!.start
		}
		return this.name!.start
	}
	get end(): number {
		if (this.value !== null) {
			return this.value!.end
		}
		if (this.array !== null) {
			return this.array.end
		}
		if (this.index !== null) {
			if (this.naked) {
				return this.index!.end + ']'.length
			}
			return this.index!.end + ']='.length
		}
		if (this.naked) {
			return this.name!.end
		}
		return this.name!.end + 1
	}
}
export class Redirect implements SyntaxNode {
	readonly type = 'Redirect'
	opPos = -1
	closePos = -1
	op = 0
	n: Lit | null = null
	word: Word | null = null
	hdoc: Word | null = null
	constructor(fields: Partial<Redirect> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.n !== null) {
			return this.n.start
		}
		return this.opPos
	}
	get end(): number {
		if (this.hdoc !== null) {
			return this.hdoc.end
		}
		return this.word!.end
	}
}
export class CallExpr implements SyntaxNode {
	readonly type = 'CallExpr'
	assigns: Array<Assign> = []
	args: Array<Word> = []
	constructor(fields: Partial<CallExpr> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.assigns.length > 0) {
			return this.assigns[0]!.start
		}
		return this.args[0]!.start
	}
	get end(): number {
		if (this.args.length === 0) {
			return this.assigns.at(-1)!.end
		}
		return this.args.at(-1)!.end
	}
}
export class Subshell implements SyntaxNode {
	readonly type = 'Subshell'
	lparen = -1
	rparen = -1
	stmts: Array<Stmt> = []
	constructor(fields: Partial<Subshell> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.lparen
	}
	get end(): number {
		return this.rparen + 1
	}
}
export class Block implements SyntaxNode {
	readonly type = 'Block'
	lbrace = -1
	rbrace = -1
	stmts: Array<Stmt> = []
	constructor(fields: Partial<Block> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.lbrace
	}
	get end(): number {
		return this.rbrace + 1
	}
}
export class IfClause implements SyntaxNode {
	readonly type = 'IfClause'
	position = -1
	thenPos = -1
	fiPos = -1
	cond: Array<Stmt> = []
	then: Array<Stmt> = []
	else: IfClause | null = null
	constructor(fields: Partial<IfClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.position
	}
	get end(): number {
		return this.fiPos + 2
	}
}
export class WhileClause implements SyntaxNode {
	readonly type = 'WhileClause'
	whilePos = -1
	doPos = -1
	donePos = -1
	until = false
	cond: Array<Stmt> = []
	do: Array<Stmt> = []
	constructor(fields: Partial<WhileClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.whilePos
	}
	get end(): number {
		return this.donePos + 4
	}
}
export class ForClause implements SyntaxNode {
	readonly type = 'ForClause'
	forPos = -1
	doPos = -1
	donePos = -1
	braces = false
	loop: SyntaxNode | null = null
	do: Array<Stmt> = []
	constructor(fields: Partial<ForClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.forPos
	}
	get end(): number {
		if (this.braces) {
			return this.donePos + '}'.length
		}
		return this.donePos + 'done'.length
	}
}
export class WordIter implements SyntaxNode {
	readonly type = 'WordIter'
	name: Lit | null = null
	names: Array<Lit> = []
	inPos = -1
	items: Array<Word> = []
	constructor(fields: Partial<WordIter> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.names.length > 0) {
			return this.names[0]!.start
		}
		return this.name!.start
	}
	get end(): number {
		if (this.items.length > 0) {
			return this.items.at(-1)!.end
		}
		let last = this.name
		if (this.names.length > 0) {
			last = this.names.at(-1)!
		}
		return Math.max(last!.end, this.inPos >= 0 ? this.inPos + 2 : 0)
	}
}
export class CStyleLoop implements SyntaxNode {
	readonly type = 'CStyleLoop'
	lparen = -1
	rparen = -1
	init: SyntaxNode | null = null
	cond: SyntaxNode | null = null
	post: SyntaxNode | null = null
	constructor(fields: Partial<CStyleLoop> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.lparen
	}
	get end(): number {
		return this.rparen + 2
	}
}
export class BinaryCmd implements SyntaxNode {
	readonly type = 'BinaryCmd'
	opPos = -1
	op = 0
	x: Stmt | null = null
	y: Stmt | null = null
	constructor(fields: Partial<BinaryCmd> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.x!.start
	}
	get end(): number {
		return this.y!.end
	}
}
export class FuncDecl implements SyntaxNode {
	readonly type = 'FuncDecl'
	position = -1
	name: Lit | null = null
	names: Array<Lit> = []
	body: Stmt | null = null
	args: Array<Word> = []
	constructor(fields: Partial<FuncDecl> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.position
	}
	get end(): number {
		if (this.args.length > 0) {
			return this.args.at(-1)!.end
		}
		return this.body!.end
	}
}
export class Word implements SyntaxNode {
	readonly type = 'Word'
	parts: WordPart[] = []
	constructor(fields: Partial<Word> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.parts[0]!.start
	}
	get end(): number {
		return this.parts.at(-1)!.end
	}
}
export class Lit implements SyntaxNode {
	readonly type = 'Lit'
	valuePos = -1
	valueEnd = -1
	value = ''
	constructor(fields: Partial<Lit> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.valuePos
	}
	get end(): number {
		return this.valueEnd
	}
}
export class SglQuoted implements SyntaxNode {
	readonly type = 'SglQuoted'
	left = -1
	right = -1
	dollar = false
	value = ''
	constructor(fields: Partial<SglQuoted> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.left
	}
	get end(): number {
		return this.right + 1
	}
}
export class DblQuoted implements SyntaxNode {
	readonly type = 'DblQuoted'
	left = -1
	right = -1
	dollar = false
	parts: WordPart[] = []
	constructor(fields: Partial<DblQuoted> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.left
	}
	get end(): number {
		return this.right + 1
	}
}
export class CmdSubst implements SyntaxNode {
	readonly type = 'CmdSubst'
	left = -1
	right = -1
	stmts: Array<Stmt> = []
	constructor(fields: Partial<CmdSubst> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.left
	}
	get end(): number {
		return this.right + 1
	}
}
export class ParamExp implements SyntaxNode {
	readonly type = 'ParamExp'
	dollar = -1
	rbrace = -1
	short = false
	excl = false
	length = false
	param: Lit | null = null
	index: SyntaxNode | null = null
	slice: Slice | null = null
	repl: Replace | null = null
	names = 0
	exp: Expansion | null = null
	constructor(fields: Partial<ParamExp> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.dollar >= 0) {
			return this.dollar
		}
		return this.param!.start
	}
	get end(): number {
		if (!this.short) {
			return this.rbrace + 1
		}
		if (this.index !== null) {
			return this.index!.end + 1
		}
		return this.param!.end
	}
}
export class Slice {
	offset: SyntaxNode | null = null
	length: SyntaxNode | null = null
	constructor(fields: Partial<Slice> = {}) {
		Object.assign(this, fields)
	}
}
export class Replace {
	orig: Word | null = null
	with: Word | null = null
	constructor(fields: Partial<Replace> = {}) {
		Object.assign(this, fields)
	}
}
export class Expansion {
	op = 0
	word: Word | null = null
	constructor(fields: Partial<Expansion> = {}) {
		Object.assign(this, fields)
	}
}
export class ArithmExp implements SyntaxNode {
	readonly type = 'ArithmExp'
	left = -1
	right = -1
	bracket = false
	x: SyntaxNode | null = null
	constructor(fields: Partial<ArithmExp> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.left
	}
	get end(): number {
		if (this.bracket) {
			return this.right + 1
		}
		return this.right + 2
	}
}
export class ArithmCmd implements SyntaxNode {
	readonly type = 'ArithmCmd'
	left = -1
	right = -1
	x: SyntaxNode | null = null
	constructor(fields: Partial<ArithmCmd> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.left
	}
	get end(): number {
		return this.right + 2
	}
}
export class BinaryArithm implements SyntaxNode {
	readonly type = 'BinaryArithm'
	opPos = -1
	op = 0
	x: SyntaxNode | null = null
	y: SyntaxNode | null = null
	constructor(fields: Partial<BinaryArithm> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.x!.start
	}
	get end(): number {
		return this.y!.end
	}
}
export class UnaryArithm implements SyntaxNode {
	readonly type = 'UnaryArithm'
	opPos = -1
	op = 0
	post = false
	x: SyntaxNode | null = null
	constructor(fields: Partial<UnaryArithm> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.post) {
			return this.x!.start
		}
		return this.opPos
	}
	get end(): number {
		if (this.post) {
			return this.opPos + 2
		}
		return this.x!.end
	}
}
export class ParenArithm implements SyntaxNode {
	readonly type = 'ParenArithm'
	lparen = -1
	rparen = -1
	x: SyntaxNode | null = null
	constructor(fields: Partial<ParenArithm> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.lparen
	}
	get end(): number {
		return this.rparen + 1
	}
}
export class CaseClause implements SyntaxNode {
	readonly type = 'CaseClause'
	case = -1;
	in = -1
	esac = -1
	braces = false
	word: Word | null = null
	items: Array<CaseItem> = []
	constructor(fields: Partial<CaseClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.case
	}
	get end(): number {
		if (this.braces) {
			return this.esac + '}'.length
		}
		return this.esac + 'esac'.length
	}
}
export class CaseItem implements SyntaxNode {
	readonly type = 'CaseItem'
	trailingCommentEnd = 0
	op = 0
	opPos = -1
	patterns: Array<Word> = []
	stmts: Array<Stmt> = []
	constructor(fields: Partial<CaseItem> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.patterns[0]!.start
	}
	get end(): number {
		if (this.opPos >= 0) {
			return this.opPos + tokenText(this.op).length
		}
		return Math.max(this.trailingCommentEnd, this.stmts.at(-1)?.end ?? 0)
	}
}
export class TestClause implements SyntaxNode {
	readonly type = 'TestClause'
	left = -1
	right = -1
	x: SyntaxNode | null = null
	constructor(fields: Partial<TestClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.left
	}
	get end(): number {
		return this.right + 2
	}
}
export class BinaryTest implements SyntaxNode {
	readonly type = 'BinaryTest'
	opPos = -1
	op = 0
	x: SyntaxNode | null = null
	y: SyntaxNode | null = null
	constructor(fields: Partial<BinaryTest> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.x!.start
	}
	get end(): number {
		return this.y!.end
	}
}
export class UnaryTest implements SyntaxNode {
	readonly type = 'UnaryTest'
	opPos = -1
	op = 0
	x: SyntaxNode | null = null
	constructor(fields: Partial<UnaryTest> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.opPos
	}
	get end(): number {
		return this.x!.end
	}
}
export class ParenTest implements SyntaxNode {
	readonly type = 'ParenTest'
	lparen = -1
	rparen = -1
	x: SyntaxNode | null = null
	constructor(fields: Partial<ParenTest> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.lparen
	}
	get end(): number {
		return this.rparen + 1
	}
}
export class DeclClause implements SyntaxNode {
	readonly type = 'DeclClause'
	variant: Lit | null = null
	args: Array<Assign> = []
	assigns: Array<Assign> = []
	constructor(fields: Partial<DeclClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.assigns.length > 0) {
			return this.assigns[0]!.start
		}
		return this.variant!.start
	}
	get end(): number {
		if (this.args.length > 0) {
			return this.args.at(-1)!.end
		}
		return this.variant!.end
	}
}
export class ArrayExpr implements SyntaxNode {
	readonly type = 'ArrayExpr'
	lparen = -1
	rparen = -1
	elems: Array<ArrayElem> = []
	constructor(fields: Partial<ArrayExpr> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.lparen
	}
	get end(): number {
		return this.rparen + 1
	}
}
export class ArrayElem implements SyntaxNode {
	readonly type = 'ArrayElem'
	index: SyntaxNode | null = null
	value: Word | null = null
	constructor(fields: Partial<ArrayElem> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		if (this.index !== null) {
			return this.index!.start
		}
		return this.value!.start
	}
	get end(): number {
		if (this.value !== null) {
			return this.value!.end
		}
		return this.index!.end + ']='.length
	}
}
export class ExtGlob implements SyntaxNode {
	readonly type = 'ExtGlob'
	opPos = -1
	op = 0
	pattern: Lit | null = null
	constructor(fields: Partial<ExtGlob> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.opPos
	}
	get end(): number {
		return this.pattern!.end + 1
	}
}
export class ProcSubst implements SyntaxNode {
	readonly type = 'ProcSubst'
	opPos = -1
	rparen = -1
	op = 0
	stmts: Array<Stmt> = []
	constructor(fields: Partial<ProcSubst> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.opPos
	}
	get end(): number {
		return this.rparen + 1
	}
}
export class TimeClause implements SyntaxNode {
	readonly type = 'TimeClause'
	time = -1
	posixFormat = false
	stmt: Stmt | null = null
	constructor(fields: Partial<TimeClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.time
	}
	get end(): number {
		if (this.stmt === null) {
			return this.time + 4
		}
		return this.stmt!.end
	}
}
export class CoprocClause implements SyntaxNode {
	readonly type = 'CoprocClause'
	coproc = -1
	name: Word | null = null
	stmt: Stmt | null = null
	constructor(fields: Partial<CoprocClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.coproc
	}
	get end(): number {
		return this.stmt!.end
	}
}
export class LetClause implements SyntaxNode {
	readonly type = 'LetClause'
	let = -1
	exprs: Array<SyntaxNode> = []
	constructor(fields: Partial<LetClause> = {}) {
		Object.assign(this, fields)
	}
	get start(): number {
		return this.let
	}
	get end(): number {
		return this.exprs.at(-1)!.end
	}
}
