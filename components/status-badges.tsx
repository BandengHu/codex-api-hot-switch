import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  HEALTH_LABELS,
  PROTOCOL_LABELS,
  REASONING_LABELS,
  type HealthStatus,
  type ProtocolType,
  type ReasoningEffort,
} from "@/lib/types"

export function HealthBadge({ status }: { status: HealthStatus }) {
  const dot =
    status === "healthy"
      ? "bg-chart-1"
      : status === "degraded"
        ? "bg-chart-3"
        : "bg-destructive"
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      {HEALTH_LABELS[status]}
    </Badge>
  )
}

export function ProtocolBadge({ protocol }: { protocol: ProtocolType }) {
  return (
    <Badge variant="secondary" className="font-mono text-xs font-normal">
      {PROTOCOL_LABELS[protocol]}
    </Badge>
  )
}

export function ReasoningBadge({ effort }: { effort: ReasoningEffort }) {
  const variant = effort === "off" ? "outline" : "secondary"
  return (
    <Badge variant={variant} className="font-normal">
      推理 · {REASONING_LABELS[effort]}
    </Badge>
  )
}

export function StatusCodeBadge({ code }: { code: number }) {
  const ok = code >= 200 && code < 300
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono font-normal",
        ok ? "text-chart-1" : "text-destructive",
      )}
    >
      {code}
    </Badge>
  )
}
