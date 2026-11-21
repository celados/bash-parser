import { harness } from '@celados/harness'
import { defineConfig } from 'vite-plus'

export default defineConfig(
	harness({ ignore: ['.scratch/**', 'scripts/corpus.json'] }),
)
