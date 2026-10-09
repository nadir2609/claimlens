import { Link } from 'react-router-dom';

export function NotFoundPage({ what = 'Page' }: { what?: string }) {
  return (
    <div className="empty-state">
      <h1>{what} not found</h1>
      <p>The address may be mistyped, or the claim may have been removed.</p>
      <p>
        <Link className="btn btn-primary" to="/claims">View all claims</Link>
      </p>
    </div>
  );
}
