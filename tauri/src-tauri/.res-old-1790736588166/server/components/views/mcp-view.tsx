"use client"

import { useEffect, useState } from "react"
import {
  Copy,
  FolderOpen,
  ListRestart,
  PlugZap,
  RefreshCw,
  RotateCcw,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import {
  fetchCodexConfigStatus,
  initCodexCodegraphProjects,
  installCodexCodegraphMcp,
  installCodexWebSearchMcp,
  removeCodexCodegraphMcp,
  removeCodexWebSearchMcp,
} from "@/lib/console-api"
import type { CodexConfigStatus } from "@/lib/codex-config-types"
import { selectDesktopDirectory } from "@/lib/desktop-directory-picker"
import { toast } from "sonner"

type McpAction =
  | "refresh"
  | "install-web-search"
  | "remove-web-search"
  | "install-codegraph"
  | "remove-codegraph"
  | "copy-dsh-address"
  | "select-project"
  | "init-projects"

export function McpView() {
  const [status, setStatus] = useState<CodexConfigStatus | null>(null)
  const [projectPath, setProjectPath] = useState("")
  const [working, setWorking] = useState<McpAction | null>("refresh")

  async function refresh() {
    setWorking("refresh")
    try {
      setStatus(await fetchCodexConfigStatus())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(null)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function mutate(
    action: Exclude<McpAction, "refresh" | "select-project" | "init-projects">,
    operation: () => Promise<{ status: CodexConfigStatus; message: string }>,
  ) {
    setWorking(action)
    try {
      const result = await operation()
      setStatus(result.status)
      toast.success(result.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(null)
    }
  }

  async function selectProject() {
    setWorking("select-project")
    try {
      const selected = await selectDesktopDirectory(projectPath)
      if (selected) setProjectPath(selected)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(null)
    }
  }

  async function initProjects() {
    setWorking("init-projects")
    try {
      const result = await initCodexCodegraphProjects(projectPath)
      setStatus(result.status)
      toast.success(result.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(null)
    }
  }

  async function copyDshAddress() {
    const endpoint = status?.dshWebSearch.endpoint
    if (!endpoint) return
    setWorking("copy-dsh-address")
    try {
      await navigator.clipboard.writeText(endpoint)
      toast.success("已复制 DSH 搜索地址")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setWorking(null)
    }
  }

  const busy = working !== null

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">MCP 管理</h1>
          <p className="text-sm text-muted-foreground">
            管理 Codex 的本地 MCP 工具和 CodeGraph 项目索引
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          title="刷新状态"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {working === "refresh" ? <Spinner /> : <RefreshCw />}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">DSH 搜索地址</CardTitle>
              <CardDescription>
                这里只提供本地中转地址，不修改 DSH 的插件、依赖或 profile。
              </CardDescription>
            </div>
            <Badge variant="secondary">仅地址</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-2 font-mono text-xs">
              {status?.dshWebSearch.endpoint || "正在读取"}
            </code>
            <Button
              variant="outline"
              size="icon"
              title="复制 DSH 搜索地址"
              aria-label="复制 DSH 搜索地址"
              disabled={busy || !status?.dshWebSearch.endpoint}
              onClick={() => void copyDshAddress()}
            >
              {working === "copy-dsh-address" ? <Spinner /> : <Copy />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            DSH 是否支持填入或调用此地址，由 DSH 自身能力决定；中转不再自动安装或改写 DSH。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">web_search MCP</CardTitle>
              <CardDescription>
                为 Codex 注册独立网页搜索 MCP；安装后需重启 Codex 重新发现工具。
              </CardDescription>
            </div>
            <Badge variant={status?.webSearchMcp.installed ? "default" : "secondary"}>
              {status?.webSearchMcp.installed ? "已写入" : "未写入"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 text-xs md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">MCP 名称</span>
              <code className="break-all rounded bg-muted px-2 py-1 font-mono">
                {status?.webSearchMcp.serverName || "switchgate_web_search"}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">脚本路径</span>
              <code className="break-all rounded bg-muted px-2 py-1 font-mono">
                {status?.webSearchMcp.scriptPath || "正在读取"}
              </code>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void mutate("install-web-search", installCodexWebSearchMcp)
              }
            >
              {working === "install-web-search" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlugZap data-icon="inline-start" />
              )}
              启用
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !status?.webSearchMcp.installed}
              onClick={() =>
                void mutate("remove-web-search", removeCodexWebSearchMcp)
              }
            >
              {working === "remove-web-search" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RotateCcw data-icon="inline-start" />
              )}
              移除
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">CodeGraph MCP</CardTitle>
              <CardDescription>
                注册原始 CodeGraph MCP、同步 AGENTS.md，并为工作区内 Git 项目建立索引。
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={status?.codegraphMcp.installed ? "default" : "secondary"}>
                {status?.codegraphMcp.installed ? "已写入" : "未写入"}
              </Badge>
              <Badge variant={status?.codegraphMcp.cliAvailable ? "secondary" : "outline"}>
                CLI {status?.codegraphMcp.cliAvailable ? "可用" : "未安装"}
              </Badge>
              <Badge variant={status?.codegraphMcp.ready ? "default" : "outline"}>
                {status?.codegraphMcp.ready ? "可用" : "未就绪"}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 text-xs md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">CLI 命令</span>
              <code className="break-all rounded bg-muted px-2 py-1 font-mono">
                {status?.codegraphMcp.command ||
                  status?.codegraphMcp.cliCommand ||
                  "正在读取"}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">AGENTS.md</span>
              <code className="break-all rounded bg-muted px-2 py-1 font-mono">
                {status?.codegraphMcp.agentsPath || "正在读取"}
              </code>
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void mutate("install-codegraph", installCodexCodegraphMcp)
              }
            >
              {working === "install-codegraph" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <PlugZap data-icon="inline-start" />
              )}
              启用
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !status?.codegraphMcp.installed}
              onClick={() =>
                void mutate("remove-codegraph", removeCodexCodegraphMcp)
              }
            >
              {working === "remove-codegraph" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RotateCcw data-icon="inline-start" />
              )}
              移除
            </Button>
          </div>

          <div className="flex flex-col gap-2 border-t border-border pt-4">
            <span className="text-xs text-muted-foreground">
              工作区索引
              {status?.codegraphMcp.cliVersion
                ? ` · CLI ${status.codegraphMcp.cliVersion}`
                : ""}
            </span>
            <div className="flex flex-col gap-2 md:flex-row">
              <Input
                value={projectPath}
                disabled={busy}
                placeholder="工作区绝对路径，例如 C:\repo"
                onChange={(event) => setProjectPath(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void selectProject()}
              >
                {working === "select-project" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <FolderOpen data-icon="inline-start" />
                )}
                选择文件夹
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !projectPath.trim()}
                onClick={() => void initProjects()}
              >
                {working === "init-projects" ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ListRestart data-icon="inline-start" />
                )}
                扫描并建索引
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
