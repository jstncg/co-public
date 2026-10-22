// shared frame for review pages: the consent banner is mandatory and
// prominent on every review surface (goal.md §31, §26.3).

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="consent-banner" role="alert">
        consent check: console blocks unconsented users
      </div>
      {children}
    </>
  );
}
