// Copied into the mvdan/sh syntax package by regenerate.sh.
package syntax

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"unicode/utf8"
)

func TestCorpus(t *testing.T) {
	type row struct {
		ID    string `json:"id"`
		Input string `json:"input"`
		Bytes string `json:"bytes,omitempty"`
	}
	corpus := struct {
		Source  string `json:"source"`
		Commit  string `json:"commit"`
		License string `json:"license"`
		Cases   []row  `json:"cases"`
	}{Source: "https://github.com/mvdan/sh", Commit: os.Getenv("MVDAN_COMMIT"), License: "Copyright (c) 2016, Daniel Martí. BSD-3-Clause; see LICENSE."}
	add := func(id, input string) {
		r := row{ID: id, Input: input}
		// The JS parser and WASM bridge both take strings. Preserve byte-only
		// Go inputs separately instead of silently replacing their invalid bytes.
		if !utf8.ValidString(input) {
			r.Input = ""
			r.Bytes = base64.StdEncoding.EncodeToString([]byte(input))
		}
		corpus.Cases = append(corpus.Cases, r)
	}
	for _, group := range []struct {
		name  string
		tests []fileTestCase
	}{
		{"fileTests", fileTests}, {"fileTestsNoPrint", fileTestsNoPrint}, {"fileTestsKeepComments", fileTestsKeepComments},
	} {
		for i, c := range group.tests {
			for j, input := range c.inputs {
				add(fmt.Sprintf("%s/%d/%d", group.name, i, j), input)
			}
		}
	}
	for i, c := range errorCases {
		add(fmt.Sprintf("errorCases/%d", i), c.in)
	}
	out, err := os.Create(os.Getenv("BASH_PARSER_CORPUS"))
	if err != nil {
		t.Fatal(err)
	}
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(corpus); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}
