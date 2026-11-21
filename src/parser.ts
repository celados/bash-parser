/*! @license Bash syntax adapted from mvdan/sh.
Copyright (c) 2016, Daniel Martí. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of the copyright holder nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
import {
	type SyntaxNode,
	type WordPart,
	Stmt,
	Assign,
	Redirect,
	CallExpr,
	Subshell,
	Block,
	IfClause,
	WhileClause,
	ForClause,
	WordIter,
	CStyleLoop,
	BinaryCmd,
	FuncDecl,
	Word,
	Lit,
	SglQuoted,
	DblQuoted,
	CmdSubst,
	ParamExp,
	Slice,
	Replace,
	Expansion,
	ArithmExp,
	ArithmCmd,
	BinaryArithm,
	UnaryArithm,
	ParenArithm,
	CaseClause,
	CaseItem,
	TestClause,
	BinaryTest,
	UnaryTest,
	ParenTest,
	DeclClause,
	ArrayExpr,
	ArrayElem,
	ExtGlob,
	ProcSubst,
	TimeClause,
	CoprocClause,
	LetClause,
} from './nodes.ts'
// Bash grammar adapted from mvdan/sh at 6f0102cc00b2. See LICENSE at the package root.
import { Token, tokenText } from './tokens.ts'
const maxNesting = 10_000
const endOfInput = '\u0000EOF',
	escapedNewline = '\u0000NL'
const noState = 1
const runeByRune = 2
const unquotedWordContinuation = 4
const subCmd = 8
const subCmdBckquo = 16
const subCmdBraces = 32
const dblQuotes = 64
const hdocWord = 128
const hdocBody = 256
const hdocBodyTabs = 512
const arithmExpr = 1024
const arithmExprLet = 2048
const arithmExprCmd = 4096
const testExpr = 8192
const testExprRegexp = 16384
const switchCase = 32768
const paramExpArithm = 65536
const paramExpSlice = 262144
const paramExpRepl = 524288
const paramExpExp = 1048576
const arrayElems = 2097152
const allKeepSpaces =
	runeByRune | paramExpRepl | dblQuotes | hdocBody | hdocBodyTabs | paramExpExp
const allRegTokens =
	noState |
	unquotedWordContinuation |
	subCmd |
	subCmdBckquo |
	subCmdBraces |
	hdocWord |
	switchCase |
	arrayElems |
	testExpr
const allArithmExpr =
	arithmExpr | arithmExprLet | arithmExprCmd | paramExpArithm | paramExpSlice
const allParamExp = paramExpArithm | paramExpSlice | paramExpRepl | paramExpExp
type NestedState = {
	quote: number
	outerHeredocs: number
}
function isLiteralToken(t: number) {
	return t === Token.Lit || t === Token.LitWord || t === Token.LitRedir
}
function validName(name: string) {
	return /^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)
}
function numberLiteral(s: string) {
	return /^[0-9]+$/.test(s)
}
function isArithName(x: SyntaxNode | null) {
	if (!(x instanceof Word) || x.parts.length !== 1) return false
	const p = x.parts[0]
	return p instanceof Lit
		? validName(p.value)
		: p instanceof ParamExp && p.short && p.index !== null && p.dollar < 0
}
function heredocDelimiter(w: Word): [string, boolean] {
	let out = '',
		quoted = false
	function visit(parts: SyntaxNode[], inQuotes: boolean) {
		for (const part of parts) {
			if (part instanceof Lit) {
				out += part.value.replace(
					inQuotes ? /\\([$\x60"\\])/g : /\\([\s\S]?)/g,
					(_m, c: string) => {
						quoted = true
						return c
					},
				)
			} else if (part instanceof SglQuoted) {
				out += part.value
				quoted = true
			} else if (part instanceof DblQuoted) {
				visit(part.parts, true)
				quoted = true
			}
		}
	}
	visit(w.parts, false)
	return [out, quoted]
}
function isKeyword(word: string): boolean {
	switch (word) {
		case '!':
		case '[[':
		case ']]':
		case 'case':
		case 'coproc':
		case 'do':
		case 'done':
		case 'elif':
		case 'else':
		case 'esac':
		case 'fi':
		case 'for':
		case 'function':
		case 'if':
		case 'in':
		case 'select':
		case 'then':
		case 'time':
		case 'until':
		case 'while':
		case '{':
		case '}':
			return true
	}
	return false
}
function isBashCompoundCommand(tok: number, val: string): boolean {
	switch (tok) {
		case Token.leftParen:
		case Token.dblLeftParen:
			return true
		case Token.LitWord:
			switch (val) {
				case '{':
				case 'if':
				case 'while':
				case 'until':
				case 'for':
				case 'case':
				case '[[':
				case 'coproc':
				case 'let':
				case 'function':
				case 'declare':
				case 'local':
				case 'export':
				case 'readonly':
				case 'typeset':
				case 'nameref':
					return true
			}
			break
	}
	return false
}
function asciiLetter(r: string): boolean {
	return ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z')
}
function asciiDigit(r: string): boolean {
	return r >= '0' && r <= '9'
}
function regOps(r: string): boolean {
	switch (r) {
		case ';':
		case '"':
		case "'":
		case '(':
		case ')':
		case '$':
		case '|':
		case '&':
		case '>':
		case '<':
		case '`':
			return true
	}
	return false
}
function paramOps(r: string): boolean {
	switch (r) {
		case '}':
		case '#':
		case '!':
		case ':':
		case '-':
		case '+':
		case '=':
		case '?':
		case '%':
		case '[':
		case ']':
		case '/':
		case '^':
		case ',':
		case '@':
		case '*':
			return true
	}
	return false
}
function arithmOps(r: string): boolean {
	switch (r) {
		case '+':
		case '-':
		case '!':
		case '~':
		case '*':
		case '/':
		case '%':
		case '(':
		case ')':
		case '^':
		case '<':
		case '>':
		case ':':
		case '=':
		case ',':
		case '?':
		case '|':
		case '&':
		case '[':
		case ']':
		case '#':
		case '.':
			return true
	}
	return false
}
function bquoteEscaped(b: string): boolean {
	switch (b) {
		case '$':
		case '`':
		case '\\':
			return true
	}
	return false
}
function positionalRuneParam(r: string): boolean {
	switch (r) {
		case '0':
		case '1':
		case '2':
		case '3':
		case '4':
		case '5':
		case '6':
		case '7':
		case '8':
		case '9':
			return true
	}
	return false
}
function singleRuneParam(r: string): boolean {
	switch (r) {
		case '@':
		case '*':
		case '#':
		case '$':
		case '?':
		case '!':
		case '-':
			return true
	}
	return positionalRuneParam(r)
}
function paramNameRune(r: string): boolean {
	return asciiLetter(r) || asciiDigit(r) || r === '_'
}
function paramNameStartRune(r: string): boolean {
	return singleRuneParam(r) || paramNameRune(r)
}
function testUnaryOp(val: string): number {
	switch (val) {
		case '!':
			return Token.exclMark
		case '-e':
		case '-a':
			return Token.tsExists
		case '-f':
			return Token.tsRegFile
		case '-d':
			return Token.tsDirect
		case '-c':
			return Token.tsCharSp
		case '-b':
			return Token.tsBlckSp
		case '-p':
			return Token.tsNmPipe
		case '-S':
			return Token.tsSocket
		case '-L':
		case '-h':
			return Token.tsSmbLink
		case '-k':
			return Token.tsSticky
		case '-g':
			return Token.tsGIDSet
		case '-u':
			return Token.tsUIDSet
		case '-G':
			return Token.tsGrpOwn
		case '-O':
			return Token.tsUsrOwn
		case '-N':
			return Token.tsModif
		case '-r':
			return Token.tsRead
		case '-w':
			return Token.tsWrite
		case '-x':
			return Token.tsExec
		case '-s':
			return Token.tsNoEmpty
		case '-t':
			return Token.tsFdTerm
		case '-z':
			return Token.tsEmpStr
		case '-n':
			return Token.tsNempStr
		case '-o':
			return Token.tsOptSet
		case '-v':
			return Token.tsVarSet
		case '-R':
			return Token.tsRefVar
		default:
			return 0
	}
}
function testBinaryOp(val: string): number {
	switch (val) {
		case '=':
			return Token.assgn
		case '==':
			return Token.equal
		case '!=':
			return Token.nequal
		case '=~':
			return Token.tsReMatch
		case '-nt':
			return Token.tsNewer
		case '-ot':
			return Token.tsOlder
		case '-ef':
			return Token.tsDevIno
		case '-eq':
			return Token.tsEql
		case '-ne':
			return Token.tsNeq
		case '-le':
			return Token.tsLeq
		case '-ge':
			return Token.tsGeq
		case '-lt':
			return Token.tsLss
		case '-gt':
			return Token.tsGtr
		default:
			return 0
	}
}
export class BashParser {
	private readonly source: string
	private constructor(source: string) {
		// TextEncoder, used by the oracle, replaces each unpaired surrogate.
		this.source = source.toWellFormed()
	}
	private cursor = 0
	private width = 0
	private char = ''
	private position = 0
	private token: number = Token.illegalTok
	private value = ''
	private spaced = false
	private context = noState
	private equalsIndex = -1
	private openNodes = 0
	private openBquotes = 0
	private openBquoteDbls = 0
	private lastBquoteEsc = 0
	private regexParens = 0
	private regexStart = false
	private forbidNested = false
	private outerHeredocs = 0
	private heredocs: Redirect[] = []
	private heredocDelimiters: Array<string | null> = []
	private hdocClosePos = -1
	private literalBuffer = ''
	private lastCommentEnd = 0
	private buffering = false
	static parse(source: string) {
		return new BashParser(source).parseFile()
	}
	private parseFile() {
		this.rune()
		this.next()
		const stmts = this.statementList()
		this.doHeredocs()
		return stmts
	}
	// The cursor points past the current character. An escaped newline is one
	// logical token. Backquotes remove one layer of quoting for each open level.
	private rune(): string {
		let escapes = 0
		while (this.cursor < this.source.length) {
			const c = this.source[this.cursor++]!
			if (c === '\0' || (c === '\r' && this.peek() === '\n')) continue
			if (c === '\\') {
				if (
					this.char !== '\\' &&
					(this.peek() === '\n' || this.source.startsWith('\r\n', this.cursor))
				) {
					this.width = this.peek() === '\r' ? 2 : 1
					this.cursor += this.width
					this.char = escapedNewline
					return this.char
				}
				if (
					(escapes < this.openBquotes && bquoteEscaped(this.peek())) ||
					(escapes < this.openBquoteDbls && this.peek() === '"')
				) {
					escapes++
					continue
				}
			}
			if (c === '\x60') this.lastBquoteEsc = escapes
			this.width = 1
			this.char = c
			if (this.buffering) this.literalBuffer += c
			return c
		}
		this.char = endOfInput
		this.width = 1
		return this.char
	}
	private peek(): string {
		return this.source[this.cursor] ?? endOfInput
	}
	private peekTwo(): [string, string] {
		return [this.peek(), this.source[this.cursor + 1] ?? endOfInput]
	}
	private nextPos() {
		return this.char === endOfInput
			? this.source.length
			: this.cursor - this.width
	}
	private newLit(r: string) {
		this.buffering = true
		this.literalBuffer = r === endOfInput || r === escapedNewline ? '' : r
	}
	private endLit() {
		const value =
			this.char === endOfInput || this.char === escapedNewline
				? this.literalBuffer
				: this.literalBuffer.slice(0, -this.width)
		this.buffering = false
		this.literalBuffer = ''
		return value
	}
	private lit(pos: number, value: string) {
		return new Lit({ valuePos: pos, valueEnd: this.nextPos(), value })
	}
	private wordAnyNumber() {
		return new Word({ parts: this.wordParts() })
	}
	private wordOne(part: WordPart) {
		return new Word({ parts: [part] })
	}
	private call(w: Word | null) {
		return new CallExpr({ args: w ? [w] : [] })
	}
	// A word can change the lexer context recursively through expansions.
	private wordParts(): WordPart[] {
		const old = this.context
		if (old === noState) this.context = unquotedWordContinuation
		const parts: WordPart[] = []
		do {
			this.enterNode()
			const part = this.wordPart()
			this.leaveNode()
			if (!part) break
			parts.push(part)
		} while (!this.spaced)
		this.context = old
		return parts
	}
	private statementList(...stops: string[]): Stmt[] {
		const stmts: Stmt[] = []
		let separated = true
		while (this.token !== Token.EOF) {
			const newline = this.got(Token.Newl)
			if (this.token === Token.LitWord) {
				if (stops.includes(this.value)) break
				if (this.value === '}') this.curErr('unexpected closing brace')
			}
			if (
				(this.token === Token.rightParen && this.context === subCmd) ||
				(this.token === Token.bckQuote && this.backquoteEnd())
			)
				break
			if (
				[
					Token.dblSemicolon,
					Token.semiAnd,
					Token.dblSemiAnd,
					Token.semiOr,
				].includes(this.token)
			) {
				if (this.context === switchCase) break
				return this.curErr('expected a case clause')
			}
			if (!newline && !separated)
				return this.curErr('statements must be separated by &, ; or a newline')
			if (this.token === Token.EOF) break
			const statement = this.parseStatement(true, false)
			if (!statement) this.invalidStmtStart()
			separated = statement!.semicolon >= 0
			stmts.push(statement!)
		}
		return stmts
	}
	private preNested(quote: number) {
		const old = { quote: this.context, outerHeredocs: this.outerHeredocs }
		this.outerHeredocs = this.heredocs.length
		this.context = quote
		return old
	}
	private postNested(state: NestedState) {
		this.context = state.quote
		this.outerHeredocs = state.outerHeredocs
	}
	private openBlock(): Block | null {
		if (this.token !== Token.LitWord || this.value !== '{') return null
		const pos = this.position
		this.next()
		return this.blockBody(pos)
	}
	private dblQuoted(): DblQuoted {
		const q = new DblQuoted({
			left: this.position,
			dollar: this.token === Token.dollDblQuote,
		})
		const old = this.context
		this.context = dblQuotes
		this.next()
		q.parts = this.wordParts()
		this.context = old
		q.right = this.position
		if (!this.got(Token.dblQuote)) this.quoteErr(q.start, Token.dblQuote)
		return q
	}
	private posErr(pos: number, format: string, ...values: unknown[]): never {
		let i = 0
		const message = format.replace(/%#?[\dsq]/g, () => {
			const v = values[i++]
			return typeof v === 'number' ? tokenText(v) : String(v)
		})
		throw new SyntaxError('at ' + pos + ': ' + message)
	}
	private curErr(format: string, ...values: unknown[]): never {
		return this.posErr(this.position, format, ...values)
	}
	private followStmts(left: string, pos: number, ...stops: string[]): Stmt[] {
		if (this.got(Token.semicolon)) this.followErr(pos, left, 'a statement list')
		const stmts = this.statementList(...stops)
		if (!stmts.length) this.followErr(pos, left, 'a statement list')
		return stmts
	}
	private enterNode(): void {
		this.openNodes++
		if (this.openNodes > maxNesting) {
			return this.curErr('nesting is deeper than %d levels', maxNesting)
		}
	}
	private leaveNode(): void {
		this.openNodes--
	}
	// Only consume heredocs queued in this command substitution.
	private doHeredocs(): void {
		const hdocs = this.heredocs.slice(this.outerHeredocs)
		if (hdocs.length === 0) {
			return
		}
		this.rune()
		const old = this.context
		this.heredocs = this.heredocs.slice(0, this.outerHeredocs)
		for (const [i, r] of hdocs.entries()) {
			this.context = hdocBody
			if (r.op === Token.dashHdoc) {
				this.context = hdocBodyTabs
			}
			const [stop, quoted] = heredocDelimiter(r.word!)
			this.heredocDelimiters.push(stop)
			if (i > 0 && this.char === '\n') {
				this.rune()
			}
			if (quoted) {
				r.hdoc = this.quotedHdocWord()
			} else {
				this.next()
				r.hdoc = this.getWord()
			}
			if (this.heredocDelimiters.at(-1) === null) {
				r.closePos = this.hdocClosePos
			}
			this.heredocDelimiters.pop()
		}
		this.context = old
	}
	private got(tok: number): boolean {
		if (this.token === tok) {
			this.next()
			return true
		}
		return false
	}
	private consumeKeyword(val: string): [number, boolean] {
		const pos = this.position
		if (this.token === Token.LitWord && this.value === val) {
			this.next()
			return [pos, true]
		}
		return [pos, false]
	}
	private followErr(pos: number, left: unknown, right: unknown): never {
		return this.posErr(pos, '%#q must be followed by %#q', left, right)
	}
	private followErrExp(pos: number, left: unknown): never {
		return this.followErr(pos, left, 'an expression')
	}
	private follow(lpos: number, left: string, tok: number): void {
		if (!this.got(tok)) {
			return this.followErr(lpos, left, tok)
		}
	}
	private followRsrv(lpos: number, left: string, val: string): number {
		const [pos, ok] = this.consumeKeyword(val)
		if (!ok) {
			return this.followErr(lpos, left, val)
		}
		return pos
	}
	private followWordTok(tok: unknown, pos: number): Word {
		const w = this.getWord()
		if (w === null) {
			return this.followErr(pos, tok, 'a word')
		}
		return w
	}
	private stmtEnd(n: SyntaxNode, start: string, end: string): number {
		const [pos, ok] = this.consumeKeyword(end)
		if (!ok) {
			return this.posErr(n.start, '%#q statement must end with %#q', start, end)
		}
		return pos
	}
	private quoteErr(lpos: number, quote: number): never {
		return this.posErr(
			lpos,
			'reached %#q without closing quote %#q',
			this.token,
			quote,
		)
	}
	private matchingErr(lpos: number, left: number, right: number): never {
		return this.posErr(
			lpos,
			'reached %#q without matching %#q with %#q',
			this.token,
			left,
			right,
		)
	}
	private matched(lpos: number, left: number, right: number): number {
		const pos = this.position
		if (!this.got(right)) {
			return this.matchingErr(lpos, left, right)
		}
		return pos
	}
	private invalidStmtStart(): never {
		switch (this.token) {
			case Token.semicolon:
			case Token.and:
			case Token.or:
			case Token.andAnd:
			case Token.orOr:
			case Token.andPipe:
			case Token.andBang:
				return this.curErr(
					'%#q can only immediately follow a statement',
					this.token,
				)
			case Token.rightParen:
				return this.curErr(
					'%#q can only be used to close a subshell',
					this.token,
				)
			default:
				return this.curErr(
					'%#q is not a valid start for a statement',
					this.token,
				)
		}
	}
	private getWord(): Word | null {
		const w = this.wordAnyNumber()
		if (w.parts.length > 0) {
			return w
		}
		return null
	}
	private getLit(): Lit | null {
		if (isLiteralToken(this.token)) {
			const l = this.lit(this.position, this.value)
			this.next()
			return l
		}
		return null
	}
	private ensureNoNested(pos: number): void {
		if (this.forbidNested) {
			return this.posErr(pos, 'expansions not allowed in heredoc words')
		}
	}
	private wordPart(): WordPart | null {
		switch (this.token) {
			case Token.Lit:
			case Token.LitWord:
			case Token.LitRedir: {
				const l = this.lit(this.position, this.value)
				this.next()
				return l
			}
			case Token.dollBrace:
				this.ensureNoNested(this.position)
				switch (this.char) {
					case '|':
					case ' ':
					case '\t':
					case '\n': {
						const cs = new CmdSubst({
							left: this.position,
						})
						const old = this.preNested(subCmdBraces)
						this.rune()
						this.next()
						cs.stmts = this.statementList('}')
						this.postNested(old)
						const [pos, ok] = this.consumeKeyword('}')
						if (!ok) {
							return this.matchingErr(
								cs.left,
								Token.dollBrace,
								Token.rightBrace,
							)
						}
						cs.right = pos
						return cs
					}
					default:
						return this.paramExp()
				}

			case Token.dollDblParen:
			case Token.dollBrack: {
				this.ensureNoNested(this.position)
				const left = this.token
				const ar = new ArithmExp({
					left: this.position,
					bracket: left === Token.dollBrack,
				})
				const old = this.preNested(arithmExpr)
				this.next()
				if (this.got(Token.hash)) {
					return this.posErr(
						ar.start,
						'unsigned expressions are unavailable in bash',
					)
				}
				ar.x = this.followArithm(left, ar.left)
				if (ar.bracket) {
					if (this.token !== Token.rightBrack) {
						this.arithmMatchingErr(ar.left, Token.dollBrack, Token.rightBrack)
					}
					this.postNested(old)
					ar.right = this.position
					this.next()
				} else {
					ar.right = this.arithmEnd(Token.dollDblParen, ar.left, old)
				}
				return ar
			}
			case Token.dollParen:
				this.ensureNoNested(this.position)
				return this.cmdSubst()
			case Token.dollar: {
				const pe = this.paramExp()
				if (pe === null) {
					const l = this.lit(this.position, '$')
					this.next()
					return l
				}
				this.ensureNoNested(pe.dollar)
				return pe
			}
			case Token.assgnParen:
				return this.posErr(
					this.position,
					'%#q process substitutions are unavailable in bash',
					this.token,
				)
			case Token.cmdIn:
			case Token.cmdOut: {
				this.ensureNoNested(this.position)
				const ps = new ProcSubst({ op: this.token, opPos: this.position })
				const old = this.preNested(subCmd)
				this.next()
				ps.stmts = this.statementList()
				this.postNested(old)
				ps.rparen = this.matched(ps.opPos, ps.op, Token.rightParen)
				return ps
			}
			case Token.sglQuote:
			case Token.dollSglQuote: {
				const sq = new SglQuoted({
					left: this.position,
					dollar: this.token === Token.dollSglQuote,
				})
				let r = this.char
				for (this.newLit(r); ; r = this.rune()) {
					switch (r) {
						case '\\':
							if (sq.dollar) {
								this.rune()
							}
							break
						case "'":
							sq.right = this.nextPos()
							sq.value = this.endLit()
							this.rune()
							this.next()
							return sq
						case escapedNewline:
							this.literalBuffer += '\\' + '\n'
							break
						case endOfInput:
							this.token = Token.EOF
							return this.quoteErr(sq.start, Token.sglQuote)
					}
				}
			}
			case Token.dblQuote:
			case Token.dollDblQuote:
				if (this.context === dblQuotes) {
					return null
				}
				return this.dblQuoted()
			case Token.bckQuote: {
				if (this.backquoteEnd()) {
					return null
				}
				this.ensureNoNested(this.position)
				const cs = new CmdSubst({ left: this.position })
				const old = this.preNested(subCmdBckquo)
				this.openBquotes++
				if (old.quote === dblQuotes) {
					this.openBquoteDbls++
				}
				this.rune()
				this.next()
				cs.stmts = this.statementList()
				if (
					this.token === Token.bckQuote &&
					this.lastBquoteEsc < this.openBquotes - 1
				) {
					this.token = Token.EOF
					return this.quoteErr(cs.start, Token.bckQuote)
				}
				this.heredocs = this.heredocs.slice(0, this.outerHeredocs)
				this.postNested(old)
				this.openBquotes--
				if (old.quote === dblQuotes) {
					this.openBquoteDbls--
				}
				cs.right = this.position
				this.rune()
				if (!this.got(Token.bckQuote)) {
					return this.quoteErr(cs.start, Token.bckQuote)
				}
				return cs
			}
			case Token.leftParen:
				return null
			case Token.globQuest:
			case Token.globStar:
			case Token.globPlus:
			case Token.globAt:
			case Token.globExcl: {
				const eg = new ExtGlob({ op: this.token, opPos: this.position })
				let lparens = 1
				let r = this.char
				globLoop: for (this.newLit(r); ; r = this.rune()) {
					switch (r) {
						case endOfInput:
							break globLoop
						case '(':
							lparens++
							break
						case ')':
							lparens--
							if (lparens === 0) {
								break globLoop
							}
							break
					}
				}
				eg.pattern = this.lit(eg.opPos + 2, this.endLit())
				this.rune()
				this.next()
				if (lparens !== 0) {
					return this.matchingErr(eg.opPos, eg.op, Token.rightParen)
				}
				return eg
			}
			default:
				return null
		}
	}
	private cmdSubst(): CmdSubst {
		const cs = new CmdSubst({ left: this.position })
		const old = this.preNested(subCmd)
		this.next()
		cs.stmts = this.statementList()
		this.postNested(old)
		cs.right = this.matched(cs.left, Token.dollParen, Token.rightParen)
		return cs
	}
	private paramExp(): ParamExp | null {
		const old = this.context
		this.context = runeByRune
		let pe: ParamExp | null = new ParamExp({
			dollar: this.position,
			short: this.token === Token.dollar,
		})
		if (!pe.short && this.char === '(') {
			return this.posErr(
				pe.start,
				'parameter expansion flags are unavailable in bash',
			)
		}
		if (!pe.short) {
			switch (this.char) {
				case '#':
					if (this.paramNameStart(pe)) {
						pe.length = true
					}
					break
				case '%':
					if (!pe.short && this.paramNameStart(pe)) {
						return this.posErr(pe.start, '`${%%foo}` is unavailable in bash')
					}
					break
				case '!':
					if (!pe.short && this.paramNameStart(pe)) {
						pe.excl = true
					}
					break
				case '+':
					if (this.paramNameStart(pe)) {
						return this.posErr(pe.start, '`${+foo}` is unavailable in bash')
					}
					break
			}
		}
		pe = this.paramExpParameter(pe)
		if (pe === null) {
			this.context = old
			return null
		}
		if (pe.short) {
			this.context = old
			this.next()
			return pe
		}
		if (this.char === '[') {
			if (pe.param !== null && !validName(pe.param.value)) {
				return this.posErr(
					this.nextPos(),
					'cannot index a special parameter name',
				)
			}
			this.position = this.nextPos()
			this.rune()
			pe.index = this.eitherIndex()
			while (this.char === '[') {
				return this.posErr(
					this.nextPos(),
					'multiple subscripts are unavailable in bash',
				)
			}
		}
		const tokRune = this.char
		this.position = this.nextPos()
		this.token = this.paramToken(this.char)
		if (this.token === Token.rightBrace) {
			pe.rbrace = this.position
			this.context = old
			this.next()
			return pe
		}
		if (this.token !== Token.EOF && pe.length) {
			return this.curErr(
				'cannot combine multiple parameter expansion operators',
			)
		}
		switch (this.token) {
			case Token.slash:
			case Token.dblSlash:
				pe.repl = new Replace()
				this.context = paramExpRepl
				this.next()
				pe.repl.orig = this.getWord()
				this.context = paramExpExp
				if (this.got(Token.slash)) {
					pe.repl.with = this.getWord()
				}
				break
			case Token.colon: {
				pe.slice = new Slice()
				let colonPos = this.position
				this.context = paramExpSlice
				this.next()
				if (this.token !== Token.colon) {
					pe.slice.offset = this.followArithm(Token.colon, colonPos)
				}
				colonPos = this.position
				if (this.got(Token.colon)) {
					pe.slice.length = this.followArithm(Token.colon, colonPos)
				}
				this.context = old
				pe.rbrace = this.position
				this.matchedArithm(pe.dollar, Token.dollBrace, Token.rightBrace)
				return pe
			}
			case Token.caret:
			case Token.dblCaret:
			case Token.comma:
			case Token.dblComma:
				pe.exp = this.paramExpExp()
				break
			case Token.at:
			case Token.star:
				switch (true) {
					case this.token === Token.star && !pe.excl:
						return this.curErr(
							'not a valid parameter expansion operator: %#q',
							this.token,
						)
					case pe.excl && this.char === '}':
						pe.names = this.token
						this.next()
						break
					case this.token === Token.at:
					default:
						pe.exp = this.paramExpExp()
						break
				}
				break
			case Token.plus:
			case Token.colPlus:
			case Token.minus:
			case Token.colMinus:
			case Token.quest:
			case Token.colQuest:
			case Token.assgn:
			case Token.colAssgn:
			case Token.perc:
			case Token.dblPerc:
			case Token.hash:
			case Token.dblHash:
			case Token.colHash:
			case Token.colPipe:
			case Token.colStar:
				pe.exp = this.paramExpExp()
				break
			case Token.EOF:
				break
			default:
				if (paramNameRune(tokRune)) {
					if (pe.param !== null) {
						return this.curErr(
							'%#q cannot be followed by a word',
							pe.param.value,
						)
					} else {
						return this.curErr(
							'nested parameter expansion cannot be followed by a word',
						)
					}
				} else {
					return this.curErr(
						'not a valid parameter expansion operator: %#q',
						tokRune,
					)
				}
		}
		if (this.token !== Token.EOF && this.token !== Token.rightBrace) {
			this.token = this.paramToken(this.char)
		}
		this.context = old
		pe.rbrace = this.matched(pe.dollar, Token.dollBrace, Token.rightBrace)
		return pe
	}
	private paramNameStart(pe: ParamExp): boolean {
		const r = this.peek()
		if (
			paramNameStartRune(r) ||
			(!pe.short && (r === '"' || r === endOfInput))
		) {
			this.rune()
			return true
		}
		return false
	}
	private paramExpParameter(pe: ParamExp): ParamExp | null {
		if (
			!pe.short &&
			(this.char === '"' ||
				(this.char === '$' && ['{', '('].includes(this.peek())))
		)
			return this.posErr(this.position, 'invalid nested parameter expansion')
		switch (this.char) {
			case '?':
			case '-':
				if (pe.length && this.peek() !== '}') {
					pe.length = false
					const pos = this.nextPos()
					pe.param = this.lit(pos - 1, '#')
					pe.param.valueEnd = pos
					break
				}
			// fall through
			case '@':
			case '*':
			case '#':
			case '!':
			case '$': {
				const [r, pos] = [this.char, this.nextPos()]
				this.rune()
				pe.param = this.lit(pos, r)
				break
			}
			default: {
				const pos = this.nextPos()
				if (pe.short && singleRuneParam(this.char)) {
					this.value = this.char
					this.rune()
				} else {
					for (this.newLit(this.char); this.char !== endOfInput; this.rune()) {
						if (!paramNameRune(this.char) && this.char !== escapedNewline) {
							break
						}
					}
					this.value = this.endLit()
					if (!numberLiteral(this.value) && !validName(this.value)) {
						if (pe.short) {
							return null
						}
						return this.posErr(pos, 'invalid parameter name')
					}
				}
				pe.param = this.lit(pos, this.value)
				break
			}
		}
		return pe
	}
	private paramExpExp(): Expansion {
		const op = this.token
		switch (op) {
			case Token.colHash:
			case Token.colPipe:
			case Token.colStar:
				return this.posErr(
					this.position,
					'${name%sarg} is unavailable in bash',
					op,
				)
		}
		this.context = paramExpExp
		this.next()
		if (op === Token.at) {
			if (!isLiteralToken(this.token)) {
				return this.curErr('@ expansion operator requires a literal')
			}
			switch (this.value) {
				case 'a':
				case 'k':
				case 'u':
				case 'A':
				case 'E':
				case 'K':
				case 'L':
				case 'P':
				case 'U':
					break
				case '#':
					return this.posErr(
						this.position,
						'this expansion operator is unavailable in bash',
					)
				case 'Q':
					break
				default:
					return this.curErr('invalid @ expansion operator %#q', this.value)
			}
		}
		return new Expansion({ op, word: this.getWord() })
	}
	private eitherIndex(): SyntaxNode | null {
		const lpos = this.position
		const old = this.context
		this.context = paramExpArithm
		this.next()
		if (this.token === Token.star || this.token === Token.at) {
			;[this.token, this.value] = [Token.LitWord, tokenText(this.token)]
		}
		const expr = this.followArithm(Token.leftBrack, lpos)
		this.context = old
		this.matchedArithm(lpos, Token.leftBrack, Token.rightBrack)
		return expr
	}
	private stopToken(): boolean {
		switch (this.token) {
			case Token.EOF:
			case Token.Newl:
			case Token.semicolon:
			case Token.and:
			case Token.or:
			case Token.andAnd:
			case Token.orOr:
			case Token.orAnd:
			case Token.andPipe:
			case Token.andBang:
			case Token.dblSemicolon:
			case Token.semiAnd:
			case Token.dblSemiAnd:
			case Token.semiOr:
			case Token.rightParen:
				return true
			case Token.bckQuote:
				return this.backquoteEnd()
			case Token.LitWord:
				return false
		}
		return false
	}
	private backquoteEnd(): boolean {
		return this.lastBquoteEsc < this.openBquotes
	}
	private hasValidIdent(): boolean {
		if (!isLiteralToken(this.token)) {
			return false
		}
		let end = this.equalsIndex
		if (end > 0) {
			if (this.value[end - 1]! === '+') {
				end--
			}
			if (validName(this.value.slice(0, end))) {
				return true
			}
		} else if (!validName(this.value)) {
			return false
		}
		return this.char === '['
	}
	private assign(needEqual: boolean): Assign {
		const assignment = new Assign()
		if (this.equalsIndex > 0) {
			let nameEnd = this.equalsIndex
			if (this.value[this.equalsIndex - 1]! === '+') {
				assignment.append = true
				nameEnd--
			}
			assignment.name = this.lit(this.position, this.value.slice(0, nameEnd))
			assignment.name.valueEnd = assignment.name.valuePos + nameEnd
			const left = this.lit(
				this.position + 1,
				this.value.slice(this.equalsIndex + 1),
			)
			if (left.value !== '') {
				left.valuePos = left.valuePos + this.equalsIndex
				assignment.value = this.wordOne(left)
			}
			this.next()
		} else {
			assignment.name = this.lit(this.position, this.value)
			this.rune()
			this.position = this.position + 1
			assignment.index = this.eitherIndex()
			if (this.spaced || this.stopToken()) {
				if (needEqual) {
					return this.followErr(assignment.start, 'a[b]', Token.assgn)
				} else {
					assignment.naked = true
					return assignment
				}
			}
			if (this.token === Token.assgnParen) {
				return this.curErr('arrays cannot be nested')
			} else {
				if (this.value.length > 0 && this.value[0]! === '+') {
					assignment.append = true
					this.value = this.value.slice(1)
					this.position = this.position + 1
				}
				if (this.value.length < 1 || this.value[0]! !== '=') {
					return this.followErr(
						assignment.start,
						assignment.append ? 'a[b]+' : 'a[b]',
						Token.assgn,
					)
				}
				this.position = this.position + 1
				this.value = this.value.slice(1)
				if (this.value === '') {
					this.next()
				}
			}
		}
		if (this.spaced || this.stopToken()) {
			return assignment
		}
		if (assignment.value === null && this.token === Token.leftParen) {
			assignment.array = new ArrayExpr({ lparen: this.position })
			const old = this.preNested(arrayElems)
			this.next()
			this.got(Token.Newl)
			while (this.token !== Token.EOF && this.token !== Token.rightParen) {
				const ae = new ArrayElem()
				if (this.token === Token.leftBrack) {
					const left = this.position
					ae.index = this.eitherIndex()
					if (this.token === Token.assgnParen) {
						return this.curErr('arrays cannot be nested')
					}
					this.follow(left, '[x]', Token.assgn)
				}
				ae.value = this.getWord()
				if (ae.value === null) {
					switch (this.token) {
						case Token.Newl:
						case Token.rightParen:
						case Token.leftBrack:
							break
						default:
							return this.curErr('array element values must be words')
					}
				}
				assignment.array.elems.push(ae)
				this.got(Token.Newl)
			}
			this.postNested(old)
			assignment.array.rparen = this.matched(
				assignment.array.lparen,
				Token.leftParen,
				Token.rightParen,
			)
		} else {
			const w = this.getWord()
			if (w !== null) {
				if (assignment.value === null) {
					assignment.value = w
				} else {
					assignment.value.parts.push(...w.parts)
				}
			}
		}
		return assignment
	}
	private peekRedir(): boolean {
		switch (this.token) {
			case Token.LitRedir:
			case Token.rdrOut:
			case Token.appOut:
			case Token.rdrIn:
			case Token.rdrInOut:
			case Token.dplIn:
			case Token.dplOut:
			case Token.rdrClob:
			case Token.appClob:
			case Token.hdoc:
			case Token.dashHdoc:
			case Token.wordHdoc:
			case Token.rdrAll:
			case Token.rdrAllClob:
			case Token.appAll:
			case Token.appAllClob:
				return true
		}
		return false
	}
	private doRedirect(s: Stmt): void {
		const r = new Redirect()
		s.redirs.push(r)
		r.n = this.getLit()
		;[r.op, r.opPos] = [this.token, this.position]
		switch (r.op) {
			case Token.rdrAll:
			case Token.appAll:
				break
			case Token.appClob:
			case Token.rdrAllClob:
			case Token.appAllClob:
				return this.posErr(
					this.position,
					'%#q redirects are unavailable in bash',
					r.op,
				)
		}
		this.next()
		switch (r.op) {
			case Token.hdoc:
			case Token.dashHdoc: {
				const old = this.context
				;[this.context, this.forbidNested] = [hdocWord, true]
				r.word = this.followWordTok(r.op, r.opPos)
				if (r.word !== null) {
					this.heredocs.push(r)
				}
				;[this.context, this.forbidNested] = [old, false]
				if (this.token === Token.Newl) {
					this.doHeredocs()
				}
				break
			}
			case Token.wordHdoc:
			default:
				r.word = this.followWordTok(r.op, r.opPos)
				break
		}
	}
	private parseStatement(readEnd: boolean, binCmd: boolean): Stmt | null {
		const depth = this.openNodes
		try {
			this.enterNode()
			const [pos, ok] = this.consumeKeyword('!')
			let s: Stmt | null = new Stmt({ position: pos })
			if (ok) {
				s.negated = true
				if (this.stopToken()) {
					return this.posErr(
						s.start,
						'%#q cannot form a statement alone',
						Token.exclMark,
					)
				}
				const [, ok] = this.consumeKeyword('!')
				if (ok) {
					return this.posErr(s.start, 'cannot negate a command multiple times')
				}
			}
			s = this.parsePipeline(s, false)
			if (s === null) {
				return null
			}
			while (this.token === Token.andAnd || this.token === Token.orOr) {
				if (binCmd) {
					return s
				}
				this.enterNode()
				const b = new BinaryCmd({ opPos: this.position, op: this.token, x: s })
				this.next()
				this.got(Token.Newl)
				b.y = this.parseStatement(false, true)
				if (b.y === null) {
					return this.followErr(b.opPos, b.op, 'a statement')
				}
				s = new Stmt({ position: s.position })
				s.cmd = b
			}
			if (readEnd) {
				switch (this.token) {
					case Token.semicolon:
						s.semicolon = this.position
						this.next()
						break
					case Token.and:
						s.semicolon = this.position
						this.next()
						s.background = true
						break
					case Token.orAnd:
						s.semicolon = this.position
						this.next()
						s.coprocess = true
						break
					case Token.andPipe:
					case Token.andBang:
						s.semicolon = this.position
						this.next()
						s.disown = true
						break
				}
			}
			return s
		} finally {
			this.openNodes = depth
		}
	}
	private parsePipeline(s: Stmt, binCmd: boolean): Stmt | null {
		const depth = this.openNodes
		try {
			while (this.peekRedir()) {
				this.doRedirect(s)
			}
			const redirsStart = s.redirs.length
			switch (this.token) {
				case Token.LitWord: {
					if (this.gotBlock(s)) {
						break
					}
					switch (this.value) {
						case 'if':
							this.ifClause(s)
							break
						case 'while':
						case 'until':
							this.whileClause(s, this.value === 'until')
							break
						case 'for':
							this.forClause(s)
							break

						case 'case':
							this.caseClause(s)
							break
						case '}':
						case 'then':
						case 'elif':
						case 'else':
						case 'fi':
						case 'do':
						case 'done':
						case 'esac':
						case '!':
							if (redirsStart > 0) {
								break
							}
							switch (this.value) {
								case '}':
									return this.curErr(
										'%#q can only be used to close a block',
										Token.rightBrace,
									)
								case 'then':
								case 'elif':
								case 'else':
									return this.curErr(
										'%#q can only be used in an `if`',
										this.value,
									)
								case 'fi':
									return this.curErr(
										'%#q can only be used to end an `if`',
										this.value,
									)
								case 'do':
									return this.curErr(
										'%#q can only be used in a loop',
										this.value,
									)
								case 'done':
									return this.curErr(
										'%#q can only be used to end a loop',
										this.value,
									)
								case 'esac':
									return this.curErr(
										'%#q can only be used to end a `case`',
										this.value,
									)
								case '!':
									if (!s.negated) {
										return this.curErr(
											'%#q can only be used in full statements',
											Token.exclMark,
										)
									}
									break
							}
							break
						case '[[':
						case ']]':
							if (this.value === '[[') {
								this.testClause(s)
							} else {
								return this.curErr(
									'%#q can only be used to close a test',
									Token.dblRightBrack,
								)
							}
							break
						case 'let':
							this.letClause(s)
							break
						case 'function':
							this.bashFuncDecl(s)
							break
						case 'declare':
						case 'local':
						case 'export':
						case 'readonly':
						case 'typeset':
						case 'nameref':
							if (this.isDeclKeyword()) {
								this.declClause(s, [])
							}
							break
						case 'time':
							this.timeClause(s)
							break
						case 'coproc':
							this.coprocClause(s)
							break
						case 'select':
							this.selectClause(s)
							break
					}
					if (s.cmd !== null) {
						break
					}
					if (this.hasValidIdent()) {
						this.callExpr(s, null, true)
						break
					}
					const name = this.lit(this.position, this.value)
					this.next()
					if (this.token === Token.leftParen) {
						this.next()
						this.follow(name.valuePos, 'foo(', Token.rightParen)
						this.funcDecl(s, name.valuePos, name)
					} else {
						const w = this.wordOne(name)
						this.callExpr(s, w, false)
					}
					break
				}
				case Token.bckQuote:
					if (this.backquoteEnd()) {
						break
					}
				// fall through
				case Token.Lit:
				case Token.dollBrace:
				case Token.dollDblParen:
				case Token.dollParen:
				case Token.dollar:
				case Token.cmdIn:
				case Token.assgnParen:
				case Token.cmdOut:
				case Token.sglQuote:
				case Token.dollSglQuote:
				case Token.dblQuote:
				case Token.dollDblQuote:
				case Token.dollBrack:
				case Token.globQuest:
				case Token.globStar:
				case Token.globPlus:
				case Token.globAt:
				case Token.globExcl: {
					if (this.gotBlock(s)) {
						break
					}
					if (this.hasValidIdent()) {
						this.callExpr(s, null, true)
						break
					}
					const w = this.wordAnyNumber()
					if (this.got(Token.leftParen)) {
						return this.posErr(w.start, 'invalid func name')
					}
					this.callExpr(s, w, false)
					break
				}
				case Token.leftParen:
					if (this.char === ')') {
						this.rune()
						const fpos = this.position
						this.next()
						if (this.token === Token.LitWord && this.value === '{') {
							return this.posErr(
								fpos,
								'anonymous functions are unavailable in bash',
							)
						}
						this.funcDecl(s, fpos)
						break
					}
					this.subshell(s)
					break
				case Token.dblLeftParen:
					this.arithmExpCmd(s)
					break
			}
			if (s.cmd === null && s.redirs.length === 0) {
				return null
			}
			if (redirsStart > 0 && s.cmd !== null) {
				const ok = s.cmd instanceof CallExpr
				if (!ok) {
					return this.posErr(
						s.start,
						'redirects before compound commands are unavailable in bash',
					)
				}
			}
			while (this.peekRedir()) {
				this.doRedirect(s)
			}
			while (this.token === Token.or || this.token === Token.orAnd) {
				if (binCmd) {
					return s
				}
				this.enterNode()
				const b = new BinaryCmd({ opPos: this.position, op: this.token, x: s })
				this.next()
				this.got(Token.Newl)
				b.y = this.parsePipeline(new Stmt({ position: this.position }), true)
				if (b.y === null) {
					return this.followErr(b.opPos, b.op, 'a statement')
				}
				s = new Stmt({ position: s.position })
				s.cmd = b
				s.negated = b.x!.negated
				b.x!.negated = false
			}
			return s
		} finally {
			this.openNodes = depth
		}
	}
	private subshell(s: Stmt): void {
		const sub = new Subshell({ lparen: this.position })
		const old = this.preNested(subCmd)
		this.next()
		sub.stmts = this.followStmts('(', sub.lparen)
		this.postNested(old)
		sub.rparen = this.matched(sub.lparen, Token.leftParen, Token.rightParen)
		s.cmd = sub
	}
	private arithmExpCmd(s: Stmt): void {
		const ar = new ArithmCmd({ left: this.position })
		const old = this.preNested(arithmExprCmd)
		this.next()
		if (this.got(Token.hash)) {
			return this.posErr(
				ar.start,
				'unsigned expressions are unavailable in bash',
			)
		}
		ar.x = this.followArithm(Token.dblLeftParen, ar.left)
		ar.right = this.arithmEnd(Token.dblLeftParen, ar.left, old)
		s.cmd = ar
	}
	private gotBlock(s: Stmt): boolean {
		const b = this.openBlock()
		if (b === null) {
			return false
		}
		if (this.token !== Token.LitWord || this.value !== 'always') {
			s.cmd = b
			return true
		}
		return this.posErr(this.position, '`always` blocks are unavailable in bash')
	}
	private blockBody(lbrace: number): Block {
		const b = new Block({ lbrace })
		b.stmts = this.followStmts('{', b.lbrace, '}')
		const [pos, ok] = this.consumeKeyword('}')
		if (ok) {
			b.rbrace = pos
		} else {
			return this.matchingErr(b.lbrace, Token.leftBrace, Token.rightBrace)
		}
		return b
	}
	private ifClause(s: Stmt): void {
		const depth = this.openNodes
		try {
			const rootIf = new IfClause({ position: this.position })
			this.next()
			rootIf.cond = this.followStmts('if', rootIf.position, 'then')
			rootIf.thenPos = this.followRsrv(rootIf.position, 'if <cond>', 'then')
			rootIf.then = this.followStmts(
				'then',
				rootIf.thenPos,
				'fi',
				'elif',
				'else',
			)
			let curIf = rootIf
			while (this.token === Token.LitWord && this.value === 'elif') {
				this.enterNode()
				const elf = new IfClause({ position: this.position })
				this.next()
				elf.cond = this.followStmts('elif', elf.position, 'then')
				elf.thenPos = this.followRsrv(elf.position, 'elif <cond>', 'then')
				elf.then = this.followStmts('then', elf.thenPos, 'fi', 'elif', 'else')
				curIf.else = elf
				curIf = elf
			}
			const [elsePos, ok] = this.consumeKeyword('else')
			if (ok) {
				const els = new IfClause({ position: elsePos })
				els.then = this.followStmts('else', els.position, 'fi')
				curIf.else = els
				curIf = els
			}
			rootIf.fiPos = this.stmtEnd(rootIf, 'if', 'fi')
			for (let els = rootIf.else; els !== null; els = els.else) {
				els.fiPos = rootIf.fiPos
			}
			s.cmd = rootIf
		} finally {
			this.openNodes = depth
		}
	}
	private whileClause(s: Stmt, until: boolean): void {
		const wc = new WhileClause({ whilePos: this.position, until })
		let rsrv = 'while'
		let rsrvCond = 'while <cond>'
		if (wc.until) {
			rsrv = 'until'
			rsrvCond = 'until <cond>'
		}
		this.next()
		wc.cond = this.followStmts(rsrv, wc.whilePos, 'do')
		wc.doPos = this.followRsrv(wc.whilePos, rsrvCond, 'do')
		wc.do = this.followStmts('do', wc.doPos, 'done')
		wc.donePos = this.stmtEnd(wc, rsrv, 'done')
		s.cmd = wc
	}
	private forClause(s: Stmt): void {
		const fc = new ForClause({ forPos: this.position })
		this.next()
		fc.loop = this.loop(fc.forPos)
		let [start, end] = ['do', 'done']
		const [pos, ok] = this.consumeKeyword('{')
		if (ok) {
			fc.doPos = pos
			fc.braces = true
			;[start, end] = ['{', '}']
		} else {
			fc.doPos = this.followRsrv(fc.forPos, 'for foo [in words]', start)
		}
		fc.do = this.followStmts(start, fc.doPos, end)
		fc.donePos = this.stmtEnd(fc, 'for', end)
		s.cmd = fc
	}
	private loop(fpos: number): SyntaxNode | null {
		switch (this.token) {
			case Token.leftParen:
			case Token.dblLeftParen:
				break
		}
		if (this.token === Token.dblLeftParen) {
			const cl = new CStyleLoop({ lparen: this.position })
			const old = this.preNested(arithmExprCmd)
			this.next()
			cl.init = this.arithmExpr(false)
			if (!this.got(Token.dblSemicolon)) {
				this.follow(this.position, 'expr', Token.semicolon)
				cl.cond = this.arithmExpr(false)
				this.follow(this.position, 'expr', Token.semicolon)
			}
			cl.post = this.arithmExpr(false)
			cl.rparen = this.arithmEnd(Token.dblLeftParen, cl.lparen, old)
			this.got(Token.semicolon)
			this.got(Token.Newl)
			return cl
		}
		return this.wordIter('for', fpos)
	}
	private wordIter(ftok: string, fpos: number): WordIter {
		const wi = new WordIter()
		wi.name = this.getLit()
		if (wi.name === null) {
			return this.followErr(fpos, ftok, 'a literal')
		}
		if (
			ftok === 'for' &&
			this.token === Token.LitWord &&
			validName(this.value) &&
			!isKeyword(this.value)
		) {
			return this.posErr(fpos, 'multi-name for loops require zsh')
		}
		if (this.got(Token.semicolon)) {
			this.got(Token.Newl)
			return wi
		}
		this.got(Token.Newl)
		const [pos, ok] = this.consumeKeyword('in')
		if (ok) {
			wi.inPos = pos
			while (!this.stopToken()) {
				const w = this.getWord()
				if (w === null) {
					return this.curErr('word list can only contain words')
				} else {
					wi.items.push(w)
				}
			}
			this.got(Token.semicolon)
			this.got(Token.Newl)
		} else if (this.token !== Token.LitWord || this.value !== 'do') {
			return this.followErr(
				fpos,
				ftok + ' foo',
				'`in`, `do`, `;`, or a newline',
			)
		}
		return wi
	}
	private selectClause(s: Stmt): void {
		const fc = new ForClause({ forPos: this.position })
		this.next()
		fc.loop = this.wordIter('select', fc.forPos)
		fc.doPos = this.followRsrv(fc.forPos, 'select foo [in words]', 'do')
		fc.do = this.followStmts('do', fc.doPos, 'done')
		fc.donePos = this.stmtEnd(fc, 'select', 'done')
		s.cmd = fc
	}
	private caseClause(s: Stmt): void {
		const cc = new CaseClause({ case: this.position })
		this.next()
		cc.word = this.getWord()
		if (cc.word === null) {
			return this.followErr(cc.case, 'case', 'a word')
		}
		const end = 'esac'
		this.got(Token.Newl)
		const [pos, ok] = this.consumeKeyword('{')
		if (ok) {
			cc.in = pos
			cc.braces = true
			return this.posErr(cc.start, '`case i {` is unavailable in bash')
		} else {
			cc.in = this.followRsrv(cc.case, 'case x', 'in')
		}
		cc.items = this.caseItems(end)
		cc.esac = this.stmtEnd(cc, 'case', end)
		s.cmd = cc
	}
	private caseItems(stop: string): Array<CaseItem> {
		const items: Array<CaseItem> = []
		this.got(Token.Newl)
		while (
			this.token !== Token.EOF &&
			(this.token !== Token.LitWord || this.value !== stop)
		) {
			const ci = new CaseItem()
			this.got(Token.leftParen)
			while (this.token !== Token.EOF) {
				const w = this.getWord()
				if (w === null) {
					return this.curErr('case patterns must consist of words')
				} else {
					ci.patterns.push(w)
				}
				if (this.token === Token.rightParen) {
					break
				}
				if (!this.got(Token.or)) {
					return this.curErr(
						'case patterns must be separated with %#q',
						Token.or,
					)
				}
			}
			const patternEnd = this.position
			const old = this.preNested(switchCase)
			this.next()
			ci.stmts = this.statementList(stop)
			if (this.lastCommentEnd > patternEnd)
				ci.trailingCommentEnd = this.lastCommentEnd
			this.postNested(old)
			switch (this.token) {
				case Token.dblSemicolon:
				case Token.semiAnd:
				case Token.dblSemiAnd:
				case Token.semiOr:
					break
				default:
					ci.op = Token.dblSemicolon
					items.push(ci)
					return items
			}
			ci.opPos = this.position
			ci.op = this.token
			this.next()
			this.got(Token.Newl)
			items.push(ci)
		}
		return items
	}
	private testClause(s: Stmt): void {
		const tc = new TestClause({ left: this.position })
		const old = this.preNested(testExpr)
		this.next()
		tc.x = this.testExprBinary(false)
		if (tc.x === null) {
			return this.followErrExp(tc.left, Token.dblLeftBrack)
		}
		tc.right = this.position
		const [, ok] = this.consumeKeyword(']]')
		if (!ok) {
			return this.matchingErr(tc.left, Token.dblLeftBrack, Token.dblRightBrack)
		}
		this.postNested(old)
		s.cmd = tc
	}
	private testExprBinary(pastAndOr: boolean): SyntaxNode | null {
		const depth = this.openNodes
		try {
			this.got(Token.Newl)
			if (!pastAndOr) {
				this.enterNode()
			}
			let left: SyntaxNode | null = null
			if (pastAndOr) {
				left = this.testExprUnary()
			} else {
				left = this.testExprBinary(true)
			}
			if (left === null) {
				return left
			}
			this.got(Token.Newl)
			switch (this.token) {
				case Token.andAnd:
				case Token.orOr:
					break
				case Token.LitWord:
					if (this.value === ']]') {
						return left
					}
					this.token = testBinaryOp(this.value)
					if (this.token === Token.illegalTok) {
						return this.curErr('not a valid test operator: %#q', this.value)
					}
					break
				case Token.rdrIn:
				case Token.rdrOut:
					break
				case Token.EOF:
				case Token.rightParen:
					return left
				case Token.Lit:
					return this.curErr(
						'test operator words must consist of a single literal',
					)
				default:
					return this.curErr('not a valid test operator: %#q', this.token)
			}
			const b = new BinaryTest({
				opPos: this.position,
				op: this.token,
				x: left,
			})
			switch (b.op) {
				case Token.andAnd:
				case Token.orOr:
					this.next()
					b.y = this.testExprBinary(false)
					if (b.y === null) {
						return this.followErrExp(b.opPos, b.op)
					}
					break
				case Token.tsReMatch:
					this.regexParens = 0
					this.regexStart = true
					this.context = testExprRegexp
				// fall through
				default: {
					const ok = b.x instanceof Word
					if (!ok) {
						return this.posErr(
							b.opPos,
							'expected %#q, %#q or %#q after complex expr',
							Token.andAnd,
							Token.orOr,
							Token.dblRightBrack,
						)
					}
					this.next()
					b.y = this.followWordTok(b.op, b.opPos)
					break
				}
			}
			return b
		} finally {
			this.openNodes = depth
		}
	}
	private testExprUnary(): SyntaxNode | null {
		switch (this.token) {
			case Token.EOF:
			case Token.rightParen:
				return null
			case Token.LitWord: {
				const op = testUnaryOp(this.value)
				switch (op) {
					case Token.illegalTok:
						break
					case Token.tsRefVar:
					case Token.tsModif:
						this.token = op
						break
					default:
						this.token = op
						break
				}
				break
			}
		}
		switch (this.token) {
			case Token.exclMark: {
				const u = new UnaryTest({ opPos: this.position, op: Token.exclMark })
				this.next()
				u.x = this.testExprBinary(false)
				if (u.x === null) {
					return this.followErrExp(u.opPos, u.op)
				}
				return u
			}
			case Token.tsExists:
			case Token.tsRegFile:
			case Token.tsDirect:
			case Token.tsCharSp:
			case Token.tsBlckSp:
			case Token.tsNmPipe:
			case Token.tsSocket:
			case Token.tsSmbLink:
			case Token.tsSticky:
			case Token.tsGIDSet:
			case Token.tsUIDSet:
			case Token.tsGrpOwn:
			case Token.tsUsrOwn:
			case Token.tsModif:
			case Token.tsRead:
			case Token.tsWrite:
			case Token.tsExec:
			case Token.tsNoEmpty:
			case Token.tsFdTerm:
			case Token.tsEmpStr:
			case Token.tsNempStr:
			case Token.tsOptSet:
			case Token.tsVarSet:
			case Token.tsRefVar: {
				const u = new UnaryTest({ opPos: this.position, op: this.token })
				this.next()
				u.x = this.followWordTok(u.op, u.opPos)
				return u
			}
			case Token.leftParen: {
				const pe = new ParenTest({ lparen: this.position })
				this.next()
				pe.x = this.testExprBinary(false)
				if (pe.x === null) {
					return this.followErrExp(pe.lparen, Token.leftParen)
				}
				pe.rparen = this.matched(pe.lparen, Token.leftParen, Token.rightParen)
				return pe
			}
			case Token.LitWord:
				if (this.value === ']]') {
					return null
				}
			// fall through
			default: {
				const w = this.getWord()
				if (w !== null) {
					return w
				}
				return null
			}
		}
	}
	private isDeclKeyword(): boolean {
		switch (this.value) {
			case 'declare':
				return true
			case 'local':
			case 'export':
			case 'readonly':
			case 'typeset':
			case 'nameref':
				return true
		}
		return false
	}
	private declClause(s: Stmt, assigns: Array<Assign>): void {
		const ds = new DeclClause({
			variant: this.lit(this.position, this.value),
			assigns,
		})
		this.next()
		while (!this.stopToken() && !this.peekRedir()) {
			if (this.hasValidIdent()) {
				ds.args.push(this.assign(false))
			} else if (
				isLiteralToken(this.token) &&
				this.equalsIndex > 0 &&
				!this.value.slice(0, this.equalsIndex).includes('{')
			) {
				return this.curErr('invalid var name')
			} else if (this.token === Token.LitWord && validName(this.value)) {
				ds.args.push(new Assign({ naked: true, name: this.getLit() }))
			} else {
				const w = this.getWord()
				if (w !== null) {
					ds.args.push(new Assign({ naked: true, value: w }))
				} else {
					return this.followErr(
						this.position,
						ds.variant!.value,
						'names or assignments',
					)
				}
			}
		}
		s.cmd = ds
	}
	private timeClause(s: Stmt): void {
		const tc = new TimeClause({ time: this.position })
		this.next()
		const [, ok] = this.consumeKeyword('-p')
		if (ok) {
			tc.posixFormat = true
		}
		this.enterNode()
		tc.stmt = this.parsePipeline(new Stmt({ position: this.position }), false)
		this.leaveNode()
		s.cmd = tc
	}
	private coprocClause(s: Stmt): void {
		const depth = this.openNodes
		try {
			const cc = new CoprocClause({ coproc: this.position })
			this.enterNode()
			this.next()
			if (isBashCompoundCommand(this.token, this.value)) {
				cc.stmt = this.parsePipeline(
					new Stmt({ position: this.position }),
					false,
				)
				s.cmd = cc
				return
			}
			cc.name = this.getWord()
			cc.stmt = this.parsePipeline(new Stmt({ position: this.position }), false)
			if (cc.stmt === null) {
				if (cc.name === null) {
					return this.posErr(cc.coproc, 'coproc clause requires a command')
				}
				cc.stmt = new Stmt({ position: cc.name.start })
				cc.stmt.cmd = this.call(cc.name)
				cc.name = null
			} else if (cc.name !== null) {
				const call = cc.stmt.cmd as CallExpr
				const ok = cc.stmt.cmd instanceof CallExpr
				if (ok) {
					call.args.unshift(cc.name)
					cc.name = null
				}
			}
			s.cmd = cc
		} finally {
			this.openNodes = depth
		}
	}
	private letClause(s: Stmt): void {
		const lc = new LetClause({ let: this.position })
		const old = this.preNested(arithmExprLet)
		this.next()
		while (!this.stopToken() && !this.peekRedir()) {
			const x = this.arithmExpr(true)
			if (x === null) {
				break
			}
			lc.exprs.push(x)
		}
		if (lc.exprs.length === 0) {
			return this.followErrExp(lc.let, 'let')
		}
		this.postNested(old)
		s.cmd = lc
	}
	private bashFuncDecl(s: Stmt): void {
		const fpos = this.position
		this.next()
		const names: Array<Lit> = []
		while (this.token === Token.LitWord && this.value !== '{') {
			names.push(this.lit(this.position, this.value))
			this.next()
		}
		const hasParens = this.got(Token.leftParen)
		switch (names.length) {
			case 0:
				if (hasParens || (this.token === Token.LitWord && this.value === '{')) {
					return this.posErr(
						fpos,
						'anonymous functions are unavailable in bash',
					)
				} else {
					return this.followErr(fpos, 'function', 'a name')
				}
			case 1:
				break
			default:
				return this.posErr(fpos, 'multi-name functions are unavailable in bash')
		}
		if (hasParens) {
			this.follow(fpos, 'function foo(', Token.rightParen)
		}
		this.funcDecl(s, fpos, ...names)
	}
	private callExpr(s: Stmt, w: Word | null, assign: boolean): void {
		const ce = this.call(w)

		if (assign) {
			ce.assigns.push(this.assign(true))
		}
		loop: while (true) {
			switch (this.token) {
				case Token.EOF:
				case Token.Newl:
				case Token.semicolon:
				case Token.and:
				case Token.or:
				case Token.andAnd:
				case Token.orOr:
				case Token.orAnd:
				case Token.andPipe:
				case Token.andBang:
				case Token.dblSemicolon:
				case Token.semiAnd:
				case Token.dblSemiAnd:
				case Token.semiOr:
					break loop
				case Token.LitWord: {
					if (ce.args.length === 0 && this.hasValidIdent()) {
						ce.assigns.push(this.assign(true))
						break
					}
					if (ce.args.length === 0 && this.isDeclKeyword()) {
						this.checkInlineAssigns(ce.assigns)
						this.declClause(s, ce.assigns)
						return
					}
					if (this.stopToken()) {
						break loop
					}
					const w = this.wordOne(this.lit(this.position, this.value))
					this.next()
					ce.args.push(w)
					break
				}
				case Token.Lit:
					if (ce.args.length === 0 && this.hasValidIdent()) {
						ce.assigns.push(this.assign(true))
						break
					}
					ce.args.push(this.wordAnyNumber())
					break
				case Token.bckQuote:
					if (this.backquoteEnd()) {
						break loop
					}
				// fall through
				case Token.dollBrace:
				case Token.dollDblParen:
				case Token.dollParen:
				case Token.dollar:
				case Token.cmdIn:
				case Token.assgnParen:
				case Token.cmdOut:
				case Token.sglQuote:
				case Token.dollSglQuote:
				case Token.dblQuote:
				case Token.dollDblQuote:
				case Token.dollBrack:
				case Token.globQuest:
				case Token.globStar:
				case Token.globPlus:
				case Token.globAt:
				case Token.globExcl:
					ce.args.push(this.wordAnyNumber())
					break
				case Token.dblLeftParen:
					return this.curErr(
						'%#q can only be used to open an arithmetic cmd',
						this.token,
					)
				case Token.leftParen:
					return this.curErr('expected a word or redirect')
				case Token.rightParen:
					if (this.context === subCmd) {
						break loop
					}
					return this.curErr('expected a word or redirect')
				default:
					if (this.peekRedir()) {
						this.doRedirect(s)
						continue
					}
					return this.curErr('expected a word or redirect')
			}
		}
		if (ce.args.length) {
			this.checkInlineAssigns(ce.assigns)
		}
		s.cmd = ce
	}
	private checkInlineAssigns(assigns: Array<Assign>): void {
		for (const asgn of assigns) {
			if (asgn.index !== null || asgn.array !== null) {
				return this.posErr(asgn.start, 'inline variables cannot be arrays')
			}
		}
	}
	private funcDecl(s: Stmt, pos: number, ...names: Array<Lit>): void {
		const fd = new FuncDecl({
			position: pos,
		})
		if (names.length === 1) {
			fd.name = names[0]!
		} else {
			fd.names = names
		}
		this.got(Token.Newl)
		fd.body = this.parseStatement(false, false)
		if (fd.body === null) {
			return this.followErr(fd.start, 'foo()', 'a statement')
		}
		s.cmd = fd
	}
	private nextKeepSpaces(): void {
		let r = this.char
		if (this.context !== hdocBody && this.context !== hdocBodyTabs) {
			while (r === escapedNewline) {
				r = this.rune()
			}
		}
		this.position = this.nextPos()
		switch (this.context) {
			case runeByRune:
				this.token = Token.illegalTok
				break
			case dblQuotes:
				switch (r) {
					case '`':
					case '"':
					case '$':
						this.token = this.quotedToken(r)
						break
					default:
						this.advanceLitDquote(r)
						break
				}
				break
			case hdocBody:
			case hdocBodyTabs:
				switch (r) {
					case '`':
					case '$':
						this.token = this.quotedToken(r)
						break
					default:
						this.advanceLitHdoc(r)
						break
				}
				break
			case paramExpRepl:
				if (r === '/') {
					this.rune()
					this.token = Token.slash
					break
				}
			// fall through
			case paramExpExp:
				switch (r) {
					case '}':
						this.token = this.paramToken(r)
						break
					case '`':
					case '"':
					case '$':
					case "'":
						this.token = this.regularToken(r)
						break
					default:
						this.advanceLitOther(r)
						break
				}
				break
		}
	}
	private next(): void {
		if (this.char === endOfInput) {
			this.token = Token.EOF
			return
		}
		this.spaced = false
		if ((this.context & allKeepSpaces) !== 0) {
			this.nextKeepSpaces()
			return
		}
		let r = this.char
		while (r === escapedNewline) {
			r = this.rune()
		}
		skipSpace: while (true) {
			switch (r) {
				case endOfInput:
					this.token = Token.EOF
					return
				case escapedNewline:
					r = this.rune()
					break
				case ' ':
				case '\t':
				case '\r':
					this.spaced = true
					r = this.rune()
					break
				case '\n':
					if (this.token === Token.Newl) {
						r = this.rune()
						continue
					}
					this.spaced = true
					this.token = Token.Newl
					if (
						this.context !== hdocWord &&
						this.heredocs.length > this.outerHeredocs
					) {
						this.doHeredocs()
					}
					return
				default:
					break skipSpace
			}
		}
		this.scanToken(r)
	}
	// Whitespace, operators and word boundaries depend on the enclosing grammar.
	private scanToken(r: string): void {
		this.position = this.nextPos()
		switch (true) {
			case (this.context & allRegTokens) !== 0:
				switch (r) {
					case ';':
					case '"':
					case "'":
					case '(':
					case ')':
					case '$':
					case '|':
					case '&':
					case '>':
					case '<':
					case '`':
						this.token = this.regularToken(r)
						break
					case '#':
						if (
							!this.spaced &&
							(this.context === unquotedWordContinuation ||
								this.context === testExpr)
						) {
							this.advanceLitNone(r)
							return
						}
						r = this.rune()
						this.newLit(r)
						runeLoop: while (true) {
							switch (r) {
								case '\n':
								case endOfInput:
									break runeLoop
								case escapedNewline:
									this.literalBuffer += '\\' + '\n'
									;[this.char, this.width] = ['\n', 1]
									break runeLoop
								case '`':
									if (this.backquoteEnd()) {
										break runeLoop
									}
									break
							}
							r = this.rune()
						}
						this.lastCommentEnd = this.position + 1 + this.endLit().length
						this.next()
						break
					case '[':
						if (
							this.context === arrayElems &&
							(this.spaced ||
								this.token === Token.leftParen ||
								this.token === Token.Newl)
						) {
							this.rune()
							this.token = Token.leftBrack
						} else {
							this.advanceLitNone(r)
						}
						break
					case '=':
						if (this.peek() === '(') {
							this.rune()
							this.rune()
							this.token = Token.assgnParen
						} else if (this.context === arrayElems) {
							this.rune()
							this.token = Token.assgn
						} else {
							this.advanceLitNone(r)
						}
						break
					case '?':
					case '*':
					case '+':
					case '@':
					case '!':
						if (this.extendedGlob()) {
							switch (r) {
								case '?':
									this.token = Token.globQuest
									break
								case '*':
									this.token = Token.globStar
									break
								case '+':
									this.token = Token.globPlus
									break
								case '@':
									this.token = Token.globAt
									break
								case '!':
									this.token = Token.globExcl
									break
							}
							this.rune()
							this.rune()
						} else {
							this.advanceLitNone(r)
						}
						break
					default:
						this.advanceLitNone(r)
						break
				}
				break
			case this.context === paramExpArithm && r === '#':
				this.advanceLitOther(r)
				break
			case (this.context & allArithmExpr) !== 0 && arithmOps(r):
				this.token = this.arithmToken(r)
				break
			case (this.context & allParamExp) !== 0 && paramOps(r):
				this.token = this.paramToken(r)
				break
			case this.context === testExprRegexp:
				if (!this.regexStart && this.spaced) {
					this.context = testExpr
					this.scanToken(r)
					return
				}
				this.regexStart = false
				switch (r) {
					case ';':
					case '"':
					case "'":
					case '$':
					case '&':
					case '>':
					case '<':
					case '`':
						this.token = this.regularToken(r)
						break
					case ')':
						if (this.regexParens > 0) {
							this.advanceLitRe(r)
						} else {
							this.token = Token.rightParen
							this.context = testExpr
							this.rune()
						}
						break
					default:
						this.advanceLitRe(r)
						break
				}
				break
			case regOps(r):
				this.token = this.regularToken(r)
				break
			default:
				this.advanceLitOther(r)
				break
		}
	}
	private extendedGlob(): boolean {
		if (this.value === 'function') {
			return false
		}
		if (this.peek() === '(') {
			const [, p2] = this.peekTwo()
			return p2 !== ')'
		}
		return false
	}
	private regularToken(r: string): number {
		switch (r) {
			case "'":
				this.rune()
				return Token.sglQuote
			case '"':
				this.rune()
				return Token.dblQuote
			case '`':
				return Token.bckQuote
			case '&':
				switch (this.rune()) {
					case '&':
						this.rune()
						return Token.andAnd
					case '>':
						switch (this.rune()) {
							case '|':
								this.rune()
								return Token.rdrAllClob
							case '!':
								break
							case '>':
								switch (this.rune()) {
									case '|':
										this.rune()
										return Token.appAllClob
									case '!':
										break
								}
								return Token.appAll
						}
						return Token.rdrAll
					case '|':
						break
					case '!':
						break
				}
				return Token.and
			case '|':
				switch (this.rune()) {
					case '|':
						this.rune()
						return Token.orOr
					case '&':
						this.rune()
						return Token.orAnd
				}
				return Token.or
			case '$':
				switch (this.rune()) {
					case "'":
						this.rune()
						return Token.dollSglQuote
					case '"':
						this.rune()
						return Token.dollDblQuote
					case '{':
						this.rune()
						return Token.dollBrace
					case '[':
						this.rune()
						return Token.dollBrack
					case '(':
						if (this.rune() === '(') {
							this.rune()
							return Token.dollDblParen
						}
						return Token.dollParen
				}
				return Token.dollar
			case '(':
				if (this.rune() === '(' && this.context !== testExpr) {
					this.rune()
					return Token.dblLeftParen
				}
				return Token.leftParen
			case ')':
				this.rune()
				return Token.rightParen
			case ';':
				switch (this.rune()) {
					case ';':
						if (this.rune() === '&') {
							this.rune()
							return Token.dblSemiAnd
						}
						return Token.dblSemicolon
					case '&':
						this.rune()
						return Token.semiAnd
					case '|':
						break
				}
				return Token.semicolon
			case '<':
				switch (this.rune()) {
					case '<':
						switch (this.rune()) {
							case '-':
								this.rune()
								return Token.dashHdoc
							case '<':
								this.rune()
								return Token.wordHdoc
						}
						return Token.hdoc
					case '>':
						this.rune()
						return Token.rdrInOut
					case '&':
						this.rune()
						return Token.dplIn
					case '(':
						this.rune()
						return Token.cmdIn
				}
				return Token.rdrIn
			case '>':
				switch (this.rune()) {
					case '>':
						switch (this.rune()) {
							case '|':
								this.rune()
								return Token.appClob
							case '!':
								break
							case '&':
								break
						}
						return Token.appOut
					case '&':
						r = this.rune()
						return Token.dplOut
					case '|':
						this.rune()
						return Token.rdrClob
					case '!':
						break
					case '(':
						this.rune()
						return Token.cmdOut
				}
				return Token.rdrOut
		}
		throw new Error('unreachable')
	}
	private quotedToken(r: string): number {
		switch (r) {
			case '"':
				this.rune()
				return Token.dblQuote
			case '`':
				return Token.bckQuote
			case '$':
				switch (this.rune()) {
					case '{':
						this.rune()
						return Token.dollBrace
					case '[':
						this.rune()
						return Token.dollBrack
					case '(':
						if (this.rune() === '(') {
							this.rune()
							return Token.dollDblParen
						}
						return Token.dollParen
				}
				return Token.dollar
		}
		throw new Error('unreachable')
	}
	private paramToken(r: string): number {
		switch (r) {
			case '}':
				this.rune()
				return Token.rightBrace
			case ':':
				switch (this.rune()) {
					case '+':
						this.rune()
						return Token.colPlus
					case '-':
						this.rune()
						return Token.colMinus
					case '?':
						this.rune()
						return Token.colQuest
					case '=':
						this.rune()
						return Token.colAssgn
					case '#':
						this.rune()
						return Token.colHash
					case '|':
						this.rune()
						return Token.colPipe
					case '*':
						this.rune()
						return Token.colStar
				}
				return Token.colon
			case '+':
				this.rune()
				return Token.plus
			case '-':
				this.rune()
				return Token.minus
			case '?':
				this.rune()
				return Token.quest
			case '=':
				this.rune()
				return Token.assgn
			case '%':
				if (this.rune() === '%') {
					this.rune()
					return Token.dblPerc
				}
				return Token.perc
			case '#':
				if (this.rune() === '#') {
					this.rune()
					return Token.dblHash
				}
				return Token.hash
			case '!':
				this.rune()
				return Token.exclMark
			case ']':
				this.rune()
				return Token.rightBrack
			case '/':
				if (this.rune() === '/') {
					this.rune()
					return Token.dblSlash
				}
				return Token.slash
			case '^':
				if (this.rune() === '^') {
					this.rune()
					return Token.dblCaret
				}
				return Token.caret
			case ',':
				if (this.rune() === ',') {
					this.rune()
					return Token.dblComma
				}
				return Token.comma
			case '@':
				this.rune()
				return Token.at
			case '*':
				this.rune()
				return Token.star
			case endOfInput:
				return Token.EOF
			default:
				return Token.illegalTok
		}
	}
	private arithmToken(r: string): number {
		switch (r) {
			case '!':
				if (this.rune() === '=') {
					this.rune()
					return Token.nequal
				}
				return Token.exclMark
			case '=':
				if (this.rune() === '=') {
					this.rune()
					return Token.equal
				}
				return Token.assgn
			case '~':
				this.rune()
				return Token.tilde
			case '(':
				this.rune()
				return Token.leftParen
			case ')':
				this.rune()
				return Token.rightParen
			case '&':
				switch (this.rune()) {
					case '&':
						this.rune()
						return Token.andAnd
					case '=':
						this.rune()
						return Token.andAssgn
				}
				return Token.and
			case '|':
				switch (this.rune()) {
					case '|':
						this.rune()
						return Token.orOr
					case '=':
						this.rune()
						return Token.orAssgn
				}
				return Token.or
			case '<':
				switch (this.rune()) {
					case '<':
						if (this.rune() === '=') {
							this.rune()
							return Token.shlAssgn
						}
						return Token.hdoc
					case '=':
						this.rune()
						return Token.lequal
				}
				return Token.rdrIn
			case '>':
				switch (this.rune()) {
					case '>':
						if (this.rune() === '=') {
							this.rune()
							return Token.shrAssgn
						}
						return Token.appOut
					case '=':
						this.rune()
						return Token.gequal
				}
				return Token.rdrOut
			case '+':
				switch (this.rune()) {
					case '+':
						this.rune()
						return Token.addAdd
					case '=':
						this.rune()
						return Token.addAssgn
				}
				return Token.plus
			case '-':
				switch (this.rune()) {
					case '-':
						this.rune()
						return Token.subSub
					case '=':
						this.rune()
						return Token.subAssgn
				}
				return Token.minus
			case '%':
				if (this.rune() === '=') {
					this.rune()
					return Token.remAssgn
				}
				return Token.perc
			case '*':
				switch (this.rune()) {
					case '*':
						this.rune()
						return Token.power
					case '=':
						this.rune()
						return Token.mulAssgn
				}
				return Token.star
			case '/':
				if (this.rune() === '=') {
					this.rune()
					return Token.quoAssgn
				}
				return Token.slash
			case '^':
				switch (this.rune()) {
					case '^':
						this.rune()
						return Token.dblCaret
					case '=':
						this.rune()
						return Token.xorAssgn
				}
				return Token.caret
			case '[':
				this.rune()
				return Token.leftBrack
			case ']':
				this.rune()
				return Token.rightBrack
			case ',':
				this.rune()
				return Token.comma
			case '?':
				this.rune()
				return Token.quest
			case ':':
				this.rune()
				return Token.colon
			case '#':
				this.rune()
				return Token.hash
			case '.':
				this.rune()
				return Token.period
		}
		throw new Error('unreachable')
	}
	private isLitRedir(): boolean {
		const lit = this.literalBuffer.slice(0, this.literalBuffer.length - 1)
		if (lit[0]! === '{' && lit[lit.length - 1]! === '}') {
			let name = lit.slice(1, lit.length - 1)
			if (name.length > 0 && name[name.length - 1]! === ']') {
				const i = name.indexOf('[')
				if (i > 0 && i < name.length - 2) {
					name = name.slice(0, i)
				}
			}
			return validName(name)
		}
		return numberLiteral(lit)
	}
	private advanceLitOther(r: string): void {
		let tok = Token.LitWord
		loop: for (this.newLit(r); r !== endOfInput; r = this.rune()) {
			switch (r) {
				case '\\':
					this.rune()
					break
				case "'":
				case '"':
				case '`':
				case '$':
					tok = Token.Lit
					break loop
				case '}':
					if ((this.context & allParamExp) !== 0) {
						break loop
					}
					break
				case '/':
					if (this.context !== paramExpExp) {
						break loop
					}
					break
				case ':':
				case '=':
				case '%':
				case '^':
				case ',':
				case '?':
				case '!':
				case '~':
				case '*':
					if ((this.context & allArithmExpr) !== 0) {
						break loop
					}
					break
				case '.':
					if ((this.context & allArithmExpr) !== 0) {
						break loop
					}
					break
				case '[':
				case ']':
					if ((this.context & allArithmExpr) !== 0) {
						break loop
					}
				// fall through
				case '+':
				case '-':
				case ' ':
				case '\t':
				case ';':
				case '&':
				case '>':
				case '<':
				case '|':
				case '(':
				case ')':
				case '\n':
				case '\r':
					if ((this.context & allKeepSpaces) === 0) {
						break loop
					}
					break
			}
		}
		const val = this.endLit()
		this.token = tok
		this.value = val
	}
	private advanceLitNone(r: string): void {
		this.equalsIndex = -1
		let tok = Token.LitWord
		loop: for (this.newLit(r); r !== endOfInput; r = this.rune()) {
			switch (r) {
				case ' ':
				case '\t':
				case '\n':
				case '\r':
				case '&':
				case '|':
				case ';':
				case ')':
					break loop
				case '(':
					break loop
				case '\\':
					this.rune()
					break
				case '>':
				case '<':
					if (this.peek() === '(') {
						tok = Token.Lit
					} else if (this.isLitRedir()) {
						tok = Token.LitRedir
					}
					break loop
				case '`':
					if (this.context !== subCmdBckquo) {
						tok = Token.Lit
					}
					break loop
				case '"':
				case "'":
				case '$':
					tok = Token.Lit
					break loop
				case '?':
				case '*':
				case '+':
				case '@':
				case '!':
					if (this.extendedGlob()) {
						tok = Token.Lit
						break loop
					}
					break
				case '=':
					if (this.equalsIndex < 0) {
						this.equalsIndex = this.literalBuffer.length - 1
					}
					break
				case '}':
					if (
						this.context === subCmdBraces &&
						this.literalBuffer.length === 1
					) {
						this.rune()
						break loop
					}
					break
				case '{':
					break
				case '[':
					if (this.literalBuffer[0]! === '{') {
						break
					}
					if (this.literalBuffer.length > 1 && this.literalBuffer[0]! !== '[') {
						tok = Token.Lit
						break loop
					}
					break
			}
		}
		const val = this.endLit()
		this.token = tok
		this.value = val
	}
	private advanceLitDquote(r: string): void {
		let tok = Token.LitWord
		loop: for (this.newLit(r); r !== endOfInput; r = this.rune()) {
			switch (r) {
				case '"':
					break loop
				case '\\':
					this.rune()
					break
				case escapedNewline:
				case '`':
				case '$':
					tok = Token.Lit
					break loop
			}
		}
		this.token = tok
		this.value = this.endLit()
	}
	private advanceLitHdoc(r: string): void {
		let lastTok = this.token
		while (r === escapedNewline) {
			r = this.rune()
			lastTok = Token.Lit
		}
		this.position = this.nextPos()
		this.token = Token.Lit
		this.newLit(r)
		while (this.context === hdocBodyTabs && r === '\t') {
			r = this.rune()
		}
		let lStart = this.literalBuffer.length - this.width
		let atLineStart = true
		let lPos: number = -1
		const stop = this.heredocDelimiters[this.heredocDelimiters.length - 1]!
		for (; ; r = this.rune()) {
			if (atLineStart) {
				lPos = this.nextPos()
				atLineStart = false
			}
			switch (r) {
				case escapedNewline:
				case '$':
					this.value = this.endLit()
					return
				case '\\':
					this.rune()
					break
				case '`':
					if (!this.backquoteEnd()) {
						this.value = this.endLit()
						return
					}
				// fall through
				case '\n':
				case endOfInput:
					if (lStart >= 0 && (lStart > 0 || lastTok !== Token.Lit)) {
						let line = this.literalBuffer.slice(lStart)
						if (r !== endOfInput && line.length > 0) {
							line = line.slice(0, line.length - 1)
						}
						if (line === (stop ?? '')) {
							this.token = Token.LitWord
							this.value = this.endLit().slice(0, lStart)
							if (this.value === '') {
								this.token = Token.Newl
							}
							if (stop !== null) {
								this.hdocClosePos = lPos
							}
							this.heredocDelimiters[this.heredocDelimiters.length - 1] = null
							return
						}
					}
					if (r !== '\n') {
						this.value = this.endLit()
						if (this.value === '') {
							this.next()
						}
						return
					}
					while (this.context === hdocBodyTabs && this.peek() === '\t') {
						this.rune()
					}
					lStart = this.literalBuffer.length
					atLineStart = true
					break
			}
		}
	}
	private quotedHdocWord(): Word | null {
		let r = this.char
		this.newLit(r)
		const pos = this.nextPos()
		const stop = this.heredocDelimiters[this.heredocDelimiters.length - 1]!
		for (; r !== endOfInput; r = this.rune()) {
			while (this.context === hdocBodyTabs && r === '\t') {
				r = this.rune()
			}
			const lStart = this.literalBuffer.length - this.width
			const lPos = this.nextPos()
			runeLoop: while (true) {
				switch (r) {
					case endOfInput:
					case '\n':
						break runeLoop
					case '`':
						if (this.backquoteEnd()) {
							break runeLoop
						}
						break
					case escapedNewline:
						this.literalBuffer += '\\' + '\n'
						break runeLoop
				}
				r = this.rune()
			}
			if (lStart < 0) {
				continue
			}
			let line = this.literalBuffer.slice(lStart)
			if (r !== endOfInput && line.length > 0) {
				line = line.slice(0, line.length - 1)
			}
			if (line === (stop ?? '')) {
				this.hdocClosePos = lPos
				this.heredocDelimiters[this.heredocDelimiters.length - 1] = null
				const val = this.endLit().slice(0, lStart)
				if (val === '') {
					return null
				}
				return this.wordOne(this.lit(pos, val))
			}
			if (r === '`') {
				break
			}
		}
		const val = this.endLit()
		if (val !== '') {
			return this.wordOne(this.lit(pos, val))
		}
		return null
	}
	private advanceLitRe(r: string): void {
		for (this.newLit(r); ; r = this.rune()) {
			switch (r) {
				case '\\':
					this.rune()
					break
				case '(':
					this.regexParens++
					break
				case ')':
					this.regexParens--
					if (this.regexParens < 0) {
						this.token = Token.LitWord
						this.value = this.endLit()
						this.context = testExpr
						return
					}
					break
				case ' ':
				case '\t':
				case '\r':
				case '\n':
				case ';':
				case '&':
				case '>':
				case '<':
					if (this.regexParens <= 0) {
						this.token = Token.LitWord
						this.value = this.endLit()
						this.context = testExpr
						return
					}
					break
				case '"':
				case "'":
				case '$':
				case '`':
					this.token = Token.Lit
					this.value = this.endLit()
					return
				case endOfInput:
					this.token = Token.LitWord
					this.value = this.endLit()
					this.context = noState
					return
			}
		}
	}
	private arithmExpr(compact: boolean): SyntaxNode | null {
		const depth = this.openNodes
		try {
			this.enterNode()
			return this.arithmExprComma(compact)
		} finally {
			this.openNodes = depth
		}
	}
	private arithmExprComma(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprAssign.bind(this),
			Token.comma,
		)
	}
	private arithmExprAssign(compact: boolean): SyntaxNode | null {
		const value = this.arithmExprTernary(compact)
		switch (this.token) {
			case Token.addAssgn:
			case Token.subAssgn:
			case Token.mulAssgn:
			case Token.quoAssgn:
			case Token.remAssgn:
			case Token.andAssgn:
			case Token.orAssgn:
			case Token.xorAssgn:
			case Token.shlAssgn:
			case Token.shrAssgn:
			case Token.assgn:
			case Token.andBoolAssgn:
			case Token.orBoolAssgn:
			case Token.xorBoolAssgn:
			case Token.powAssgn: {
				if (compact && this.spaced) {
					return value
				}
				if (!isArithName(value)) {
					return this.posErr(
						this.position,
						'%#q must follow a name',
						this.token,
					)
				}
				const pos = this.position
				const tok = this.token
				this.nextArithOp(compact)
				this.enterNode()
				const y = this.arithmExprAssign(compact)
				this.leaveNode()
				if (y === null) {
					return this.followErrExp(pos, tok)
				}
				return new BinaryArithm({ opPos: pos, op: tok, x: value, y })
			}
		}
		return value
	}
	private arithmExprTernary(compact: boolean): SyntaxNode | null {
		const value = this.arithmExprLor(compact)
		if (this.token !== Token.quest || (compact && this.spaced)) {
			return value
		}
		if (value === null) {
			return this.curErr('%#q must follow an expression', this.token)
		}
		const questPos = this.position
		this.nextArithOp(compact)
		if (this.token === Token.colon) {
			return this.followErrExp(questPos, Token.quest)
		}
		const trueExpr = this.arithmExpr(compact)
		if (trueExpr === null) {
			return this.followErrExp(questPos, Token.quest)
		}
		if (this.token !== Token.colon) {
			return this.posErr(
				questPos,
				'ternary operator missing %#q after %#q',
				Token.colon,
				Token.quest,
			)
		}
		const colonPos = this.position
		this.nextArithOp(compact)
		this.enterNode()
		const falseExpr = this.arithmExprTernary(compact)
		this.leaveNode()
		if (falseExpr === null) {
			return this.followErrExp(colonPos, Token.colon)
		}
		return new BinaryArithm({
			opPos: questPos,
			op: Token.quest,
			x: value,
			y: new BinaryArithm({
				opPos: colonPos,
				op: Token.colon,
				x: trueExpr,
				y: falseExpr,
			}),
		})
	}
	private arithmExprLor(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprLand.bind(this),
			Token.orOr,
			Token.dblCaret,
		)
	}
	private arithmExprLand(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprBor.bind(this),
			Token.andAnd,
		)
	}
	private arithmExprBor(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprBxor.bind(this),
			Token.or,
		)
	}
	private arithmExprBxor(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprBand.bind(this),
			Token.caret,
		)
	}
	private arithmExprBand(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprEquality.bind(this),
			Token.and,
		)
	}
	private arithmExprEquality(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprComparison.bind(this),
			Token.equal,
			Token.nequal,
		)
	}
	private arithmExprComparison(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprShift.bind(this),
			Token.rdrIn,
			Token.rdrOut,
			Token.lequal,
			Token.gequal,
		)
	}
	private arithmExprShift(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprAddition.bind(this),
			Token.hdoc,
			Token.appOut,
		)
	}
	private arithmExprAddition(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprMultiplication.bind(this),
			Token.plus,
			Token.minus,
		)
	}
	private arithmExprMultiplication(compact: boolean): SyntaxNode | null {
		return this.arithmExprBinary(
			compact,
			this.arithmExprPower.bind(this),
			Token.star,
			Token.slash,
			Token.perc,
		)
	}
	private arithmExprPower(compact: boolean): SyntaxNode | null {
		const value = this.arithmExprUnary(compact)
		if (this.token !== Token.power || (compact && this.spaced)) {
			return value
		}
		if (value === null) {
			return this.curErr('%#q must follow an expression', this.token)
		}
		const op = this.token
		const pos = this.position
		this.nextArithOp(compact)
		this.enterNode()
		const y = this.arithmExprPower(compact)
		this.leaveNode()
		if (y === null) {
			return this.followErrExp(pos, op)
		}
		return new BinaryArithm({ opPos: pos, op, x: value, y })
	}
	private arithmExprUnary(compact: boolean): SyntaxNode | null {
		if (!compact) {
			this.got(Token.Newl)
		}
		switch (this.token) {
			case Token.exclMark:
			case Token.tilde:
			case Token.plus:
			case Token.minus: {
				const ue = new UnaryArithm({ opPos: this.position, op: this.token })
				this.nextArithOp(compact)
				this.enterNode()
				ue.x = this.arithmExprUnary(compact)
				this.leaveNode()
				if (ue.x === null) {
					return this.followErrExp(ue.opPos, ue.op)
				}
				return ue
			}
		}
		return this.arithmExprValue(compact)
	}
	private arithmExprValue(compact: boolean): SyntaxNode | null {
		let x: SyntaxNode | null = null
		switch (this.token) {
			case Token.addAdd:
			case Token.subSub: {
				const ue = new UnaryArithm({ opPos: this.position, op: this.token })
				this.nextArith(compact)
				if (this.token !== Token.LitWord) {
					return this.followErr(ue.opPos, ue.op, 'a literal')
				}
				ue.x = this.arithmExprValue(compact)
				return ue
			}
			case Token.leftParen: {
				const pe = new ParenArithm({ lparen: this.position })
				this.nextArithOp(compact)
				pe.x = this.followArithm(Token.leftParen, pe.lparen)
				pe.rparen = this.matched(pe.lparen, Token.leftParen, Token.rightParen)
				if (this.context === paramExpArithm && this.token === Token.LitWord) {
					return this.posErr(
						pe.lparen,
						'subscript flags are unavailable in bash',
					)
				}
				x = pe
				break
			}
			case Token.leftBrack:
				return this.curErr('%#q must follow a name like a[i]', this.token)
			case Token.colon:
				return this.curErr(
					'ternary operator missing %#q before %#q',
					Token.quest,
					Token.colon,
				)
			case Token.LitWord: {
				const l = this.getLit()!
				if (
					this.token === Token.leftParen &&
					!this.spaced &&
					validName(l.value)
				) {
					x = this.posErr(
						this.position,
						'math functions are unavailable in bash',
					)
					break
				}
				if (this.token !== Token.leftBrack) {
					x = this.wordOne(l)
					break
				}
				const pe = new ParamExp({ short: true, param: l })
				pe.index = this.eitherIndex()
				x = this.wordOne(pe)
				break
			}
			case Token.bckQuote:
				if (this.context === arithmExprLet && this.openBquotes > 0) {
					return null
				}
			// fall through
			default: {
				const w = this.getWord()
				if (w !== null) {
					x = w
				} else {
					return null
				}
				break
			}
		}
		if (compact && this.spaced) {
			return x
		}
		if (!compact) {
			this.got(Token.Newl)
		}
		if (this.token === Token.addAdd || this.token === Token.subSub) {
			if (!isArithName(x)) {
				return this.curErr('%#q must follow a name', this.token)
			}
			const u = new UnaryArithm({
				post: true,
				opPos: this.position,
				op: this.token,
				x,
			})
			this.nextArith(compact)
			return u
		}
		return x
	}
	private nextArith(compact: boolean): boolean {
		this.next()
		if (compact && this.spaced) {
			return true
		}
		if (!compact) {
			this.got(Token.Newl)
		}
		return false
	}
	private nextArithOp(compact: boolean): void {
		const pos = this.position
		const tok = this.token
		if (this.nextArith(compact)) {
			return this.followErrExp(pos, tok)
		}
	}
	private arithmExprBinary(
		compact: boolean,
		nextOp: (compact: boolean) => SyntaxNode | null,
		...operators: Array<number>
	): SyntaxNode | null {
		const openNodes = this.openNodes
		let value = nextOp(compact)
		while (true) {
			let foundOp: number = 0
			for (const op of operators) {
				if (this.token === op) {
					foundOp = op
					break
				}
			}
			if (foundOp === Token.illegalTok || (compact && this.spaced)) {
				this.openNodes = openNodes
				return value
			}
			if (value === null) {
				return this.curErr('%#q must follow an expression', this.token)
			}
			this.enterNode()
			const pos = this.position
			this.nextArithOp(compact)
			const y = nextOp(compact)
			if (y === null) {
				return this.followErrExp(pos, foundOp)
			}
			value = new BinaryArithm({ opPos: pos, op: foundOp, x: value, y })
		}
	}
	private followArithm(ftok: number, fpos: number): SyntaxNode {
		const x = this.arithmExpr(false)
		if (x === null) {
			return this.followErrExp(fpos, ftok)
		}
		return x
	}
	private peekArithmEnd(): boolean {
		return this.token === Token.rightParen && this.char === ')'
	}
	private arithmMatchingErr(pos: number, left: number, right: number): void {
		switch (this.token) {
			case Token.Lit:
			case Token.LitWord:
				return this.curErr('not a valid arithmetic operator: %#q', this.value)
			case Token.leftBrack:
				return this.curErr('%#q must follow a name like a[i]', Token.leftBrack)
			case Token.colon:
				return this.curErr(
					'ternary operator missing %#q before %#q',
					Token.quest,
					Token.colon,
				)
			case Token.rightParen:
			case Token.EOF:
				return this.matchingErr(pos, left, right)
			case Token.period:
				return this.posErr(
					this.position,
					'floating point arithmetic is unavailable in bash',
				)
			default:
				if ((this.context & allArithmExpr) !== 0) {
					return this.curErr('not a valid arithmetic operator: %#q', this.token)
				}
				return this.matchingErr(pos, left, right)
		}
	}
	private matchedArithm(lpos: number, left: number, right: number): void {
		if (!this.got(right)) {
			this.arithmMatchingErr(lpos, left, right)
		}
	}
	private arithmEnd(ltok: number, lpos: number, old: NestedState): number {
		if (!this.peekArithmEnd()) {
			this.arithmMatchingErr(lpos, ltok, Token.dblRightParen)
		}
		this.rune()
		this.postNested(old)
		const pos = this.position
		this.next()
		return pos
	}
}
