.DEFAULT_GOAL := help

help:
	@printf '%s\n' 'make check      Type check and free unit tests' 'make test-live  Real bubblewrap smoke test' 'make pibox      Interactive pi session'

check:
	npm run check

test-live:
	npm run test:live

pibox:
	./bin/pibox

.PHONY: help check test-live pibox
