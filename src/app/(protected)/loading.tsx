export default function ProtectedLoading() {
  return (
    <div className="page-loading-skeleton" aria-busy="true" aria-label="กำลังโหลดข้อมูล…">
      <div className="skeleton-header">
        <div className="skeleton-bar title-bar" />
        <div className="skeleton-bar subtitle-bar" />
      </div>
      <div className="skeleton-grid">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
      <div className="skeleton-card large" />
    </div>
  );
}
