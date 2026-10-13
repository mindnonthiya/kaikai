import type { DayPoint } from "@/lib/analytics";
import { formatBaht } from "@/lib/money";

export function SalesChart({ points }: { points: DayPoint[] }) {
  const max = Math.max(1, ...points.map((p) => Math.max(p.revenue, p.grossProfit)));
  const height = (value: number) => `${Math.max(0, Math.round((value / max) * 100))}%`;
  return <div className="chart-wrap" aria-label={`กราฟยอดขายและกำไร ${points.length} วัน`}>
    <div className="chart-legend"><span><i className="legend-sales" />ยอดขาย</span><span><i className="legend-profit" />กำไรขั้นต้น</span></div>
    <div className="bar-chart">
      {points.map((point) => <div className="bar-group" key={point.key} title={`${point.shortDate}: ยอดขาย ${formatBaht(point.revenue)} · กำไรขั้นต้น ${formatBaht(point.grossProfit)}`}>
        <div className="bars"><i className="bar sales" style={{ height: height(point.revenue) }} /><i className="bar profit" style={{ height: height(point.grossProfit) }} /></div>
        <span>{point.label}</span>
      </div>)}
    </div>
  </div>;
}
