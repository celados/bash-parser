import { defineHarnessConfig } from '@celados/harness'

export default defineHarnessConfig({
	typecheck: { programs: [{ project: 'tsconfig.json' }] },
})
