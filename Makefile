NPM_CACHE ?= /tmp/specdd-npm-cache
NPM := npm --cache $(NPM_CACHE)
PACKAGE := specdd
PACKAGE_VERSION := $(shell node -p "require('./package.json').version")
VERSION ?= $(PACKAGE_VERSION)
CONFIRM = printf '%s [y/N] ' "$(1)"; read -r answer; case "$$answer" in [yY]|[yY][eE][sS]) ;; *) echo "Aborted."; exit 1 ;; esac
HOMEBREW_TAP_DIR ?= ../homebrew-cli
HOMEBREW_FORMULA ?= $(HOMEBREW_TAP_DIR)/Formula/specdd.rb
HOMEBREW_TARBALL := /tmp/$(PACKAGE)-$(VERSION).tgz
HOMEBREW_TARBALL_URL := https://registry.npmjs.org/$(PACKAGE)/-/$(PACKAGE)-$(VERSION).tgz
GH ?= gh
GITHUB_RELEASE_TAG := $(PACKAGE_VERSION)
GITHUB_RELEASE_TITLE ?= $(PACKAGE) $(PACKAGE_VERSION)
DOCKER ?= docker
DOCKER_CONFIG := $(CURDIR)/.docker
DOCKER_IMAGE ?= ghcr.io/specdd/cli
DOCKER_HUB_IMAGE ?= specdd/cli
DOCKER_PLATFORMS ?= linux/amd64,linux/arm64
DOCKER_BUILDER ?= specdd-builder
NODE_IMAGE ?= node:22-bookworm-slim

export DOCKER_CONFIG

.PHONY: build install sync-shrinkwrap audit typecheck test dist pack-check release release-preflight bump-homebrew github-release docker-config docker-build docker-smoke docker-builder docker-release docker-inspect

build: install sync-shrinkwrap audit typecheck test dist pack-check

install:
	yarn install --frozen-lockfile

sync-shrinkwrap:
	$(NPM) install --package-lock-only --ignore-scripts
	$(NPM) shrinkwrap --ignore-scripts

audit:
	yarn security:audit
	$(NPM) audit --audit-level=info

typecheck:
	yarn typecheck

test:
	yarn test

dist:
	yarn build

pack-check:
	$(NPM) pack --dry-run

release: release-preflight build
	@$(call CONFIRM,Publish $(PACKAGE)@$(VERSION) to npm?)
	$(NPM) publish
	@$(call CONFIRM,Update Homebrew formula for $(PACKAGE)@$(VERSION)?)
	$(MAKE) bump-homebrew
	@$(call CONFIRM,Publish Docker images for $(PACKAGE)@$(VERSION)?)
	$(MAKE) docker-release
	@$(call CONFIRM,Create GitHub release $(GITHUB_RELEASE_TAG)?)
	$(MAKE) github-release

release-preflight:
	@git rev-parse --is-inside-work-tree >/dev/null
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "Release preflight failed: uncommitted changes are present."; \
		git status --short; \
		exit 1; \
	fi
	@upstream=$$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null) || { \
		echo "Release preflight failed: current branch has no upstream configured."; \
		exit 1; \
	}; \
	unpushed_count=$$(git rev-list --count "$$upstream"..HEAD); \
	if [ "$$unpushed_count" -ne 0 ]; then \
		echo "Release preflight failed: $$unpushed_count commit(s) have not been pushed to $$upstream."; \
		git log --oneline "$$upstream"..HEAD; \
		exit 1; \
	fi

bump-homebrew: release-preflight
	@if [ ! -f "$(HOMEBREW_FORMULA)" ]; then echo "Homebrew formula not found: $(HOMEBREW_FORMULA)"; exit 1; fi
	curl -fsSL -o "$(HOMEBREW_TARBALL)" "$(HOMEBREW_TARBALL_URL)"
	ruby -rdigest -e 'formula = ARGV[0]; url = ARGV[1]; sha = Digest::SHA256.file(ARGV[2]).hexdigest; text = File.read(formula); text = text.sub(%r{url "https://registry\.npmjs\.org/specdd/-/specdd-[^"]+\.tgz"}, %(url "#{url}")); text = text.sub(/sha256 "[^"]*"/, %(sha256 "#{sha}")); File.write(formula, text)' "$(HOMEBREW_FORMULA)" "$(HOMEBREW_TARBALL_URL)" "$(HOMEBREW_TARBALL)"
	ruby -c "$(HOMEBREW_FORMULA)"
	@if command -v brew >/dev/null 2>&1; then brew audit --strict --online --new "$(HOMEBREW_FORMULA)"; else echo "Skipping Homebrew audit: brew not found."; fi

github-release: release-preflight
	@command -v "$(GH)" >/dev/null 2>&1 || { echo "GitHub CLI not found: $(GH)"; exit 1; }
	@notes_file=$$(mktemp); \
	trap 'rm -f "$$notes_file"' EXIT; \
	printf 'Release message body for %s (finish with a single "." line):\n' "$(GITHUB_RELEASE_TAG)"; \
	while IFS= read -r line; do \
		if [ "." = "$$line" ]; then break; fi; \
		printf '%s\n' "$$line" >> "$$notes_file"; \
	done; \
	if [ ! -s "$$notes_file" ]; then echo "Release message body is required."; exit 1; fi; \
	"$(GH)" release create "$(GITHUB_RELEASE_TAG)" --title "$(GITHUB_RELEASE_TITLE)" --notes-file "$$notes_file"

docker-config:
	mkdir -p "$(DOCKER_CONFIG)"

docker-build: docker-config
	$(DOCKER) build \
		--build-arg SPECDD_VERSION="$(VERSION)" \
		--build-arg NODE_IMAGE="$(NODE_IMAGE)" \
		--tag "$(DOCKER_IMAGE):$(VERSION)" \
		--tag "$(DOCKER_IMAGE):latest" \
		--tag "$(DOCKER_HUB_IMAGE):$(VERSION)" \
		--tag "$(DOCKER_HUB_IMAGE):latest" \
		.

docker-smoke: docker-config
	$(DOCKER) run --rm "$(DOCKER_IMAGE):$(VERSION)" --help

docker-builder: docker-config
	$(DOCKER) buildx inspect "$(DOCKER_BUILDER)" >/dev/null 2>&1 || $(DOCKER) buildx create --use --name "$(DOCKER_BUILDER)"
	$(DOCKER) buildx use "$(DOCKER_BUILDER)"
	$(DOCKER) buildx inspect --bootstrap

docker-release: release-preflight docker-builder
	$(DOCKER) buildx build \
		--platform "$(DOCKER_PLATFORMS)" \
		--build-arg SPECDD_VERSION="$(VERSION)" \
		--build-arg NODE_IMAGE="$(NODE_IMAGE)" \
		--tag "$(DOCKER_IMAGE):$(VERSION)" \
		--tag "$(DOCKER_IMAGE):latest" \
		--tag "$(DOCKER_HUB_IMAGE):$(VERSION)" \
		--tag "$(DOCKER_HUB_IMAGE):latest" \
		--push \
		.
	$(MAKE) docker-inspect

docker-inspect: docker-config
	$(DOCKER) buildx imagetools inspect "$(DOCKER_IMAGE):$(VERSION)"
	$(DOCKER) buildx imagetools inspect "$(DOCKER_HUB_IMAGE):$(VERSION)"
