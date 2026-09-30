import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { LucideIcon } from "lucide-react"

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string
  value: string
  hint?: string
  icon: LucideIcon
  tone?: "default" | "good" | "warn" | "bad"
}) {
  const toneClass =
    tone === "good"
      ? "text-chart-1"
      : tone === "warn"
        ? "text-chart-3"
        : tone === "bad"
          ? "text-destructive"
          : "text-foreground"
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 px-4 pt-4">
        <CardDescription className="text-xs">{label}</CardDescription>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-1">
        <div className={cn("font-mono text-2xl font-semibold tabular-nums", toneClass)}>
          {value}
        </div>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}
