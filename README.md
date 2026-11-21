# @celados/bash-parser

A bash parser in pure TypeScript with exact source spans. It is a port of the
bash lexer and parser of [mvdan/sh](https://github.com/mvdan/sh), checked
against mvdan/sh itself (the [`sh-syntax`](https://www.npmjs.com/package/sh-syntax)
WASM build) on every node and every span.

- Zero runtime dependencies, synchronous, no WASM.
- Every node has `start` / `end` as **JavaScript string indices**, so
  `source.slice(node.start, node.end)` is the node's text and edits keep the
  rest of the command byte-for-byte.
- Bash dialect only (see [Limits](#limits)).

## Install

The package is public on the celados registry. Point the `@celados` scope at it
(`.npmrc`), then add it:

```ini
@celados:registry=https://npm.celados.com
```

```sh
bun add @celados/bash-parser
```

The package ships TypeScript source; use it from Bun (>= 1.4) or any
TypeScript-aware toolchain.

## API

```ts
import { parse, Token, tokenText } from '@celados/bash-parser'
```

### `parse(source: string): Stmt[]`

Parses a script into its top-level statements. Throws `SyntaxError` with a
message of the form `at <index>: <reason>` when mvdan/sh rejects the input.

```ts
const source = 'git log --oneline | head -n 5 > out.txt'
const [stmt] = parse(source)

const pipe = stmt.cmd // BinaryCmd { op: Token.or, x: Stmt, y: Stmt }
tokenText(pipe.op) // '|'

const head = pipe.y // Stmt
head.cmd.args.map((w) => source.slice(w.start, w.end)) // ['head', '-n', '5']
head.redirs.map((r) => [
	tokenText(r.op),
	source.slice(r.word.start, r.word.end),
])
// [['>', 'out.txt']]
source.slice(head.start, head.end) // 'head -n 5 > out.txt'
```

```ts
try {
	parse('echo "x')
} catch (error) {
	error instanceof SyntaxError // true
	error.message // 'at 5: reached EOF without closing quote "'
}
```

### AST

The node classes mirror mvdan/sh's `syntax` package, with the same field
names: `Stmt`, `CallExpr`, `BinaryCmd`, `Subshell`, `Block`, `IfClause`,
`WhileClause`, `ForClause`, `CaseClause`, `FuncDecl`, `DeclClause`,
`TestClause`, `ArithmCmd`, `Word`, `Lit`, `SglQuoted`, `DblQuoted`, `ParamExp`,
`CmdSubst`, `ProcSubst`, `ArithmExp`, `ExtGlob`, `Redirect`, `Assign`, and the
rest. All are exported from the package root, along with the `SyntaxNode` and
`WordPart` types.

Every node has a `type` string discriminator and `start` / `end` indices.
Words are lists of `WordPart`s; a literal fragment is a `Lit` with its decoded
`value`, quoting and expansions are separate parts, which is what makes
"is this argument a plain literal?" a one-line check.

### `Token` and `tokenText(token)`

Operators (`Redirect.op`, `BinaryCmd.op`, ...) are numeric `Token` values.
`tokenText(token)` returns the source spelling (`'>>'`, `'&&'`, `'<<-'`, ...).

## How it is verified

Correctness is defined as "agrees with mvdan/sh", and the test suite checks
that differentially (`test/differential.test.ts`, run by `bun test` and CI):

- **Corpus**: 1404 inputs extracted from mvdan/sh's own test tables
  (`fileTests`, `fileTestsNoPrint`, `fileTestsKeepComments`, `errorCases`) at
  commit [`6f0102c`](https://github.com/mvdan/sh/commit/6f0102cc00b2024fdffb1f6b8a15d0d586cd5324).
  **Zero exclusions.** 1389 are valid UTF-8 strings (846 accepted, 543
  rejected); the other 15 are byte-only Go inputs, stored as base64 and checked
  through their JS string decoding.
- **Oracle**: for each input, `sh-syntax` and this parser must agree on
  acceptance, on every node's path, `type`, `start`, `end`, operator, literal
  value and `$`-quoting flag, and on the literal value of every word. Rejected
  inputs must be rejected by both.
- **Mutation fuzz**: 4000 seeded mutations of the corpus must stay identical to
  the oracle. A mutation inserts a shell metacharacter, quote, heredoc marker,
  CJK / astral character or NUL, deletes or replaces a range, splices in
  another corpus input, or duplicates a slice. The stream uses a fixed
  Mulberry32 seed; `BASH_PARSER_FUZZ_COUNT` raises the count (minimum 4000).
- **`bash -n` cross-check**: wherever real `bash -n` and mvdan/sh agree on a
  corpus input, this parser must give the same verdict (1221 agreements; 167
  inputs only bash accepts and 1 only mvdan accepts are reported, not
  asserted).
- **Unicode and lexer boundaries**: unpaired surrogates, comments inside `case`,
  astral characters before redirects, nested backquotes with escapes, and an
  escaped CRLF after a 1 KiB literal are pinned as explicit cases.

Positions are JS string indices; the oracle converts sh-syntax's UTF-8 byte
offsets with `createSourceIndex`.

### Regenerating the corpus

The Go test tables are private to mvdan/sh's `syntax` package, so
`scripts/regenerate.sh` fetches the pinned commit, drops `scripts/extract.go`
into it as a test, and writes `scripts/corpus.json`. It needs `go`, `git` and
`bun`. To move to a newer mvdan/sh, change `commit` in the script, regenerate,
and fix any divergence the differential test then reports.

```sh
bun run corpus
bun test
```

## Benchmark

`bun run bench` (`scripts/bench.ts`). Bun 1.4.4, Apple M1 Pro, macOS 26.7;
median of 7 warm rounds over the 1389 string inputs of the corpus (syntax errors
included), and of 31 fresh `bun` processes for cold.

|                                              | `sh-syntax` (WASM) | `@celados/bash-parser` |
| -------------------------------------------- | -----------------: | ---------------------: |
| Warm parse, median per input                 |           0.019 ms |               0.003 ms |
| Cold: process start, import, one parse       |            59.0 ms |                33.3 ms |
| Cold, excluding bare `bun` startup (29.5 ms) |            29.5 ms |                 3.8 ms |

Warm is about 7x faster; cold is about 8x cheaper once the Bun startup floor is
subtracted, because there is no WASM to fetch and instantiate.

## Limits

- **Bash dialect only.** mvdan/sh also parses POSIX, mksh and bats; this port
  implements the bash grammar and does not expose language variants.
- Parses only: no printing, formatting, expansion or interpretation.
- Matches mvdan/sh, including the places it differs from real bash
  (`bash -n` accepts 167 corpus inputs mvdan/sh rejects).
- Source is parsed as a JS string; lone surrogates are replaced with U+FFFD, as
  UTF-8 encoding would, before parsing.

## License

BSD 3-Clause. Copyright (c) 2016 Daniel Martí (mvdan/sh) and (c) 2026 celados.
See [LICENSE](LICENSE).
