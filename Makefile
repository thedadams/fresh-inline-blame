.PHONY: check typecheck test manifest-check plugin-check

check: typecheck test manifest-check plugin-check

typecheck:
	tsc --project tsconfig.json

test:
	tsc --project tsconfig.test.json
	tsc --project tsconfig.plugin-test.json
	node --test --test-concurrency=1 tests/*.test.cjs

manifest-check:
	python3 scripts/validate_manifest.py

plugin-check:
	fresh --check-plugin fresh-inline-blame.ts
