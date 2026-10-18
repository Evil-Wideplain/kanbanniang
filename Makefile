# 看板娘（Tauri + Live2D）常用命令入口
# 用法：make <目标>；make 或 make help 查看全部
# 注意：msys sh 里裸 `npm` 的 bash shebang 会解析到 WSL 的 bash 别名而失败，故用 npm.cmd
NPM ?= npm.cmd
APP := target/release/kanban-mascot.exe

.PHONY: help install dev build debug run check test unit lint fmt verify score clean

help: ## 显示命令列表
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F ':.*?## ' '{ printf "  %-12s %s\n", $$1, $$2 }'

install: ## 安装前端依赖
	$(NPM) install

dev: ## 开发调试：Vite 热更新 + Tauri 窗口
	$(NPM) run tauri:dev

build: ## Release 构建：exe + MSI/NSIS 安装包（target/release）
	$(NPM) run tauri:build

debug: ## Debug 构建：带调试符号（target/debug）
	$(NPM) run tauri -- build --debug

run: ## 运行 Release 构建的程序
	./$(APP)

check: ## 前端门禁：tsc 类型检查 + Vite 构建（前端改动必过）
	$(NPM) run build

test: ## MCP 冒烟测试（需程序已启动）
	node cmd/client/test.mjs

unit: ## 前端单元测试（vitest；领域层与纯函数）
	$(NPM) run test

lint: ## Rust 门禁：clippy 严格检查（-D warnings）+ 格式校验
	cd src/tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check

verify: check unit lint ## 提交前全量门禁（= check + unit + lint）

fmt: ## Rust 自动格式化（src/tauri）
	cd src/tauri && cargo fmt

score: ## Rust CRAP 复杂度打分（cargo-crap；无覆盖率数据按 0% 保守计）
	cd src/tauri && cargo crap

clean: ## 清理构建产物（dist/、target/）
	rm -rf dist target
