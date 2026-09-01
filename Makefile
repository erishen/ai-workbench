# ===========================================================================
# AI Workbench dev targets
# ===========================================================================

.PHONY: install dev build dist clean help

install: ## Install dependencies
	npm install

dev: ## Launch the Electron app (react-scripts + Electron, HMR)
	npm run dev

build: ## Build the React app
	npm run build

dist: ## Build the Electron installer/package
	npm run dist

clean: ## Remove build outputs
	rm -rf build dist

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033%-12s\033 %s\n", $$1, $$2}'
