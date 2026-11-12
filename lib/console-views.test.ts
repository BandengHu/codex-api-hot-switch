import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_VIEW,
  SERVER_DEFAULT_VIEW,
  SERVER_HIDDEN_VIEWS,
  isViewKey,
  isViewVisible,
  resolveView,
} from "./console-views"

test("本机模式默认进入 Codex 桌面端并保留全部入口", () => {
  assert.equal(DEFAULT_VIEW, "codex-desktop")
  assert.equal(resolveView(undefined, false), "codex-desktop")
  assert.equal(resolveView("wecom-bridge", false), "wecom-bridge")
  for (const view of SERVER_HIDDEN_VIEWS) {
    assert.equal(isViewVisible(view, false), true)
  }
})

test("服务器模式默认进入总览并隐藏本机专属入口", () => {
  assert.equal(SERVER_DEFAULT_VIEW, "dashboard")
  assert.equal(resolveView(undefined, true), "dashboard")
  for (const view of SERVER_HIDDEN_VIEWS) {
    assert.equal(isViewVisible(view, true), false)
    assert.equal(resolveView(view, true), "dashboard")
  }
  assert.equal(resolveView("providers", true), "providers")
})

test("非法视图回退到当前模式默认页", () => {
  assert.equal(isViewKey("unknown"), false)
  assert.equal(isViewKey(["dashboard"]), false)
  assert.equal(resolveView("unknown", false), "codex-desktop")
  assert.equal(resolveView("unknown", true), "dashboard")
})
