import { chartData } from "@/lib/demo-data";

export function SalesChart() {
  return <div className="chart-wrap" aria-label="กราฟยอดขายและกำไร 7 วัน">
    <div className="chart-legend"><span><i className="legend-sales" />ยอดขาย</span><span><i className="legend-profit" />กำไร</span></div>
    <div className="bar-chart">
      {chartData.map((point) => <div className="bar-group" key={point.label}>
        <div className="bars"><i className="bar sales" style={{ height: `${point.sales}%` }} /><i className="bar profit" style={{ height: `${point.profit}%` }} /></div>
        <span>{point.label}</span>
      </div>)}
    </div>
  </div>;
}
