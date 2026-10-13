export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="kaikai">
      <span className="brand-mark" aria-hidden="true">ก</span>
      {!compact && <span className="brand-copy"><strong>kaikai</strong><small>รู้ต้นทุน เห็นกำไร</small></span>}
    </div>
  );
}
