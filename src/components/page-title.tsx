export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <section className="page-heading"><div className="page-heading-content"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{action ? <div className="page-heading-action">{action}</div> : null}</section>;
}
